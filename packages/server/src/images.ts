import { readFile } from 'node:fs/promises';
import { primaryImageUrl, readerOf, subtreeText, type NodeRecord } from '@openpaper/core';
import type { ActorRef, DocumentHub } from './hub.ts';
import type { MediaStore } from './media.ts';
import { imageGenerationGuide } from './tools/guides.ts';
import type { Call } from './tools/context.ts';

export const MAX_GENERATIONS_PER_CALL = 10;

type Provider = 'openai' | 'google';

interface Model {
  id: string;
  label: string;
  provider: Provider;
  kind: 'text-to-image' | 'image-to-image';
}

const MODELS: Model[] = [
  { id: 'openai-gpt-image-1', label: 'OpenAI GPT Image', provider: 'openai', kind: 'text-to-image' },
  { id: 'google-gemini-flash-image', label: 'Google Gemini Flash Image ("Nano Banana")', provider: 'google', kind: 'text-to-image' },
  { id: 'google-gemini-flash-image-edit', label: 'Google Gemini Flash Image with references', provider: 'google', kind: 'image-to-image' },
];

const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'];

function configured(provider: Provider): boolean {
  return provider === 'openai' ? !!process.env.OPENAI_API_KEY : !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

/** Map any model id (including Paper's) to one of ours. */
function resolveModel(id: string): Model | null {
  const exact = MODELS.find((m) => m.id === id);
  if (exact) return exact;
  if (id.startsWith('openai')) return MODELS[0]!;
  if (id.startsWith('google')) return MODELS[1]!;
  // Other Paper models (recraft, seedream, quiver, flux…) → whichever provider is configured.
  if (/^(recraft|seedream|quiver|flux|ideogram|imagen|bfl|black-forest)/.test(id)) {
    return MODELS.find((m) => configured(m.provider) && m.kind === 'text-to-image') ?? MODELS[0]!;
  }
  return null;
}

interface ParsedGen {
  model: Model;
  prompt: string;
  aspectRatio: string;
  referenceNodes: string[];
}

function parseGenUrl(url: string): { ok: ParsedGen; notes: string[] } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^paper-gen:\/\//, 'https://paper-gen/'));
  } catch (error) {
    return { error: `Could not parse paper-gen:// URL: ${error instanceof Error ? error.message : String(error)}.` };
  }
  const modelId = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  const model = resolveModel(modelId);
  const t2i = MODELS.filter((m) => m.kind === 'text-to-image').map((m) => m.id).join(', ');
  const i2i = MODELS.filter((m) => m.kind === 'image-to-image').map((m) => m.id).join(', ');
  if (!model) return { error: `Unknown image model "${modelId}". Available text-to-image models: ${t2i}. Available image-to-image models: ${i2i}.` };
  const prompt = parsed.searchParams.get('prompt')?.trim();
  if (!prompt) return { error: 'paper-gen:// URL is missing the required "prompt" query param.' };
  const notes: string[] = [];
  let aspectRatio = parsed.searchParams.get('aspect_ratio')?.trim() || '1:1';
  if (!RATIOS.includes(aspectRatio)) {
    notes.push(`aspect_ratio "${aspectRatio}" is not supported; the default "1:1" was used instead. "${model.id}" supports: ${RATIOS.join(', ')}.`);
    aspectRatio = '1:1';
  }
  const referenceNodes = (parsed.searchParams.get('reference_nodes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { ok: { model, prompt, aspectRatio, referenceNodes }, notes };
}

async function generateOpenAI(prompt: string, aspectRatio: string): Promise<{ data: Buffer; mime: string }> {
  const [w, h] = aspectRatio.split(':').map(Number) as [number, number];
  const size = w / h > 1.2 ? '1536x1024' : w / h < 0.83 ? '1024x1536' : '1024x1024';
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: process.env.OPENPAPER_OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size, n: 1 }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `OpenAI returned HTTP ${res.status}`);
  const item = body.data?.[0];
  if (item?.b64_json) return { data: Buffer.from(item.b64_json, 'base64'), mime: 'image/png' };
  if (item?.url) {
    const img = await fetch(item.url);
    return { data: Buffer.from(await img.arrayBuffer()), mime: img.headers.get('content-type') ?? 'image/png' };
  }
  throw new Error('OpenAI returned no image');
}

async function generateGemini(prompt: string, aspectRatio: string, images: Array<{ data: Buffer; mime: string }>): Promise<{ data: Buffer; mime: string }> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!;
  const model = process.env.OPENPAPER_GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const parts: unknown[] = [{ text: prompt }, ...images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.data.toString('base64') } }))];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } } }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> } }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(body.error?.message ?? `Gemini returned HTTP ${res.status}`);
  const inline = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline) throw new Error('Gemini returned no image');
  return { data: Buffer.from(inline.data, 'base64'), mime: inline.mimeType };
}

const SYSTEM: ActorRef = { kind: 'system', id: 'image-generation', name: 'Image generation' };

