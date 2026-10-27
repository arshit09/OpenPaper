import type { ActorInfo, AgentPresence, NodeRecord, PaperDocument, Patch } from '@openpaper/core';
import { camera, getState, useEditor } from '../../state/store.ts';
import { elementFor, getViewportElement, viewportRect, type Rect } from './geometry.ts';

/**
 * Live preview of agent edits. The server applies each tool call at once; the editor plays the
 * change back so you can watch it being built: new layers appear in tree order (outline first,
 * then the fill wipes in and text types), style edits tween, deletions fade out, and a cursor
 * follows the agent's write head.
 *
 * Presentation only. Layers wait with `visibility: hidden` and animate clip-path, opacity, filter
 * and paint properties (Web Animations), never layout, so measuring, hit-testing and the document
 * are final at every moment. User edits, undo and redo stay instant.
 */

const PENDING = 'data-op-pending';
/** An outline is drawn this long before its layer fills in. */
const LEAD = 140;
const FADE = 260;
/** Stagger between layers of a small write, and the span a big write's starts fit in. */
const STEP_MAX = 48;
const SPAN = 1500;
/** When a new patch lands, earlier layers still waiting catch up within this. */
const BURST = 220;
/** Reveals this overdue (throttled tab, long task) appear without animation. */
const LATE = 600;
const EDIT_MS = 520;
const PULSE_MS = 950;
const MORPH_MS = 420;
const GHOST_MS = 320;
const SCAN_MS = 900;
const CURSOR_IDLE = 1400;
const MAX_EDITS = 60;
const MAX_GHOSTS = 6;
const FALLBACK_COLOR = '#8B5CF6';
const EASE = 'cubic-bezier(0.22, 0.8, 0.24, 1)';

/** Paint-only properties tweened when an agent restyles a layer (camelCase, kebab-case). */
const PAINT: Array<[string, string]> = [
  ['backgroundColor', 'background-color'],
  ['color', 'color'],
  ['borderTopColor', 'border-top-color'],
  ['borderRightColor', 'border-right-color'],
  ['borderBottomColor', 'border-bottom-color'],
  ['borderLeftColor', 'border-left-color'],
  ['outlineColor', 'outline-color'],
  ['borderTopLeftRadius', 'border-top-left-radius'],
  ['borderTopRightRadius', 'border-top-right-radius'],
  ['borderBottomRightRadius', 'border-bottom-right-radius'],
  ['borderBottomLeftRadius', 'border-bottom-left-radius'],
  ['boxShadow', 'box-shadow'],
  ['textShadow', 'text-shadow'],
  ['opacity', 'opacity'],
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['filter', 'filter'],
];

/** Node-targeted reads that get a scan highlight. */
const READS = new Set(['get_screenshot', 'get_jsx', 'get_computed_styles', 'get_node_info', 'get_children', 'get_fill_image', 'export']);

type Kind = 'box' | 'text' | 'image' | 'svg' | 'fade';

interface Reveal {
  id: string;
  el: Element;
  node: NodeRecord;
  kind: Kind;
  agent: string;
  /** Start time (performance.now) and animation length. */
  at: number;
  dur: number;
  clip: Element | null;
}

interface TypePath {
  lines: Array<{ x0: number; x1: number; y0: number; y1: number }>;
  total: number;
}

interface Fx {
  type: 'outline' | 'pulse' | 'morph' | 'caret' | 'scan' | 'mark';
  id: string;
  el: Element;
  agent: string;
  t0: number;
  t1: number;
  /** outline: fully drawn until this time. */
  hold?: number;
  node?: NodeRecord;
  clip?: Element | null;
  /** morph: the box before the change, in world coordinates. */
  from?: Rect;
  path?: TypePath;
}

interface Cursor {
  agent: string;
  el: HTMLDivElement;
  label: HTMLSpanElement;
  look: string;
  x: number;
  y: number;
  placed: boolean;
  target: Element | null;
  caret: Fx | null;
  until: number;
}

interface Edit {
  id: string;
  box: Rect;
  paint: Record<string, string> | null;
  text: boolean;
  /** A copy of the old look, dissolved over the new one (changes that can't tween: gradients, images, SVG). */
  ghost: Ghost | null;
}

interface Ghost {
  el: HTMLElement | SVGElement;
  box: Rect;
  /** clip-path keeping the copy inside its artboard, like the canvas. */
  clip: string | null;
}

/** What a patch will animate, decided before it is applied. */
export interface LivePlan {
  agent: string | null;
  created: string[];
  edits: Edit[];
  ghosts: Ghost[];
  /** Ids changed by someone else: their pending reveals finish now. */
  touched: string[];
}

const pending = new Map<string, Reveal>();
let queue: Reveal[] = [];
let fxs: Fx[] = [];
const running = new Set<Animation>();
const cursors = new Map<string, Cursor>();
const actorNames = new Map<string, string>();
let frame = 0;
let lastFrame = 0;
let suspended = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;
let hud: HTMLCanvasElement | null = null;
let ghostLayer: HTMLElement | null = null;
let cursorLayer: HTMLElement | null = null;

