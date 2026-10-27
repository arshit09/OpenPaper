import { FREEFORM_DISPLAY, parentKindOf, type NewNode, type NodeRecord, type StyleInput } from '@openpaper/core';
import { camera, getState, setCamera, setState } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import { fitCamera, lockAxis } from './canvas-math.ts';
import {
  chainOf,
  clientToWorld,
  drillTarget,
  elementFor,
  hitStack,
  pickTarget,
  rectsIntersect,
  unionRects,
  viewportRect,
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

/** Spring-loaded keys and pointer modes that change what the canvas does. */
export interface KeyModes {
  /** Space held: dragging pans. */
  space: boolean;
  /** Z (or Ctrl+Space) held: click zooms in, Alt+click out, drag zooms to an area. */
  zoom: boolean;
  /** Alt held: measure distances, Alt-drag duplicates, Alt-resize from the center. */
  alt: boolean;
  /** A pan drag is in progress. */
  panning: boolean;
}

let modes: KeyModes = { space: false, zoom: false, alt: false, panning: false };
const modeListeners = new Set<() => void>();
export function getModes() {
  return modes;
}
export function subscribeModes(l: () => void) {
  modeListeners.add(l);
  return () => modeListeners.delete(l);
}
export function setModes(patch: Partial<KeyModes>) {
  if ((Object.keys(patch) as Array<keyof KeyModes>).every((k) => modes[k] === patch[k])) return;
  modes = { ...modes, ...patch };
  for (const l of modeListeners) l();
}

/** Tool visuals drawn by ZoomOverlay, DragGhost and MeasureOverlay. */
export interface ToolView {
  /** Zoom tool brush in viewport-relative screen px. */
  zoomRect: Rect | null;
  /** Alt-drag: copies of `ids` follow the pointer by (dx, dy) world px; a `flow` copy drops into a slot. */
  clone: { ids: string[]; dx: number; dy: number; flow: boolean } | null;
}

let toolView: ToolView = { zoomRect: null, clone: null };
const toolListeners = new Set<() => void>();
export function getToolView() {
  return toolView;
}
export function subscribeToolView(l: () => void) {
  toolListeners.add(l);
  return () => toolListeners.delete(l);
}
function setToolView(patch: Partial<ToolView>) {
  toolView = { ...toolView, ...patch };
  for (const l of toolListeners) l();
}

export let spaceHeld = false;
export function setSpaceHeld(v: boolean) {
  spaceHeld = v;
  setModes({ space: v });
}

const DRAG_THRESHOLD = 3;

function px(n: number) {
  return `${Math.round(n)}px`;
}

/** The parts of a pointer event gestures read (a modifier change replays the last position). */
export interface PointerLike {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

let lastPointer: PointerLike | null = null;
function remember(e: PointerLike) {
  lastPointer = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
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

type MoveItem = { id: string; left: number; top: number; mode: 'absolute' | 'flow' };
type Slot = { id: string; parentId: string; index: number };

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
      items: MoveItem[];
      /** Flow child: the slot it moves to (index without itself), or where its copy goes (index among all children). */
      reorder: Slot | null;
      /** Alt held: the originals stay and copies follow the pointer. */
      clone: boolean;
      dx: number;
      dy: number;
    }
  | { kind: 'marquee'; start: Point; additive: string[]; scopeParentId: string | null }
  | {
      kind: 'draw';
      tool: 'frame' | 'rectangle' | 'ellipse' | 'text';
      start: Point;
      startClient: Point;
      container: { id: string; node: NodeRecord };
      rect: Rect | null;
    }
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
    }
  | { kind: 'zoom'; startX: number; startY: number };

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
  remember(e);
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
  remember(e);
  gesture = { kind: 'press', startX: e.clientX, startY: e.clientY, targetId: id, shift: e.shiftKey, wasSelected: s.selection.includes(id) };
  if (e.shiftKey) setState({ selection: s.selection.includes(id) ? s.selection : [...s.selection, id] });
  else if (!s.selection.includes(id)) setState({ selection: [id] });
}

