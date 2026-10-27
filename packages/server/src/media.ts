import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { writeFileAtomic } from './fs-utils.ts';

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

const EXT_FOR_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MIME).map(([ext, mime]) => [mime, ext === '.jpeg' ? '.jpg' : ext])
);

export const MEDIA_ROUTE = '/media/';
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export interface StoredMedia {
  /** Root-relative URL served by OpenPaper, e.g. `/media/ab12….png`. */
  url: string;
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Content-addressed image store under `<home>/assets`. */
export class MediaStore {
  constructor(private readonly dir: string) {}

  async put(data: Buffer, mimeType: string): Promise<StoredMedia> {
    if (data.length > MAX_MEDIA_BYTES) throw new Error('Image is larger than 100 MB');
    const mime = sniffMime(data) ?? mimeType;
    const ext = EXT_FOR_MIME[mime];
    if (!ext) throw new Error(`Unsupported image type "${mimeType}"`);
    const hash = createHash('sha256').update(data).digest('hex').slice(0, 32);
    const name = `${hash}${ext}`;
    const path = join(this.dir, name);
    if (!existsSync(path)) await writeFileAtomic(path, data);
    return { url: `${MEDIA_ROUTE}${name}`, path, mimeType: mime, bytes: data.length, ...imageSize(data) };
  }

  /** Decode a `data:image/...;base64,` URI into the store. */
  async putDataUri(uri: string): Promise<StoredMedia> {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
    if (!m) throw new Error('Malformed data URI');
    const data = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    return this.put(data, m[1]!);
  }

  /** Copy a local image file (from a `paper-asset://` URL or absolute path) into the store. */
  async putLocalFile(filePath: string): Promise<StoredMedia> {
    const ext = extname(filePath).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) throw new Error(`Only image files can be used (${filePath})`);
    // UNC paths (\\host\share) would send the user's Windows credentials to that host.
    if (/^[\\/]{2}/.test(filePath)) throw new Error(`Network paths can't be used (${filePath})`);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
    return this.put(await readFile(filePath), mime);
  }

  /** Resolve `/media/<name>` to a file path inside the store, or null. */
  pathFor(url: string): string | null {
    if (!url.startsWith(MEDIA_ROUTE)) return null;
    const name = url.slice(MEDIA_ROUTE.length).split(/[?#]/)[0]!;
    if (!/^[a-f0-9]{32}\.[a-z]{3,4}$/.test(name)) return null;
    return join(this.dir, name);
  }
}

/**
 * Convert a `paper-asset://` URL into an absolute local path.
 * Rejects UNC paths on Windows (they would trigger SMB auth to remote hosts)
 * and drive-relative paths.
 */
export function assetUrlToPath(rawUrl: string, platform: NodeJS.Platform = process.platform): string | null {
  const prefix = 'paper-asset://';
  if (!rawUrl.startsWith(prefix)) return null;
  let raw = rawUrl.slice(prefix.length).split(/[?#]/)[0]!;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  raw = raw.replace(/\\/g, '/');
  if (platform === 'win32') {
    if (raw.startsWith('//')) return null;
    raw = raw.replace(/^\/+(?=[a-zA-Z]:)/, '');
    if (/^[a-zA-Z]:(?!\/)/.test(raw)) return null;
  } else if (!raw.startsWith('/')) {
    raw = `/${raw}`;
  }
  const resolved = resolve(normalize(raw));
  return isAbsolute(resolved) ? resolved : null;
}

export function sniffMime(data: Buffer): string | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && data.toString('ascii', 4, 12).startsWith('ftypavi')) return 'image/avif';
  if (data.length >= 2 && data.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  const head = data.toString('utf8', 0, Math.min(data.length, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** Intrinsic pixel size for common formats (reads headers only). */
export function imageSize(data: Buffer): { width?: number; height?: number } {
  try {
    const mime = sniffMime(data);
    if (mime === 'image/png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (mime === 'image/gif' && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    if (mime === 'image/bmp' && data.length >= 26) return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
    if (mime === 'image/webp') return webpSize(data);
    if (mime === 'image/jpeg') return jpegSize(data);
    if (mime === 'image/svg+xml') return svgSize(data.toString('utf8', 0, Math.min(data.length, 4096)));
  } catch {
    // fall through
  }
  return {};
}

function jpegSize(data: Buffer): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = data.readUInt16BE(offset + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return {};
}

function webpSize(data: Buffer): { width?: number; height?: number } {
  const chunk = data.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && data.length >= 30) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && data.length >= 25) {
    const b = data.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && data.length >= 30) {
    return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
  }
  return {};
}

function svgSize(text: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return {};
  const num = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag);
    return m ? Number(m[1]) : undefined;
  };
  const width = num('width');
  const height = num('height');
  if (width && height) return { width, height };
  const vb = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) return { width: Number(vb[1]), height: Number(vb[2]) };
  return {};
}