const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!motion?.matches;

// ---- patch hooks (called by the sync session) --------------------------------

/** Inspect a patch before it is applied: old boxes, old paint, what to hide. */
export function planLive(fileId: string, patch: Patch, actor: ActorInfo, label: string): LivePlan | null {
  const doc = getState().doc;
  if (!doc || doc.id !== fileId || !patch.nodes) return null;
  const { upsert, remove } = patch.nodes;
  const animate =
    actor.kind === 'agent' && !/^(Undo|Redo) /.test(label) && !suspended && !!getViewportElement() && document.visibilityState === 'visible';
  if (!animate) {
    for (const id of remove) drop(id);
    return { agent: null, created: [], edits: [], ghosts: [], touched: upsert.map((n) => n.id) };
  }
  actorNames.set(actor.id, actor.name);
  const reduce = reducedMotion();
  const ghosts = reduce ? [] : captureGhosts(doc, remove);
  for (const id of remove) drop(id);
  const created: string[] = [];
  const edits: Edit[] = [];
  let swaps = 0;
  for (const n of upsert) {
    if (n.component === 'PageRoot') continue;
    const old = doc.nodes[n.id];
    if (!old) {
      created.push(n.id);
      continue;
    }
    // Still waiting to appear: it will build with its final look.
    if (pending.has(n.id) || edits.length >= MAX_EDITS) continue;
    const text = n.component === 'Text' && old.textValue !== n.textValue;
    const runs = old.textRuns !== n.textRuns && JSON.stringify(old.textRuns) !== JSON.stringify(n.textRuns);
    const media = old.src !== n.src || old.svg !== n.svg;
    if (!text && !runs && !media && old.parentId === n.parentId && sameStyles(old.styles, n.styles)) continue;
    const el = elementFor(n.id);
    if (!el || el.closest(`[${PENDING}]`)) continue;
    // Gradients, images and SVG markup can't tween: the old look dissolves over the new one instead.
    const swap = !reduce && swaps < MAX_GHOSTS && (media || imageFillChanged(old.styles, n.styles));
    const ghost = swap ? snapshot(el, old) : null;
    if (ghost) swaps++;
    edits.push({ id: n.id, box: worldBox(el), paint: reduce ? null : readPaint(el), text, ghost });
  }
  return { agent: actor.id, created, edits, ghosts, touched: [] };
}

function imageFillChanged(a: NodeRecord['styles'], b: NodeRecord['styles']): boolean {
  if (a.backgroundImage === b.backgroundImage && a.background === b.background) return false;
  return [a.backgroundImage, a.background, b.backgroundImage, b.background].some((v) => /gradient|url\(/i.test(String(v ?? '')));
}

/** Run right after the patch is committed to the DOM, before the browser paints. */
export function applyLive(plan: LivePlan): void {
  revalidate();
  if (!plan.agent) {
    for (const id of plan.touched) reveal(id);
    return;
  }
  const now = performance.now();
  const reduce = reducedMotion();
  for (const g of plan.ghosts) showGhost(g);
  for (const e of plan.edits) animateEdit(e, plan.agent, now, reduce);
  if (plan.created.length) build(plan.created, plan.agent, now, reduce);
  kick();
}

/** Presence update: scan the layer an agent just read. */
export function noteAgentReads(next: AgentPresence[], prev: AgentPresence[]): void {
  if (suspended || reducedMotion() || document.visibilityState !== 'visible') return;
  const now = performance.now();
  for (const a of next) {
    if (!a.lastTool || !READS.has(a.lastTool) || !a.lastNodeId) continue;
    const before = prev.find((p) => p.sessionId === a.sessionId);
    if (before && before.lastActiveAt >= a.lastActiveAt) continue;
    const el = elementFor(a.lastNodeId);
    const node = getState().doc?.nodes[a.lastNodeId];
    if (!el || !node || el.closest(`[${PENDING}]`)) continue;
    fxs.push({ type: 'scan', id: node.id, el, agent: a.sessionId, t0: now, t1: now + SCAN_MS, node });
    aim(a.sessionId, el, now);
    kick();
  }
}

/** Show everything in its final state now (page/file switch, capture, hidden tab). */
export function flushLive(): void {
  for (const r of pending.values()) r.el.removeAttribute(PENDING);
  pending.clear();
  queue = [];
  for (const a of [...running]) a.cancel();
  running.clear();
  fxs = [];
  ghostLayer?.replaceChildren();
  for (const c of cursors.values()) c.el.remove();
  cursors.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  clearHud();
}

/** Finish every reveal and keep new ones instant until released (screenshots). */
export function suspendLive(): () => void {
  suspended++;
  flushLive();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspended--;
  };
}

/** Canvas overlay parts (mounted by LiveLayer). */
export function attachLiveLayer(canvas: HTMLCanvasElement | null, ghosts: HTMLElement | null): () => void {
  hud = canvas;
  ghostLayer = ghosts;
  return () => {
    flushLive();
    if (hud === canvas) hud = null;
    if (ghostLayer === ghosts) ghostLayer = null;
  };
}

