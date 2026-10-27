import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_RATE, SILENCE_RMS, cleanTranscript, loudestFrameRms, normalize, resample } from '../src/speech/audio.ts';
import { downloadFile, partPath } from '../src/speech/download.ts';
import { PARAKEET_TDT_V2, type SpeechModel } from '../src/speech/model.ts';
import { SpeechService, type SpeechStatus } from '../src/speech/service.ts';

const tone = (freq: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

const rms = (s: Float32Array, from = 0, to = s.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += s[i]! * s[i]!;
  return Math.sqrt(e / (to - from));
};

/** Upward zero crossings per second over the middle of the signal (away from edge effects). */
function frequency(s: Float32Array, rate: number): number {
  const from = Math.floor(s.length * 0.1);
  const to = Math.floor(s.length * 0.9);
  let n = 0;
  for (let i = from + 1; i < to; i++) if (s[i - 1]! < 0 && s[i]! >= 0) n++;
  return (n * rate) / (to - from);
}

describe('speech audio helpers', () => {
  it('resamples to the model rate keeping pitch, level and length', () => {
    for (const rate of [48_000, 44_100, 22_050, 8_000]) {
      const out = resample(tone(440, rate, 1), rate, MODEL_RATE);
      expect(out.length).toBe(MODEL_RATE);
      expect(frequency(out, MODEL_RATE)).toBeCloseTo(440, -1);
      expect(rms(out, 1600, 14_400)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    }
    const same = tone(440, MODEL_RATE, 0.1);
    expect(resample(same, MODEL_RATE, MODEL_RATE)).toBe(same);
  });

  it('filters out content above the new Nyquist instead of aliasing it', () => {
    // 12 kHz would fold down to 4 kHz at 16 kHz without the low-pass.
    const out = resample(tone(12_000, 48_000, 0.5), 48_000, MODEL_RATE);
    expect(rms(out, 800, 7200)).toBeLessThan(0.005);
  });

  it('detects silence and quiet noise but not speech-level sound', () => {
    expect(loudestFrameRms(new Float32Array(MODEL_RATE), MODEL_RATE)).toBe(0);
    const hiss = Float32Array.from({ length: MODEL_RATE }, () => (Math.random() * 2 - 1) * 0.002);
    expect(loudestFrameRms(hiss, MODEL_RATE)).toBeLessThan(SILENCE_RMS);
    const voice = new Float32Array(MODEL_RATE * 2);
    voice.set(tone(200, MODEL_RATE, 0.3, 0.05), MODEL_RATE); // one short, quiet word in two seconds
    expect(loudestFrameRms(voice, MODEL_RATE)).toBeGreaterThan(SILENCE_RMS);
  });

  it('normalizes to a 0.9 peak without DC offset', () => {
    const quiet = tone(300, MODEL_RATE, 0.5, 0.01).map((x) => x + 0.2);
    const out = normalize(quiet);
    expect(Math.max(...out.map(Math.abs))).toBeCloseTo(0.9, 3);
    expect(out.reduce((a, b) => a + b, 0) / out.length).toBeCloseTo(0, 3);
    expect([...normalize(new Float32Array(4))]).toEqual([0, 0, 0, 0]);
  });

  it('cleans transcripts', () => {
    expect(cleanTranscript('  Make this card\n darker ,  and add a   soft shadow . ')).toBe('Make this card darker, and add a soft shadow.');
    expect(cleanTranscript('Build faster with open paper and Open Paper.')).toBe('Build faster with OpenPaper and OpenPaper.');
    expect(cleanTranscript(' . ')).toBe('');
    expect(cleanTranscript('')).toBe('');
  });
});

describe('speech model manifest', () => {
  it('pins every file to a revision with its size and hash', () => {
    const names = PARAKEET_TDT_V2.files.map((f) => f.name);
    expect(names.sort()).toEqual(['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']);
    for (const f of PARAKEET_TDT_V2.files) {
      expect(f.url).toMatch(/^https:\/\/[^/]+\/csukuangfj\/sherpa-onnx-nemo-parakeet-tdt-0\.6b-v2-int8\/resolve\/[0-9a-f]{40}\//);
      expect(f.url.endsWith(`/${f.name}`)).toBe(true);
      expect(f.size).toBeGreaterThan(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const total = PARAKEET_TDT_V2.files.reduce((a, f) => a + f.size, 0);
    expect(total).toBeGreaterThan(600e6);
    expect(total).toBeLessThan(700e6);
  });
});

// A local file server with Range support (and switches to misbehave), standing in for Hugging Face.
const blobs = new Map<string, Buffer>();
const requests: Array<{ path: string; range?: string }> = [];
const quirks = { ignoreRange: false, dropAfter: 0, failStatus: 0 };
let server: Server;
let base: string;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-speech-test-'));
  server = createServer((req, res) => {
    const path = req.url!;
    requests.push({ path, range: req.headers.range });
    const blob = blobs.get(path);
    if (quirks.failStatus) return void res.writeHead(quirks.failStatus).end();
    if (!blob) return void res.writeHead(404).end();
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const start = m && !quirks.ignoreRange ? Number(m[1]) : 0;
    const body = blob.subarray(start);
    res.writeHead(start ? 206 : 200, {
      'content-length': body.length,
      ...(start ? { 'content-range': `bytes ${start}-${blob.length - 1}/${blob.length}` } : {}),
    });
    if (quirks.dropAfter) {
      // Send part of the body, then kill the connection mid-download.
      res.write(body.subarray(0, quirks.dropAfter));
      quirks.dropAfter = 0;
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

/** Serve deterministic bytes at `/<path>`; the result doubles as a model file entry. */
function serve(path: string, size: number) {
  const data = Buffer.alloc(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;
  blobs.set(`/${path}`, data);
  return { name: path.split('/').pop()!, url: `${base}/${path}`, size, sha256: createHash('sha256').update(data).digest('hex'), data };
}

const reset = () => {
  requests.length = 0;
  Object.assign(quirks, { ignoreRange: false, dropAfter: 0, failStatus: 0 });
};

describe('model download', () => {
  it('downloads atomically and verifies the hash', async () => {
    reset();
    const f = serve('a.bin', 300_000);
    const dest = join(home, 'dl', 'a.bin');
    await mkdir(join(home, 'dl'), { recursive: true });
    const seen: number[] = [];
    await downloadFile(f.url, dest, f, (b) => seen.push(b));
    expect((await readFile(dest)).equals(f.data)).toBe(true);
    expect(existsSync(partPath(dest))).toBe(false);
    expect(seen.at(-1)).toBe(f.size);
  });

  it('resumes a partial file with a Range request', async () => {
    reset();
    const f = serve('b.bin', 200_000);
    const dest = join(home, 'dl', 'b.bin');
    await writeFile(partPath(dest), f.data.subarray(0, 123_456));
    await downloadFile(f.url, dest, f, () => {});
    expect(requests).toEqual([{ path: '/b.bin', range: 'bytes=123456-' }]);
    expect((await readFile(dest)).equals(f.data)).toBe(true);
  });

  it('restarts when the server ignores the range', async () => {
    reset();
    quirks.ignoreRange = true;
    const f = serve('c.bin', 100_000);
    const dest = join(home, 'dl', 'c.bin');
    await writeFile(partPath(dest), f.data.subarray(0, 50_000));
    await downloadFile(f.url, dest, f, () => {});
    expect((await readFile(dest)).equals(f.data)).toBe(true);
  });

  it('picks up where a dropped connection stopped', async () => {
    reset();
    quirks.dropAfter = 64 * 1024;
    const f = serve('d.bin', 500_000);
    const dest = join(home, 'dl', 'd.bin');
    await downloadFile(f.url, dest, f, () => {});
    expect((await readFile(dest)).equals(f.data)).toBe(true);
    expect(requests.length).toBe(2);
    expect(requests[1]!.range).toMatch(/^bytes=[1-9]\d*-$/);
  });

  it('rejects a corrupt download and leaves nothing behind', async () => {
    reset();
    const f = serve('e.bin', 10_000);
    const dest = join(home, 'dl', 'e.bin');
    await expect(downloadFile(f.url, dest, { size: f.size, sha256: '0'.repeat(64) }, () => {})).rejects.toThrow(/corrupt/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(partPath(dest))).toBe(false);
  });

  it('does not retry a missing file', async () => {
    reset();
    const dest = join(home, 'dl', 'missing.bin');
    await expect(downloadFile(`${base}/missing.bin`, dest, { size: 1, sha256: '0'.repeat(64) }, () => {})).rejects.toThrow(/HTTP 404/);
    expect(requests.length).toBe(1);
  });
});

describe('SpeechService', () => {
  const fakeModel = (id: string): SpeechModel => ({
    id,
    label: 'Test model',
    files: [serve(`${id}/big.onnx`, 400_000), serve(`${id}/tokens.txt`, 1000)].map(({ data: _data, ...f }) => f),
  });
  /** Stands in for sherpa-onnx; recognition must never be reached in these tests. */
  const fakeEngine = async () =>
    ({
      version: 'test',
      OfflineRecognizer: {
        createAsync: () => Promise.reject(new Error('the model should not load')),
      },
    }) as never;

  it('reports not-installed for an empty models dir', () => {
    const status = new SpeechService({ dir: join(home, 'empty') }).status();
    // This dev install has the native engine; without it the state is 'unavailable'.
    expect(status).toEqual({ engine: 'Parakeet TDT 0.6B v2', state: 'not-installed', sizeBytes: expect.any(Number), downloadedBytes: 0 });
    expect(status.sizeBytes).toBe(PARAKEET_TDT_V2.files.reduce((a, f) => a + f.size, 0));
  });

  it('installs once for concurrent callers, reporting progress, then is ready', async () => {
    reset();
    const model = fakeModel('m1');
    const statuses: SpeechStatus[] = [];
    const speech = new SpeechService({ dir: join(home, 'models'), model, loadEngine: fakeEngine, onStatus: (s) => statuses.push(s) });
    expect(speech.status().state).toBe('not-installed');
    await Promise.all([speech.install(), speech.install(), speech.install()]);
    expect(requests.map((r) => r.path)).toEqual(['/m1/big.onnx', '/m1/tokens.txt']);
    expect(statuses[0]!.state).toBe('downloading');
    expect(statuses.at(-1)).toEqual({ engine: 'Test model', state: 'ready', sizeBytes: 401_000, downloadedBytes: 401_000 });
    // Already installed: no more requests, and a fresh service sees it too.
    await speech.install();
    expect(requests.length).toBe(2);
    expect(new SpeechService({ dir: join(home, 'models'), model, loadEngine: fakeEngine }).status().state).toBe('ready');
  });

  it('counts a partial download and resumes it after a failure', async () => {
    reset();
    const model = fakeModel('m2');
    const dir = join(home, 'models');
    await mkdir(join(dir, 'm2'), { recursive: true });
    await writeFile(partPath(join(dir, 'm2', 'big.onnx')), blobs.get('/m2/big.onnx')!.subarray(0, 100_000));
    const speech = new SpeechService({ dir, model, loadEngine: fakeEngine });
    expect(speech.status().downloadedBytes).toBe(100_000);
    // 503 is retried with backoff before giving up; keep the test fast by failing permanently instead.
    quirks.failStatus = 403;
    await expect(speech.install()).rejects.toThrow(/HTTP 403/);
    expect(speech.status()).toMatchObject({ state: 'error', downloadedBytes: 100_000, error: expect.stringMatching(/HTTP 403/) });
    quirks.failStatus = 0;
    await speech.install();
    expect(speech.status().state).toBe('ready');
    expect(requests.find((r) => r.path === '/m2/big.onnx' && r.range)?.range).toBe('bytes=100000-');
  });

  it('is unavailable, without downloading, when the engine cannot load', async () => {
    reset();
    const speech = new SpeechService({ dir: join(home, 'models'), model: fakeModel('m3'), loadEngine: () => Promise.reject(new Error('no addon\nmore detail')) });
    await expect(speech.install()).rejects.toThrow('The speech engine failed to load: no addon');
    expect(speech.status()).toMatchObject({ state: 'unavailable', error: 'The speech engine failed to load: no addon' });
    expect(requests.length).toBe(0);
    await expect(speech.transcribe(new Float32Array(16_000), 16_000)).rejects.toThrow(/failed to load/);
  });

  it('refuses to transcribe before install, and skips silence without loading the model', async () => {
    const dir = join(home, 'models');
    const missing = new SpeechService({ dir, model: fakeModel('m4'), loadEngine: fakeEngine });
    await expect(missing.transcribe(new Float32Array(16_000), 16_000)).rejects.toThrow(/not installed/);
    // m1 was installed above; the fake engine fails if recognition is attempted.
    const speech = new SpeechService({ dir, model: fakeModel('m1'), loadEngine: fakeEngine });
    const hiss = Float32Array.from({ length: 48_000 * 2 }, () => (Math.random() * 2 - 1) * 0.001);
    expect(await speech.transcribe(hiss, 48_000)).toEqual({ text: '', durationMs: 2000, elapsedMs: 0 });
    await expect(speech.transcribe(new Float32Array(16_000 * 121), 16_000)).rejects.toThrow(/limited to 120 seconds/);
    speech.close();
  });
});
