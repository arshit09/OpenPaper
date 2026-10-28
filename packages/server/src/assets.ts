import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { imageSize, sniffMime, assetUrlToPath, type MediaStore } from './media.ts';
import type { ResolvedImage } from '@openpaper/core';
import { figmaImageFills, parseFigmaImageUrl } from './figma.ts';

const REMOTE_TIMEOUT_MS = 15_000;
const REMOTE_MAX_BYTES = 25 * 1024 * 1024;
/** Videos are bigger and slower to fetch than images. */
const MOTION_TIMEOUT_MS = 90_000;
const MOTION_MAX_BYTES = 100 * 1024 * 1024;
const CACHE_MAX = 500;
const CONCURRENCY = 6;
const MAX_REDIRECTS = 5;

/** Loopback, private, link-local and unique-local ranges: the user's own machine and network. */
const LOCAL_NETWORK = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
  LOCAL_NETWORK.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) LOCAL_NETWORK.addSubnet(net, prefix, 'ipv6');

function isLocalAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return LOCAL_NETWORK.check(mapped, 'ipv4');
  return LOCAL_NETWORK.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** Whether a host name points into the user's own machine or network. */
async function isLocalHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host)) return isLocalAddress(host);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.some((a) => isLocalAddress(a.address));
}

/** What a reference is expected to be: an image, or a file that plays (video, Lottie). */
export type AssetKind = 'image' | 'motion';

function isKind(mime: string, kind: AssetKind): boolean {
  return kind === 'image' ? mime.startsWith('image/') : mime.startsWith('video/') || mime === 'application/json';
}

/** Not worth remembering: the same URL may well work on the next try. */
class TransientError extends Error {}

/** The body, or null once it passes `max` bytes (the declared length can't be trusted: compressed bodies are decoded). */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Turns image references found in imported HTML into local media URLs before the
 * (synchronous) import runs: data URIs, local files and remote images are copied
 * into the content-addressed media store so designs keep working offline.
 */
export class AssetResolver {
  private readonly cache = new Map<string, ResolvedImage | null>();

  constructor(
    private readonly media: MediaStore,
    /** Figma personal access token for figma-image:// URLs (pasted Figma image fills). */
    private readonly figmaToken: () => Promise<string | null> = async () => null
  ) {}

  async resolveAll(urls: string[], kind: AssetKind = 'image'): Promise<Map<string, ResolvedImage | null>> {
    const out = new Map<string, ResolvedImage | null>();
    // Figma image fills: one REST call per source file maps hashes to download URLs.
    const figma = urls.map((u) => [u, parseFigmaImageUrl(u)] as const).filter(([, p]) => p);
    const download = new Map<string, string>();
    if (figma.length) {
      const token = await this.figmaToken();
      const files = new Set(figma.map(([, p]) => p!.fileKey));
      for (const fileKey of files) {
        const fills = token ? await figmaImageFills(fileKey, token).catch(() => new Map<string, string>()) : new Map<string, string>();
        for (const [url, p] of figma) {
          if (p!.fileKey !== fileKey) continue;
          const remote = fills.get(p!.hash);
          if (remote) download.set(url, remote);
          else out.set(url, null);
        }
      }
    }
    const queue = [...new Set(urls)].filter((u) => !out.has(u));
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift()!;
        const remote = download.get(url);
        out.set(url, await this.resolveOne(remote ?? url, kind));
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

  async resolveOne(raw: string, kind: AssetKind = 'image'): Promise<ResolvedImage | null> {
    const url = raw.trim();
    const key = kind === 'image' ? url : `${kind}:${url}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const remember = (value: ResolvedImage | null) => this.remember(key, value);
    try {
      if (url.startsWith('/media/')) {
        const path = this.media.pathFor(url);
        if (!path) return null;
        const size = imageSize(await readFile(path));
        return { url, ...size };
      }
      if (url.startsWith('data:')) {
        const stored = await this.media.putDataUri(url);
        return remember(isKind(stored.mimeType, kind) ? { url: stored.url, width: stored.width, height: stored.height } : null);
      }
      if (url.startsWith('paper-asset://') || url.startsWith('file://')) {
        // `file://host/share/…` is a UNC path on Windows: opening it would send the user's credentials to that host.
        const path = url.startsWith('file://') ? (new URL(url).host && new URL(url).host !== 'localhost' ? null : fileURLToPath(url)) : assetUrlToPath(url);
        if (!path) return null;
        // Not cached: the file can change on disk.
        const stored = await this.media.putLocalFile(path, kind === 'motion');
        return isKind(stored.mimeType, kind) ? { url: stored.url, width: stored.width, height: stored.height } : null;
      }
      if (/^https?:\/\//i.test(url)) {
        const res = await this.fetchRemote(url, kind === 'motion' ? MOTION_TIMEOUT_MS : REMOTE_TIMEOUT_MS);
        if (!res) return remember(null);
        if (!res.ok) {
          // Rate limits, timeouts and server errors pass; a missing image stays missing.
          if (res.status === 408 || res.status === 429 || res.status >= 500) throw new TransientError(String(res.status));
          return remember(null);
        }
        const data = await readCapped(res, kind === 'motion' ? MOTION_MAX_BYTES : REMOTE_MAX_BYTES);
        if (!data) return remember(null);
        const mime = sniffMime(data) ?? res.headers.get('content-type')?.split(';')[0] ?? '';
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
        if (kind === 'image' && mime === 'image/svg+xml' && isLocalhost) {
          return remember({ url, svgMarkup: data.toString('utf8') });
        }
        if (kind === 'image' && !mime.startsWith('image/')) return remember(null);
        // Video and Lottie: the store checks the bytes (and unpacks a .lottie archive).
        const stored = await this.media.put(data, mime);
        if (!isKind(stored.mimeType, kind)) return remember(null);
        return remember({ url: stored.url, width: stored.width, height: stored.height });
      }
    } catch {
      // Network errors, timeouts and unreadable files: try again next time.
      return null;
    }
    // Relative or unknown schemes: leave as written.
    return { url };
  }

  /**
   * GET with redirects followed by hand: an image on the internet may not redirect into the user's own
   * machine or network (it would be fetched and stored blind). Local addresses are fine when asked for directly.
   * Null when a redirect is refused or loops.
   */
  private async fetchRemote(url: string, timeoutMs = REMOTE_TIMEOUT_MS): Promise<Response | null> {
    const signal = AbortSignal.timeout(timeoutMs);
    const local = await isLocalHost(new URL(url).hostname);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, { signal, redirect: 'manual', headers: { 'user-agent': 'OpenPaper/0.1 (+https://github.com/openpaper)' } });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) return res;
      await res.body?.cancel().catch(() => {});
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
      if (!local && (await isLocalHost(next.hostname))) return null;
      current = next.href;
    }
    return null;
  }
}