export function attachLiveCursors(layer: HTMLElement | null): () => void {
  cursorLayer = layer;
  return () => {
    for (const c of cursors.values()) c.el.remove();
    cursors.clear();
    if (cursorLayer === layer) cursorLayer = null;
  };
}

// Nothing may stay hidden across a page or file switch, a hidden tab or a motion preference change.
useEditor.subscribe((s, prev) => {
  if (s.pageId !== prev.pageId || s.doc?.id !== prev.doc?.id) flushLive();
});
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') flushLive();
  });
}
motion?.addEventListener('change', () => flushLive());

// ---- building new layers -----------------------------------------------------

function build(ids: string[], agent: string, now: number, reduce: boolean) {
  const s = getState();
  const doc = s.doc;
  const page = doc && s.pageId ? doc.pages[s.pageId] : undefined;
  if (!doc || !page) return;
  const created = new Set(ids);
  const order = treeOrder(doc, page.rootId, created);
  if (!order.length) return;
  const els = elementsOf(order, created);
  const vr = viewportRect();
  const clips = new Map<Element, Element | null>();
  // Reads first (one layout), writes after.
  const items: Reveal[] = [];
  for (const id of order) {
    const el = els.get(id);
    const node = doc.nodes[id];
    if (!el || !node) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    // Offscreen layers appear at once.
    if (r.right < vr.left - 80 || r.left > vr.right + 80 || r.bottom < vr.top - 80 || r.top > vr.bottom + 80) continue;
    items.push({ id, el, node, kind: kindOf(node), agent, at: 0, dur: 0, clip: clipOf(el, clips) });
  }
  if (!items.length) return;
  if (reduce) {
    // Minimal motion: no hiding, just a brief highlight on the written groups.
    for (const it of items) {
      if (it.node.parentId && created.has(it.node.parentId)) continue;
      fxs.push({ type: 'mark', id: it.id, el: it.el, agent, t0: now, t1: now + 900, node: it.node, clip: it.clip });
    }
    return;
  }
  const start = squeeze(now);
  const n = items.length;
  const step = Math.min(STEP_MAX, SPAN / n);
  const pace = n > 80 ? 0.7 : n > 30 ? 0.85 : 1;
  items.forEach((it, i) => {
    it.at = start + i * step;
    it.dur = durationOf(it, pace);
    it.el.setAttribute(PENDING, '');
    pending.set(it.id, it);
    queue.push(it);
  });
  armWatchdog();
}

/** Earlier layers still waiting catch up quickly so the canvas never falls behind the agent. */
function squeeze(now: number): number {
  queue = queue.filter((r) => pending.get(r.id) === r);
  const n = queue.length;
  if (!n) return now;
  const window = Math.min(BURST, n * 8);
  for (let i = 0; i < n; i++) queue[i]!.at = Math.min(queue[i]!.at, now + (window * i) / n);
  return Math.max(now, queue[n - 1]!.at + 16);
}

/** Pre-order walk of the page: containers before their children, siblings in order. */
function treeOrder(doc: PaperDocument, rootId: string, ids: Set<string>): string[] {
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = doc.nodes[id];
    if (!n || (!n.isVisible && n.component !== 'PageRoot')) continue;
    if (ids.has(id)) out.push(id);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

function elementsOf(order: string[], ids: Set<string>): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const id of order) {
    if (out.has(id)) continue;
    const el = elementFor(id);
    if (!el) continue;
    out.set(id, el);
    for (const d of Array.from(el.querySelectorAll('[data-op-id]'))) {
      const did = d.getAttribute('data-op-id')!;
      if (ids.has(did) && !out.has(did)) out.set(did, d);
    }
  }
  return out;
}

/** The artboard (top-level layer) that clips this element's effects, if it clips. */
function clipOf(el: Element, cache: Map<Element, Element | null>): Element | null {
  let top: Element = el;
  while (top.parentElement && !top.parentElement.hasAttribute('data-op-world')) top = top.parentElement;
  if (top === el || !top.parentElement) return null;
  if (!cache.has(top)) {
    const cs = getComputedStyle(top);
    cache.set(top, cs.overflowX !== 'visible' || cs.overflowY !== 'visible' ? top : null);
  }
  return cache.get(top) ?? null;
}

function kindOf(n: NodeRecord): Kind {
  switch (n.component) {
    case 'Frame':
    case 'Rectangle':
      return 'box';
    case 'Text':
      return 'text';
    case 'Image':
      return 'image';
    case 'SVG':
      return 'svg';
    default:
      return 'fade';
  }
}

function durationOf(r: Reveal, pace: number): number {
  switch (r.kind) {
    case 'text':
      return Math.round(Math.min(620, Math.max(160, (r.node.textValue?.length ?? 0) * 14)) * pace);
    case 'image':
      return 520 * pace;
    case 'svg':
      return 380 * pace;
    case 'fade':
      return 600 * pace;
    default:
      return 420 * pace;
  }
}

