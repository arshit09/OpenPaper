import { describe, expect, it } from 'vitest';
import { TailwindService } from '../src/tailwind.ts';

const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  return check();
};

describe('Tailwind canonicalizer', () => {
  it('starts its worker on the first export, stops it once exports pause, and starts it again', async () => {
    const tailwind = new TailwindService(100);
    expect(tailwind.running).toBe(false);
    const first = await tailwind.canonicalizerFor([]);
    expect(await first!(['[display:flex]', '[padding:16px]'])).toEqual(['flex', 'p-4']);
    expect(await until(() => !tailwind.running)).toBe(true);
    const again = await tailwind.canonicalizerFor([]);
    expect(await again!(['[display:flex]'])).toEqual(['flex']);
    tailwind.close();
    expect(tailwind.running).toBe(false);
  }, 60_000);

  it('stops a worker started for an export that never asks for anything', async () => {
    const tailwind = new TailwindService(100);
    await tailwind.canonicalizerFor([]);
    expect(tailwind.running).toBe(true);
    expect(await until(() => !tailwind.running)).toBe(true);
  });

  it('gives back the candidates unchanged if the worker is stopped mid-request', async () => {
    const tailwind = new TailwindService();
    const canonicalize = await tailwind.canonicalizerFor([]);
    const pending = canonicalize!(['[display:flex]']);
    tailwind.close();
    expect(await pending).toEqual(['[display:flex]']);
  });
});