/** Shift keeps the aspect ratio; Alt resizes around the center. */
function resizeBox(g: Extract<Gesture, { kind: 'resize' }>, e: PointerLike) {
  const zoom = camera().zoom;
  const dx = (e.clientX - g.startX) / zoom;
  const dy = (e.clientY - g.startY) / zoom;
  const sx = g.handle.includes('e') ? 1 : g.handle.includes('w') ? -1 : 0;
  const sy = g.handle.includes('s') ? 1 : g.handle.includes('n') ? -1 : 0;
  const k = e.altKey ? 2 : 1;
  let w = g.w + sx * dx * k;
  let h = g.h + sy * dy * k;
  if (e.shiftKey && g.w > 0 && g.h > 0) {
    const ratio = g.w / g.h;
    if (sx && sy) {
      if (Math.abs(w - g.w) > Math.abs(h - g.h) * ratio) h = w / ratio;
      else w = h * ratio;
    } else if (sx) h = w / ratio;
    else w = h * ratio;
  }
  w = Math.max(1, w);
  h = Math.max(1, h);
  const left = e.altKey ? g.left + (g.w - w) / 2 : sx < 0 ? g.left + (g.w - w) : g.left;
  const top = e.altKey ? g.top + (g.h - h) / 2 : sy < 0 ? g.top + (g.h - h) : g.top;
  return { w, h, left, top };
}