function begin(r: Reveal, now: number, instant: boolean) {
  let el = r.el;
  if (!el.isConnected) {
    const fresh = elementFor(r.id);
    if (!fresh) return;
    el = fresh;
  }
  // Start the animation before unhiding: both land in the same frame.
  if (!instant) animateIn(el, r, now);
  el.removeAttribute(PENDING);
  if (instant) return;
  fxs.push({ type: 'outline', id: r.id, el, agent: r.agent, t0: r.at - LEAD, hold: now + r.dur, t1: now + r.dur + FADE, node: r.node, clip: r.clip });
}

function has(styles: NodeRecord['styles'], key: string): boolean {
  const v = styles[key];
  return v !== undefined && v !== null && v !== '';
}

function animateIn(el: Element, r: Reveal, now: number) {
  const st = r.node.styles;
  let kind = r.kind;
  if (kind === 'text') {
    const path = el instanceof HTMLElement && !has(st, 'clipPath') ? typePath(el) : null;
    if (path) {
      play(el, typeFrames(path, (el as HTMLElement).offsetWidth), { duration: r.dur, easing: 'linear' });
      const caret: Fx = { type: 'caret', id: r.id, el, agent: r.agent, t0: now, t1: now + r.dur, path };
      fxs.push(caret);
      aim(r.agent, el, now, caret);
      return;
    }
    kind = 'box';
  }
  aim(r.agent, el, now);
  // Layers with their own clip-path, opacity or filter keep them: pick an effect that leaves them alone.
  if ((kind === 'image' && (has(st, 'opacity') || has(st, 'filter'))) || (kind === 'fade' && has(st, 'opacity'))) kind = 'box';
  if ((kind === 'box' || kind === 'svg') && has(st, 'clipPath')) {
    if (has(st, 'opacity')) return;
    kind = 'fade';
  }
  switch (kind) {
    case 'box':
      play(el, [{ clipPath: 'inset(0px -40px 100% -40px)' }, { clipPath: 'inset(-40px -40px -40px -40px)' }], { duration: r.dur, easing: EASE });
      break;
    case 'svg':
      play(el, [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }], { duration: r.dur, easing: EASE });
      break;
    case 'image':
      play(el, [{ opacity: 0, filter: 'blur(12px)' }, { opacity: 1, filter: 'blur(0px)' }], { duration: r.dur, easing: 'ease-out' });
      break;
    case 'fade':
      play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: r.dur, easing: 'ease-out' });
      break;
  }
}

function play(el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions) {
  try {
    const a = el.animate(frames, timing);
    running.add(a);
    const done = () => running.delete(a);
    a.onfinish = done;
    a.oncancel = done;
  } catch {
    // A value the browser can't animate: show the final state.
  }
}

/** Line boxes of a text layer in its own (unzoomed) coordinates. */
function typePath(el: HTMLElement): TypePath | null {
  const w = el.offsetWidth;
  const box = el.getBoundingClientRect();
  if (!w || !el.offsetHeight || !box.width) return null;
  const zoom = camera().zoom || 1;
  const s = box.width / w;
  // Rotated or scaled by an ancestor: line boxes would not map back cleanly.
  if (Math.abs(s - zoom) > zoom * 0.02 || Math.abs(box.height / el.offsetHeight - zoom) > zoom * 0.02) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const lines: TypePath['lines'] = [];
  for (const q of Array.from(range.getClientRects())) {
    if (q.width < 0.5 || q.height < 0.5) continue;
    const l = { x0: (q.left - box.left) / s, x1: (q.right - box.left) / s, y0: (q.top - box.top) / s, y1: (q.bottom - box.top) / s };
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y0 - l.y0) < 2 && Math.abs(last.y1 - l.y1) < 2) {
      last.x0 = Math.min(last.x0, l.x0);
      last.x1 = Math.max(last.x1, l.x1);
    } else lines.push(l);
  }
  const total = lines.reduce((t, l) => t + (l.x1 - l.x0), 0);
  if (!lines.length || lines.length > 60 || total < 1) return null;
  return { lines, total };
}

/** clip-path keyframes that uncover the text line by line, left to right. */
function typeFrames(p: TypePath, width: number): Keyframe[] {
  const pad = 8;
  let left = 0;
  let right = width;
  for (const l of p.lines) {
    left = Math.min(left, l.x0);
    right = Math.max(right, l.x1);
  }
  const L = left - pad;
  const R = right + pad;
  const poly = (y0: number, x: number, y1: number) =>
    `polygon(${L}px ${-pad}px, ${R}px ${-pad}px, ${R}px ${y0}px, ${x}px ${y0}px, ${x}px ${y1}px, ${L}px ${y1}px)`;
  const frames: Keyframe[] = [];
  let acc = 0;
  for (const l of p.lines) {
    frames.push({ offset: Math.min(1, acc / p.total), clipPath: poly(l.y0, l.x0, l.y1) });
    acc += l.x1 - l.x0;
    frames.push({ offset: Math.min(1, acc / p.total), clipPath: poly(l.y0, l.x1, l.y1) });
  }
  frames[frames.length - 1]!.offset = 1;
  return frames;
}

