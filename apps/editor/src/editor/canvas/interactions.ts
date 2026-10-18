import { FREEFORM_DISPLAY, parentKindOf, type NewNode, type NodeRecord, type StyleInput } from '@openpaper/core';
import { camera, getState, setCamera, setState } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import {
  chainOf,
  clientToWorld,
  drillTarget,
  elementFor,
  hitStack,
  pickTarget,
  rectsIntersect,
  unionRects,
  worldRectOf,
  type Point,
  type Rect,
} from './geometry.ts';

/** Ephemeral gesture state rendered by the overlay. */
export interface GestureView {
  marquee: Rect | null;
  draw: Rect | null;
  pencil: Point[] | null;
  dropLine: { x1: number; y1: number; x2: number; y2: number } | null;
}

let gestureView: GestureView = { marquee: null, draw: null, pencil: null, dropLine: null };
const gestureListeners = new Set<() => void>();
export function getGestureView() {
  return gestureView;
}
export function subscribeGesture(l: () => void) {
  gestureListeners.add(l);
  return () => gestureListeners.delete(l);
}
function setGesture(patch: Partial<GestureView>) {
  gestureView = { ...gestureView, ...patch };
  for (const l of gestureListeners) l();
}

export let spaceHeld = false;
export function setSpaceHeld(v: boolean) {
  spaceHeld = v;
}

const DRAG_THRESHOLD = 3;

function px(n: number) {
  return `${Math.round(n)}px`;
}

/** Deepest Frame (or page root) under a client point that can receive new children. */
function containerAt(clientX: number, clientY: number): { id: string; node: NodeRecord } | null {
  const s = getState();
  const doc = s.doc;
  const page = doc && s.pageId ? doc.pages[s.pageId] : undefined;
  if (!doc || !page) return null;
  for (const id of hitStack(clientX, clientY)) {
    const node = doc.nodes[id];
    if (node?.component === 'Frame' && !chainOf(doc, id).some((n) => n.isLocked)) return { id, node };
  }
  const root = doc.nodes[page.rootId];
  return root ? { id: root.id, node: root } : null;
}

/** Origin of a container's padding box in world coordinates (page root = 0,0). */
function containerOrigin(container: NodeRecord): Point {
  if (container.component === 'PageRoot') return { x: 0, y: 0 };
  const el = elementFor(container.id) as HTMLElement | null;
  const rect = worldRectOf(container.id);
  if (!el || !rect) return { x: 0, y: 0 };
  return { x: rect.x + el.clientLeft, y: rect.y + el.clientTop };
}

// ---------------------------------------------------------------------------

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; camX: number; camY: number }
  | {
      kind: 'press';
      startX: number;
      startY: number;
      targetId: string | null;
      shift: boolean;
      wasSelected: boolean;
    }
  | {
      kind: 'move';
      startX: number;
      startY: number;
      items: Array<{ id: string; left: number; top: number; mode: 'absolute' | 'flow' }>;
      reorder: { id: string; parentId: string; index: number } | null;
    }
  | { kind: 'marquee'; start: Point; additive: string[]; scopeParentId: string | null }
  | { kind: 'draw'; tool: 'frame' | 'rectangle' | 'ellipse' | 'text'; start: Point; startClient: Point; container: { id: string; node: NodeRecord } }
  | { kind: 'pencil'; points: Point[]; container: { id: string; node: NodeRecord } }
  | {
      kind: 'resize';
      id: string;
      handle: string;
      startX: number;
      startY: number;
      w: number;
      h: number;
      left: number;
      top: number;
      positioned: boolean;
      changed: boolean;
    };

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Begin resizing a node from one of its handles. */
export function startResize(e: PointerEvent, id: string, handle: ResizeHandle) {
  const s = getState();
  const node = s.doc?.nodes[id];
  const el = elementFor(id) as HTMLElement | null;
  if (!node || !el || node.isLocked) return;
  const parent = node.parentId ? s.doc!.nodes[node.parentId] : undefined;
  const kind = parentKindOf(parent);
  const box = el.getBoundingClientRect();
  const zoom = camera().zoom;
  gesture = {
    kind: 'resize',
    id,
    handle,
    startX: e.clientX,
    startY: e.clientY,
    w: box.width / zoom,
    h: box.height / zoom,
    left: el.offsetLeft,
    top: el.offsetTop,
    positioned: kind === 'root' || kind === 'freeform' || node.styles.position === 'absolute',
    changed: false,
  };
}

