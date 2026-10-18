import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { tokenCssName, tokensContentHash, type TokenRecord } from '@openpaper/core';

type Canonicalize = (candidates: string[]) => Promise<string[]>;

/**
 * Runs inside a worker thread: Tailwind CSS v4's canonicalizer is CPU-heavy (seconds
 * for the first call per design system), so it must never block the server's event
 * loop, which also carries live sync for every editor and agent.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const tw = require(workerData.libPath);
const base = workerData.baseDir;
const OPTIONS = { rem: 16, collapse: true, logicalToPhysical: true };
const systems = new Map();
function load(key, css) {
  let pending = systems.get(key);
  if (!pending) {
    pending = tw.__unstable__loadDesignSystem(css, {
      base,
      loadStylesheet: async (id, from) => {
        const file = id.startsWith('tailwindcss/') ? path.join(base, id.slice('tailwindcss/'.length)) : path.join(from, id);
        return { path: file, base: path.dirname(file), content: await readFile(file, 'utf8') };
      },
    });
    systems.set(key, pending);
    if (systems.size > 20) systems.delete(systems.keys().next().value);
  }
  return pending;
}
parentPort.on('message', async (msg) => {
  try {
    const ds = await load(msg.key, msg.css);
    const out = msg.candidates.length ? ds.canonicalizeCandidates(msg.candidates, OPTIONS) : [];
    parentPort.postMessage({ id: msg.id, out });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, error: String(error && error.message || error) });
  }
});
`;

function themeCss(tokens: readonly TokenRecord[]): string {
  if (!tokens.length) return '@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css";';
  const hasSpacing = tokens.some((t) => tokenCssName(t).startsWith('--spacing'));
  const lines = tokens.map((t) => `  ${tokenCssName(t)}: ${t.value};`).join('\n');
  // Paper uses the file's own tokens as the theme (so --color-primary enables bg-primary).
  return `@import "tailwindcss/utilities.css";\n@theme {\n${hasSpacing ? '' : '  --spacing: 0.25rem;\n'}${lines}\n}`;
}

/**
 * Tailwind CSS v4's own canonicalizer turns arbitrary properties (`[padding:16px]`)
 * into idiomatic utilities (`p-4`) — the same engine Paper uses for get_jsx.
 */
export class TailwindService {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 1;
  private readonly pending = new Map<number, { resolve: (v: string[]) => void; reject: (e: Error) => void }>();

  private getWorker(): Worker | null {
    if (this.broken) return null;
    if (this.worker) return this.worker;
    try {
      const require = createRequire(import.meta.url);
      const libPath = require.resolve('tailwindcss');
      const baseDir = dirname(require.resolve('tailwindcss/package.json'));
      const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { libPath, baseDir } });
      worker.unref();
      worker.on('message', (msg: { id: number; out?: string[]; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.out ?? []);
      });
      worker.on('error', (error) => {
        console.warn('[openpaper] Tailwind worker failed:', error.message);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        this.worker = null;
      });
      this.worker = worker;
      return worker;
    } catch (error) {
      console.warn('[openpaper] Tailwind engine unavailable, emitting arbitrary properties:', error instanceof Error ? error.message : error);
      this.broken = true;
      return null;
    }
  }

  private request(key: string, css: string, candidates: string[]): Promise<string[]> {
    const worker = this.getWorker();
    if (!worker) return Promise.resolve(candidates);
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, key, css, candidates });
    });
  }

  async canonicalizerFor(tokens: readonly TokenRecord[]): Promise<Canonicalize | undefined> {
    if (!this.getWorker()) return undefined;
    const key = tokens.length ? tokensContentHash(tokens) : 'default';
    const css = themeCss(tokens);
    return (candidates) => this.request(key, css, candidates).catch(() => candidates);
  }

  /** Build the default design system in the background so the first get_jsx is fast. */
  warmup(): void {
    void this.request('default', themeCss([]), ['[display:flex]', '[padding:16px]']).catch(() => {});
  }

  close(): void {
    void this.worker?.terminate();
    this.worker = null;
  }
}
