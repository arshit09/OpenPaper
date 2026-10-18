import { PDFDocument } from 'pdf-lib';
import type { Page } from 'puppeteer-core';
import {
  artboardOf,
  defaultResolveUrl,
  fontFamiliesUsed,
  pageRootOfNode,
  pxValue,
  readerOf,
  renderDocumentHtml,
  resolveTokenValue,
  subtreeOf,
  type DocReader,
  type LayoutMap,
  type NodeRecord,
  type PaperDocument,
  type RenderContext,
} from '@openpaper/core';
import type { FontService } from '../fonts/fonts.ts';
import type { HeadlessRenderer } from './headless.ts';

export const MODEL_IMAGE_MAX_SIDE = 2000;
export const MODEL_IMAGE_MAX_BASE64 = 4_500_000;
const MAX_CANVAS_SIDE = 16_000;
export const DEFAULT_CANVAS_COLOR = '#EEEEEE';

export interface EncodedImage {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  resized: boolean;
}

/** Ask a connected editor to do the work (fallback when no browser is installed). */
export interface EditorFallback {
  measure(fileId: string, pageId: string, version: number): Promise<LayoutMap | null>;
  screenshot(fileId: string, nodeId: string, scale: number): Promise<EncodedImage | null>;
}

interface RenderTarget {
  reader: DocReader;
  rootIds: string[];
  offsetX: number;
  offsetY: number;
  background: string;
}