/** Pressing an artboard's label selects it and lets you drag it. */
export function pressNode(e: PointerEvent, id: string) {
  const s = getState();
  gesture = { kind: 'press', startX: e.clientX, startY: e.clientY, targetId: id, shift: e.shiftKey, wasSelected: s.selection.includes(id) };
  if (e.shiftKey) setState({ selection: s.selection.includes(id) ? s.selection : [...s.selection, id] });
  else if (!s.selection.includes(id)) setState({ selection: [id] });
}

function resizeBox(g: Extract<Gesture, { kind: 'resize' }>, e: PointerEvent) {
  const zoom = camera().zoom;
  const dx = (e.clientX - g.startX) / zoom;
  const dy = (e.clientY - g.startY) / zoom;
  let w = g.w;
  let h = g.h;
  let left = g.left;
  let top = g.top;
  if (g.handle.includes('e')) w = g.w + dx;
  if (g.handle.includes('w')) {
    w = g.w - dx;
    left = g.left + dx;
  }
  if (g.handle.includes('s')) h = g.h + dy;
  if (g.handle.includes('n')) {
    h = g.h - dy;
    top = g.top + dy;
  }
  if (e.shiftKey && g.w > 0 && g.h > 0) {
    const ratio = g.w / g.h;
    if (g.handle.length === 2) {
      if (Math.abs(w - g.w) > Math.abs(h - g.h) * ratio) h = w / ratio;
      else w = h * ratio;
      if (g.handle.includes('n')) top = g.top + (g.h - h);
      if (g.handle.includes('w')) left = g.left + (g.w - w);
    } else if (g.handle === 'e' || g.handle === 'w') h = w / ratio;
    else w = h * ratio;
  }
  if (w < 1) {
    if (g.handle.includes('w')) left -= 1 - w;
    w = 1;
  }
  if (h < 1) {
    if (g.handle.includes('n')) top -= 1 - h;
    h = 1;
  }
  return { w, h, left, top };
}

let gesture: Gesture | null = null;

