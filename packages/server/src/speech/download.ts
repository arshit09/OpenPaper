import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

/** Abort a response that sends nothing for this long, then resume it. */
const STALL_MS = 30_000;
const ATTEMPTS = 5;
const RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];

export const partPath = (dest: string) => `${dest}.part`;

export async function fileSize(path: string): Promise<number> {
  return stat(path).then((s) => s.size, () => 0);
}

/**
 * Download `url` to `dest` through `dest.part`, then check its size and SHA-256 and rename it into place, so `dest`
 * only ever exists complete. A `.part` left by an interrupted run (or a dropped connection) is resumed with an HTTP
 * Range request; a server that ignores the range restarts it. `onProgress` gets the bytes on disk so far.
 */
export async function downloadFile(
  url: string,
  dest: string,
  want: { size: number; sha256: string },
  onProgress: (bytes: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const part = partPath(dest);
  for (let attempt = 1; ; attempt++) {
    try {
      await fetchInto(url, part, want.size, onProgress, signal);
      break;
    } catch (error) {
      if (signal?.aborted || attempt >= ATTEMPTS || (error as { permanent?: boolean }).permanent) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const size = await fileSize(part);
  const sha256 = size === want.size ? await hashFile(part) : '';
  if (sha256 !== want.sha256) {
    await rm(part, { force: true });
    throw new Error(`The download of ${url} was corrupt (${size} bytes, expected ${want.size}). Try again.`);
  }
  await renameWithRetry(part, dest);
}

async function fetchInto(url: string, part: string, size: number, onProgress: (bytes: number) => void, signal?: AbortSignal): Promise<void> {
  let have = await fileSize(part);
  if (have > size) {
    await rm(part, { force: true });
    have = 0;
  }
  onProgress(have);
  if (have === size) return;

  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_MS);
  try {
    const res = await fetch(url, {
      headers: have ? { range: `bytes=${have}-` } : {},
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
    });
    if (!res.ok || !res.body) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      throw Object.assign(new Error(`Download failed: HTTP ${res.status} for ${url}`), { permanent });
    }
    // 206 continues the partial file; 200 is the whole file again.
    const resumed = res.status === 206;
    if (resumed && contentRangeStart(res.headers.get('content-range')) !== have) {
      await res.body.cancel();
      await rm(part, { force: true });
      throw new Error(`Download of ${url} resumed at the wrong offset.`);
    }
    if (!resumed) have = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        clearTimeout(timer);
        timer = setTimeout(() => stall.abort(), STALL_MS);
        onProgress((have += chunk.length));
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as ReadableStream), count, createWriteStream(part, { flags: resumed ? 'a' : 'w' }));
  } finally {
    clearTimeout(timer);
  }
}

function contentRangeStart(header: string | null): number | null {
  const m = /^bytes (\d+)-/.exec(header ?? '');
  return m ? Number(m[1]) : null;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Windows: antivirus scanning the freshly written file can briefly lock it. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}
