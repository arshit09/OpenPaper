import type { NodeRecord, PaperDocument } from '@openpaper/core';
import { camera, getState } from '../../state/store.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The canvas viewport element (set by Canvas). */
let viewportEl: HTMLElement | null = null;
export function setViewportElement(el: HTMLElement | null) {
  viewportEl = el;
}
export function getViewportElement(): HTMLElement | null {
  return viewportEl;
}

export function viewportRect(): DOMRect {
  return viewportEl?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

/** Client (page) coordinates → world coordinates. */
export function clientToWorld(clientX: number, clientY: number): Point {
  const vr = viewportRect();
  const cam = camera();
  return { x: (clientX - vr.left - cam.x) / cam.zoom, y: (clientY - vr.top - cam.y) / cam.zoom };
}

/** World coordinates → viewport-relative screen coordinates. */
export function worldToScreen(p: Point): Point {
  const cam = camera();
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y };
}

export function elementFor(id: string): Element | null {
  return viewportEl?.querySelector(`[data-op-id="${CSS.escape(id)}"]`) ?? null;
}

/** A node's border box in world coordinates (from the live DOM), or null when not rendered. */
export function worldRectOf(id: string): Rect | null {
  const el = elementFor(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0 && !(el as HTMLElement).offsetParent) return null;
  const tl = clientToWorld(r.left, r.top);
  const cam = camera();
  return { x: tl.x, y: tl.y, width: r.width / cam.zoom, height: r.height / cam.zoom };
}

/** Viewport-relative screen rect of a node. */
export function screenRectOf(id: string): Rect | null {
  const el = elementFor(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vr = viewportRect();
  return { x: r.left - vr.left, y: r.top - vr.top, width: r.width, height: r.height };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

/** Ids of rendered nodes under a client point, deepest first. */
export function hitStack(clientX: number, clientY: number): string[] {
  const ids: string[] = [];
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const id = (el as HTMLElement).dataset?.opId ?? el.getAttribute?.('data-op-id');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Ancestor chain from the node up to (excluding) the page root: [node, parent, …, artboard]. */
export function chainOf(doc: PaperDocument, id: string): NodeRecord[] {
  const chain: NodeRecord[] = [];
  let node: NodeRecord | undefined = doc.nodes[id];
  while (node && node.component !== 'PageRoot') {
    chain.push(node);
    node = node.parentId ? doc.nodes[node.parentId] : undefined;
  }
  return chain;
}

function isLockedChain(chain: NodeRecord[]): boolean {
  return chain.some((n) => n.isLocked);
}

/**
 * Pick what a click selects, Figma-style:
 *  - deep (⌘/Ctrl): the deepest unlocked node
 *  - otherwise keep the current selection depth: a sibling of the selection when the
 *    hit is inside the selection's parent, else the artboard's direct child (or the
 *    artboard itself when clicking its own background).
 */
export function pickTarget(clientX: number, clientY: number, deep: boolean): string | null {
  const s = getState();
  const doc = s.doc;
  if (!doc) return null;
  const stack = hitStack(clientX, clientY).filter((id) => doc.nodes[id]);
  if (!stack.length) return null;
  const hit = stack.find((id) => !isLockedChain(chainOf(doc, id)));
  if (!hit) return null;
  const chain = chainOf(doc, hit); // [hit … artboard]
  if (deep) return hit;

  // Stay at the depth of the current selection when possible.
  for (const selectedId of s.selection) {
    const selected = doc.nodes[selectedId];
    if (!selected) continue;
    const idx = chain.findIndex((n) => n.parentId === selected.parentId && n.id !== selectedId);
    if (idx >= 0) return chain[idx]!.id;
    // Clicking inside the selected node selects its child on the path.
    const inside = chain.findIndex((n) => n.id === selectedId);
    if (inside > 0) return chain[inside - 1]!.id;
    if (inside === 0) return selectedId;
  }
  if (chain.length === 1) return chain[0]!.id; // artboard (or top-level item) itself
  return chain[chain.length - 2]!.id; // direct child of the artboard
}

/** Double-click: drill one level deeper toward the hit node. */
export function drillTarget(clientX: number, clientY: number): string | null {
  const s = getState();
  const doc = s.doc;
  if (!doc) return null;
  const hit = hitStack(clientX, clientY).find((id) => doc.nodes[id]);
  if (!hit) return null;
  const chain = chainOf(doc, hit);
  const current = s.selection[0];
  const idx = current ? chain.findIndex((n) => n.id === current) : -1;
  if (idx > 0) return chain[idx - 1]!.id;
  return idx === 0 ? hit : (chain[chain.length - 2] ?? chain[0])!.id;
}