/** Where the typing head is (unzoomed, element coordinates). */
function headOf(p: TypePath, t: number): { x: number; y0: number; y1: number } {
  let left = Math.max(0, Math.min(1, t)) * p.total;
  for (const l of p.lines) {
    const w = l.x1 - l.x0;
    if (left <= w) return { x: l.x0 + left, y0: l.y0, y1: l.y1 };
    left -= w;
  }
  const last = p.lines[p.lines.length - 1]!;
  return { x: last.x1, y0: last.y0, y1: last.y1 };
}

// ---- edits and deletions -----------------------------------------------------

function animateEdit(e: Edit, agent: string, now: number, reduce: boolean) {
  const el = elementFor(e.id);
  const node = getState().doc?.nodes[e.id];
  if (!el || !node) return;
  const clip = clipOf(el, new Map());
  if (reduce) {
    fxs.push({ type: 'mark', id: e.id, el, agent, t0: now, t1: now + 900, node, clip });
    return;
  }
  if (e.paint) {
    const after = readPaint(el);
    const from: Keyframe = {};
    const to: Keyframe = {};
    let changed = false;
    for (const [camel] of PAINT) {
      if (e.paint[camel] === after[camel]) continue;
      from[camel] = e.paint[camel]!;
      to[camel] = after[camel]!;
      changed = true;
    }
    if (changed) play(el, [from, to], { duration: EDIT_MS, easing: EASE });
  }
  if (e.text && el instanceof HTMLElement && !has(node.styles, 'clipPath')) {
    const path = typePath(el);
    if (path) {
      const dur = Math.min(620, Math.max(160, (node.textValue?.length ?? 0) * 14));
      play(el, typeFrames(path, el.offsetWidth), { duration: dur, easing: 'linear' });
      const caret: Fx = { type: 'caret', id: e.id, el, agent, t0: now, t1: now + dur, path };
      fxs.push(caret);
      aim(agent, el, now, caret);
    }
  }
  if (e.ghost) showGhost(e.ghost, EDIT_MS, false);
  const box = worldBox(el);
  if (Math.abs(box.x - e.box.x) + Math.abs(box.y - e.box.y) + Math.abs(box.width - e.box.width) + Math.abs(box.height - e.box.height) > 1) {
    fxs.push({ type: 'morph', id: e.id, el, agent, t0: now, t1: now + MORPH_MS + FADE, from: e.box, node, clip });
  }
  fxs.push({ type: 'pulse', id: e.id, el, agent, t0: now, t1: now + PULSE_MS, node, clip });
  if (!e.text) aim(agent, el, now);
}

function readPaint(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const [camel, kebab] of PAINT) out[camel] = cs.getPropertyValue(kebab);
  return out;
}

function sameStyles(a: NodeRecord['styles'], b: NodeRecord['styles']): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

/** Snapshot removed groups so they can fade out after React unmounts them. */
function captureGhosts(doc: PaperDocument, removed: string[]): Ghost[] {
  if (!removed.length || !ghostLayer) return [];
  const gone = new Set(removed);
  const out: Ghost[] = [];
  for (const id of removed) {
    if (out.length >= MAX_GHOSTS) break;
    const node = doc.nodes[id];
    if (!node || node.component === 'PageRoot' || (node.parentId && gone.has(node.parentId)) || pending.has(id)) continue;
    const el = elementFor(id);
    const ghost = el && !el.closest(`[${PENDING}]`) ? snapshot(el, node) : null;
    if (ghost) out.push(ghost);
  }
  return out;
}

/** A detached copy of a layer as it looks now, placed at its world box. */
function snapshot(el: Element, node: NodeRecord): Ghost | null {
  if (!ghostLayer || !(el instanceof HTMLElement || el instanceof SVGElement)) return null;
  const st = node.styles;
  if (has(st, 'transform') || has(st, 'rotate') || has(st, 'scale')) return null;
  if (el.getElementsByTagName('*').length > 400) return null;
  const box = worldBox(el);
  const zoom = camera().zoom;
  if (box.width * zoom < 2 || box.height * zoom < 2) return null;
  const board = clipOf(el, new Map());
  let clip: string | null = null;
  if (board) {
    const c = worldBox(board);
    const inset = [c.y - box.y, box.x + box.width - (c.x + c.width), box.y + box.height - (c.y + c.height), c.x - box.x].map((v) => Math.max(0, v));
    if (inset.some((v) => v > 0)) clip = `inset(${inset.map((v) => `${v}px`).join(' ')})`;
  }
  const clone = el.cloneNode(true) as HTMLElement | SVGElement;
  // A ghost is not a layer: nothing may find it by id.
  clone.removeAttribute('data-op-id');
  for (const d of Array.from(clone.querySelectorAll('[data-op-id]'))) d.removeAttribute('data-op-id');
  const from = el.querySelectorAll('canvas');
  const to = clone.querySelectorAll('canvas');
  from.forEach((c, i) => {
    const d = to[i];
    if (!d || !c.width || !c.height) return;
    d.width = c.width;
    d.height = c.height;
    try {
      d.getContext('2d')?.drawImage(c, 0, 0);
    } catch {
      // Tainted or lost context: the ghost shows the layer box only.
    }
  });
  return { el: clone, box, clip };
}

