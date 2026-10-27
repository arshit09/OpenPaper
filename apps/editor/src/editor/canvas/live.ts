import type { ActorInfo, AgentPresence, NodeRecord, PaperDocument, Patch } from '@openpaper/core';
import { camera, getState, useEditor } from '../../state/store.ts';
import { elementFor, getViewportElement, muteVideos, viewportRect, type Rect } from './geometry.ts';

/**
 * Live preview of agent edits. The server applies each tool call at once; the editor plays the
 * change back as if the agent drew it by hand. Each agent has one pen that goes through the new
 * layers in tree order: it traces a layer's outline (an SVG's own paths, which draw themselves
 * under it) and the layer fills in from where the pen closed it; text types in a character at a
 * time. The agent's cursor rides the pen and lifts between layers. Style edits tween and
 * deletions fade out.
 *
 * Presentation only. Layers wait with `visibility: hidden` and animate clip-path, opacity, filter
 * and paint properties (Web Animations), never layout, so measuring, hit-testing and the document
 * are final at every moment. User edits, undo and redo stay instant.
 */

const PENDING = 'data-op-pending';
const FADE = 260;
/** The fill flooding in from where the pen closed an outline. */
const FILL = 240;
/** Typing speed per character, and the longest a text takes. */
const CHAR_MS = 16;
const TYPE_MAX = 1400;
/** Longer texts type a few characters per step. */
const TYPE_STEPS = 400;
/** A write's drawing speeds up to fit in SPAN; when the next write lands, what is left catches up within CATCHUP. */
const SPAN = 5000;
const CATCHUP = 800;
/** Pen-up hops between the paths of an SVG cost this share of their length in time. */
const PEN_UP = 0.35;
const SHAPE_FILL = 180;
const MAX_SVG_PARTS = 150;
const MAX_SVG_SAMPLES = 4000;
/** Reveals this overdue (throttled tab, long task) appear without animation. */
const LATE = 600;
const EDIT_MS = 520;
const PULSE_MS = 950;
const MORPH_MS = 420;
const GHOST_MS = 320;
const SCAN_MS = 900;
const CURSOR_IDLE = 1400;
/** The I-beam sits this far right of the caret, clear of the text it types. */
const IBEAM_DX = 7;
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

/** SVG parts the pen draws, and containers whose content never renders directly. */
const SVG_PARTS = 'path, circle, ellipse, rect, line, polyline, polygon, text, image, use, foreignObject';
const SVG_UNDRAWN = 'defs, clipPath, mask, symbol, pattern, marker';

type Kind = 'box' | 'text' | 'image' | 'svg' | 'fade';

/** A polyline of the pen, in its layer's box normalized to 0..1 (so it survives pan and zoom). */
interface Stroke {
  /** x, y pairs. */
  pts: number[];
  /** Where each point falls on the pen's timeline (screen px at plan time). */
  acc: number[];
  /** Drawn on the HUD. Off where the layer's own stroke draws itself under the pen. */
  ink: boolean;
}

interface Pen {
  strokes: Stroke[];
  /** Timeline length: strokes plus pen-up hops. */
  total: number;
  /** Normalized bounds of every point (some SVG paths overflow their box). */
  bounds: [number, number, number, number];
}

/** A text's characters on their lines, in its own (unzoomed) coordinates. */
interface Typing {
  lines: Array<{ y0: number; y1: number }>;
  /** After each step: the line it is on and how far that line is typed. */
  line: number[];
  x: number[];
  /** Where the first character starts, and the text's horizontal extent. */
  x0: number;
  left: number;
  right: number;
  chars: number;
}

/** One part of an SVG and when the pen draws it (positions on the pen's timeline). */
interface Part {
  el: Element;
  from: number;
  to: number;
  /** Stroke length to draw with a dash (user units), and the cap overhang hidden before it starts. */
  dash: number | null;
  cap: number;
  /** Values to fade back to: a stroke that can't dash, the fill, or the opacity of a non-path part. */
  stroke: string | null;
  fill: string | null;
  opacity: string | null;
}

interface Reveal {
  id: string;
  el: Element;
  node: NodeRecord;
  kind: Kind;
  agent: string;
  /** Pen down (performance.now), drawing time, the pen-up move before it and the fill after it. */
  at: number;
  dur: number;
  travel: number;
  fill: number;
  /** Timings at full speed; `scale` < 1 once a big write or a backlog sped them up. */
  base: { dur: number; travel: number };
  scale: number;
  clip: Element | null;
  /** What the pen draws, measured on `geo` (re-measured when React replaced it or a later write changed it). */
  pen: Pen | null;
  typing: Typing | null;
  parts: Part[] | null;
  geo: Element | null;
  stale: boolean;
}

