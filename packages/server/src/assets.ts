import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { imageSize, sniffMime, assetUrlToPath, type MediaStore } from './media.ts';
import type { ResolvedImage } from '@openpaper/core';

const REMOTE_TIMEOUT_MS = 15_000;
const REMOTE_MAX_BYTES = 25 * 1024 * 1024;
const CACHE_MAX = 500;
const CONCURRENCY = 6;

/**
 * Turns image references found in imported HTML into local media URLs before the
 * (synchronous) import runs: data URIs, local files and remote images are copied
 * into the content-addressed media store so designs keep working offline.
 */
export class AssetResolver {
  private readonly cache = new Map<string, ResolvedImage | null>();

  constructor(private readonly media: MediaStore) {}

  async resolveAll(urls: string[]): Promise<Map<string, ResolvedImage | null>> {
    const out = new Map<string, ResolvedImage | null>();
    const queue = [...new Set(urls)];
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift()!;
        out.set(url, await this.resolveOne(url));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return out;
  }

  private remember(url: string, value: ResolvedImage | null): ResolvedImage | null {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, value);
    return value;
  }

  async resolveOne(raw: string): Promise<ResolvedImage | null> {
    const url = raw.trim();
    if (this.cache.has(url)) return this.cache.get(url)!;
    try {
      if (url.startsWith('/media/')) {
        const path = this.media.pathFor(url);
        if (!path) return null;
        const size = imageSize(await readFile(path));
        return { url, ...size };
      }
      if (url.startsWith('data:')) {
        const stored = await this.media.putDataUri(url);
        return this.remember(url, { url: stored.url, width: stored.width, height: stored.height });
      }
      if (url.startsWith('paper-asset://') || url.startsWith('file://')) {
        const path = url.startsWith('file://') ? fileURLToPath(url) : assetUrlToPath(url);
        if (!path) return null;
        const stored = await this.media.putLocalFile(path);
        return this.remember(url, { url: stored.url, width: stored.width, height: stored.height });
      }
      if (/^https?:\/\//i.test(url)) {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
          headers: { 'user-agent': 'OpenPaper/0.1 (+https://github.com/openpaper)' },
        });
        if (!res.ok) return this.remember(url, null);
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > REMOTE_MAX_BYTES) return this.remember(url, null);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > REMOTE_MAX_BYTES) return this.remember(url, null);
        const mime = sniffMime(data) ?? res.headers.get('content-type')?.split(';')[0] ?? '';
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
        if (mime === 'image/svg+xml' && isLocalhost) {
          return this.remember(url, { url, svgMarkup: data.toString('utf8') });
        }
        if (!mime.startsWith('image/')) return this.remember(url, null);
        const stored = await this.media.put(data, mime);
        return this.remember(url, { url: stored.url, width: stored.width, height: stored.height });
      }
    } catch {
      return this.remember(url, null);
    }
    // Relative or unknown schemes: leave as written.
    return { url };
  }
}