/** Fade a snapshot out over the canvas: deletions dissolve, unanimatable edits crossfade. */
function showGhost(g: Ghost, ms = GHOST_MS, blur = true) {
  if (!ghostLayer) return;
  syncGhostLayer(true);
  const wrap = document.createElement('div');
  wrap.className = 'op-live-ghost';
  Object.assign(wrap.style, { left: `${g.box.x}px`, top: `${g.box.y}px`, width: `${g.box.width}px`, height: `${g.box.height}px` });
  if (g.clip) wrap.style.clipPath = g.clip;
  Object.assign(g.el.style, {
    position: 'absolute',
    left: '0px',
    top: '0px',
    right: 'auto',
    bottom: 'auto',
    margin: '0px',
    width: `${g.box.width}px`,
    height: `${g.box.height}px`,
    flex: 'none',
    translate: 'none',
  });
  wrap.appendChild(g.el);
  ghostLayer.appendChild(wrap);
  try {
    const a = wrap.animate([{ opacity: 1, filter: 'blur(0px)' }, { opacity: 0, filter: blur ? 'blur(3px)' : 'blur(0px)' }], {
      duration: ms,
      easing: blur ? 'ease-in' : 'ease-in-out',
      fill: 'forwards',
    });
    a.onfinish = () => wrap.remove();
    a.oncancel = () => wrap.remove();
  } catch {
    wrap.remove();
  }
}

/** Keep the ghost layer on the camera (and give it the file's token variables). */
function syncGhostLayer(withVars = false) {
  if (!ghostLayer) return;
  const cam = camera();
  ghostLayer.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
  if (!withVars) return;
  const world = getViewportElement()?.querySelector('[data-op-world]') as HTMLElement | null;
  if (!world) return;
  for (let i = 0; i < world.style.length; i++) {
    const p = world.style.item(i);
    if (p.startsWith('--')) ghostLayer.style.setProperty(p, world.style.getPropertyValue(p));
  }
}

// ---- bookkeeping -------------------------------------------------------------

/** Reveal a waiting layer now, without animation. */
function reveal(id: string) {
  const r = pending.get(id);
  if (!r) return;
  pending.delete(id);
  r.el.removeAttribute(PENDING);
}

function drop(id: string) {
  reveal(id);
  if (fxs.some((f) => f.id === id)) fxs = fxs.filter((f) => f.id !== id);
}

/** Waiting layers whose element React replaced (moved, or a different kind) stay hidden. */
function revalidate() {
  for (const r of pending.values()) {
    if (r.el.isConnected) continue;
    const el = elementFor(r.id);
    if (el) {
      el.setAttribute(PENDING, '');
      r.el = el;
    } else pending.delete(r.id);
  }
}

function armWatchdog() {
  if (watchdog) clearTimeout(watchdog);
  const last = queue.length ? queue[queue.length - 1]!.at : performance.now();
  watchdog = setTimeout(
    () => {
      watchdog = null;
      // Frames stopped (throttled or detached): never leave layers hidden.
      if (pending.size && performance.now() - lastFrame > 1000) flushLive();
    },
    Math.max(0, last - performance.now()) + 2500
  );
}

function worldBox(el: Element): Rect {
  const r = el.getBoundingClientRect();
  const vr = viewportRect();
  const cam = camera();
  const z = cam.zoom || 1;
  return { x: (r.left - vr.left - cam.x) / z, y: (r.top - vr.top - cam.y) / z, width: r.width / z, height: r.height / z };
}

// ---- frame loop --------------------------------------------------------------

function kick() {
  if (frame) return;
  lastFrame = performance.now();
  frame = requestAnimationFrame(tick);
}

function tick() {
  frame = 0;
  const now = performance.now();
  const dt = now - lastFrame;
  const late = dt > 400;
  lastFrame = now;
  while (queue.length && queue[0]!.at <= now) {
    const r = queue.shift()!;
    if (pending.get(r.id) !== r) continue;
    pending.delete(r.id);
    begin(r, now, late || now - r.at > LATE);
  }
  if (ghostLayer?.firstChild) syncGhostLayer();
  fxs = fxs.filter((f) => now < f.t1 && f.el.isConnected);
  draw(now);
  moveCursors(now, Math.min(dt, 100));
  if (queue.length || fxs.length || cursors.size || ghostLayer?.firstChild) frame = requestAnimationFrame(tick);
  else clearHud();
}