interface Fx {
  type: 'pen' | 'type' | 'pulse' | 'morph' | 'scan' | 'mark';
  id: string;
  el: Element;
  agent: string;
  t0: number;
  t1: number;
  /** pen, type: drawing until this time. */
  hold?: number;
  node?: NodeRecord;
  clip?: Element | null;
  /** morph: the box before the change, in world coordinates. */
  from?: Rect;
  pen?: Pen;
  typing?: Typing;
}

/** A point on a layer, normalized to its box. */
interface Anchor {
  el: Element;
  u: number;
  v: number;
}

interface Cursor {
  agent: string;
  el: HTMLDivElement;
  label: HTMLSpanElement;
  look: string;
  x: number;
  y: number;
  placed: boolean;
  /** What it draws now, and the layer that belongs to (its fill may still be running). */
  pen: Fx | null;
  drawing: Reveal | null;
  /** The layer it is heading for, and where and when it set off. */
  dest: Reveal | null;
  fromX: number;
  fromY: number;
  fromAt: number;
  /** Where the pen last lifted: the cursor rests there, on the canvas. */
  rest: Anchor | null;
  /** The layer it points at outside a drawing (edits, reads). */
  target: Element | null;
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
    const waiting = pending.get(n.id);
    if (waiting) {
      waiting.stale = true;
      continue;
    }
    if (edits.length >= MAX_EDITS) continue;
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
    items.push({
      id,
      el,
      node,
      kind: kindOf(node),
      agent,
      at: 0,
      dur: 0,
      travel: 0,
      fill: FILL,
      base: { dur: 0, travel: 0 },
      scale: 1,
      clip: clipOf(el, clips),
      pen: null,
      typing: null,
      parts: null,
      geo: null,
      stale: false,
    });
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
  // Layout-only frames (no fill, border or shadow) have nothing to draw: their content draws itself.
  const drawn = items.filter((it) => it.kind !== 'box' || paints(getComputedStyle(it.el)));
  if (!drawn.length) return;
  for (const it of drawn) it.base.dur = measure(it, it.el);

  // The pen goes from layer to layer: each move starts where the last drawing ended.
  const c = cursorFor(agent);
  const prev = backlog(agent);
  const active = c?.pen ? c.drawing : null;
  const tail = prev[prev.length - 1] ?? active;
  let last: { x: number; y: number } | null = tail ? endPoint(tail, vr) : c?.placed ? { x: c.x, y: c.y } : null;
  for (const it of drawn) {
    const p = startPoint(it, vr);
    it.base.travel = last ? clamp(60 + Math.hypot(p.x - last.x, p.y - last.y) * 0.2, 70, 260) : 160;
    last = endPoint(it, vr);
  }
  pace(prev, CATCHUP);
  pace(drawn, SPAN);
  schedule([...prev, ...drawn], Math.max(now, c?.pen?.hold ?? now), active);
  for (const it of drawn) {
    it.el.setAttribute(PENDING, '');
    pending.set(it.id, it);
    queue.push(it);
  }
  queue.sort((a, b) => a.at - b.at);
  armWatchdog();
}

/** This agent's layers still waiting for the pen (in drawing order). */
function backlog(agent: string): Reveal[] {
  queue = queue.filter((r) => pending.get(r.id) === r);
  return queue.filter((r) => r.agent === agent);
}

/** Speed a run of drawings up to fit in a time budget (never slows one back down). */
function pace(list: Reveal[], budget: number) {
  if (!list.length) return;
  const total = list.reduce((t, r) => t + r.base.travel + r.base.dur, 0);
  const f = total > budget ? budget / total : 1;
  for (const r of list) {
    r.scale = Math.min(r.scale, f);
    r.travel = r.base.travel * r.scale;
    r.dur = Math.max(24, r.base.dur * r.scale);
    r.fill = FILL * Math.max(0.5, r.scale);
  }
}

/** One pen: drawings follow each other, separated by the move to the next. */
function schedule(list: Reveal[], start: number, active: Reveal | null) {
  let t = start;
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    let at = t + r.travel;
    // Inside a layer still filling in: wait until the fill covers it. An outline can start
    // tracing a bit earlier, since its own fill comes after it.
    const wait = (p: Reveal) => {
      if (p.el === r.el || !p.el.contains(r.el)) return;
      const need = p.at + p.dur + p.fill * 0.6;
      at = Math.max(at, r.typing || r.parts ? need : need - r.dur);
    };
    if (active) wait(active);
    for (let j = i - 1; j >= Math.max(0, i - 24); j--) wait(list[j]!);
    r.at = at;
    t = at + r.dur;
  }
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

const CLEAR = /^transparent$|[,/]\s*0(\.0*)?\s*\)$/;