/** Shift draws a square; Alt draws from the center. */
function drawRect(g: Extract<Gesture, { kind: 'draw' }>, p: Point, e: PointerLike): Rect {
  let dx = p.x - g.start.x;
  let dy = p.y - g.start.y;
  if (e.shiftKey) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  if (e.altKey) return { x: g.start.x - Math.abs(dx), y: g.start.y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  return normRect(g.start, { x: g.start.x + dx, y: g.start.y + dy });
}

let gesture: Gesture | null = null;

/** The gesture in progress, if any (overlays hide or adapt while dragging). */
export function gestureKind(): Gesture['kind'] | null {
  return gesture?.kind ?? null;
}

export function onPointerDown(e: PointerEvent) {
  const s = getState();
  if (!s.doc || !s.pageId) return;
  if (s.editingTextId) return;
  const cam = camera();
  remember(e);

  if (e.button === 1 || s.tool === 'hand' || modes.space) {
    gesture = { kind: 'pan', startX: e.clientX, startY: e.clientY, camX: cam.x, camY: cam.y };
    setModes({ panning: true });
    return;
  }
  if (e.button !== 0) return;
  if (modes.zoom) {
    gesture = { kind: 'zoom', startX: e.clientX, startY: e.clientY };
    return;
  }
  const world = clientToWorld(e.clientX, e.clientY);

  switch (s.tool) {
    case 'frame':
    case 'rectangle':
    case 'ellipse':
    case 'text': {
      const container = containerAt(e.clientX, e.clientY);
      if (!container) return;
      gesture = { kind: 'draw', tool: s.tool, start: world, startClient: { x: e.clientX, y: e.clientY }, container, rect: null };
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

export function onPointerMove(e: PointerLike) {
  const s = getState();
  remember(e);
  if (!gesture) {
    if (s.tool === 'select' && !modes.space && !modes.zoom) {
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
    case 'zoom': {
      const vr = viewportRect();
      const a = { x: gesture.startX - vr.left, y: gesture.startY - vr.top };
      const b = { x: e.clientX - vr.left, y: e.clientY - vr.top };
      setToolView({ zoomRect: Math.hypot(b.x - a.x, b.y - a.y) < DRAG_THRESHOLD ? null : normRect(a, b) });
      return;
    }
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
      const g = gesture;
      let dx = (e.clientX - g.startX) / cam.zoom;
      let dy = (e.clientY - g.startY) / cam.zoom;
      if (e.shiftKey) ({ dx, dy } = lockAxis(dx, dy));
      // Whole pixels, so what is shown while dragging is exactly where it lands.
      dx = Math.round(dx);
      dy = Math.round(dy);
      g.dx = dx;
      g.dy = dy;
      g.clone = e.altKey;
      const flow = g.items.length === 1 && g.items[0]!.mode === 'flow' ? g.items[0]! : null;
      if (flow) g.reorder = computeReorder(flow.id, g.startX + dx * cam.zoom, g.startY + dy * cam.zoom, g.clone);
      if (g.clone) {
        if (Object.keys(getState().transient).length) setState({ transient: {} });
        setToolView({ clone: { ids: g.items.map((i) => i.id), dx, dy, flow: !!flow } });
        return;
      }
      if (toolView.clone) setToolView({ clone: null });
      const transient: Record<string, Record<string, string>> = {};
      for (const item of g.items) {
        if (item.mode === 'absolute') {
          transient[item.id] = { left: px(item.left + dx), top: px(item.top + dy), right: 'auto', bottom: 'auto' };
        } else {
          transient[item.id] = { transform: `translate(${dx}px, ${dy}px)`, opacity: '0.85', pointerEvents: 'none' };
        }
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
      gesture.rect = drawRect(gesture, clientToWorld(e.clientX, e.clientY), e);
      setGesture({ draw: gesture.rect });
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

/** Shift or Alt went down/up mid-gesture: redraw it as if the pointer moved. */
export function refreshGesture(mods: { shiftKey: boolean; altKey: boolean }) {
  if (!gesture || !lastPointer) return;
  if (gesture.kind !== 'move' && gesture.kind !== 'resize' && gesture.kind !== 'draw') return;
  if (gesture.kind === 'resize' && !gesture.changed) return;
  onPointerMove({ ...lastPointer, ...mods });
}

export function onPointerUp(e: PointerEvent) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  const s = getState();
  switch (g.kind) {
    case 'pan':
      setModes({ panning: false });
      return;
    case 'zoom':
      finishZoom(g, e);
      return;
    case 'press':
      // Plain click on an already-selected node (no drag): narrow selection to it.
      if (g.targetId && g.wasSelected && !g.shift && s.selection.length > 1) setState({ selection: [g.targetId] });
      else if (g.targetId && g.wasSelected && g.shift) setState({ selection: s.selection.filter((id) => id !== g.targetId) });
      return;
    case 'move':
      void (g.clone ? commitClone(g) : commitMove(g));
      return;
    case 'marquee':
      setGesture({ marquee: null });
      return;
    case 'draw':
      setGesture({ draw: null });
      void commitDraw(g, g.rect ?? drawRect(g, clientToWorld(e.clientX, e.clientY), e));
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
  if (!s.doc || s.tool !== 'select' || modes.zoom) return;
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

/** Center a world rect in the viewport at the zoom that fits it. */
export function fitRect(rect: Rect, padding = 80, maxZoom = 4) {
  setCamera(fitCamera(rect, viewportRect(), padding, maxZoom));
}

let zoomEndPending = false;

/** Z released: leave the zoom tool, or right after the zoom drag in progress ends. */
export function endZoomMode() {
  if (gesture?.kind === 'zoom') zoomEndPending = true;
  else setModes({ zoom: false });
}

function finishZoom(g: Extract<Gesture, { kind: 'zoom' }>, e: PointerEvent) {
  setToolView({ zoomRect: null });
  const vr = viewportRect();
  const cam = camera();
  const out = e.altKey;
  if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < DRAG_THRESHOLD) {
    zoomAt(out ? cam.zoom / 2 : cam.zoom * 2, e.clientX - vr.left, e.clientY - vr.top);
  } else if (out) {
    zoomAt(cam.zoom / 2, (g.startX + e.clientX) / 2 - vr.left, (g.startY + e.clientY) / 2 - vr.top);
  } else {
    fitRect(normRect(clientToWorld(g.startX, g.startY), clientToWorld(e.clientX, e.clientY)), 0, 256);
  }
  if (zoomEndPending) {
    zoomEndPending = false;
    setModes({ zoom: false });
  }
}

let keyPanFrame = 0;

/** Pan with the arrow keys for as long as `direction()` returns a heading (Shift = faster). */
export function startKeyPan(direction: () => { x: number; y: number; fast: boolean } | null) {
  if (keyPanFrame) return;
  let last = performance.now();
  const tick = (now: number) => {
    const d = direction();
    if (!d) {
      keyPanFrame = 0;
      return;
    }
    const len = Math.hypot(d.x, d.y);
    // Screen px per second, independent of the display's frame rate.
    const step = ((d.fast ? 2700 : 900) * Math.min(50, Math.max(0, now - last))) / 1000;
    last = now;
    if (len && step) {
      const cam = camera();
      setCamera({ ...cam, x: cam.x + (d.x / len) * step, y: cam.y + (d.y / len) * step });
    }
    keyPanFrame = requestAnimationFrame(tick);
  };
  const first = direction();
  if (first && (first.x || first.y)) {
    // A tap moves a little right away.
    const len = Math.hypot(first.x, first.y);
    const cam = camera();
    const step = first.fast ? 48 : 16;
    setCamera({ ...cam, x: cam.x + (first.x / len) * step, y: cam.y + (first.y / len) * step });
  }
  keyPanFrame = requestAnimationFrame(tick);
}

export function cancelGesture() {
  if (!gesture) return;
  if (gesture.kind === 'pan') setModes({ panning: false });
  gesture = null;
  zoomEndPending = false;
  setGesture({ marquee: null, draw: null, pencil: null, dropLine: null });
  setToolView({ zoomRect: null, clone: null });
  setState({ transient: {} });
}

/** Window lost focus: keys may have been released elsewhere. */
export function resetModes() {
  if (gesture?.kind === 'zoom') {
    gesture = null;
    setToolView({ zoomRect: null });
  }
  zoomEndPending = false;
  spaceHeld = false;
  setModes({ space: false, zoom: false, alt: false });
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
  const items: MoveItem[] = [];
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
    clone: false,
    dx: 0,
    dy: 0,
  };
}

/**
 * Where a dragged flow child lands among its siblings. A move counts the siblings without the
 * node (how moveNode inserts); a copy counts all children (the original stays).
 */
function computeReorder(id: string, clientX: number, clientY: number, copy: boolean): Slot | null {
  const s = getState();
  const doc = s.doc!;
  const node = doc.nodes[id];
  const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
  if (!node || !parent) return null;
  const parentEl = elementFor(parent.id) as HTMLElement | null;
  if (!parentEl) return null;
  const style = getComputedStyle(parentEl);
  const horizontal = style.display.includes('flex') && style.flexDirection.startsWith('row');
  const order = copy ? parent.children : parent.children.filter((c) => c !== id);
  const pointer = clientToWorld(clientX, clientY);
  let index = order.length;
  let before: string | null = null;
  let last: string | null = null;
  for (let i = 0; i < order.length; i++) {
    const r = doc.nodes[order[i]!]?.isVisible === false ? null : worldRectOf(order[i]!);
    if (!r) continue;
    const mid = horizontal ? r.x + r.width / 2 : r.y + r.height / 2;
    if ((horizontal ? pointer.x : pointer.y) < mid) {
      index = i;
      before = order[i]!;
      break;
    }
    last = order[i]!;
  }
  // Drop indicator line.
  const ref = before ?? last;
  const r = ref ? worldRectOf(ref) : worldRectOf(parent.id);
  if (r) {
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

async function commitMove(g: Extract<Gesture, { kind: 'move' }>) {
  setGesture({ dropLine: null });
  const absolute = g.items.filter((i) => i.mode === 'absolute');
  try {
    if (absolute.length && (g.dx || g.dy)) {
      await command({
        type: 'updateStyles',
        updates: absolute.map((i) => ({
          nodeIds: [i.id],
          styles: { left: px(i.left + g.dx), top: px(i.top + g.dy), right: null, bottom: null } as StyleInput,
        })),
      });
    }
    if (g.reorder) {
      const { id, parentId, index } = g.reorder;
      const current = getState().doc?.nodes[parentId]?.children.indexOf(id);
      if (current !== index) await command({ type: 'move', moves: [{ nodeId: id, parentId, index }] });
    }
  } finally {
    setState({ transient: {} });
  }
}

/** Resolves once the given nodes are in the DOM (or after a short timeout). */
function rendered(ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    let frames = 0;
    const check = () => (ids.every((id) => elementFor(id)) || ++frames > 30 ? resolve() : requestAnimationFrame(check));
    check();
  });
}

/** Alt-drop: one duplicate command places every copy where it was dropped (a single undo step). */
async function commitClone(g: Extract<Gesture, { kind: 'move' }>) {
  setGesture({ dropLine: null });
  const place: Record<string, { index?: number; styles?: StyleInput }> = {};
  for (const i of g.items) {
    if (i.mode === 'absolute') place[i.id] = { styles: { left: px(i.left + g.dx), top: px(i.top + g.dy), right: null, bottom: null } };
    else if (g.reorder?.id === i.id) place[i.id] = { index: g.reorder.index };
  }
  try {
    const result = await command<{ ids: string[] }>({ type: 'duplicate', nodeIds: g.items.map((i) => i.id), place });
    const ids = result.ids ?? [];
    await rendered(ids);
    if (ids.length) setState({ selection: ids });
  } finally {
    setToolView({ clone: null });
  }
}

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  frame: { w: 400, h: 300 },
  rectangle: { w: 100, h: 100 },
  ellipse: { w: 100, h: 100 },
  text: { w: 0, h: 0 },
};

async function commitDraw(g: Extract<Gesture, { kind: 'draw' }>, drawn: Rect) {
  let rect = drawn;
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
