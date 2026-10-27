import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { SpeechState, SpeechStatus } from '@openpaper/core';
import type sherpa from 'sherpa-onnx-node';
import { MODEL_RATE, SILENCE_RMS, cleanTranscript, loudestFrameRms, normalize, resample } from './audio.ts';
import { downloadFile, partPath } from './download.ts';
import { PARAKEET_TDT_V2, recognizerConfig, type SpeechModel } from './model.ts';

/**
 * Local speech-to-text for dictating prompts to the built-in agent. Runs NVIDIA Parakeet on the CPU through
 * sherpa-onnx (an optional native dependency); the model is a one-time ~660 MB download into the models dir.
 * Nothing leaves the machine.
 */

// The status is part of the editor protocol (`downloadedBytes` includes partial files an interrupted download left).
export type { SpeechState, SpeechStatus } from '@openpaper/core';

export interface Transcript {
  text: string;
  /** Length of the audio. */
  durationMs: number;
  /** Time spent recognizing it (0 when it was skipped as silence). */
  elapsedMs: number;
}

export interface SpeechServiceOptions {
  /** Models dir, e.g. ~/.openpaper/models (the model gets its own folder inside). */
  dir: string;
  onStatus?: (status: SpeechStatus) => void;
  /** Overrides for tests. */
  model?: SpeechModel;
  loadEngine?: () => Promise<Engine>;
}

type Engine = typeof sherpa;
type Recognizer = Awaited<ReturnType<Engine['OfflineRecognizer']['createAsync']>>;

/** Longest recording accepted; dictated prompts are far shorter. */
export const MAX_AUDIO_SECONDS = 120;
const IDLE_UNLOAD_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 200;

const nativeTarget = () => `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const SUPPORTED = ['win-x64', 'win-arm64', 'win-ia32', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

/** Why the native engine can't load here, checked without loading it; null when it looks installed. */
function engineMissing(): string | null {
  const target = nativeTarget();
  if (!SUPPORTED.includes(target)) return `Voice input isn't available on this platform (${target}).`;
  try {
    const main = createRequire(import.meta.url).resolve('sherpa-onnx-node');
    createRequire(main).resolve(`sherpa-onnx-${target}/package.json`);
    return null;
  } catch {
    return "The speech engine (sherpa-onnx-node) isn't installed. Reinstall OpenPaper with optional dependencies enabled.";
  }
}

async function importEngine(): Promise<Engine> {
  const mod = (await import('sherpa-onnx-node')) as { default?: Engine };
  return mod.default ?? (mod as unknown as Engine);
}

