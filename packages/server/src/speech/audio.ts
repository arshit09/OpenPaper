/** Audio preparation and transcript cleanup for the speech engine (pure, so it's testable without the model). */

export const MODEL_RATE = 16_000;
/** Loudest 30 ms frame below this RMS (≈ -46 dBFS) is treated as silence: no speech worth decoding. */
export const SILENCE_RMS = 0.005;

const ZERO_CROSSINGS = 8;
const TABLE_RES = 256;

/** Band-limited (windowed-sinc) resampling of mono PCM, anti-aliased when downsampling. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const step = from / to; // input samples per output sample
  const cutoff = Math.min(1, to / from) * 0.95; // of the input Nyquist
  const reach = ZERO_CROSSINGS / cutoff; // kernel half-width in input samples
  // Blackman-windowed sinc, tabulated over [0, ZERO_CROSSINGS] zero crossings.
  const table = new Float32Array(ZERO_CROSSINGS * TABLE_RES + 2);
  for (let i = 0; i < table.length; i++) {
    const u = i / TABLE_RES;
    const w = u >= ZERO_CROSSINGS ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * u) / ZERO_CROSSINGS) + 0.08 * Math.cos((2 * Math.PI * u) / ZERO_CROSSINGS);
    table[i] = (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w;
  }
  const out = new Float32Array(Math.round((input.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const t = i * step;
    const first = Math.max(0, Math.ceil(t - reach));
    const last = Math.min(input.length - 1, Math.floor(t + reach));
    let sum = 0;
    let weights = 0;
    for (let j = first; j <= last; j++) {
      const x = Math.abs(t - j) * cutoff * TABLE_RES;
      const k = x | 0;
      const w = table[k]! + (table[k + 1]! - table[k]!) * (x - k);
      sum += input[j]! * w;
      weights += w;
    }
    // Normalizing by the summed weights keeps unity gain, including at the edges.
    out[i] = weights > 0 ? sum / weights : 0;
  }
  return out;
}

/** RMS of the loudest 30 ms frame. */
export function loudestFrameRms(samples: Float32Array, rate: number): number {
  const frame = Math.max(1, Math.round(rate * 0.03));
  let loudest = 0;
  for (let start = 0; start < samples.length; start += frame) {
    const end = Math.min(samples.length, start + frame);
    let energy = 0;
    for (let i = start; i < end; i++) energy += samples[i]! * samples[i]!;
    loudest = Math.max(loudest, Math.sqrt(energy / (end - start)));
  }
  return loudest;
}

/**
 * Remove DC offset and scale to a 0.9 peak. Very quiet input otherwise sinks into the feature extractor's
 * log floor, where the model starts inventing words.
 */
export function normalize(samples: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i]!;
  mean /= samples.length || 1;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]! - mean));
  const gain = peak > 0 ? 0.9 / peak : 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i]! - mean) * gain;
  return out;
}

/** Tidy model output for the prompt field: one line, single spaces, nothing for punctuation-only results. */
export function cleanTranscript(text: string): string {
  const t = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    // The model hears the product's name as two words.
    .replace(/\bopen ?paper\b/gi, 'OpenPaper')
    .trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}
