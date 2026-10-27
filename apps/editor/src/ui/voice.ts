import type { SpeechStatus } from '@openpaper/core';
import { setState } from '../state/store.ts';
import { client } from '../sync/session.ts';
import { encodePcm16, resample, SPEECH_RATE } from './audio.ts';

export { hasSpeech, SPEECH_RATE } from './audio.ts';

/** Stop a little before the server's 120 s limit (the last chunk overshoots). */
const MAX_SECONDS = 115;

// Copies mic frames off the audio thread (the default output stays silent).
const TAP = `class OpTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('op-tap', OpTap);`;

export interface Recording {
  /** Recent input level, 0–1 (for the meter). */
  level(): number;
  /** Seconds recorded so far. */
  seconds(): number;
  /** Stop and return the audio as mono 16 kHz samples. */
  stop(): Promise<Float32Array>;
  cancel(): void;
}

async function openContext(stream: MediaStream): Promise<{ ctx: AudioContext; source: MediaStreamAudioSourceNode }> {
  // Ask for 16 kHz so the browser resamples; Firefox can't mix rates with a mic source, so fall back.
  try {
    const ctx = new AudioContext({ sampleRate: SPEECH_RATE });
    try {
      return { ctx, source: ctx.createMediaStreamSource(stream) };
    } catch {
      void ctx.close();
    }
  } catch {
    // Unsupported rate: use the device rate.
  }
  const ctx = new AudioContext();
  return { ctx, source: ctx.createMediaStreamSource(stream) };
}

/** Start capturing the microphone. `onLimit` fires once when the recording hits its length limit. */
export async function startRecording(onLimit?: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx: AudioContext | null = null;
  try {
    const opened = await openContext(stream);
    ctx = opened.ctx;
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const tap = new AudioWorkletNode(ctx, 'op-tap');
    const rate = ctx.sampleRate;
    const chunks: Float32Array[] = [];
    let length = 0;
    let level = 0;
    let limited = false;
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const chunk = e.data;
      chunks.push(chunk);
      length += chunk.length;
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
      // RMS of speech sits around 0.02–0.2; stretch it to fill the meter, and let it fall slowly.
      level = Math.max(Math.min(1, Math.sqrt(sum / chunk.length) * 6), level * 0.9);
      if (!limited && length >= MAX_SECONDS * rate) {
        limited = true;
        onLimit?.();
      }
    };
    opened.source.connect(tap);
    tap.connect(ctx.destination);
    const context = ctx;
    const release = () => {
      tap.port.onmessage = null;
      opened.source.disconnect();
      tap.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    };
    return {
      level: () => level,
      seconds: () => length / rate,
      async stop() {
        release();
        const all = new Float32Array(length);
        let offset = 0;
        for (const c of chunks) {
          all.set(c, offset);
          offset += c.length;
        }
        return resample(all, rate);
      },
      cancel: release,
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    void ctx?.close();
    throw error;
  }
}

export async function transcribe(samples: Float32Array): Promise<string> {
  const { text } = await client.request<{ text: string }>('speech.transcribe', { audio: encodePcm16(samples), sampleRate: SPEECH_RATE });
  return text.trim();
}

export async function refreshSpeechStatus(): Promise<SpeechStatus> {
  const status = await client.request<SpeechStatus>('speech.status');
  setState({ speech: status });
  return status;
}

/** Load the model while the user is still talking (it takes a few seconds the first time). */
export function preloadSpeech(): void {
  client.notify('speech.preload', {});
}

/** Start the one-time model download (progress arrives as `speech` pushes). */
export async function installSpeech(): Promise<void> {
  await client.request('speech.install');
}