/** Does a box paint anything of its own (fill, border, shadow)? */
function paints(cs: CSSStyleDeclaration): boolean {
  if (!CLEAR.test(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none') return true;
  if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
  if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) return true;
  return (['Top', 'Right', 'Bottom', 'Left'] as const).some(
    (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && !CLEAR.test(cs[`border${s}Color`])
  );
}

function has(styles: NodeRecord['styles'], key: string): boolean {
  const v = styles[key];
  return v !== undefined && v !== null && v !== '';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Work out what the pen draws on `el`. Returns the drawing time at full speed. */
function measure(r: Reveal, el: Element): number {
  r.geo = el;
  r.stale = false;
  r.pen = r.typing = r.parts = null;
  const st = r.node.styles;
  const box = el.getBoundingClientRect();
  if (r.kind === 'text' && el instanceof HTMLElement && !has(st, 'clipPath')) {
    r.typing = typingOf(el);
    if (r.typing) return typeTime(r.typing);
  }
  if (r.kind === 'svg' && el instanceof SVGSVGElement) {
    const d = svgDrawing(el, box);
    if (d) {
      r.pen = d.pen;
      r.parts = d.parts;
      return clamp(180 + d.pen.total * 0.35, 280, 1200);
    }
  }
  r.pen = outlineOf(el, box);
  return clamp(110 + r.pen.total * 0.22, 150, 600);
}

function begin(r: Reveal, now: number, instant: boolean) {
  let el = r.el;
  if (!el.isConnected) {
    const fresh = elementFor(r.id);
    if (!fresh) return;
    el = fresh;
  }
  if (!instant) {
    if (r.stale || el !== r.geo) {
      r.node = getState().doc?.nodes[r.id] ?? r.node;
      measure(r, el);
    }
    // Start the animation before unhiding: both land in the same frame.
    startDrawing(el, r, now);
  }
  el.removeAttribute(PENDING);
}

function startDrawing(el: Element, r: Reveal, now: number) {
  if (r.typing && el instanceof HTMLElement) {
    play(el, typeFrames(r.typing, el.offsetWidth), { duration: r.dur, easing: 'linear' });
    penDown({ type: 'type', id: r.id, el, agent: r.agent, t0: now, hold: now + r.dur, t1: now + r.dur, typing: r.typing, clip: r.clip }, r);
    return;
  }
  if (r.parts) drawSvg(r.parts, r.pen!.total, r.dur);
  else fillIn(el, r);
  penDown({ type: 'pen', id: r.id, el, agent: r.agent, t0: now, hold: now + r.dur, t1: now + r.dur + FADE, pen: r.pen!, node: r.node, clip: r.clip }, r);
}

/** After the outline: the layer floods in from where the pen closed it. */
function fillIn(el: Element, r: Reveal) {
  const st = r.node.styles;
  const timing: KeyframeAnimationOptions = { duration: r.fill, delay: r.dur, fill: 'backwards', easing: EASE };
  // A layer with its own clip-path keeps it: fade instead, or just wait if it has its own opacity too.
  if (has(st, 'clipPath')) {
    if (has(st, 'opacity')) play(el, [{ visibility: 'hidden' }, { visibility: 'hidden' }], { duration: r.dur });
    else play(el, [{ opacity: 0 }, { opacity: 1 }], { ...timing, easing: 'ease-out' });
    return;
  }
  const box = el.getBoundingClientRect();
  const [w, h] = localSize(el, box);
  const [u, v] = r.pen ? headAt(r.pen, r.pen.total) : [0, 0];
  const x = u * w;
  const y = v * h;
  // Past the farthest corner, with room for shadows.
  const radius = Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) + 120;
  const from: Keyframe = { clipPath: `circle(0px at ${x}px ${y}px)` };
  const to: Keyframe = { clipPath: `circle(${radius}px at ${x}px ${y}px)` };
  if (r.kind === 'image' && !has(st, 'filter') && !has(st, 'opacity')) {
    from.filter = 'blur(10px)';
    to.filter = 'blur(0px)';
  }
  play(el, [from, to], timing);
}

/** An SVG draws itself under the pen: strokes dash in, fills and other parts fade in once traced. */
function drawSvg(parts: Part[], total: number, dur: number) {
  const time = (d: number) => (d / (total || 1)) * dur;
  for (const p of parts) {
    const from = time(p.from);
    const span = Math.max(1, time(p.to) - from);
    if (p.dash !== null) {
      const dash = `${p.dash}px ${p.dash + 2 * p.cap}px`;
      play(p.el, [{ strokeDasharray: dash, strokeDashoffset: `${p.dash + p.cap}px` }, { strokeDasharray: dash, strokeDashoffset: '0px' }], {
        delay: from,
        duration: span,
        fill: 'backwards',
        easing: 'linear',
      });
    } else if (p.stroke !== null) {
      play(p.el, [{ strokeOpacity: 0 }, { strokeOpacity: p.stroke }], { delay: from, duration: span, fill: 'backwards', easing: 'linear' });
    }
    if (p.fill !== null) {
      play(p.el, [{ fillOpacity: 0 }, { fillOpacity: p.fill }], { delay: from + span, duration: SHAPE_FILL, fill: 'backwards', easing: 'ease-out' });
    }
    if (p.opacity !== null) {
      play(p.el, [{ opacity: 0 }, { opacity: p.opacity }], { delay: from, duration: SHAPE_FILL, fill: 'backwards', easing: 'ease-out' });
    }
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

// ---- pen geometry ------------------------------------------------------------

/** A layer's size in its own (unzoomed) pixels. */
function localSize(el: Element, box: DOMRect): [number, number] {
  if (el instanceof HTMLElement && el.offsetWidth && el.offsetHeight) return [el.offsetWidth, el.offsetHeight];
  const z = camera().zoom || 1;
  return [Math.max(1, box.width / z), Math.max(1, box.height / z)];
}

/** Corner radii [tl x, tl y, tr x, tr y, br x, br y, bl x, bl y], scaled down like CSS when they overlap. */
function cornerRadii(cs: CSSStyleDeclaration, w: number, h: number): number[] {
  const len = (s: string, of: number) => (s.endsWith('%') ? (parseFloat(s) * of) / 100 : parseFloat(s)) || 0;
  const out: number[] = [];
  for (const v of [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]) {
    const [a = '0', b = a] = v.trim().split(/\s+/);
    out.push(Math.max(0, len(a, w)), Math.max(0, len(b, h)));
  }
  const fit = (side: number, a: number, b: number) => (a + b > side ? side / (a + b) : 1);
  const f = Math.min(fit(w, out[0]!, out[2]!), fit(h, out[3]!, out[5]!), fit(w, out[4]!, out[6]!), fit(h, out[7]!, out[1]!));
  return out.map((r) => r * f);
}

function penOf(strokes: Stroke[], total: number): Pen {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i < s.pts.length; i += 2) {
      x0 = Math.min(x0, s.pts[i]!);
      x1 = Math.max(x1, s.pts[i]!);
      y0 = Math.min(y0, s.pts[i + 1]!);
      y1 = Math.max(y1, s.pts[i + 1]!);
    }
  }
  return { strokes, total, bounds: [x0, y0, x1, y1] };
}

/** A box's outline, clockwise from its top-left corner like drawing it by hand. */
function outlineOf(el: Element, box: DOMRect): Pen {
  const pts: number[] = [];
  if (box.width < 3 || box.height < 3) {
    // A rule or a dot: one stroke along it.
    if (box.width >= box.height) pts.push(0, 0.5, 1, 0.5);
    else pts.push(0.5, 0, 0.5, 1);
  } else {
    const [w, h] = localSize(el, box);
    const [tlx, tly, trx, tr_y, brx, bry, blx, bly] = cornerRadii(getComputedStyle(el), w, h) as [number, number, number, number, number, number, number, number];
    const at = (x: number, y: number) => pts.push(x / w, y / h);
    const arc = (cx: number, cy: number, rx: number, ry: number, a0: number) => {
      if (rx < 0.5 || ry < 0.5) return;
      for (let i = 1; i <= 8; i++) {
        const a = a0 + (i / 8) * (Math.PI / 2);
        at(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
      }
    };
    at(tlx, 0);
    at(w - trx, 0);
    arc(w - trx, tr_y, trx, tr_y, -Math.PI / 2);
    at(w, h - bry);
    arc(w - brx, h - bry, brx, bry, 0);
    at(blx, h);
    arc(blx, h - bly, blx, bly, Math.PI / 2);
    at(0, tly);
    arc(tlx, tly, tlx, tly, Math.PI);
  }
  const acc: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (i) total += Math.hypot((pts[i]! - pts[i - 2]!) * box.width, (pts[i + 1]! - pts[i - 1]!) * box.height);
    acc.push(total);
  }
  return penOf([{ pts, acc, ink: true }], total);
}

/** Trace an SVG's own paths, in document order, sampled in screen space. */
function svgDrawing(svg: SVGSVGElement, box: DOMRect): { pen: Pen; parts: Part[] } | null {
  if (box.width < 1 || box.height < 1) return null;
  const els = Array.from(svg.querySelectorAll(SVG_PARTS));
  if (!els.length || els.length > MAX_SVG_PARTS) return null;
  const strokes: Stroke[] = [];
  const parts: Part[] = [];
  let total = 0;
  let samples = 0;
  let lx = NaN;
  let ly = NaN;
  for (const el of els) {
    if (el.closest(SVG_UNDRAWN)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const fade = (): Part => ({ el, from: total, to: total, dash: null, cap: 0, stroke: null, fill: null, opacity: cs.opacity });
    if (!(el instanceof SVGGeometryElement)) {
      parts.push(fade());
      continue;
    }
    const width = parseFloat(cs.strokeWidth) || 0;
    const stroked = cs.stroke !== 'none' && width > 0;
    const filled = cs.fill !== 'none';
    if (!stroked && !filled) continue;
    let len = 0;
    try {
      len = el.getTotalLength();
    } catch {
      len = 0;
    }
    const m = el.getScreenCTM();
    if (!m || !(len > 0)) {
      parts.push(fade());
      continue;
    }
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const n = clamp(Math.ceil((len * scale) / 5), 6, 96);
    samples += n + 1;
    if (samples > MAX_SVG_SAMPLES) return null;
    // A move inside the path (a new subpath) shows up as a jump between samples.
    const jump = ((len * scale) / n) * 3 + 2;
    const dashes = stroked && cs.strokeDasharray === 'none';
    let stroke: Stroke | null = null;
    let from = total;
    let px = 0;
    let py = 0;
    for (let i = 0; i <= n; i++) {
      const q = el.getPointAtLength((len * i) / n);
      const x = m.a * q.x + m.c * q.y + m.e;
      const y = m.b * q.x + m.d * q.y + m.f;
      if (!stroke) {
        if (!Number.isNaN(lx)) total += Math.hypot(x - lx, y - ly) * PEN_UP;
        from = total;
        stroke = { pts: [], acc: [], ink: !dashes };
      } else {
        const d = Math.hypot(x - px, y - py);
        if (d > jump) {
          strokes.push(stroke);
          stroke = { pts: [], acc: [], ink: !dashes };
        } else total += d;
      }
      stroke.pts.push((x - box.left) / box.width, (y - box.top) / box.height);
      stroke.acc.push(total);
      px = x;
      py = y;
    }
    strokes.push(stroke!);
    lx = px;
    ly = py;
    // pathLength rescales dash units.
    const declared = parseFloat(el.getAttribute('pathLength') ?? '');
    const units = declared > 0 ? declared / len : 1;
    parts.push({
      el,
      from,
      to: total,
      dash: dashes ? len * units : null,
      cap: width * units,
      stroke: stroked && !dashes ? cs.strokeOpacity : null,
      fill: filled ? cs.fillOpacity : null,
      opacity: null,
    });
  }
  if (total < 1 || !strokes.length) return null;
  return { pen: penOf(strokes, total), parts };
}

/** Where the pen is after `d` of its timeline (normalized to the layer's box). */
function headAt(p: Pen, d: number): [number, number] {
  let prev: Stroke | null = null;
  for (const s of p.strokes) {
    const { pts, acc } = s;
    if (d < acc[0]!) {
      if (!prev) return [pts[0]!, pts[1]!];
      // Pen up, between two strokes.
      const n = prev.pts.length;
      const e = prev.acc[prev.acc.length - 1]!;
      const k = (d - e) / (acc[0]! - e || 1);
      return [prev.pts[n - 2]! + (pts[0]! - prev.pts[n - 2]!) * k, prev.pts[n - 1]! + (pts[1]! - prev.pts[n - 1]!) * k];
    }
    if (d <= acc[acc.length - 1]!) {
      if (acc.length === 1) return [pts[0]!, pts[1]!];
      let i = 1;
      while (i < acc.length - 1 && acc[i]! < d) i++;
      const k = (d - acc[i - 1]!) / (acc[i]! - acc[i - 1]! || 1);
      return [pts[2 * i - 2]! + (pts[2 * i]! - pts[2 * i - 2]!) * k, pts[2 * i - 1]! + (pts[2 * i + 1]! - pts[2 * i - 1]!) * k];
    }
    prev = s;
  }
  const last = p.strokes[p.strokes.length - 1]!.pts;
  return [last[last.length - 2]!, last[last.length - 1]!];
}

// ---- typing ------------------------------------------------------------------

/** Each character of a text layer on its line, in the layer's own (unzoomed) coordinates. */
function typingOf(el: HTMLElement): Typing | null {
  const w = el.offsetWidth;
  const box = el.getBoundingClientRect();
  if (!w || !el.offsetHeight || !box.width) return null;
  const zoom = camera().zoom || 1;
  const s = box.width / w;
  // Rotated or scaled by an ancestor: character boxes would not map back cleanly.
  if (Math.abs(s - zoom) > zoom * 0.02 || Math.abs(box.height / el.offsetHeight - zoom) > zoom * 0.02) return null;
  const texts: Text[] = [];
  let chars = 0;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    texts.push(n as Text);
    chars += (n as Text).length;
  }
  if (!chars) return null;
  const per = Math.ceil(chars / TYPE_STEPS);
  const range = document.createRange();
  const t: Typing = { lines: [], line: [], x: [], x0: 0, left: Infinity, right: -Infinity, chars };
  for (const node of texts) {
    const data = node.data;
    for (let i = 0; i < data.length; ) {
      let j = Math.min(data.length, i + per);
      // Keep surrogate pairs together.
      if (j < data.length && /[\uDC00-\uDFFF]/.test(data[j]!)) j++;
      range.setStart(node, i);
      range.setEnd(node, j);
      i = j;
      const rects = range.getClientRects();
      const q = rects[rects.length - 1];
      // Collapsed whitespace has no box.
      if (!q || q.width < 0.3 || q.height < 0.5) continue;
      const x0 = (q.left - box.left) / s;
      const x1 = (q.right - box.left) / s;
      const y0 = (q.top - box.top) / s;
      const y1 = (q.bottom - box.top) / s;
      const cur = t.lines[t.lines.length - 1];
      if (!cur || (y0 + y1) / 2 > cur.y1) t.lines.push({ y0, y1 });
      else {
        cur.y0 = Math.min(cur.y0, y0);
        cur.y1 = Math.max(cur.y1, y1);
      }
      if (!t.x.length) t.x0 = x0;
      t.line.push(t.lines.length - 1);
      t.x.push(x1);
      t.left = Math.min(t.left, x0);
      t.right = Math.max(t.right, x1);
    }
  }
  if (!t.x.length || t.lines.length > 80) return null;
  return t;
}

/** clip-path keyframes that uncover the text a character at a time, line by line. */
function typeFrames(t: Typing, width: number): Keyframe[] {
  const pad = 8;
  const top = Math.min(-pad, t.lines[0]!.y0 - pad);
  const L = Math.min(0, t.left) - pad;
  const R = Math.max(width, t.right) + pad;
  const poly = (line: number, x: number) => {
    const { y0, y1 } = t.lines[line]!;
    return `polygon(${L}px ${top}px, ${R}px ${top}px, ${R}px ${y0}px, ${x}px ${y0}px, ${x}px ${y1}px, ${L}px ${y1}px)`;
  };
  const n = t.x.length;
  // step-end: each character appears whole, as it is typed.
  const frames: Keyframe[] = [{ offset: 0, clipPath: poly(0, t.x0), easing: 'step-end' }];
  for (let i = 0; i < n; i++) frames.push({ offset: (i + 1) / n, clipPath: poly(t.line[i]!, t.x[i]!), easing: 'step-end' });
  return frames;
}

/** The caret after `p` (0..1) of the typing. */
function caretAt(t: Typing, p: number): { x: number; y0: number; y1: number } {
  const n = t.x.length;
  const k = clamp(Math.floor(p * n), 0, n);
  const line = t.lines[k ? t.line[k - 1]! : 0]!;
  return { x: k ? t.x[k - 1]! : t.x0, y0: line.y0, y1: line.y1 };
}

function typeTime(t: Typing): number {
  return clamp(t.chars * CHAR_MS, 120, TYPE_MAX);
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
  let typed = false;
  if (e.text && el instanceof HTMLElement && !has(node.styles, 'clipPath')) {
    const t = typingOf(el);
    if (t) {
      const dur = typeTime(t);
      play(el, typeFrames(t, el.offsetWidth), { duration: dur, easing: 'linear' });
      typed = penDown({ type: 'type', id: e.id, el, agent, t0: now, hold: now + dur, t1: now + dur, typing: t, clip }, null, true);
    }
  }
  if (e.ghost) showGhost(e.ghost, EDIT_MS, false);
  const box = worldBox(el);
  if (Math.abs(box.x - e.box.x) + Math.abs(box.y - e.box.y) + Math.abs(box.width - e.box.width) + Math.abs(box.height - e.box.height) > 1) {
    fxs.push({ type: 'morph', id: e.id, el, agent, t0: now, t1: now + MORPH_MS + FADE, from: e.box, node, clip });
  }
  fxs.push({ type: 'pulse', id: e.id, el, agent, t0: now, t1: now + PULSE_MS, node, clip });
  if (!typed) aim(agent, el, now);
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
  muteVideos(clone);
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

/** Clear the outlines and release the HUD's viewport-sized bitmap until the next drawing. */
function clearHud() {
  if (hud) {
    hud.width = 0;
    hud.height = 0;
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

/** Screen pixels per unzoomed pixel of a layer. */
function scaleOf(el: Element, b: Box): number {
  return b.w / ((el as HTMLElement).offsetWidth || b.w || 1);
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

/** The pen's ink up to `upto` along its timeline: only where it has already been. */
function ink(ctx: CanvasRenderingContext2D, p: Pen, b: Box, upto: number, color: string, alpha: number) {
  if (alpha <= 0.01 || upto <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (const s of p.strokes) {
    const { pts, acc } = s;
    if (acc[0]! >= upto) break;
    if (!s.ink) continue;
    let x = b.x + pts[0]! * b.w;
    let y = b.y + pts[1]! * b.h;
    ctx.moveTo(x, y);
    for (let i = 1; i < acc.length; i++) {
      const nx = b.x + pts[2 * i]! * b.w;
      const ny = b.y + pts[2 * i + 1]! * b.h;
      if (acc[i]! > upto) {
        const k = (upto - acc[i - 1]!) / (acc[i]! - acc[i - 1]! || 1);
        ctx.lineTo(x + (nx - x) * k, y + (ny - y) * k);
        break;
      }
      ctx.lineTo(nx, ny);
      x = nx;
      y = ny;
    }
  }
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
const easeInOut = (t: number) => {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
};

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

  for (const f of fxs) {
    if (now < f.t0) continue;
    const color = colorOf(f.agent);
    const b = screenBox(f.el, vr);
    if (f.pen) {
      const [x0, y0, x1, y1] = f.pen.bounds;
      const pb = { x: b.x + x0 * b.w, y: b.y + y0 * b.h, w: (x1 - x0) * b.w, h: (y1 - y0) * b.h };
      if (pb.x > vr.width || pb.y > vr.height || pb.x + pb.w < 0 || pb.y + pb.h < 0) continue;
      touch(pb);
    } else {
      if (!visible(b) && f.type !== 'morph') continue;
      touch(b);
    }
    if (f.type === 'morph') {
      const cam = camera();
      touch({ x: f.from!.x * cam.zoom + cam.x, y: f.from!.y * cam.zoom + cam.y, w: f.from!.width * cam.zoom, h: f.from!.height * cam.zoom });
    }
    const radius = radiusOf(f.node, b, zoom);
    const t = (now - f.t0) / (f.t1 - f.t0);
    withClip(ctx, f.clip, vr, () => {
      switch (f.type) {
        case 'pen': {
          const p = f.pen!;
          const drawing = now < f.hold!;
          const upto = drawing ? ((now - f.t0) / (f.hold! - f.t0)) * p.total : p.total;
          ink(ctx, p, b, upto, color, drawing ? 0.95 : 0.95 * (1 - (now - f.hold!) / FADE));
          break;
        }
        case 'type': {
          const head = caretAt(f.typing!, t);
          const s = scaleOf(f.el, b);
          ctx.globalAlpha = 1;
          ctx.fillStyle = color;
          ctx.fillRect(b.x + head.x * s - 1, b.y + head.y0 * s, 2, Math.max(4, (head.y1 - head.y0) * s));
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

function cursorFor(agent: string): Cursor | null {
  if (!cursorLayer || reducedMotion()) return null;
  let c = cursors.get(agent);
  if (c) return c;
  const root = document.createElement('div');
  root.className = 'op-live-cursor';
  root.innerHTML =
    '<svg class="op-live-arrow" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 2.2v12.6l3.4-3.2 2.3 4.9 2.3-1-2.3-4.8h4.7z" fill="var(--c)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
    '<svg class="op-live-ibeam" width="10" height="20" viewBox="0 0 10 20" aria-hidden="true"><path d="M2 2.5h6M5 2.5v15M2 17.5h6" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M2 2.5h6M5 2.5v15M2 17.5h6" fill="none" stroke="var(--c)" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const label = document.createElement('span');
  label.className = 'op-live-cursor-name';
  root.appendChild(label);
  cursorLayer.appendChild(root);
  c = {
    agent,
    el: root,
    label,
    look: '',
    x: 0,
    y: 0,
    placed: false,
    pen: null,
    drawing: null,
    dest: null,
    fromX: 0,
    fromY: 0,
    fromAt: 0,
    rest: null,
    target: null,
    until: 0,
  };
  cursors.set(agent, c);
  return c;
}

/** The cursor rides this stroke or caret until it is done. Returns false if it is busy drawing. */
function penDown(f: Fx, r: Reveal | null, onlyIfIdle = false): boolean {
  fxs.push(f);
  const c = cursorFor(f.agent);
  if (!c || (onlyIfIdle && (c.pen || nextFor(f.agent)))) return false;
  c.pen = f;
  c.drawing = r;
  c.dest = null;
  c.rest = null;
  c.target = null;
  return true;
}

/** Point an agent's cursor at a layer it is editing or reading (unless it is busy drawing). */
function aim(agent: string, el: Element, now: number) {
  const c = cursorFor(agent);
  if (!c || c.pen || nextFor(agent)) return;
  c.target = el;
  c.rest = null;
  c.until = Math.max(c.until, now + CURSOR_IDLE);
}

/** The next layer this agent's pen will draw. */
function nextFor(agent: string): Reveal | null {
  for (const r of queue) if (r.agent === agent && pending.get(r.id) === r) return r;
  return null;
}

/** Where the cursor puts the pen down on a layer (screen, viewport-relative). */
function startPoint(r: Reveal, vr: DOMRect): { x: number; y: number } {
  const b = screenBox(r.el, vr);
  if (r.typing) {
    const s = scaleOf(r.el, b);
    const l = r.typing.lines[0]!;
    return { x: b.x + r.typing.x0 * s + IBEAM_DX, y: b.y + ((l.y0 + l.y1) / 2) * s };
  }
  const [u, v] = r.pen ? headAt(r.pen, 0) : [0, 0];
  return { x: b.x + u * b.w, y: b.y + v * b.h };
}

/** Where the cursor lifts the pen off a layer. */
function endPoint(r: Reveal, vr: DOMRect): { x: number; y: number } {
  const b = screenBox(r.el, vr);
  if (r.typing) {
    const h = caretAt(r.typing, 1);
    const s = scaleOf(r.el, b);
    return { x: b.x + h.x * s + IBEAM_DX, y: b.y + ((h.y0 + h.y1) / 2) * s };
  }
  const [u, v] = r.pen ? headAt(r.pen, r.pen.total) : [0, 0];
  return { x: b.x + u * b.w, y: b.y + v * b.h };
}

/** The tip of a stroke or caret being drawn now. */
function headPoint(f: Fx, now: number, vr: DOMRect): { x: number; y: number } {
  const b = screenBox(f.el, vr);
  const t = clamp((now - f.t0) / Math.max(1, f.hold! - f.t0), 0, 1);
  if (f.typing) {
    const h = caretAt(f.typing, t);
    const s = scaleOf(f.el, b);
    return { x: b.x + h.x * s + IBEAM_DX, y: b.y + ((h.y0 + h.y1) / 2) * s };
  }
  const [u, v] = headAt(f.pen!, t * f.pen!.total);
  return { x: b.x + u * b.w, y: b.y + v * b.h };
}

function anchorOf(p: { x: number; y: number }, el: Element, vr: DOMRect): Anchor {
  const b = screenBox(el, vr);
  return { el, u: (p.x - b.x) / (b.w || 1), v: (p.y - b.y) / (b.h || 1) };
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
    // Pen lifted: rest where it ended, on the canvas.
    if (c.pen && (now >= c.pen.hold! || !c.pen.el.isConnected)) {
      if (c.pen.el.isConnected) c.rest = anchorOf(headPoint(c.pen, c.pen.hold!, vr), c.pen.el, vr);
      c.pen = null;
    }
    let p: { x: number; y: number } | null = null;
    let smooth = false;
    const next = c.pen ? null : nextFor(c.agent);
    if (c.pen) p = headPoint(c.pen, now, vr);
    else if (next) {
      // Pen up: glide to where the next drawing starts, arriving as it does.
      if (c.dest !== next) {
        c.dest = next;
        c.fromX = c.x;
        c.fromY = c.y;
        c.fromAt = now;
      }
      const to = startPoint(next, vr);
      if (!c.placed) p = to;
      else {
        const t0 = Math.max(c.fromAt, next.at - next.travel);
        const k = easeInOut((now - t0) / Math.max(1, next.at - t0));
        p = { x: c.fromX + (to.x - c.fromX) * k, y: c.fromY + (to.y - c.fromY) * k };
      }
    } else if (c.target?.isConnected && now < c.until) {
      const b = screenBox(c.target, vr);
      p = { x: b.x + Math.min(18, b.w * 0.3), y: b.y + Math.min(14, b.h * 0.35) };
      smooth = true;
    } else if (c.rest?.el.isConnected) {
      const b = screenBox(c.rest.el, vr);
      p = { x: b.x + c.rest.u * b.w, y: b.y + c.rest.v * b.h };
    }
    if (p) {
      if (!c.placed || !smooth || Math.hypot(p.x - c.x, p.y - c.y) > 1600) {
        c.x = p.x;
        c.y = p.y;
        c.placed = true;
      } else {
        const k = 1 - Math.exp(-dt / 70);
        c.x += (p.x - c.x) * k;
        c.y += (p.y - c.y) * k;
      }
      c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
    }
    c.el.classList.toggle('type', c.pen?.type === 'type');
    // Shown while drawing or heading for the next layer, then a moment after.
    if (c.pen || next) c.until = Math.max(c.until, now + CURSOR_IDLE);
    const on = now < c.until && c.placed;
    c.el.classList.toggle('on', on);
    if (!on && now > c.until + 500) {
      c.el.remove();
      cursors.delete(c.agent);
    }
  }
}
