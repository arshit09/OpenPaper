import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { tokenCssName, tokensContentHash, type TokenRecord } from '@openpaper/core';

type Canonicalize = (candidates: string[]) => Promise<string[]>;

/** How long the worker stays up after the last Tailwind export (a burst of get_jsx calls shares it). */
const IDLE_STOP_MS = 3 * 60_000;

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
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly idleStopMs = IDLE_STOP_MS) {}

  /** Whether the worker is running (tests). */
  get running(): boolean {
    return this.worker !== null;
  }

  /**
   * The worker starts on the first Tailwind export, not at boot, and stops once exports pause: with
   * Tailwind and its design systems loaded it holds ~200 MB, most of the server's memory otherwise.
   */
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
        if (!this.pending.size) this.scheduleIdleStop();
      });
      worker.on('error', (error) => {
        console.warn('[openpaper] Tailwind worker failed:', error.message);
        this.forget(worker, error);
      });
      // Exiting without an error (out of memory, terminated) must not leave requests waiting forever.
      worker.on('exit', () => this.forget(worker, new Error('The Tailwind worker stopped.')));
      this.worker = worker;
      return worker;
    } catch (error) {
      console.warn('[openpaper] Tailwind engine unavailable, emitting arbitrary properties:', error instanceof Error ? error.message : error);
      this.broken = true;
      return null;
    }
  }

  private forget(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.pending.size) this.stopWorker();
    }, this.idleStopMs);
    this.idleTimer.unref();
  }

  private stopWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.forget(worker, new Error('The Tailwind worker was stopped.'));
    void worker.terminate();
  }

  private request(key: string, css: string, candidates: string[]): Promise<string[]> {
    const worker = this.getWorker();
    if (!worker) return Promise.resolve(candidates);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, key, css, candidates });
    });
  }

  async canonicalizerFor(tokens: readonly TokenRecord[]): Promise<Canonicalize | undefined> {
    if (!this.getWorker()) return undefined;
    // Started (or kept) for this export: it still stops if no request follows.
    if (!this.pending.size) this.scheduleIdleStop();
    const key = tokens.length ? tokensContentHash(tokens) : 'default';
    const css = themeCss(tokens);
    return (candidates) => this.request(key, css, candidates).catch(() => candidates);
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopWorker();
  }
}