function familiesIn(reader: DocReader, ids: string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    for (const n of subtreeOf(reader, id)) {
      const ff = n.styles.fontFamily;
      if (!ff) continue;
      for (const part of ff.split(',')) {
        const fam = resolveTokenValue(part.trim(), reader.getTokens()).replace(/^["']|["']$/g, '').trim();
        if (fam) out.add(fam);
      }
    }
  }
  for (const t of reader.getTokens()) if (t.type === 'fontFamily') for (const p of t.value.split(',')) out.add(p.trim().replace(/^["']|["']$/g, ''));
  return [...out];
}

function measureScript(): Record<string, { worldX: number; worldY: number; x: number; y: number; width: number; height: number }> {
  const world = document.querySelector('[data-op-world]') as HTMLElement;
  const wr = world.getBoundingClientRect();
  const round = (n: number) => Math.round(n * 100) / 100;
  const out: Record<string, { worldX: number; worldY: number; x: number; y: number; width: number; height: number }> = {};
  for (const el of Array.from(document.querySelectorAll('[data-op-id]'))) {
    const id = el.getAttribute('data-op-id')!;
    const r = el.getBoundingClientRect();
    const parentEl = el.parentElement?.closest('[data-op-id]') as HTMLElement | null;
    let x: number;
    let y: number;
    if (parentEl) {
      const pr = parentEl.getBoundingClientRect();
      x = r.left - pr.left - (parentEl.clientLeft || 0);
      y = r.top - pr.top - (parentEl.clientTop || 0);
    } else {
      x = r.left - wr.left;
      y = r.top - wr.top;
    }
    out[id] = { worldX: round(r.left - wr.left), worldY: round(r.top - wr.top), x: round(x), y: round(y), width: round(r.width), height: round(r.height) };
  }
  return out;
}

export class RenderService {
  private readonly layoutCache = new Map<string, { version: number; layout: LayoutMap }>();
  editorFallback: EditorFallback | null = null;

  constructor(
    readonly headless: HeadlessRenderer,
    private readonly fonts: FontService,
    private readonly baseUrl: () => string
  ) {}

  get canRender(): boolean {
    return this.headless.available;
  }

  private ctx(): RenderContext {
    const origin = this.baseUrl();
    return { resolveUrl: (src) => defaultResolveUrl(src, origin) };
  }

  canvasColor(doc: PaperDocument, pageId: string | null): string {
    return (pageId && doc.pages[pageId]?.canvasColor) || DEFAULT_CANVAS_COLOR;
  }

  private html(t: RenderTarget, extraCss = ''): string {
    const fontCss = this.fonts.cssUrls(familiesIn(t.reader, t.rootIds));
    return renderDocumentHtml(t.reader, this.ctx(), {
      rootIds: t.rootIds,
      offsetX: t.offsetX,
      offsetY: t.offsetY,
      background: t.background,
      fontCss,
      extraCss,
    });
  }

  /** Top-level nodes of a page with the offset that keeps them all in positive space. */
  private pageTarget(doc: PaperDocument, pageId: string): RenderTarget {
    const reader = readerOf(doc);
    const page = doc.pages[pageId]!;
    const root = doc.nodes[page.rootId]!;
    let minX = 0;
    let minY = 0;
    for (const id of root.children) {
      const n = doc.nodes[id];
      if (!n) continue;
      minX = Math.min(minX, pxValue(n.styles.left) ?? 0);
      minY = Math.min(minY, pxValue(n.styles.top) ?? 0);
    }
    return { reader, rootIds: [...root.children], offsetX: minX, offsetY: minY, background: this.canvasColor(doc, pageId) };
  }

  /** Measured layout of every node on a page (cached per document version). */
  async measurePage(doc: PaperDocument, version: number, pageId: string): Promise<LayoutMap | null> {
    const key = `${doc.id}:${pageId}`;
    const cached = this.layoutCache.get(key);
    if (cached && cached.version === version) return cached.layout;
    let layout: LayoutMap | null = null;
    if (this.editorFallback) {
      layout = await this.editorFallback.measure(doc.id, pageId, version).catch(() => null);
    }
    if (!layout && this.headless.available) {
      const target = this.pageTarget(doc, pageId);
      if (!target.rootIds.length) layout = {};
      else layout = await this.headless.withDocument(this.html(target), { width: 1600, height: 1000 }, (page) => page.evaluate(measureScript));
    }
    if (layout) this.layoutCache.set(key, { version, layout });
    return layout;
  }

  /** The top-level node (artboard) a node renders inside. */
  private topLevelOf(reader: DocReader, node: NodeRecord): NodeRecord {
    const board = artboardOf(reader, node.id);
    if (board) return board;
    let n = node;
    while (n.parentId) {
      const p = reader.getNode(n.parentId);
      if (!p || p.component === 'PageRoot') break;
      n = p;
    }
    return n;
  }

  private nodeTarget(doc: PaperDocument, node: NodeRecord, transparent: boolean): RenderTarget {
    const reader = readerOf(doc);
    const top = this.topLevelOf(reader, node);
    const root = pageRootOfNode(reader, node.id);
    const pageId = root ? Object.values(doc.pages).find((p) => p.rootId === root.id)?.id ?? null : null;
    return {
      reader,
      rootIds: [top.id],
      offsetX: pxValue(top.styles.left) ?? 0,
      offsetY: pxValue(top.styles.top) ?? 0,
      background: transparent ? 'transparent' : this.canvasColor(doc, pageId),
    };
  }

  /** Render and capture a node at a scale, applying model-friendly size limits. */
  async screenshot(doc: PaperDocument, nodeId: string, scale: number): Promise<EncodedImage> {
    const node = doc.nodes[nodeId]!;
    if (!this.headless.available) {
      const viaEditor = await this.editorFallback?.screenshot(doc.id, nodeId, scale).catch(() => null);
      if (viaEditor) return viaEditor;
      throw new Error(
        'No Chrome, Edge, Brave or Chromium browser was found for rendering, and no editor is open. Install one (or set OPENPAPER_BROWSER), or open the file in OpenPaper.'
      );
    }
    const target = this.nodeTarget(doc, node, false);
    const html = this.html(target);
    // Measure first to pick a scale that respects the size caps.
    const box = await this.headless.withDocument(html, { width: 1600, height: 1000 }, (page) =>
      page.evaluate((id: string) => {
        const el = document.querySelector(`[data-op-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, nodeId)
    );
    if (!box || box.width < 1 || box.height < 1) throw new Error('The node has no visible size.');
    let dsf = scale;
    let resized = false;
    const longest = Math.max(box.width, box.height) * dsf;
    if (longest > MODEL_IMAGE_MAX_SIDE) {
      dsf = MODEL_IMAGE_MAX_SIDE / Math.max(box.width, box.height);
      resized = true;
    }
    for (let round = 0; round < 8; round++) {
      for (const quality of round === 0 ? [92, 75, 60, 45] : [75, 60, 45]) {
        const shot = await this.capture(html, nodeId, box, dsf, 'jpeg', quality, false);
        if (shot.data.length <= MODEL_IMAGE_MAX_BASE64) {
          return { ...shot, resized: resized || quality !== 92 || round > 0 };
        }
      }
      dsf /= 2;
      resized = true;
    }
    const last = await this.capture(html, nodeId, box, dsf, 'jpeg', 50, false);
    return { ...last, resized: true };
  }

  private async capture(
    html: string,
    nodeId: string,
    box: { x: number; y: number; width: number; height: number },
    dsf: number,
    type: 'jpeg' | 'png' | 'webp',
    quality: number | undefined,
    transparent: boolean
  ): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const viewport = { width: Math.ceil(box.x + box.width) + 1, height: Math.ceil(box.y + box.height) + 1, deviceScaleFactor: dsf };
    return this.headless.withDocument(html, viewport, async (page: Page) => {
      const el = await page.$(`[data-op-id="${nodeId.replace(/"/g, '\\"')}"]`);
      if (!el) throw new Error(`No rendered element found for node ${nodeId}`);
      const rect = await el.boundingBox();
      if (!rect) throw new Error(`No rendered element found for node ${nodeId}`);
      const buf = (await page.screenshot({
        type,
        ...(type === 'png' ? {} : { quality }),
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        captureBeyondViewport: true,
        omitBackground: transparent,
        encoding: 'binary',
      })) as Uint8Array;
      return {
        data: Buffer.from(buf).toString('base64'),
        mimeType: type === 'jpeg' ? 'image/jpeg' : `image/${type}`,
        width: Math.round(rect.width * dsf),
        height: Math.round(rect.height * dsf),
      };
    });
  }

  /** Raster export (png/jpg/webp) at a device scale factor. */
  async exportRaster(doc: PaperDocument, nodeId: string, format: 'png' | 'jpg' | 'webp', pixelRatio: number): Promise<Buffer> {
    if (!this.headless.available) throw new Error('Exports need Chrome, Edge, Brave or Chromium installed (or set OPENPAPER_BROWSER).');
    const node = doc.nodes[nodeId]!;
    const target = this.nodeTarget(doc, node, format !== 'jpg');
    if (format === 'jpg') target.background = '#FFFFFF';
    const html = this.html(target);
    const box = await this.headless.withDocument(html, { width: 1600, height: 1000 }, (page) =>
      page.evaluate((id: string) => {
        const el = document.querySelector(`[data-op-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, nodeId)
    );
    if (!box || box.width < 1 || box.height < 1) throw new Error(`No rendered element found for node ${nodeId}`);
    let dsf = pixelRatio;
    const maxSide = Math.max(box.width, box.height) * dsf;
    if (maxSide > MAX_CANVAS_SIDE) dsf = MAX_CANVAS_SIDE / Math.max(box.width, box.height);
    if (box.width * box.height * dsf * dsf > MAX_CANVAS_SIDE * MAX_CANVAS_SIDE) dsf = MAX_CANVAS_SIDE / Math.sqrt(box.width * box.height);
    const shot = await this.capture(html, nodeId, box, dsf, format === 'jpg' ? 'jpeg' : format, format === 'png' ? undefined : 90, format !== 'jpg');
    return Buffer.from(shot.data, 'base64');
  }

  /** Measured size of a node in its rendering context. */
  async nodeSize(doc: PaperDocument, nodeId: string): Promise<{ width: number; height: number } | null> {
    if (!this.headless.available) return null;
    const target = this.nodeTarget(doc, doc.nodes[nodeId]!, true);
    return this.headless.withDocument(this.html(target), { width: 1600, height: 1000 }, (page) =>
      page.evaluate((id: string) => {
        const el = document.querySelector(`[data-op-id="${CSS.escape(id)}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }, nodeId)
    );
  }

  /** One-page PDF of a node (vector text, embedded images). */
  async exportPdf(doc: PaperDocument, nodeId: string): Promise<Buffer> {
    if (!this.headless.available) throw new Error('PDF export needs Chrome, Edge, Brave or Chromium installed (or set OPENPAPER_BROWSER).');
    const size = await this.nodeSize(doc, nodeId);
    if (!size || size.width < 1 || size.height < 1) throw new Error(`Error assembling PDF page`);
    const node = doc.nodes[nodeId]!;
    const target = this.nodeTarget(doc, node, true);
    // Hide everything except the node's ancestor chain + subtree, and pin the node to the page origin.
    const css = `@page{size:${Math.ceil(size.width)}px ${Math.ceil(size.height)}px;margin:0}
html,body{width:${Math.ceil(size.width)}px;height:${Math.ceil(size.height)}px}`;
    const html = this.html(target, css);
    return this.headless.withDocument(html, { width: Math.ceil(size.width), height: Math.ceil(size.height) }, async (page) => {
      await page.evaluate((id: string) => {
        const el = document.querySelector(`[data-op-id="${CSS.escape(id)}"]`) as HTMLElement | null;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const world = document.querySelector('[data-op-world]') as HTMLElement;
        const t = getComputedStyle(world).transform;
        const m = new DOMMatrix(t === 'none' ? undefined : t);
        world.style.transform = `translate(${m.e - r.left}px, ${m.f - r.top}px)`;
      }, nodeId);
      const pdf = await page.pdf({
        width: `${Math.ceil(size.width)}px`,
        height: `${Math.ceil(size.height)}px`,
        printBackground: true,
        pageRanges: '1',
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      return Buffer.from(pdf);
    });
  }

  async combinePdfs(parts: Buffer[]): Promise<Buffer> {
    const out = await PDFDocument.create();
    for (const part of parts) {
      const src = await PDFDocument.load(part);
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    }
    return Buffer.from(await out.save());
  }

  /** Re-encode image bytes as JPEG within model limits (get_fill_image). */
  async encodeForModel(bytes: Buffer, mimeType: string): Promise<EncodedImage> {
    if (!this.headless.available) {
      return { data: bytes.toString('base64'), mimeType, width: 0, height: 0, resized: false };
    }
    const dataUrl = `data:${mimeType};base64,${bytes.toString('base64')}`;
    const html = `<!doctype html><html><body style="margin:0"><img id="i" src="${dataUrl}"></body></html>`;
    return this.headless.withDocument(html, { width: 100, height: 100 }, (page) =>
      page.evaluate(
        async (maxSide: number, maxB64: number) => {
          const img = document.getElementById('i') as HTMLImageElement;
          await img.decode().catch(() => {});
          let w = img.naturalWidth || 1;
          let h = img.naturalHeight || 1;
          let resized = false;
          if (Math.max(w, h) > maxSide) {
            const k = maxSide / Math.max(w, h);
            w = Math.round(w * k);
            h = Math.round(h * k);
            resized = true;
          }
          const encode = (q: number) => {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const g = c.getContext('2d')!;
            g.fillStyle = '#fff';
            g.fillRect(0, 0, w, h);
            g.drawImage(img, 0, 0, w, h);
            return c.toDataURL('image/jpeg', q).slice('data:image/jpeg;base64,'.length);
          };
          let data = encode(0.92);
          for (let round = 0; data.length > maxB64 && round < 8; round++) {
            resized = true;
            let ok = false;
            for (const q of [0.75, 0.6, 0.45]) {
              data = encode(q);
              if (data.length <= maxB64) {
                ok = true;
                break;
              }
            }
            if (ok) break;
            w = Math.max(1, Math.round(w / 2));
            h = Math.max(1, Math.round(h / 2));
          }
          return { data, mimeType: 'image/jpeg', width: w, height: h, resized };
        },
        MODEL_IMAGE_MAX_SIDE,
        MODEL_IMAGE_MAX_BASE64
      )
    );
  }

  /** Detect installed fonts with the Local Font Access API in headless Chrome. */
  async localFonts(): Promise<Array<{ family: string; style: string }>> {
    if (!this.headless.available) return [];
    return this.headless.withLocalFonts();
  }

  invalidate(fileId: string): void {
    for (const key of this.layoutCache.keys()) if (key.startsWith(`${fileId}:`)) this.layoutCache.delete(key);
  }
}

export function fontFamiliesOf(doc: PaperDocument): string[] {
  return fontFamiliesUsed(readerOf(doc));
}
