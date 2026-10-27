/** Pure geometry for canvas tools: measuring, zoom steps, axis lock, artboard order. */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Distance extends Segment {
  value: number;
  axis: 'x' | 'y';
}

export interface Measurement {
  distances: Distance[];
  /** Dashed extensions of the target's edges up to a distance line. */
  guides: Segment[];
}

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;

function contains(outer: Box, inner: Box, eps: number): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && right(inner) <= right(outer) + eps && bottom(inner) <= bottom(outer) + eps;
}

/**
 * Distances between a selection box `a` and a target box `b`, Figma style: the four insets when
 * one contains the other, edge-to-edge gaps when they are apart, edge offsets when they overlap.
 */
export function measureBoxes(a: Box, b: Box, eps = 0.01): Measurement {
  const distances: Distance[] = [];
  const guides: Segment[] = [];
  const h = (x1: number, x2: number, y: number) => {
    const value = Math.abs(x2 - x1);
    if (value > eps) distances.push({ x1: Math.min(x1, x2), y1: y, x2: Math.max(x1, x2), y2: y, value, axis: 'x' });
  };
  const v = (y1: number, y2: number, x: number) => {
    const value = Math.abs(y2 - y1);
    if (value > eps) distances.push({ x1: x, y1: Math.min(y1, y2), x2: x, y2: Math.max(y1, y2), value, axis: 'y' });
  };

  const inner = contains(b, a, eps) ? a : contains(a, b, eps) ? b : null;
  if (inner) {
    const outer = inner === a ? b : a;
    const cx = inner.x + inner.width / 2;
    const cy = inner.y + inner.height / 2;
    h(outer.x, inner.x, cy);
    h(right(inner), right(outer), cy);
    v(outer.y, inner.y, cx);
    v(bottom(inner), bottom(outer), cx);
    return { distances, guides };
  }

  const xOverlap = a.x < right(b) - eps && b.x < right(a) - eps;
  const yOverlap = a.y < bottom(b) - eps && b.y < bottom(a) - eps;
  const midY = yOverlap ? (Math.max(a.y, b.y) + Math.min(bottom(a), bottom(b))) / 2 : a.y + a.height / 2;
  const midX = xOverlap ? (Math.max(a.x, b.x) + Math.min(right(a), right(b))) / 2 : a.x + a.width / 2;

  if (xOverlap && yOverlap) {
    h(a.x, b.x, midY);
    h(right(a), right(b), midY);
    v(a.y, b.y, midX);
    v(bottom(a), bottom(b), midX);
    return { distances, guides };
  }
  if (!xOverlap) {
    const toRight = right(a) <= b.x + eps;
    h(toRight ? right(a) : right(b), toRight ? b.x : a.x, midY);
    if (!yOverlap) {
      const edge = toRight ? b.x : right(b);
      guides.push({ x1: edge, y1: midY, x2: edge, y2: midY < b.y ? b.y : bottom(b) });
    }
  }
  if (!yOverlap) {
    const below = bottom(a) <= b.y + eps;
    v(below ? bottom(a) : bottom(b), below ? b.y : a.y, midX);
    if (!xOverlap) {
      const edge = below ? b.y : bottom(b);
      guides.push({ x1: midX, y1: edge, x2: midX < b.x ? b.x : right(b), y2: edge });
    }
  }
  return { distances, guides };
}

/** Zoom stops used by zoom in/out and the zoom tool (Paper and Figma step by powers of two). */
export const ZOOM_LEVELS = [0.02, 0.03, 0.06, 0.13, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];

export function nextZoomLevel(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((z) => z > current * 1.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!;
  return [...ZOOM_LEVELS].reverse().find((z) => z < current / 1.001) ?? ZOOM_LEVELS[0]!;
}

/** Shift-drag: keep only the dominant axis. */
export function lockAxis(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

/** Reading order for artboards: rows top to bottom (a row tolerates small vertical offsets), then left to right. */
export function readingOrder<T extends { box: Box }>(items: T[]): T[] {
  const sorted = [...items].sort((p, q) => p.box.y - q.box.y || p.box.x - q.box.x);
  const rows: Array<{ top: number; height: number; items: T[] }> = [];
  for (const item of sorted) {
    const row = rows.find((r) => item.box.y - r.top <= Math.min(r.height, item.box.height) * 0.2);
    if (row) {
      row.items.push(item);
      row.height = Math.max(row.height, item.box.height);
    } else rows.push({ top: item.box.y, height: item.box.height, items: [item] });
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.box.x - q.box.x || p.box.y - q.box.y));
}

/** Camera that centers `rect` in a viewport at the zoom that fits it. */
export function fitCamera(rect: Box, view: { width: number; height: number }, padding: number, maxZoom: number) {
  const zoom = Math.min(maxZoom, Math.max(0.02, Math.min((view.width - padding * 2) / rect.width, (view.height - padding * 2) / rect.height)));
  return { zoom, x: view.width / 2 - (rect.x + rect.width / 2) * zoom, y: view.height / 2 - (rect.y + rect.height / 2) * zoom };
}

/** Flex layout that keeps freely placed boxes in place: the axis they spread along, their order and typical gap. */
export function inferFlex(boxes: Box[]): { direction: 'row' | 'column'; gap: number; order: number[] } {
  const order = boxes.map((_, i) => i);
  if (boxes.length < 2) return { direction: 'column', gap: 8, order };
  const cx = boxes.map((b) => b.x + b.width / 2);
  const cy = boxes.map((b) => b.y + b.height / 2);
  const row = Math.max(...cx) - Math.min(...cx) > Math.max(...cy) - Math.min(...cy);
  order.sort((p, q) => (row ? boxes[p]!.x - boxes[q]!.x : boxes[p]!.y - boxes[q]!.y));
  const gaps = order.slice(1).map((i, k) => {
    const prev = boxes[order[k]!]!;
    const cur = boxes[i]!;
    return row ? cur.x - right(prev) : cur.y - bottom(prev);
  });
  gaps.sort((p, q) => p - q);
  return { direction: row ? 'row' : 'column', gap: Math.max(0, Math.round(gaps[Math.floor(gaps.length / 2)]!)), order };
}

/**
 * Opacity from number keys: 1 → 10%, 5 → 50%, 0 → 100%; a second digit typed quickly makes two
 * digits (4 then 5 → 45%, 0 then 5 → 5%). `previous` is the digit typed just before, if recent.
 */
export function opacityFromDigits(digit: number, previous: number | null): number {
  if (previous === null) return digit === 0 ? 100 : digit * 10;
  return previous * 10 + digit;
}
