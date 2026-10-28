import { strFromU8, unzipSync } from 'fflate';

/**
 * Lottie files. Layers play Lottie JSON; a dotLottie archive (`.lottie`, a zip with a manifest)
 * is unpacked to its first animation with the images it uses inlined, so one file holds it all.
 */

export interface LottieInfo {
  width: number;
  height: number;
  /** Frames per second and the in/out frames: the animation's length. */
  frameRate: number;
  durationMs: number;
}

/** Size and timing of Lottie JSON, or null when the text isn't a Lottie animation. */
export function lottieInfo(json: string): LottieInfo | null {
  try {
    const data = JSON.parse(json) as { w?: unknown; h?: unknown; fr?: unknown; ip?: unknown; op?: unknown; layers?: unknown };
    if (!Array.isArray(data.layers) || typeof data.w !== 'number' || typeof data.h !== 'number') return null;
    const fr = typeof data.fr === 'number' && data.fr > 0 ? data.fr : 30;
    const frames = typeof data.op === 'number' && typeof data.ip === 'number' ? Math.max(0, data.op - data.ip) : 0;
    return { width: data.w, height: data.h, frameRate: fr, durationMs: Math.round((frames / fr) * 1000) };
  } catch {
    return null;
  }
}

/** Quick check on the first bytes: does this look like Lottie JSON? */
export function looksLikeLottie(head: string): boolean {
  const t = head.trimStart();
  return t.startsWith('{') && /"(layers|assets|fr|ip|op)"\s*:/.test(t) && /"v"\s*:/.test(t);
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Unpacked size limits: a small archive can expand to gigabytes (a zip bomb). */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const WANTED = /^(manifest\.json|(animations|a)\/[^/]+\.json|(images|i)\/[^/]+)$/;

/** The first animation of a dotLottie archive as Lottie JSON (images inlined), or null. */
export function dotLottieToJson(archive: Uint8Array): string | null {
  let files: Record<string, Uint8Array>;
  let total = 0;
  try {
    // Only the entries a dotLottie needs, each within its declared size.
    files = unzipSync(archive, {
      filter: (f) => {
        if (!WANTED.test(f.name) || f.originalSize > MAX_ENTRY_BYTES || total + f.originalSize > MAX_TOTAL_BYTES) return false;
        total += f.originalSize;
        return true;
      },
    });
  } catch {
    return null;
  }
  const manifest = files['manifest.json'];
  let id: string | undefined;
  if (manifest) {
    try {
      id = (JSON.parse(strFromU8(manifest)) as { animations?: Array<{ id?: string }> }).animations?.[0]?.id;
    } catch {
      // fall back to the first animation file
    }
  }
  const names = Object.keys(files);
  const animation =
    (id && (files[`animations/${id}.json`] ?? files[`a/${id}.json`])) ||
    files[names.find((n) => /^(animations|a)\/[^/]+\.json$/.test(n)) ?? ''];
  if (!animation) return null;
  let data: { assets?: Array<{ u?: string; p?: string; e?: number }> };
  try {
    data = JSON.parse(strFromU8(animation));
  } catch {
    return null;
  }
  for (const asset of data.assets ?? []) {
    if (!asset.p || asset.e === 1 || asset.p.startsWith('data:')) continue;
    const bytes = files[`images/${asset.p}`] ?? files[`i/${asset.p}`] ?? files[`${(asset.u ?? '').replace(/^\//, '')}${asset.p}`];
    const type = IMAGE_TYPES[asset.p.split('.').pop()?.toLowerCase() ?? ''];
    if (!bytes || !type) continue;
    asset.u = '';
    asset.p = `data:${type};base64,${base64(bytes)}`;
    asset.e = 1;
  }
  const json = JSON.stringify(data);
  return lottieInfo(json) ? json : null;
}
