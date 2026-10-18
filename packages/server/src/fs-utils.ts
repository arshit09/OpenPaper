import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

/** Write via temp file + rename so readers never observe a half-written file. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fileMode = mode ?? (await stat(path).then((s) => s.mode & 0o777).catch(() => 0o644));
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, data, { mode: fileMode });
  // Windows: antivirus / indexers can briefly lock the destination.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** Decode config text that may carry a BOM or be UTF-16LE (common with Windows tools). */
export function decodeText(bytes: Buffer): string {
  let text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
  if (text.startsWith('﻿')) text = text.slice(1);
  return text;
}
