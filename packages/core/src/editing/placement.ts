import { pxValue } from '../styles/css.ts';
import type { DocReader } from '../model/transaction.ts';
import type { LayoutMap, NodeRecord } from '../model/types.ts';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const ARTBOARD_PADDING = 80;
const UNKNOWN_SIZE = 10_000;

function intersects(a: Box, b: Box): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function inflate(b: Box, p: number): Box {
  return { minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p };
}

function boxAt(x: number, y: number, w: number, h: number): Box {
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

/** Canvas boxes of a page's top-level nodes (measured when possible). */
export function topLevelBoxes(reader: DocReader, root: NodeRecord, layout: LayoutMap | null, exclude: Set<string> = new Set()): Box[] {
  const boxes: Box[] = [];
  for (const id of root.children) {
    if (exclude.has(id)) continue;
    const n = reader.getNode(id);
    if (!n) continue;
    const m = layout?.[id];
    if (m) {
      boxes.push(boxAt(m.worldX, m.worldY, m.width, m.height));
      continue;
    }
    const x = pxValue(n.styles.left ?? '0px');
    const y = pxValue(n.styles.top ?? '0px');
    if (x === null || y === null) continue;
    const w = pxValue(n.styles.width) ?? UNKNOWN_SIZE;
    const h = pxValue(n.styles.height) ?? UNKNOWN_SIZE;
    boxes.push(boxAt(x, y, w, h));
  }
  return boxes;
}

export interface PlacementOptions {
  padding?: number;
  /** Visible canvas area when the page is the one the user is looking at. */
  viewport?: Box | null;
  /** Source box when placing a duplicate (prefer right of / below it). */
  anchor?: Box | null;
}

/** Find a free spot for a `w`×`h` item among `obstacles`. Returns integer coordinates. */
export function findFreeSpot(obstacles: Box[], w: number, h: number, opts: PlacementOptions = {}): { x: number; y: number } {
  const p = opts.padding ?? ARTBOARD_PADDING;
  const free = (x: number, y: number) => {
    const target = inflate(boxAt(x, y, w, h), p);
    return !obstacles.some((o) => intersects(target, o));
  };
  const vp = opts.viewport ?? null;
  const mostlyVisible = (x: number, y: number) => {
    if (!vp) return true;
    const ox = Math.min(x + w, vp.maxX) - Math.max(x, vp.minX);
    const oy = Math.min(y + h, vp.maxY) - Math.max(y, vp.minY);
    if (ox <= 0 || oy <= 0) return false;
    return ox >= Math.min(300, w) && oy >= Math.min(300, h) && ox * oy >= (2 / 3) * w * h;
  };
  const ok = (x: number, y: number) => free(x, y) && mostlyVisible(x, y);
  const round = (pt: { x: number; y: number }) => ({ x: Math.round(pt.x), y: Math.round(pt.y) });

  const sortByYX = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y - b.y || a.x - b.x;
  const rightOf = obstacles.map((o) => ({ x: o.maxX + p, y: o.minY })).sort(sortByYX);
  const below = obstacles.map((o) => ({ x: o.minX, y: o.maxY + p })).sort(sortByYX);

  // 1. Anchor (duplicates): right of the source, then below it.
  const anchorCandidates: Array<{ x: number; y: number }> = [];
  if (opts.anchor) {
    const a = opts.anchor;
    const ys = [a.minY, ...obstacles.map((o) => o.maxY + p), ...obstacles.map((o) => o.minY).filter((y) => y >= a.minY && y <= a.maxY)];
    for (const y of [...new Set(ys)].sort((m, n) => m - n)) anchorCandidates.push({ x: a.maxX + p, y });
    const xs = [a.minX, ...obstacles.map((o) => o.maxX + p), ...obstacles.map((o) => o.minX).filter((x) => x >= a.minX && x <= a.maxX)];
    for (const x of [...new Set(xs)].sort((m, n) => m - n)) anchorCandidates.push({ x, y: a.maxY + p });
    for (const c of anchorCandidates) if (ok(c.x, c.y)) return round(c);
  }

  // 2. Viewport-aware placement.
  if (vp) {
    const inset = { minX: vp.minX + p, minY: vp.minY + p, maxX: vp.maxX - p, maxY: vp.maxY - p };
    const fits = w <= inset.maxX - inset.minX && h <= inset.maxY - inset.minY;
    if (fits) {
      if (!obstacles.some((o) => intersects(o, vp))) {
        return round({ x: (vp.minX + vp.maxX - w) / 2, y: (vp.minY + vp.maxY - h) / 2 });
      }
      const xs = [inset.minX, ...obstacles.map((o) => o.minX), ...obstacles.map((o) => o.maxX + p)].filter((x) => x >= inset.minX && x + w <= inset.maxX);
      const ys = [inset.minY, ...obstacles.map((o) => o.minY), ...obstacles.map((o) => o.maxY + p)].filter((y) => y >= inset.minY && y + h <= inset.maxY);
      for (const y of [...new Set(ys)].sort((m, n) => m - n)) for (const x of [...new Set(xs)].sort((m, n) => m - n)) if (free(x, y)) return round({ x, y });
    }
  }

  // 3. Right of / below existing items.
  for (const c of [...rightOf, ...below]) if (ok(c.x, c.y)) return round(c);

  if (!vp) {
    if (!obstacles.length) return { x: 0, y: 0 };
    const union = obstacles.reduce((u, o) => ({
      minX: Math.min(u.minX, o.minX),
      minY: Math.min(u.minY, o.minY),
      maxX: Math.max(u.maxX, o.maxX),
      maxY: Math.max(u.maxY, o.maxY),
    }));
    const right = { x: union.maxX + p, y: union.minY };
    if (free(right.x, right.y)) return round(right);
    const bottom = { x: union.minX, y: union.maxY + p };
    if (free(bottom.x, bottom.y)) return round(bottom);
    return round(right);
  }

  // 4. Fallbacks that ignore visibility but stay within the viewport's top-left.
  for (const c of [...anchorCandidates, ...rightOf, ...below]) {
    if (c.x >= vp.minX && c.y >= vp.minY && free(c.x, c.y)) return round(c);
  }
  return round({ x: (vp.minX + vp.maxX - w) / 2, y: (vp.minY + vp.maxY - h) / 2 });
}