export function onPointerDown(e: PointerEvent) {
  const s = getState();
  if (!s.doc || !s.pageId) return;
  if (s.editingTextId) return;
  const cam = camera();

  if (e.button === 1 || s.tool === 'hand' || spaceHeld || (e.button === 2 && false)) {
    gesture = { kind: 'pan', startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    return;
  }
  if (e.button !== 0) return;
  const world = clientToWorld(e.clientX, e.clientY);

  switch (s.tool) {
    case 'frame':
    case 'rectangle':
    case 'ellipse':
    case 'text': {
      const container = containerAt(e.clientX, e.clientY);
      if (!container) return;
      gesture = { kind: 'draw', tool: s.tool, start: world, startClient: { x: e.clientX, y: e.clientY }, container };
      return;
    }
    case 'pencil': {
      const container = containerAt(e.clientX, e.clientY);
      if (!container) return;
      gesture = { kind: 'pencil', points: [world], container };
      setGesture({ pencil: [world] });
      return;
    }
    case 'comment': {
      const target = pickTarget(e.clientX, e.clientY, true);
      setState({ rightTab: 'comments', focusedThreadId: null, pendingComment: { nodeId: target, world }, tool: 'select' });
      return;
    }
    default: {
      const deep = e.metaKey || e.ctrlKey;
      let targetId = pickTarget(e.clientX, e.clientY, deep);
      // Clicking an artboard's empty background (when it has content) starts a marquee instead.
      if (targetId && !deep) {
        const node = s.doc.nodes[targetId];
        const parent = node?.parentId ? s.doc.nodes[node.parentId] : undefined;
        if (node && parent?.component === 'PageRoot' && node.children.length > 0 && !s.selection.includes(targetId)) {
          const hit = hitStack(e.clientX, e.clientY)[0];
          if (hit === targetId) targetId = null;
        }
      }
      gesture = {
        kind: 'press',
        startX: e.clientX,
        startY: e.clientY,
        targetId,
        shift: e.shiftKey,
        wasSelected: !!targetId && s.selection.includes(targetId),
      };
      if (targetId && !e.shiftKey && !s.selection.includes(targetId)) setState({ selection: [targetId] });
      if (targetId && e.shiftKey && !s.selection.includes(targetId)) setState({ selection: [...s.selection, targetId] });
      if (!targetId && !e.shiftKey) setState({ selection: [] });
    }
  }
}

export function onPointerMove(e: PointerEvent) {
  const s = getState();
  if (!gesture) {
    if (s.tool === 'select' && !spaceHeld) {
      const hover = pickTarget(e.clientX, e.clientY, e.metaKey || e.ctrlKey);
      if (hover !== s.hoverId) setState({ hoverId: hover });
    }
    return;
  }
  const cam = camera();
  switch (gesture.kind) {
    case 'pan':
      setCamera({ ...cam, x: gesture.camX + (e.clientX - gesture.startX), y: gesture.camY + (e.clientY - gesture.startY) });
      return;
    case 'press': {
      if (Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < DRAG_THRESHOLD) return;
      if (gesture.targetId) startMove(gesture);
      else {
        const start = clientToWorld(gesture.startX, gesture.startY);
        const scopeNode = scopeParentFor(gesture.startX, gesture.startY);
        gesture = { kind: 'marquee', start, additive: gesture.shift ? s.selection : [], scopeParentId: scopeNode };
      }
      onPointerMove(e);
      return;
    }
    case 'move': {
      const dx = (e.clientX - gesture.startX) / cam.zoom;
      const dy = (e.clientY - gesture.startY) / cam.zoom;
      const transient: Record<string, Record<string, string>> = {};
      for (const item of gesture.items) {
        if (item.mode === 'absolute') {
          transient[item.id] = { left: px(item.left + dx), top: px(item.top + dy), right: 'auto', bottom: 'auto' };
        } else {
          transient[item.id] = { transform: `translate(${dx}px, ${dy}px)`, opacity: '0.85', pointerEvents: 'none' };
        }
      }
      if (gesture.items.length === 1 && gesture.items[0]!.mode === 'flow') {
        gesture.reorder = computeReorder(gesture.items[0]!.id, e.clientX, e.clientY);
      }
      setState({ transient });
      return;
    }
    case 'marquee': {
      const p = clientToWorld(e.clientX, e.clientY);
      const rect = normRect(gesture.start, p);
      setGesture({ marquee: rect });
      const doc = s.doc!;
      const page = doc.pages[s.pageId!]!;
      const scope = gesture.scopeParentId ? doc.nodes[gesture.scopeParentId] : doc.nodes[page.rootId];
      const hits = (scope?.children ?? []).filter((id) => {
        const r = worldRectOf(id);
        return r && rectsIntersect(r, rect) && !doc.nodes[id]?.isLocked;
      });
      setState({ selection: [...new Set([...gesture.additive, ...hits])] });
      return;
    }
    case 'draw': {
      const p = clientToWorld(e.clientX, e.clientY);
      let rect = normRect(gesture.start, p);
      if (e.shiftKey) {
        const size = Math.max(rect.width, rect.height);
        rect = { x: p.x < gesture.start.x ? gesture.start.x - size : gesture.start.x, y: p.y < gesture.start.y ? gesture.start.y - size : gesture.start.y, width: size, height: size };
      }
      setGesture({ draw: rect });
      return;
    }
    case 'pencil': {
      const p = clientToWorld(e.clientX, e.clientY);
      const last = gesture.points[gesture.points.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) * cam.zoom < 1.5) return;
      gesture.points.push(p);
      setGesture({ pencil: [...gesture.points] });
      return;
    }
    case 'resize': {
      gesture.changed = true;
      const box = resizeBox(gesture, e);
      const t: Record<string, string> = { width: px(box.w), height: px(box.h) };
      if (gesture.positioned) Object.assign(t, { left: px(box.left), top: px(box.top) });
      setState({ transient: { [gesture.id]: t } });
      return;
    }
  }
}