/** paper-gen:// support with the user's own provider keys. */
export class ImageGenService {
  constructor(
    private readonly hub: DocumentHub,
    private readonly media: MediaStore
  ) {}

  models() {
    return MODELS.map((m) => ({ id: m.id, label: m.label, kind: m.kind, configured: configured(m.provider) }));
  }

  guide(): string {
    return imageGenerationGuide(this.models(), MAX_GENERATIONS_PER_CALL);
  }

  /** Validate and start generations; returns a note for the tool result (or undefined). */
  async startAll(call: Call, gens: Array<{ nodeId: string; url: string }>): Promise<string | undefined> {
    if (!gens.length || !call.live) return undefined;
    const live = call.live;
    const notes: string[] = [];
    const fail = (nodeId: string, url: string, error: string) =>
      live.transact(SYSTEM, 'Image generation', (tx) => {
        tx.updateNode(nodeId, (n) => {
          n.imageGeneration = { status: 'error', output: 'raster', url, error };
        });
      }, { undoable: false });
    if (gens.length > MAX_GENERATIONS_PER_CALL) {
      for (const g of gens) fail(g.nodeId, g.url, 'declined');
      return `${gens.length} images would be generated but at most ${MAX_GENERATIONS_PER_CALL} can start per call. No generations were started. Split them across multiple calls.`;
    }
    let started = 0;
    for (const g of gens) {
      const parsed = parseGenUrl(g.url);
      if ('error' in parsed) {
        notes.push(parsed.error);
        fail(g.nodeId, g.url, parsed.error);
        continue;
      }
      notes.push(...parsed.notes);
      const { model, aspectRatio } = parsed.ok;
      if (!configured(model.provider)) {
        const msg =
          model.provider === 'openai'
            ? 'Image generation needs an OpenAI API key: set OPENAI_API_KEY for the OpenPaper server and restart it.'
            : 'Image generation needs a Google API key: set GEMINI_API_KEY for the OpenPaper server and restart it.';
        notes.push(msg);
        fail(g.nodeId, g.url, msg);
        continue;
      }
      // Reserve space with the requested aspect ratio while the image generates.
      const [rw, rh] = aspectRatio.split(':');
      live.transact(SYSTEM, 'Image generation', (tx) => {
        tx.updateNode(g.nodeId, (n) => {
          n.imageGeneration = { status: 'processing', output: 'raster', url: g.url };
          const hasW = !!n.styles.width;
          const hasH = !!n.styles.height;
          if (!hasW && !hasH) n.styles.width = '512px';
          if (!(hasW && hasH)) n.styles.aspectRatio ??= `${rw} / ${rh}`;
        });
      }, { undoable: false });
      started++;
      void this.run(live.id, g.nodeId, g.url, parsed.ok).catch((error) => console.error('[openpaper] image generation:', error));
    }
    if (started) notes.unshift(`${started} image(s) are generating. Poll get_node_info to know when they complete.`);
    return notes.length ? notes.join('\n') : undefined;
  }

  private async run(fileId: string, nodeId: string, url: string, gen: ParsedGen) {
    const live = await this.hub.get(fileId);
    try {
      const reader = readerOf(live.doc);
      let prompt = gen.prompt;
      const refImages: Array<{ data: Buffer; mime: string }> = [];
      for (const ref of gen.referenceNodes) {
        if (!live.doc.nodes[ref]) continue;
        const text = subtreeText(reader, ref);
        if (text) prompt = `${text}\n\n${prompt}`;
        const imageUrl = primaryImageUrl(live.doc.nodes[ref] as NodeRecord);
        const path = imageUrl ? this.media.pathFor(imageUrl) : null;
        if (path) refImages.push({ data: await readFile(path), mime: imageUrl!.endsWith('.png') ? 'image/png' : 'image/jpeg' });
      }
      const result =
        gen.model.provider === 'openai' ? await generateOpenAI(prompt, gen.aspectRatio) : await generateGemini(prompt, gen.aspectRatio, refImages);
      const stored = await this.media.put(result.data, result.mime);
      live.transact(SYSTEM, 'Image generated', (tx) => {
        tx.updateNode(nodeId, (n) => {
          const bg = n.styles.backgroundImage;
          if (bg && bg.includes('paper-gen://')) n.styles.backgroundImage = bg.replace(/url\(\s*["']?paper-gen:\/\/[^)"']*["']?\s*\)/, `url("${stored.url}")`);
          else n.styles.backgroundImage = `url("${stored.url}")`;
          n.styles.backgroundSize ??= 'cover';
          n.styles.backgroundPosition ??= 'center';
          n.styles.backgroundRepeat ??= 'no-repeat';
          n.imageGeneration = { status: 'ready', output: 'raster', url };
        });
      }, { undoable: false });
    } catch (error) {
      // The file was deleted while the image generated: nothing left to update.
      if (live.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      live.transact(SYSTEM, 'Image generation failed', (tx) => {
        tx.updateNode(nodeId, (n) => {
          n.imageGeneration = { status: 'error', output: 'raster', url, error: message };
        });
      }, { undoable: false });
    }
  }
}
