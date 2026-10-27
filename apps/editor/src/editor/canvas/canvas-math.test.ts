import { describe, expect, it } from 'vitest';
import { fitCamera, inferFlex, lockAxis, measureBoxes, nextZoomLevel, opacityFromDigits, readingOrder } from './canvas-math.ts';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const values = (m: ReturnType<typeof measureBoxes>) => m.distances.map((d) => `${d.axis}${Math.round(d.value)}`).sort();

describe('measureBoxes', () => {
  it('measures the four insets to a containing frame', () => {
    const m = measureBoxes(box(20, 30, 100, 50), box(0, 0, 400, 300));
    expect(values(m)).toEqual(['x20', 'x280', 'y220', 'y30']);
    const left = m.distances.find((d) => d.axis === 'x' && d.x1 === 0)!;
    expect(left).toMatchObject({ x2: 20, y1: 55, y2: 55 });
  });
  it('measures from a contained child to the selection', () => {
    expect(values(measureBoxes(box(0, 0, 100, 100), box(10, 10, 20, 20)))).toEqual(['x10', 'x70', 'y10', 'y70']);
  });
  it('shows only the gap for boxes stacked vertically', () => {
    const m = measureBoxes(box(0, 0, 100, 40), box(20, 64, 100, 40));
    expect(values(m)).toEqual(['y24']);
    expect(m.distances[0]).toMatchObject({ x1: 60, y1: 40, y2: 64 });
    expect(m.guides).toEqual([]);
  });
  it('measures both gaps with guides for diagonal boxes', () => {
    const m = measureBoxes(box(0, 0, 50, 50), box(100, 80, 40, 40));
    expect(values(m)).toEqual(['x50', 'y30']);
    expect(m.guides).toHaveLength(2);
    expect(m.guides[0]).toEqual({ x1: 100, y1: 25, x2: 100, y2: 80 });
  });
  it('measures edge offsets for overlapping boxes', () => {
    expect(values(measureBoxes(box(0, 0, 100, 100), box(50, 50, 100, 100)))).toEqual(['x50', 'x50', 'y50', 'y50']);
  });
  it('skips zero distances', () => {
    expect(values(measureBoxes(box(0, 0, 100, 100), box(0, 0, 100, 200)))).toEqual(['y100']);
    expect(values(measureBoxes(box(0, 0, 50, 50), box(50, 0, 50, 50)))).toEqual([]);
  });
});

describe('nextZoomLevel', () => {
  it('steps through the zoom stops', () => {
    expect(nextZoomLevel(1, 1)).toBe(2);
    expect(nextZoomLevel(1, -1)).toBe(0.5);
    expect(nextZoomLevel(0.7, 1)).toBe(1);
    expect(nextZoomLevel(0.7, -1)).toBe(0.5);
    expect(nextZoomLevel(256, 1)).toBe(256);
    expect(nextZoomLevel(0.02, -1)).toBe(0.02);
  });
});

describe('lockAxis', () => {
  it('keeps the dominant axis', () => {
    expect(lockAxis(30, -10)).toEqual({ dx: 30, dy: 0 });
    expect(lockAxis(3, -10)).toEqual({ dx: 0, dy: -10 });
  });
});

describe('readingOrder', () => {
  it('orders rows top to bottom, then left to right', () => {
    const items = [
      { id: 'c', box: box(0, 500, 100, 100) },
      { id: 'b', box: box(600, 4, 100, 100) },
      { id: 'a', box: box(0, 0, 100, 100) },
      { id: 'd', box: box(300, 520, 100, 100) },
    ];
    expect(readingOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('fitCamera', () => {
  it('centers and fits a rect', () => {
    expect(fitCamera(box(0, 0, 400, 200), { width: 1000, height: 600 }, 100, 4)).toEqual({ zoom: 2, x: 100, y: 100 });
    expect(fitCamera(box(0, 0, 10, 10), { width: 1000, height: 600 }, 0, 4).zoom).toBe(4);
  });
});

describe('inferFlex', () => {
  it('finds the axis, visual order and gap', () => {
    const row = inferFlex([box(240, 0, 100, 40), box(0, 0, 100, 40), box(120, 0, 100, 40)]);
    expect(row).toEqual({ direction: 'row', gap: 20, order: [1, 2, 0] });
    expect(inferFlex([box(0, 0, 100, 40), box(0, 52, 100, 40)])).toMatchObject({ direction: 'column', gap: 12 });
    expect(inferFlex([])).toEqual({ direction: 'column', gap: 8, order: [] });
  });
});

describe('opacityFromDigits', () => {
  it('maps single and double digits', () => {
    expect(opacityFromDigits(5, null)).toBe(50);
    expect(opacityFromDigits(0, null)).toBe(100);
    expect(opacityFromDigits(5, 4)).toBe(45);
    expect(opacityFromDigits(5, 0)).toBe(5);
    expect(opacityFromDigits(0, 1)).toBe(10);
  });
});