function clearHud() {
  const ctx = hud?.getContext('2d');
  if (ctx && hud) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, hud.width, hud.height);
  }
  dirty = null;
}

// ---- drawing -----------------------------------------------------------------

type Box = { x: number; y: number; w: number; h: number };

/** What the last frame drew: only that part is cleared and repainted. */
let dirty: Box | null = null;

function union(a: Box | null, b: Box): Box {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function screenBox(el: Element, vr: DOMRect): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left - vr.left, y: r.top - vr.top, w: r.width, h: r.height };
}

/** Corner radius of a layer on screen (first value of border-radius). */
function radiusOf(node: NodeRecord | undefined, b: Box, zoom: number): number {
  const raw = node?.styles.borderRadius;
  if (raw === undefined || raw === null) return 0;
  const first = String(raw).trim().split(/\s+/)[0] ?? '';
  const n = parseFloat(first);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const r = first.endsWith('%') ? (Math.min(b.w, b.h) * n) / 100 : first.endsWith('px') || /^[\d.]+$/.test(first) ? n * zoom : 0;
  return Math.min(r, b.w / 2, b.h / 2);
}

function withClip(ctx: CanvasRenderingContext2D, clip: Element | null | undefined, vr: DOMRect, paint: () => void) {
  if (!clip?.isConnected) return paint();
  const c = screenBox(clip, vr);
  ctx.save();
  ctx.beginPath();
  ctx.rect(c.x, c.y, c.w, c.h);
  ctx.clip();
  paint();
  ctx.restore();
}

