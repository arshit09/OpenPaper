// Pure audio helpers for voice input (no browser APIs, so they're unit-tested).

/** The speech engine's input rate: mono 16 kHz. */
export const SPEECH_RATE = 16_000;

/** Block-average down to 16 kHz (enough low-pass for speech). */
export function resample(input: Float32Array, from: number, to = SPEECH_RATE): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / (end - start);
  }
  return out;
}

/** 16-bit little-endian PCM, base64 (what `speech.transcribe` takes). */
export function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Loud enough to be worth transcribing (skips accidental clicks and silence). */
export function hasSpeech(samples: Float32Array): boolean {
  if (samples.length < SPEECH_RATE * 0.3) return false;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
  return peak > 0.02;
}