export function onPointerUp(e: PointerEvent) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  const s = getState();
  switch (g.kind) {
    case 'press':
      // Plain click on an already-selected node (no drag): narrow selection to it.
      if (g.targetId && g.wasSelected && !g.shift && s.selection.length > 1) setState({ selection: [g.targetId] });
      else if (g.targetId && g.wasSelected && g.shift) setState({ selection: s.selection.filter((id) => id !== g.targetId) });
      return;
    case 'move':
      void commitMove(g, e);
      return;
    case 'marquee':
      setGesture({ marquee: null });
      return;
    case 'draw':
      setGesture({ draw: null });
      void commitDraw(g, clientToWorld(e.clientX, e.clientY), e.shiftKey);
      return;
    case 'pencil':
      setGesture({ pencil: null });
      void commitPencil(g);
      return;
    case 'resize': {
      if (!g.changed) return;
      const box = resizeBox(g, e);
      const styles: StyleInput = { width: px(box.w), height: px(box.h) };
      if (g.positioned) Object.assign(styles, { left: px(box.left), top: px(box.top) });
      void command({ type: 'updateStyles', updates: [{ nodeIds: [g.id], styles }] }).finally(() => setState({ transient: {} }));
      return;
    }
  }
}

export function onDoubleClick(e: MouseEvent) {
  const s = getState();
  if (!s.doc || s.tool !== 'select') return;
  const target = drillTarget(e.clientX, e.clientY);
  if (!target) return;
  const node = s.doc.nodes[target];
  if (node?.component === 'Text' && s.selection[0] === target) {
    setState({ editingTextId: target });
    return;
  }
  setState({ selection: [target] });
  if (node?.component === 'Text') setState({ editingTextId: target });
}

export function onWheel(e: WheelEvent) {
  e.preventDefault();
  const cam = camera();
  if (e.ctrlKey || e.metaKey) {
    const vr = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 4 : 1));
    zoomAt(cam.zoom * factor, e.clientX - vr.left, e.clientY - vr.top);
  } else {
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    setCamera({ ...cam, x: cam.x - dx, y: cam.y - dy });
  }
}

export function zoomAt(zoom: number, sx: number, sy: number) {
  const cam = camera();
  const z = Math.min(256, Math.max(0.02, zoom));
  const wx = (sx - cam.x) / cam.zoom;
  const wy = (sy - cam.y) / cam.zoom;
  setCamera({ zoom: z, x: sx - wx * z, y: sy - wy * z });
}

export function cancelGesture() {
  if (!gesture) return;
  gesture = null;
  setGesture({ marquee: null, draw: null, pencil: null, dropLine: null });
  setState({ transient: {} });
}

// ---------------------------------------------------------------------------

function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function scopeParentFor(clientX: number, clientY: number): string | null {
  const s = getState();
  const doc = s.doc!;
  const hit = hitStack(clientX, clientY).find((id) => doc.nodes[id]);
  if (!hit) return null;
  const chain = chainOf(doc, hit);
  const artboard = chain[chain.length - 1];
  return artboard && artboard.children.length ? artboard.id : null;
}