function strokeBox(ctx: CanvasRenderingContext2D, b: Box, radius: number, color: string, alpha: number, width: number) {
  if (alpha <= 0.01 || b.w <= 0 || b.h <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  const i = width / 2;
  ctx.beginPath();
  ctx.roundRect(b.x + i, b.y + i, Math.max(0, b.w - width), Math.max(0, b.h - width), Math.max(0, radius - i));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** A soft band of the agent's colour sweeping across a layer (dir 1 = down, -1 = up). */
function band(ctx: CanvasRenderingContext2D, b: Box, radius: number, color: string, t: number, alpha: number, dir: 1 | -1) {
  if (alpha <= 0.005 || b.h <= 0) return;
  const size = Math.max(14, b.h * 0.45);
  const y = dir === 1 ? b.y - size + t * (b.h + size) : b.y + b.h - t * (b.h + size);
  const g = ctx.createLinearGradient(0, y, 0, y + size);
  g.addColorStop(0, 'transparent');
  g.addColorStop(0.5, color);
  g.addColorStop(1, 'transparent');
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, radius);
  ctx.clip();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.fillRect(b.x, y, b.w, size);
  ctx.restore();
}

const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

function draw(now: number) {
  if (!hud) return;
  const ctx = hud.getContext('2d');
  if (!ctx) return;
  const vr = viewportRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(vr.width * dpr));
  const h = Math.max(1, Math.round(vr.height * dpr));
  if (hud.width !== w || hud.height !== h) {
    hud.width = w;
    hud.height = h;
    dirty = null;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (dirty) ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
  let drawn: Box | null = null;
  const touch = (b: Box) => (drawn = union(drawn, { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }));
  const zoom = camera().zoom || 1;
  const colors = new Map<string, string>();
  const colorOf = (agent: string) => {
    let c = colors.get(agent);
    if (!c) colors.set(agent, (c = agentLook(agent).color));
    return c;
  };
  // On screen and big enough to be worth an outline.
  const visible = (b: Box) => b.x < vr.width && b.y < vr.height && b.x + b.w > 0 && b.y + b.h > 0 && (b.w >= 4 || b.h >= 4);

  // Layers about to build: their outline appears first, while they are still hidden.
  for (const r of queue) {
    if (r.at - LEAD > now) break;
    if (pending.get(r.id) !== r || !r.el.isConnected) continue;
    const b = screenBox(r.el, vr);
    if (!visible(b)) continue;
    touch(b);
    withClip(ctx, r.clip, vr, () => strokeBox(ctx, b, radiusOf(r.node, b, zoom), colorOf(r.agent), ((now - (r.at - LEAD)) / LEAD) * 0.9, 1.25));
  }

  for (const f of fxs) {
    if (now < f.t0) continue;
    const color = colorOf(f.agent);
    const b = screenBox(f.el, vr);
    if (!visible(b) && f.type !== 'morph') continue;
    touch(b);
    if (f.type === 'morph') {
      const cam = camera();
      touch({ x: f.from!.x * cam.zoom + cam.x, y: f.from!.y * cam.zoom + cam.y, w: f.from!.width * cam.zoom, h: f.from!.height * cam.zoom });
    }
    const radius = radiusOf(f.node, b, zoom);
    const t = (now - f.t0) / (f.t1 - f.t0);
    withClip(ctx, f.clip, vr, () => {
      switch (f.type) {
        case 'outline': {
          const a = now < f.t0 + LEAD ? (now - f.t0) / LEAD : now < f.hold! ? 1 : 1 - (now - f.hold!) / FADE;
          strokeBox(ctx, b, radius, color, a * 0.9, 1.25);
          break;
        }
        case 'pulse': {
          const a = now - f.t0 < 120 ? (now - f.t0) / 120 : Math.min(1, (f.t1 - now) / 450);
          band(ctx, b, radius, color, ease((now - f.t0) / 650), 0.16 * Math.sin(Math.PI * Math.min(1, (now - f.t0) / 650)), 1);
          strokeBox(ctx, b, radius, color, a, 1.5);
          break;
        }
        case 'mark':
          strokeBox(ctx, b, radius, color, 1 - t, 1.5);
          break;
        case 'scan':
          band(ctx, b, radius, color, ease(t), 0.18 * Math.sin(Math.PI * t), -1);
          strokeBox(ctx, b, radius, color, 0.55 * Math.sin(Math.PI * t), 1);
          break;
        case 'morph': {
          const cam = camera();
          const from = f.from!;
          const fb: Box = { x: from.x * cam.zoom + cam.x, y: from.y * cam.zoom + cam.y, w: from.width * cam.zoom, h: from.height * cam.zoom };
          const k = ease((now - f.t0) / MORPH_MS);
          const m: Box = { x: fb.x + (b.x - fb.x) * k, y: fb.y + (b.y - fb.y) * k, w: fb.w + (b.w - fb.w) * k, h: fb.h + (b.h - fb.h) * k };
          const a = now < f.t0 + MORPH_MS ? 1 : 1 - (now - f.t0 - MORPH_MS) / FADE;
          ctx.setLineDash([4, 3]);
          strokeBox(ctx, m, radius, color, a, 1.5);
          ctx.setLineDash([]);
          break;
        }
        case 'caret': {
          const p = f.path!;
          const head = headOf(p, t);
          const s = b.w / ((f.el as HTMLElement).offsetWidth || b.w || 1);
          ctx.globalAlpha = 1;
          ctx.fillStyle = color;
          ctx.fillRect(b.x + head.x * s - 1, b.y + head.y0 * s, 2, Math.max(4, (head.y1 - head.y0) * s));
          break;
        }
      }
    });
  }
  dirty = drawn;
}

// ---- agent cursors -----------------------------------------------------------

function agentLook(id: string): { color: string; name: string } {
  const a = getState().agents.find((x) => x.sessionId === id);
  return { color: a?.color ?? FALLBACK_COLOR, name: a?.name ?? actorNames.get(id) ?? 'Agent' };
}

/** Point an agent's cursor at what it is building now. */
function aim(agent: string, el: Element, now: number, caret: Fx | null = null) {
  if (!cursorLayer || reducedMotion()) return;
  let c = cursors.get(agent);
  if (!c) {
    const root = document.createElement('div');
    root.className = 'op-live-cursor';
    root.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 2.2v12.6l3.4-3.2 2.3 4.9 2.3-1-2.3-4.8h4.7z" fill="var(--c)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const label = document.createElement('span');
    label.className = 'op-live-cursor-name';
    root.appendChild(label);
    cursorLayer.appendChild(root);
    c = { agent, el: root, label, look: '', x: 0, y: 0, placed: false, target: null, caret: null, until: 0 };
    cursors.set(agent, c);
  }
  c.target = el;
  c.caret = caret;
  c.until = now + CURSOR_IDLE;
}

function moveCursors(now: number, dt: number) {
  if (!cursors.size) return;
  const vr = viewportRect();
  for (const c of [...cursors.values()]) {
    const look = agentLook(c.agent);
    const key = `${look.color}|${look.name}`;
    if (c.look !== key) {
      c.look = key;
      c.el.style.setProperty('--c', look.color);
      c.label.textContent = look.name;
    }
    const on = now < c.until && !!c.target?.isConnected;
    if (on && c.target) {
      const b = screenBox(c.target, vr);
      let p: { x: number; y: number };
      if (c.caret && now < c.caret.t1) {
        const head = headOf(c.caret.path!, (now - c.caret.t0) / (c.caret.t1 - c.caret.t0));
        const s = b.w / ((c.target as HTMLElement).offsetWidth || b.w || 1);
        p = { x: b.x + head.x * s + 2, y: b.y + head.y1 * s - 2 };
      } else p = { x: b.x + Math.min(18, b.w * 0.3), y: b.y + Math.min(14, b.h * 0.35) };
      if (!c.placed || Math.hypot(p.x - c.x, p.y - c.y) > 1600) {
        c.x = p.x;
        c.y = p.y;
        c.placed = true;
      } else {
        const k = 1 - Math.exp(-dt / 70);
        c.x += (p.x - c.x) * k;
        c.y += (p.y - c.y) * k;
      }
      c.el.style.transform = `translate(${c.x - 3}px, ${c.y - 2}px)`;
    }
    c.el.classList.toggle('on', on);
    if (!on && now > c.until + 500) {
      c.el.remove();
      cursors.delete(c.agent);
    }
  }
}