/** Full GC, so an unloaded model's native memory is returned now instead of at V8's next major collection. */
function collectGarbage() {
  try {
    const exposed = typeof globalThis.gc === 'function';
    if (!exposed) setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    if (!exposed) setFlagsFromString('--no-expose-gc');
    gc();
  } catch {
    // Best effort.
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SpeechService {
  private readonly model: SpeechModel;
  private readonly modelDir: string;
  private readonly sizeBytes: number;
  private state: SpeechState;
  private error: string | undefined;
  private downloadedBytes = 0;
  private engine: Promise<Engine> | null = null;
  private recognizer: Promise<Recognizer> | null = null;
  private installing: Promise<void> | null = null;
  /** Recognitions run one at a time; parallel ones would only fight over the same cores. */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastProgress = 0;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(private readonly opts: SpeechServiceOptions) {
    this.model = opts.model ?? PARAKEET_TDT_V2;
    this.modelDir = join(opts.dir, this.model.id);
    this.sizeBytes = this.model.files.reduce((sum, f) => sum + f.size, 0);
    const missing = opts.loadEngine ? null : engineMissing();
    this.state = missing ? 'unavailable' : this.installed() ? 'ready' : 'not-installed';
    this.error = missing ?? undefined;
    this.downloadedBytes = this.bytesOnDisk();
  }

  status(): SpeechStatus {
    const status: SpeechStatus = { engine: this.model.label, state: this.state, sizeBytes: this.sizeBytes, downloadedBytes: this.downloadedBytes };
    if (this.error) status.error = this.error;
    return status;
  }

  /** Download the model (once; concurrent calls share the download). Rejects, with the status saying why, on failure. */
  install(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Speech service is closed.'));
    if (this.state === 'unavailable') return Promise.reject(new Error(this.error));
    if (this.installing) return this.installing;
    if (this.installed()) {
      if (this.state === 'not-installed' || this.state === 'error') this.set('ready');
      return Promise.resolve();
    }
    this.installing = this.download().finally(() => (this.installing = null));
    return this.installing;
  }

  /** Load the model ahead of `transcribe` (e.g. when recording starts), so the first result isn't delayed by it. */
  async preload(): Promise<void> {
    if (this.closed || this.state === 'unavailable' || !this.installed()) return;
    await this.run(async () => void (await this.load())).catch(() => {});
  }

  /** Transcribe mono PCM in [-1, 1] at any sample rate. Silent audio gives empty text. */
  async transcribe(samples: Float32Array, sampleRate: number): Promise<Transcript> {
    if (this.closed) throw new Error('Speech service is closed.');
    if (!(sampleRate >= 1000 && sampleRate <= 384_000)) throw new Error(`Unsupported sample rate: ${sampleRate}`);
    const durationMs = Math.round((samples.length / sampleRate) * 1000);
    if (durationMs > MAX_AUDIO_SECONDS * 1000) throw new Error(`Recordings are limited to ${MAX_AUDIO_SECONDS} seconds.`);
    if (this.state === 'unavailable') throw new Error(this.error);
    if (!this.installed()) {
      if (this.state === 'ready') this.set('not-installed');
      throw new Error('The speech model is not installed.');
    }
    const audio = resample(samples, sampleRate, MODEL_RATE);
    if (loudestFrameRms(audio, MODEL_RATE) < SILENCE_RMS) return { text: '', durationMs, elapsedMs: 0 };
    return this.run(async () => {
      const recognizer = await this.load();
      const started = performance.now();
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: normalize(audio), sampleRate: MODEL_RATE });
      const result = await recognizer.decodeAsync(stream);
      return { text: cleanTranscript(result.text), durationMs, elapsedMs: Math.round(performance.now() - started) };
    });
  }

  /** Stop any download and release the model. */
  close(): void {
    this.closed = true;
    this.abort.abort();
    this.unload();
  }

  private async download(): Promise<void> {
    // Make sure the engine runs here before spending ~660 MB of bandwidth.
    await this.loadEngine();
    this.set('downloading');
    const done = new Map<string, number>();
    const report = (name: string, bytes: number) => {
      done.set(name, bytes);
      this.progress([...done.values()].reduce((a, b) => a + b, 0));
    };
    try {
      await mkdir(this.modelDir, { recursive: true });
      for (const file of this.model.files) {
        const dest = join(this.modelDir, file.name);
        if (sizeOf(dest) === file.size) report(file.name, file.size);
        else await downloadFile(file.url, dest, file, (bytes) => report(file.name, bytes), this.abort.signal);
      }
      this.downloadedBytes = this.sizeBytes;
      this.set('ready');
    } catch (error) {
      this.downloadedBytes = this.bytesOnDisk();
      this.set('error', this.closed ? 'Download cancelled.' : `Couldn't download the speech model: ${message(error)}`);
      throw error;
    }
  }

  private loadEngine(): Promise<Engine> {
    this.engine ??= (this.opts.loadEngine ?? importEngine)().catch((error: unknown) => {
      this.set('unavailable', `The speech engine failed to load: ${message(error).split('\n')[0]}`);
      throw new Error(this.error, { cause: error });
    });
    return this.engine;
  }

  private load(): Promise<Recognizer> {
    if (!this.recognizer) {
      this.set('loading');
      this.recognizer = this.loadEngine()
        .then((engine) => engine.OfflineRecognizer.createAsync(recognizerConfig(this.modelDir)))
        .then(
          (recognizer) => {
            this.set('ready');
            return recognizer;
          },
          (error: unknown) => {
            this.recognizer = null;
            if (this.state !== 'unavailable') this.set('error', `Couldn't load the speech model: ${message(error)}`);
            throw error;
          }
        );
    }
    return this.recognizer;
  }

  /** Queue `task` behind other recognitions; the model unloads after a quiet spell. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      return task();
    });
    this.queue = next.catch(() => {}).finally(() => {
      if (this.closed) return;
      this.idleTimer = setTimeout(() => this.unload(), IDLE_UNLOAD_MS);
      this.idleTimer.unref();
    });
    return next;
  }

  private unload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.recognizer) return;
    // A recognition in flight keeps its own reference until it finishes.
    this.recognizer = null;
    setImmediate(collectGarbage);
  }

  private installed(): boolean {
    return this.model.files.every((f) => sizeOf(join(this.modelDir, f.name)) === f.size);
  }

  private bytesOnDisk(): number {
    return this.model.files.reduce((sum, f) => {
      const dest = join(this.modelDir, f.name);
      return sum + (sizeOf(dest) === f.size ? f.size : Math.min(f.size, Math.max(0, sizeOf(partPath(dest)))));
    }, 0);
  }

  private set(state: SpeechState, error?: string) {
    this.state = state;
    this.error = error;
    this.opts.onStatus?.(this.status());
  }

  private progress(bytes: number) {
    this.downloadedBytes = bytes;
    const now = Date.now();
    if (now - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = now;
    this.opts.onStatus?.(this.status());
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}
