import { describe, expect, it } from 'vitest';
import { findFreeSpot, type Box } from './placement.ts';

/** The search as it was before it narrowed the layers it checks: the results must not change. */
function reference(obstacles: Box[], w: number, h: number, vp: Box, p = 80): { x: number; y: number } | null {
  const intersects = (a: Box, b: Box) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  const free = (x: number, y: number) => !obstacles.some((o) => intersects({ minX: x - p, minY: y - p, maxX: x + w + p, maxY: y + h + p }, o));
  const inset = { minX: vp.minX + p, minY: vp.minY + p, maxX: vp.maxX - p, maxY: vp.maxY - p };
  if (w > inset.maxX - inset.minX || h > inset.maxY - inset.minY || !obstacles.some((o) => intersects(o, vp))) return null;
  const xs = [inset.minX, ...obstacles.map((o) => o.minX), ...obstacles.map((o) => o.maxX + p)].filter((x) => x >= inset.minX && x + w <= inset.maxX);
  const ys = [inset.minY, ...obstacles.map((o) => o.minY), ...obstacles.map((o) => o.maxY + p)].filter((y) => y >= inset.minY && y + h <= inset.maxY);
  for (const y of [...new Set(ys)].sort((m, n) => m - n)) for (const x of [...new Set(xs)].sort((m, n) => m - n)) if (free(x, y)) return { x: Math.round(x), y: Math.round(y) };
  return null;
}

/** A deterministic pseudo-random sequence. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('findFreeSpot', () => {
  it('finds the same spot in view as the full search, on many random pages', () => {
    const rand = random(7);
    let compared = 0;
    for (let round = 0; round < 400; round++) {
      const obstacles: Box[] = [];
      const count = Math.floor(rand() * 40);
      for (let i = 0; i < count; i++) {
        const x = Math.round(rand() * 4000 - 1000);
        const y = Math.round(rand() * 3000 - 800);
        obstacles.push({ minX: x, minY: y, maxX: x + 50 + Math.round(rand() * 600), maxY: y + 50 + Math.round(rand() * 500) });
      }
      const vp = { minX: 0, minY: 0, maxX: 1600 + Math.round(rand() * 800), maxY: 1000 + Math.round(rand() * 600) };
      const w = 100 + Math.round(rand() * 500);
      const h = 100 + Math.round(rand() * 400);
      const expected = reference(obstacles, w, h, vp);
      if (!expected) continue;
      compared++;
      expect(findFreeSpot(obstacles, w, h, { viewport: vp })).toEqual(expected);
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('stays quick with hundreds of layers in view', () => {
    // A zoomed-out grid of 400 artboards filling the view, no hole big enough.
    const obstacles: Box[] = [];
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) obstacles.push({ minX: c * 500, minY: r * 400, maxX: c * 500 + 420, maxY: r * 400 + 320 });
    const started = performance.now();
    findFreeSpot(obstacles, 400, 300, { viewport: { minX: 0, minY: 0, maxX: 10_000, maxY: 8000 } });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
