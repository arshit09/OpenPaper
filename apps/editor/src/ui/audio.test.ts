import { describe, expect, it } from 'vitest';
import { encodePcm16, hasSpeech, resample, SPEECH_RATE } from './audio.ts';

describe('voice audio helpers', () => {
  it('downsamples 48 kHz to 16 kHz by averaging blocks', () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? 0.3 : 0));
    const out = resample(input, 48_000);
    expect(out).toHaveLength(16);
    expect(out[0]).toBeCloseTo(0.1);
    expect(resample(input, SPEECH_RATE)).toBe(input);
  });

  it('handles rates that are not a whole multiple', () => {
    const out = resample(new Float32Array(44_100).fill(0.5), 44_100);
    expect(out).toHaveLength(16_000);
    expect(out.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });

  it('encodes little-endian 16-bit PCM as base64, clipping out-of-range samples', () => {
    const bytes = Uint8Array.from(atob(encodePcm16(Float32Array.from([0, 1, -1, 2, 0.5]))), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true))).toEqual([0, 32767, -32768, 32767, 16383]);
  });

  it('skips clicks and silence', () => {
    expect(hasSpeech(new Float32Array(SPEECH_RATE * 2))).toBe(false);
    expect(hasSpeech(new Float32Array(SPEECH_RATE * 0.1).fill(0.5))).toBe(false);
    const talk = new Float32Array(SPEECH_RATE);
    talk[4000] = 0.2;
    expect(hasSpeech(talk)).toBe(true);
  });
});
