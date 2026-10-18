import { readFile } from 'node:fs/promises';
import { FIGMA_IMAGE_SCHEME } from '@openpaper/core';
import { writeFileAtomic } from './fs-utils.ts';

/**
 * Figma image fills. The clipboard only carries image hashes; with a personal access token the
 * Figma REST API maps them to download URLs for the file the layers were copied from.
 */

const API = 'https://api.figma.com/v1';
const TIMEOUT_MS = 20_000;

export interface FigmaConfigInfo {
  /** Where the token comes from (it is never sent to editors). */
  tokenSource: 'settings' | 'environment' | null;
}

/** The Figma token, stored in `<home>/config.json` (owner-only) next to the agent settings. */
export class FigmaSettings {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private static env(): string | undefined {
    return process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN || undefined;
  }

  async token(): Promise<string | null> {
    const stored = ((await this.read()).figma as { token?: string } | undefined)?.token;
    return stored || FigmaSettings.env() || null;
  }

  async info(): Promise<FigmaConfigInfo> {
    const stored = ((await this.read()).figma as { token?: string } | undefined)?.token;
    return { tokenSource: stored ? 'settings' : FigmaSettings.env() ? 'environment' : null };
  }

  async setToken(token: string | null): Promise<void> {
    const cfg = await this.read();
    const figma = { ...((cfg.figma as Record<string, unknown>) ?? {}) };
    const t = token?.trim();
    if (t) figma.token = t;
    else delete figma.token;
    await writeFileAtomic(this.path, JSON.stringify({ ...cfg, figma }, null, 2), 0o600);
  }
}

/** `figma-image://<fileKey>/<hash>` → { fileKey, hash }. */
export function parseFigmaImageUrl(url: string): { fileKey: string; hash: string } | null {
  if (!url.startsWith(FIGMA_IMAGE_SCHEME)) return null;
  const [fileKey, hash] = url.slice(FIGMA_IMAGE_SCHEME.length).split('/');
  if (!fileKey || !hash || !/^[0-9a-f]+$/i.test(hash) || !/^[A-Za-z0-9]+$/.test(fileKey)) return null;
  return { fileKey, hash: hash.toLowerCase() };
}

/** Download URLs for every image fill in a Figma file (GET /v1/files/:key/images). */
export async function figmaImageFills(fileKey: string, token: string): Promise<Map<string, string>> {
  const res = await fetch(`${API}/files/${encodeURIComponent(fileKey)}/images`, {
    headers: { 'X-Figma-Token': token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403) throw new Error('Figma rejected the access token (or it cannot read this file).');
  if (res.status === 404) throw new Error('Figma could not find the file the layers were copied from.');
  if (!res.ok) throw new Error(`Figma API error ${res.status}`);
  const body = (await res.json()) as { meta?: { images?: Record<string, string | null> } };
  const out = new Map<string, string>();
  for (const [hash, url] of Object.entries(body.meta?.images ?? {})) if (url) out.set(hash.toLowerCase(), url);
  return out;
}