function startMove(press: Extract<Gesture, { kind: 'press' }>) {
  const s = getState();
  const doc = s.doc!;
  const ids = s.selection.filter((id) => doc.nodes[id] && !doc.nodes[id]!.isLocked);
  const items: Extract<Gesture, { kind: 'move' }>['items'] = [];
  for (const id of ids) {
    const node = doc.nodes[id]!;
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    const kind = parentKindOf(parent);
    const el = elementFor(id) as HTMLElement | null;
    if (!el) continue;
    const absolute = kind === 'root' || kind === 'freeform' || node.styles.position === 'absolute' || node.styles.position === 'fixed';
    items.push({ id, left: el.offsetLeft, top: el.offsetTop, mode: absolute ? 'absolute' : 'flow' });
  }
  if (!items.length) {
    gesture = null;
    return;
  }
  // Flow children only reorder one at a time.
  const flow = items.filter((i) => i.mode === 'flow');
  gesture = {
    kind: 'move',
    startX: press.startX,
    startY: press.startY,
    items: flow.length && items.length > 1 ? items.filter((i) => i.mode === 'absolute') : items,
    reorder: null,
  };
}

function computeReorder(id: string, clientX: number, clientY: number): { id: string; parentId: string; index: number } | null {
  const s = getState();
  const doc = s.doc!;
  const node = doc.nodes[id];
  const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
  if (!node || !parent) return null;
  const parentEl = elementFor(parent.id) as HTMLElement | null;
  if (!parentEl) return null;
  const dir = getComputedStyle(parentEl).flexDirection;
  const horizontal = getComputedStyle(parentEl).display.includes('flex') && dir.startsWith('row');
  const siblings = parent.children.filter((c) => c !== id && doc.nodes[c]?.isVisible !== false);
  const pointer = clientToWorld(clientX, clientY);
  let index = siblings.length;
  for (let i = 0; i < siblings.length; i++) {
    const r = worldRectOf(siblings[i]!);
    if (!r) continue;
    const mid = horizontal ? r.x + r.width / 2 : r.y + r.height / 2;
    if ((horizontal ? pointer.x : pointer.y) < mid) {
      index = i;
      break;
    }
  }
  // Drop indicator line.
  const ref = siblings[index] ?? siblings[index - 1];
  const r = ref ? worldRectOf(ref) : worldRectOf(parent.id);
  if (r) {
    const before = !!siblings[index];
    if (horizontal) {
      const x = before ? r.x : r.x + r.width;
      setGesture({ dropLine: { x1: x, y1: r.y, x2: x, y2: r.y + r.height } });
    } else {
      const y = before ? r.y : r.y + r.height;
      setGesture({ dropLine: { x1: r.x, y1: y, x2: r.x + r.width, y2: y } });
    }
  }
  return { id, parentId: parent.id, index };
}

async function commitMove(g: Extract<Gesture, { kind: 'move' }>, e: PointerEvent) {
  const cam = camera();
  const dx = (e.clientX - g.startX) / cam.zoom;
  const dy = (e.clientY - g.startY) / cam.zoom;
  setGesture({ dropLine: null });
  const absolute = g.items.filter((i) => i.mode === 'absolute');
  try {
    if (absolute.length) {
      await command({
        type: 'updateStyles',
        updates: absolute.map((i) => ({
          nodeIds: [i.id],
          styles: { left: px(i.left + dx), top: px(i.top + dy), right: null, bottom: null } as StyleInput,
        })),
      });
    }
    if (g.reorder) {
      // The index counts siblings without the moved node, matching how moveNode inserts.
      const { id, parentId, index } = g.reorder;
      const current = getState().doc?.nodes[parentId]?.children.indexOf(id);
      if (current !== index) await command({ type: 'move', moves: [{ nodeId: id, parentId, index }] });
    }
  } finally {
    setState({ transient: {} });
  }
}

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  frame: { w: 400, h: 300 },
  rectangle: { w: 100, h: 100 },
  ellipse: { w: 100, h: 100 },
  text: { w: 0, h: 0 },
};

async function commitDraw(g: Extract<Gesture, { kind: 'draw' }>, end: Point, square: boolean) {
  let rect = normRect(g.start, end);
  if (square) {
    const size = Math.max(rect.width, rect.height);
    rect = { x: rect.x, y: rect.y, width: size, height: size };
  }
  const clicked = rect.width < 3 && rect.height < 3;
  const def = DEFAULT_SIZE[g.tool]!;
  if (clicked) rect = { x: g.start.x, y: g.start.y, width: def.w, height: def.h };

  const container = g.container.node;
  const isRoot = container.component === 'PageRoot';
  const freeform = isRoot || container.styles.display === FREEFORM_DISPLAY;
  const origin = containerOrigin(container);
  const local = { x: rect.x - origin.x, y: rect.y - origin.y };
  const pos: Record<string, string> = freeform ? { left: px(local.x), top: px(local.y) } : {};

  let node: NewNode;
  switch (g.tool) {
    case 'frame':
      node = {
        component: 'Frame',
        label: isRoot ? 'Artboard' : 'Frame',
        styles: {
          ...pos,
          width: px(rect.width),
          height: px(rect.height),
          display: FREEFORM_DISPLAY,
          overflow: 'clip',
          ...(isRoot ? { backgroundColor: '#FFFFFF' } : {}),
        },
      };
      break;
    case 'rectangle':
      node = { component: 'Rectangle', label: 'Rectangle', styles: { ...pos, width: px(rect.width), height: px(rect.height), backgroundColor: '#D9D9D9' } };
      break;
    case 'ellipse':
      node = {
        component: 'Rectangle',
        label: 'Ellipse',
        styles: { ...pos, width: px(rect.width), height: px(rect.height), backgroundColor: '#D9D9D9', borderRadius: '50%' },
      };
      break;
    default:
      node = {
        component: 'Text',
        textValue: '',
        label: 'Text',
        styles: {
          ...pos,
          fontFamily: 'system-ui, sans-serif',
          fontSize: '16px',
          lineHeight: '24px',
          color: '#000000',
          ...(clicked ? {} : { width: px(rect.width) }),
        },
      };
  }
  const result = await command<{ ids: string[] }>({ type: 'createNodes', parentId: g.container.id, nodes: [node] });
  const id = result.ids[0];
  if (!id) return;
  setState({ selection: [id], tool: 'select', editingTextId: g.tool === 'text' ? id : null });
}

/** Smooth a polyline into an SVG path using quadratic curves through midpoints. */
function smoothPath(points: Point[]): string {
  if (points.length < 2) {
    const p = points[0]!;
    return `M${p.x} ${p.y}l0.01 0`;
  }
  const f = (n: number) => Math.round(n * 100) / 100;
  let d = `M${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const next = points[i + 1]!;
    d += ` Q${f(p.x)} ${f(p.y)} ${f((p.x + next.x) / 2)} ${f((p.y + next.y) / 2)}`;
  }
  const last = points[points.length - 1]!;
  d += ` L${f(last.x)} ${f(last.y)}`;
  return d;
}

export const pencilStyle = { color: '#111111', width: 3 };

async function commitPencil(g: Extract<Gesture, { kind: 'pencil' }>) {
  const pts = g.points;
  if (!pts.length) return;
  const sw = pencilStyle.width;
  const bounds = unionRects(pts.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })))!;
  const pad = sw;
  const x0 = bounds.x - pad;
  const y0 = bounds.y - pad;
  const w = Math.max(1, bounds.width + pad * 2);
  const h = Math.max(1, bounds.height + pad * 2);
  const d = smoothPath(pts.map((p) => ({ x: p.x - x0, y: p.y - y0 })));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w * 100) / 100} ${Math.round(h * 100) / 100}" fill="none">` +
    `<path d="${d}" stroke="${pencilStyle.color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const container = g.container.node;
  const freeform = container.component === 'PageRoot' || container.styles.display === FREEFORM_DISPLAY;
  const origin = containerOrigin(container);
  const styles: Record<string, string> = { width: px(w), height: px(h) };
  if (freeform) Object.assign(styles, { left: px(x0 - origin.x), top: px(y0 - origin.y) });
  const result = await command<{ ids: string[] }>({
    type: 'createNodes',
    parentId: g.container.id,
    nodes: [{ component: 'SVG', label: 'Drawing', svg, styles }],
  });
  if (result.ids[0]) setState({ selection: [result.ids[0]] });
}
