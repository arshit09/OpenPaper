/** Editor operations behind keyboard shortcuts. Every document change is an editor command. */
import { FREEFORM_DISPLAY, parentKindOf, pxValue, type NodeRecord, type StyleInput } from '@openpaper/core';
import { camera, getState, setCamera, setState } from '../state/store.ts';
import { client, command } from '../sync/session.ts';
import { chainOf, elementFor, rectsIntersect, unionRects, viewportRect, worldRectOf, type Rect } from './canvas/geometry.ts';
import { fitRect } from './canvas/interactions.ts';
import { fitCamera, inferFlex, opacityFromDigits, readingOrder } from './canvas/canvas-math.ts';
import { insertImageFiles, PLACEABLE_FILES } from './clipboard.ts';

// ---- helpers -------------------------------------------------------------------

function doc() {
  return getState().doc;
}

export function selectedNodes(): NodeRecord[] {
  const s = getState();
  return s.doc ? s.selection.map((id) => s.doc!.nodes[id]).filter((n): n is NodeRecord => !!n) : [];
}

function parentOf(n: NodeRecord): NodeRecord | undefined {
  return n.parentId ? doc()?.nodes[n.parentId] : undefined;
}

/** Placed by left/top (canvas, freeform frames, absolute) rather than by layout. */
function isPositioned(n: NodeRecord): boolean {
  const kind = parentKindOf(parentOf(n));
  return kind === 'root' || kind === 'freeform' || n.styles.position === 'absolute' || n.styles.position === 'fixed';
}

function byParent(nodes: NodeRecord[]): Map<string, NodeRecord[]> {
  const map = new Map<string, NodeRecord[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    map.set(n.parentId, [...(map.get(n.parentId) ?? []), n]);
  }
  return map;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => `${round2(n)}px`;

function updateStyles(updates: Array<{ nodeIds: string[]; styles: StyleInput }>) {
  if (updates.length) void command({ type: 'updateStyles', updates });
}

/** Style patch that moves a positioned layer by (dx, dy), keeping right/bottom anchoring. */
function shiftStyles(n: NodeRecord, dx: number, dy: number): StyleInput {
  const el = elementFor(n.id) as HTMLElement | null;
  const styles: StyleInput = {};
  if (dx) {
    const left = pxValue(n.styles.left);
    const rightPx = pxValue(n.styles.right);
    if (left === null && rightPx !== null) styles.right = px(rightPx - dx);
    else styles.left = px((left ?? el?.offsetLeft ?? 0) + dx);
  }
  if (dy) {
    const top = pxValue(n.styles.top);
    const bottomPx = pxValue(n.styles.bottom);
    if (top === null && bottomPx !== null) styles.bottom = px(bottomPx - dy);
    else styles.top = px((top ?? el?.offsetTop ?? 0) + dy);
  }
  return styles;
}

/** A frame's content area (padding box) in world coordinates. */
function paddingBox(id: string): Rect | null {
  const el = elementFor(id) as HTMLElement | null;
  const r = worldRectOf(id);
  if (!el || !r) return null;
  return { x: r.x + el.clientLeft, y: r.y + el.clientTop, width: el.clientWidth || r.width, height: el.clientHeight || r.height };
}

let toastSeq = 0;
const channels = new Map<string, number>();
/** A toast that replaces the previous one on the same channel (no stacking while keys repeat). */
export function notify(channel: string, text: string, ms = 1600) {
  const id = -++toastSeq;
  const prev = channels.get(channel);
  channels.set(channel, id);
  setState((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== prev), { id, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

// ---- view ----------------------------------------------------------------------

/** Pan just enough to bring the layers into view. */
export function reveal(ids: string[], margin = 40) {
  const r = unionRects(ids.map((id) => worldRectOf(id)).filter((x): x is Rect => !!x));
  if (!r) return;
  const cam = camera();
  const vr = viewportRect();
  const axis = (start: number, size: number, view: number) => {
    if (size > view - margin * 2) return view / 2 - (start + size / 2);
    if (start < margin) return margin - start;
    if (start + size > view - margin) return view - margin - (start + size);
    return 0;
  };
  const dx = axis(r.x * cam.zoom + cam.x, r.width * cam.zoom, vr.width);
  const dy = axis(r.y * cam.zoom + cam.y, r.height * cam.zoom, vr.height);
  if (dx || dy) setCamera({ ...cam, x: cam.x + dx, y: cam.y + dy });
}

function zoomedToFit(box: Rect, padding: number): boolean {
  const cam = camera();
  const target = fitCamera(box, viewportRect(), padding, 4);
  return Math.abs(cam.zoom - target.zoom) / target.zoom < 0.01 && Math.abs(cam.x - target.x) < 4 && Math.abs(cam.y - target.y) < 4;
}

/** N / Shift+N: zoom to the next or previous artboard in reading order. */
export function goToArtboard(direction: 1 | -1) {
  const s = getState();
  const d = s.doc;
  if (!d || !s.pageId) return;
  const root = d.nodes[d.pages[s.pageId]!.rootId]!;
  const boards = readingOrder(
    root.children
      .filter((id) => d.nodes[id]?.isVisible !== false)
      .map((id) => ({ id, box: worldRectOf(id)! }))
      .filter((b) => b.box && b.box.width > 0 && b.box.height > 0)
  );
  if (!boards.length) return;
  const n = boards.length;
  const first = s.selection[0];
  const current = first ? boards.findIndex((b) => b.id === chainOf(d, first).at(-1)?.id) : -1;
  let index: number;
  if (current >= 0) index = zoomedToFit(boards[current]!.box, 50) ? (current + direction + n) % n : current;
  else {
    const fitted = boards.findIndex((b) => zoomedToFit(b.box, 50));
    if (fitted >= 0) index = (fitted + direction + n) % n;
    else {
      const cam = camera();
      const vr = viewportRect();
      const view = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: vr.width / cam.zoom, height: vr.height / cam.zoom };
      index = Math.max(0, boards.findIndex((b) => rectsIntersect(b.box, view)));
    }
  }
  const board = boards[index]!;
  if (s.selection.length) setState({ selection: [board.id] });
  fitRect(board.box, 50);
}

/** PageDown / PageUp. */
export function goToPage(direction: 1 | -1) {
  const s = getState();
  const pages = s.doc?.pageList.filter((p) => p.type === 'page') ?? [];
  if (pages.length < 2) return;
  const i = pages.findIndex((p) => p.id === s.pageId);
  const next = pages[(i + direction + pages.length) % pages.length]!;
  setState({ pageId: next.id, selection: [], hoverId: null });
}

// ---- selection -----------------------------------------------------------------

function siblingsOfSelection(): { parents: string[]; selected: Set<string> } {
  const s = getState();
  const d = s.doc!;
  const nodes = selectedNodes();
  const parents = nodes.length ? [...new Set(nodes.map((n) => n.parentId!).filter(Boolean))] : s.pageId ? [d.pages[s.pageId]!.rootId] : [];
  return { parents, selected: new Set(s.selection) };
}

/** Ctrl+A: everything next to the selection (or on the page). */
export function selectAll() {
  const d = doc();
  if (!d) return;
  const { parents } = siblingsOfSelection();
  setState({ selection: parents.flatMap((p) => d.nodes[p]?.children ?? []).filter((id) => !d.nodes[id]?.isLocked) });
}

/** Ctrl+Shift+A: the siblings that are not selected. */
export function selectOthers() {
  const d = doc();
  if (!d) return;
  const { parents, selected } = siblingsOfSelection();
  setState({ selection: parents.flatMap((p) => d.nodes[p]?.children ?? []).filter((id) => !selected.has(id) && !d.nodes[id]?.isLocked) });
}

/** Tab / Shift+Tab: next or previous sibling, wrapping around. */
export function selectSibling(direction: 1 | -1) {
  const s = getState();
  const d = s.doc;
  if (!d || !s.pageId) return;
  const root = d.nodes[d.pages[s.pageId]!.rootId]!;
  let next: string[];
  if (!s.selection.length) {
    const id = direction > 0 ? root.children[0] : root.children[root.children.length - 1];
    next = id ? [id] : [];
  } else {
    next = [...byParent(selectedNodes())].map(([parentId, nodes]) => {
      const kids = d.nodes[parentId]!.children;
      if (nodes.length > 1) return nodes[0]!.id;
      const i = kids.indexOf(nodes[0]!.id);
      return kids[(i + direction + kids.length) % kids.length]!;
    });
  }
  if (!next.length) return;
  setState({ selection: next });
  requestAnimationFrame(() => reveal(next));
}

/** Enter: edit a text layer, or select the children. */
export function selectChildren() {
  const s = getState();
  const node = s.selection.length === 1 ? s.doc?.nodes[s.selection[0]!] : undefined;
  if (!node) return;
  if (node.component === 'Text') setState({ editingTextId: node.id });
  else if (node.children.length) setState({ selection: [...node.children] });
}

/** Shift+Enter, \ or Esc: select the parents (top-level layers deselect). */
export function selectParent() {
  const d = doc();
  if (!d) return;
  const parents = [...new Set(selectedNodes().map((n) => n.parentId!).filter(Boolean))];
  setState({ selection: parents.filter((id) => d.nodes[id] && d.nodes[id]!.component !== 'PageRoot') });
}

// ---- arrange -------------------------------------------------------------------

/** One step earlier (-1) or later (+1) in the parent for each selected child, simulated like the server applies moves. */
function stepMoves(parentId: string, ids: string[], step: 1 | -1): Array<{ nodeId: string; parentId: string; index: number }> {
  const d = doc()!;
  let arr = [...d.nodes[parentId]!.children];
  const moves: Array<{ nodeId: string; parentId: string; index: number }> = [];
  const ordered = arr.filter((id) => ids.includes(id));
  if (step > 0) ordered.reverse();
  for (const id of ordered) {
    const i = arr.indexOf(id);
    const without = arr.filter((x) => x !== id);
    const j = Math.max(0, Math.min(without.length, i + step));
    if (j === i || ids.includes(without[step > 0 ? j - 1 : j] ?? '')) continue;
    without.splice(j, 0, id);
    arr = without;
    moves.push({ nodeId: id, parentId, index: j });
  }
  return moves;
}

/** Ctrl+[ / Ctrl+] one step; [ / ] (and Ctrl+Shift, Ctrl+Alt) all the way. */
export function reorder(where: 1 | -1 | 'front' | 'back') {
  const d = doc();
  if (!d) return;
  const moves: Array<{ nodeId: string; parentId: string; index: number }> = [];
  for (const [parentId, nodes] of byParent(selectedNodes())) {
    const ids = nodes.map((n) => n.id);
    if (where === 1 || where === -1) {
      moves.push(...stepMoves(parentId, ids, where));
      continue;
    }
    const kids = d.nodes[parentId]!.children;
    const ordered = kids.filter((id) => ids.includes(id));
    const target = where === 'front' ? [...kids.filter((id) => !ids.includes(id)), ...ordered] : [...ordered, ...kids.filter((id) => !ids.includes(id))];
    if (target.every((id, i) => kids[i] === id)) continue;
    if (where === 'front') ordered.forEach((id) => moves.push({ nodeId: id, parentId, index: kids.length - 1 }));
    else [...ordered].reverse().forEach((id) => moves.push({ nodeId: id, parentId, index: 0 }));
  }
  if (moves.length) void command({ type: 'move', moves });
}

/** Arrows: positioned layers move; flex children trade places along their parent's direction. */
export function nudge(dx: number, dy: number) {
  const d = doc();
  if (!d) return;
  const nodes = selectedNodes().filter((n) => !n.isLocked);
  const positioned = nodes.filter(isPositioned);
  if (positioned.length) {
    updateStyles(positioned.map((n) => ({ nodeIds: [n.id], styles: shiftStyles(n, dx, dy) })));
    return;
  }
  const moves: Array<{ nodeId: string; parentId: string; index: number }> = [];
  for (const [parentId, kids] of byParent(nodes)) {
    const el = elementFor(parentId) as HTMLElement | null;
    if (!el) continue;
    const style = getComputedStyle(el);
    const row = style.display.includes('flex') && style.flexDirection.startsWith('row');
    const along = row ? dx : dy;
    if (!along) continue;
    const step = (Math.sign(along) * (style.flexDirection.endsWith('reverse') ? -1 : 1)) as 1 | -1;
    moves.push(...stepMoves(parentId, kids.map((k) => k.id), step));
  }
  if (moves.length) void command({ type: 'move', moves });
}

/** Ctrl+Arrows: resize by 1px (10px with Shift). */
export function resizeBy(dw: number, dh: number) {
  const updates = selectedNodes()
    .filter((n) => !n.isLocked)
    .map((n) => {
      const el = elementFor(n.id) as HTMLElement | null;
      const r = worldRectOf(n.id);
      const w = el instanceof HTMLElement ? el.offsetWidth : (r?.width ?? 0);
      const h = el instanceof HTMLElement ? el.offsetHeight : (r?.height ?? 0);
      const styles: StyleInput = {};
      if (dw) styles.width = px(Math.max(1, w + dw));
      if (dh) styles.height = px(Math.max(1, h + dh));
      return { nodeIds: [n.id], styles };
    });
  updateStyles(updates);
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

/** Alt+A/D/W/S/H/V: align to each other, or a single layer to its parent frame. */
export function align(edge: AlignEdge) {
  const all = selectedNodes();
  const nodes = all.filter((n) => !n.isLocked && isPositioned(n));
  if (!nodes.length) return;
  let bounds: Rect | null;
  if (all.length === 1) {
    const parent = parentOf(nodes[0]!);
    if (!parent || parent.component === 'PageRoot') return;
    bounds = paddingBox(parent.id);
  } else bounds = unionRects(nodes.map((n) => worldRectOf(n.id)).filter((r): r is Rect => !!r));
  if (!bounds) return;
  const b = bounds;
  updateStyles(
    nodes.flatMap((n) => {
      const r = worldRectOf(n.id);
      if (!r) return [];
      const dx = edge === 'left' ? b.x - r.x : edge === 'right' ? b.x + b.width - (r.x + r.width) : edge === 'centerX' ? b.x + b.width / 2 - (r.x + r.width / 2) : 0;
      const dy = edge === 'top' ? b.y - r.y : edge === 'bottom' ? b.y + b.height - (r.y + r.height) : edge === 'centerY' ? b.y + b.height / 2 - (r.y + r.height / 2) : 0;
      return Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005 ? [] : [{ nodeIds: [n.id], styles: shiftStyles(n, dx, dy) }];
    })
  );
}

/** Alt+Shift+H / V: equal spacing between three or more layers; the outer ones stay. */
export function distribute(axis: 'x' | 'y') {
  const items = selectedNodes()
    .filter((n) => !n.isLocked && isPositioned(n))
    .map((n) => ({ n, r: worldRectOf(n.id)! }))
    .filter((i) => i.r);
  if (items.length < 3) {
    notify('distribute', 'Select three or more layers to distribute');
    return;
  }
  const start = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const size = (r: Rect) => (axis === 'x' ? r.width : r.height);
  items.sort((p, q) => start(p.r) - start(q.r));
  const first = items[0]!;
  const last = items.reduce((m, i) => (start(i.r) + size(i.r) > start(m.r) + size(m.r) ? i : m), items[items.length - 1]!);
  const middle = items.filter((i) => i !== first && i !== last);
  const gap = (start(last.r) - (start(first.r) + size(first.r)) - middle.reduce((sum, i) => sum + size(i.r), 0)) / (middle.length + 1);
  let pos = start(first.r) + size(first.r) + gap;
  const updates = middle.map((i) => {
    const delta = pos - start(i.r);
    pos += size(i.r) + gap;
    return { nodeIds: [i.n.id], styles: shiftStyles(i.n, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0) };
  });
  updateStyles(updates);
}

/** Shift+H / Shift+V. */
export function flip(axis: 'x' | 'y') {
  const fn = axis === 'x' ? 'scaleX(-1)' : 'scaleY(-1)';
  updateStyles(
    selectedNodes()
      .filter((n) => !n.isLocked)
      .map((n) => {
        const t = n.styles.transform && n.styles.transform !== 'none' ? n.styles.transform : '';
        const next = t.includes(fn) ? t.replace(fn, '').replace(/\s+/g, ' ').trim() : `${t} ${fn}`.trim();
        return { nodeIds: [n.id], styles: { transform: next || null } };
      })
  );
}

let lastDigit: { digit: number; at: number } | null = null;
/** 0–9: opacity (1 = 10% … 0 = 100%; two quick digits = exact). */
export function opacityKey(digit: number) {
  const ids = getState().selection;
  if (!ids.length) return;
  const now = Date.now();
  const previous = lastDigit && now - lastDigit.at < 700 ? lastDigit.digit : null;
  const value = Math.min(100, opacityFromDigits(digit, previous));
  lastDigit = previous === null ? { digit, at: now } : null;
  updateStyles([{ nodeIds: ids, styles: { opacity: value >= 100 ? null : String(value / 100) } }]);
  notify('opacity', `Opacity ${value}%`);
}

export function toggleVisibility() {
  const nodes = selectedNodes();
  if (nodes.length) void command({ type: 'setFlags', nodeIds: nodes.map((n) => n.id), isVisible: !nodes.every((n) => n.isVisible) });
}

export function toggleLock() {
  const nodes = selectedNodes();
  if (nodes.length) void command({ type: 'setFlags', nodeIds: nodes.map((n) => n.id), isLocked: !nodes.every((n) => n.isLocked) });
}

export function unlockAll() {
  const s = getState();
  const d = s.doc;
  if (!d || !s.pageId) return;
  const locked: string[] = [];
  const walk = (id: string) => {
    const n = d.nodes[id];
    if (!n) return;
    if (n.isLocked) locked.push(id);
    n.children.forEach(walk);
  };
  walk(d.pages[s.pageId]!.rootId);
  if (locked.length) void command({ type: 'setFlags', nodeIds: locked, isLocked: false });
  notify('unlock', locked.length ? `Unlocked ${locked.length} layer${locked.length === 1 ? '' : 's'}` : 'Nothing to unlock');
}

/** Alt+C. */
export function toggleClip() {
  const frames = selectedNodes().filter((n) => n.component === 'Frame');
  if (!frames.length) return;
  const on = !frames.every((n) => n.styles.overflow === 'clip');
  updateStyles([{ nodeIds: frames.map((n) => n.id), styles: { overflow: on ? 'clip' : null } }]);
  notify('clip', on ? 'Clip content on' : 'Clip content off');
}

const BORDER_WORDS = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|thin|medium|thick)$/i;
const cssTokens = (value: string) => value.match(/(?:[^\s(]+|\([^)]*\))+/g) ?? [];
function splitBorder(border: string): { width: string; style: string; color: string | null } {
  const parts = cssTokens(border);
  const color = parts.find((p) => !BORDER_WORDS.test(p) && !/^-?[\d.]+[a-z%]*$/i.test(p)) ?? null;
  return { width: parts.find((p) => /^-?[\d.]+[a-z%]*$/i.test(p)) ?? '1px', style: parts.find((p) => BORDER_WORDS.test(p)) ?? 'solid', color };
}

/** Shift+X: the fill becomes the border color and vice versa (solid colors). */
export function swapFillAndStroke() {
  const updates = selectedNodes()
    .filter((n) => n.component === 'Frame' || n.component === 'Rectangle')
    .flatMap((n) => {
      // `background: <one color>` counts as the fill too; images and gradients do not.
      const bg = n.styles.background && !/url\(|gradient\(/i.test(n.styles.background) && cssTokens(n.styles.background).length === 1 ? n.styles.background : null;
      const fill = n.styles.backgroundColor ?? bg;
      const border = n.styles.border ? splitBorder(n.styles.border) : null;
      const stroke = n.styles.borderColor ?? border?.color ?? null;
      if (!fill && !stroke) return [];
      const styles: StyleInput = { backgroundColor: stroke };
      if (bg) styles.background = null;
      if (fill) styles.border = `${border?.width ?? '1px'} ${border?.style ?? 'solid'} ${fill}`;
      else styles.border = null;
      if (n.styles.borderColor) styles.borderColor = null;
      return [{ nodeIds: [n.id], styles }];
    });
  updateStyles(updates);
}

// ---- frames and flex -----------------------------------------------------------

/** Ctrl+G (Group), Ctrl+Alt+G and Shift+F (Frame): one wrapper per parent. */
export async function wrap(label: 'Group' | 'Frame') {
  const ids: string[] = [];
  for (const nodes of byParent(selectedNodes()).values()) {
    const r = await command<{ ids: string[] }>({ type: 'group', nodeIds: nodes.map((n) => n.id), label });
    ids.push(...(r.ids ?? []));
  }
  if (ids.length) setState({ selection: ids });
}

export async function ungroup() {
  const s = getState();
  if (!s.selection.length) return;
  const r = await command<{ ids: string[] }>({ type: 'ungroup', nodeIds: s.selection });
  setState({ selection: r.ids ?? [] });
}

function isFlex(n: NodeRecord): boolean {
  return /flex|grid/.test(String(n.styles.display ?? ''));
}

/** Shift+A: flex layout on plain frames; other layers (or frames that already have it) get wrapped in a new flex frame. */
export async function addFlex() {
  const d = doc();
  const nodes = selectedNodes();
  if (!d || !nodes.length) return;
  const frames = nodes.filter((n) => n.component === 'Frame' && !isFlex(n));
  if (frames.length === nodes.length) {
    updateStyles(
      frames.map((f) => {
        const flex = inferFlex(f.children.map((id) => worldRectOf(id)).filter((r): r is Rect => !!r));
        return { nodeIds: [f.id], styles: { display: 'flex', flexDirection: flex.direction, gap: f.styles.gap ?? px(flex.gap) } };
      })
    );
    return;
  }
  const ids: string[] = [];
  for (const group of byParent(nodes).values()) {
    const boxes = group.map((n) => worldRectOf(n.id) ?? { x: 0, y: 0, width: 0, height: 0 });
    const flex = inferFlex(boxes);
    const r = await command<{ ids: string[] }>({
      type: 'group',
      label: 'Frame',
      ordered: true,
      nodeIds: flex.order.map((i) => group[i]!.id),
      styles: { display: 'flex', flexDirection: flex.direction, gap: px(flex.gap), width: 'fit-content', height: 'fit-content' },
    });
    ids.push(...(r.ids ?? []));
  }
  if (ids.length) setState({ selection: ids });
}

const FLEX_PROPS = ['flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent', 'gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingInline', 'paddingBlock'];

/** Alt+Shift+A: back to a freeform frame; children stay where they are. */
export function removeFlex() {
  const updates: Array<{ nodeIds: string[]; styles: StyleInput }> = [];
  for (const f of selectedNodes().filter((n) => n.component === 'Frame' && isFlex(n))) {
    const el = elementFor(f.id) as HTMLElement | null;
    const box = paddingBox(f.id);
    if (!el || !box) continue;
    const styles: StyleInput = { display: FREEFORM_DISPLAY, width: px(el.offsetWidth), height: px(el.offsetHeight) };
    for (const p of FLEX_PROPS) if (f.styles[p] !== undefined) styles[p] = null;
    updates.push({ nodeIds: [f.id], styles });
    for (const id of f.children) {
      const child = doc()!.nodes[id];
      const r = worldRectOf(id);
      if (!child || !r || child.styles.position === 'absolute') continue;
      const cel = elementFor(id) as HTMLElement | null;
      updates.push({
        nodeIds: [id],
        styles: {
          left: px(r.x - box.x),
          top: px(r.y - box.y),
          ...(cel instanceof HTMLElement ? { width: px(cel.offsetWidth), height: px(cel.offsetHeight) } : {}),
          flexGrow: null,
          flexBasis: null,
          alignSelf: null,
        },
      });
    }
  }
  updateStyles(updates);
}

/** Ctrl+Alt+Shift+R: hug the content. Freeform frames shrink to their children. */
export function resizeToFit() {
  const d = doc();
  if (!d) return;
  const updates: Array<{ nodeIds: string[]; styles: StyleInput }> = [];
  for (const n of selectedNodes().filter((x) => !x.isLocked)) {
    if (n.component === 'Text' || isFlex(n)) {
      updates.push({ nodeIds: [n.id], styles: { width: 'fit-content', height: 'fit-content', flexGrow: null } });
      continue;
    }
    if (n.component !== 'Frame' || !n.children.length) continue;
    const box = paddingBox(n.id);
    const kids = unionRects(n.children.map((id) => worldRectOf(id)).filter((r): r is Rect => !!r));
    const el = elementFor(n.id) as HTMLElement | null;
    if (!box || !kids || !el) continue;
    const dx = kids.x - box.x;
    const dy = kids.y - box.y;
    const borderX = el.offsetWidth - el.clientWidth;
    const borderY = el.offsetHeight - el.clientHeight;
    updates.push({ nodeIds: [n.id], styles: { ...(isPositioned(n) ? shiftStyles(n, dx, dy) : {}), width: px(kids.width + borderX), height: px(kids.height + borderY) } });
    for (const id of n.children) {
      const child = d.nodes[id];
      if (child && (dx || dy)) updates.push({ nodeIds: [id], styles: shiftStyles(child, -dx, -dy) });
    }
  }
  updateStyles(updates);
}

/** Ctrl+Alt+Shift+F: fill the parent (flex children grow along the main axis). */
export function resizeToFill() {
  const updates: Array<{ nodeIds: string[]; styles: StyleInput }> = [];
  for (const n of selectedNodes().filter((x) => !x.isLocked)) {
    const parent = parentOf(n);
    if (!parent || parent.component === 'PageRoot') continue;
    if (isPositioned(n)) {
      updates.push({ nodeIds: [n.id], styles: { left: '0px', top: '0px', right: null, bottom: null, width: '100%', height: '100%' } });
      continue;
    }
    const el = elementFor(parent.id) as HTMLElement | null;
    const row = !!el && getComputedStyle(el).flexDirection.startsWith('row');
    updates.push({
      nodeIds: [n.id],
      styles: row ? { flexGrow: '1', flexBasis: '0px', width: null, height: '100%' } : { flexGrow: '1', flexBasis: '0px', height: null, width: '100%' },
    });
  }
  updateStyles(updates);
}

// ---- text ----------------------------------------------------------------------

/** Text layers in the selection, including those inside selected frames. */
function textTargets(): NodeRecord[] {
  const d = doc();
  if (!d) return [];
  const out = new Map<string, NodeRecord>();
  const walk = (id: string) => {
    const n = d.nodes[id];
    if (!n) return;
    if (n.component === 'Text') out.set(id, n);
    n.children.forEach(walk);
  };
  getState().selection.forEach(walk);
  return [...out.values()];
}

function computed(id: string): CSSStyleDeclaration | null {
  const el = elementFor(id);
  return el ? getComputedStyle(el) : null;
}

function weightOf(n: NodeRecord): number {
  const w = String(n.styles.fontWeight ?? computed(n.id)?.fontWeight ?? '400');
  return w === 'bold' ? 700 : w === 'normal' ? 400 : Number(w) || 400;
}

export type TextStep = 'fontSize' | 'lineHeight' | 'letterSpacing' | 'fontWeight';

/** Font size, line height, letter spacing and weight up/down. */
export function textStep(prop: TextStep, direction: 1 | -1) {
  const updates = textTargets().flatMap((n) => {
    const value = String(n.styles[prop] ?? '');
    let next: string | null = null;
    if (prop === 'fontSize') {
      const current = pxValue(value) ?? parseFloat(computed(n.id)?.fontSize ?? '16');
      next = px(Math.max(1, Math.round(current) + direction));
    } else if (prop === 'lineHeight') {
      if (value.endsWith('%')) next = `${Math.max(0, Math.round(parseFloat(value) / 5) * 5 + direction * 5)}%`;
      else if (/^[\d.]+$/.test(value)) next = String(Math.max(0, round2(parseFloat(value) + direction * 0.05)));
      else {
        const css = computed(n.id);
        const current = pxValue(value) ?? (css && css.lineHeight !== 'normal' ? parseFloat(css.lineHeight) : parseFloat(css?.fontSize ?? '16') * 1.2);
        next = px(Math.max(0, Math.round(current) + direction));
      }
    } else if (prop === 'letterSpacing') {
      if (value.endsWith('px')) next = `${Math.round((parseFloat(value) + direction * 0.1) * 10) / 10}px`;
      else next = `${Math.round(((parseFloat(value) || 0) + direction * 0.01) * 1000) / 1000}em`;
    } else next = String(Math.min(900, Math.max(100, Math.round(weightOf(n) / 100) * 100 + direction * 100)));
    return next === value ? [] : [{ nodeIds: [n.id], styles: { [prop]: next } }];
  });
  updateStyles(updates);
}

/** Ctrl+B: bold, or regular when mostly bold already. */
export function toggleBold() {
  const nodes = textTargets();
  if (!nodes.length) return;
  const bold = nodes.reduce((sum, n) => sum + weightOf(n), 0) / nodes.length < 600;
  updateStyles([{ nodeIds: nodes.map((n) => n.id), styles: { fontWeight: bold ? '700' : '400' } }]);
}

export function toggleItalic() {
  const nodes = textTargets();
  if (!nodes.length) return;
  const on = !nodes.every((n) => n.styles.fontStyle === 'italic');
  updateStyles([{ nodeIds: nodes.map((n) => n.id), styles: { fontStyle: on ? 'italic' : null } }]);
}

/** Ctrl+U / Ctrl+Shift+X. */
export function toggleDecoration(line: 'underline' | 'line-through') {
  const nodes = textTargets();
  if (!nodes.length) return;
  const lines = (n: NodeRecord) => String(n.styles.textDecorationLine ?? n.styles.textDecoration ?? '').split(/\s+/).filter((w) => /^(underline|line-through|overline)$/.test(w));
  const on = !nodes.every((n) => lines(n).includes(line));
  updateStyles(
    nodes.map((n) => {
      const next = on ? [...new Set([...lines(n), line])] : lines(n).filter((w) => w !== line);
      return { nodeIds: [n.id], styles: { textDecoration: next.join(' ') || null, textDecorationLine: null } };
    })
  );
}

export function alignText(value: 'left' | 'center' | 'right' | 'justify') {
  const nodes = textTargets();
  if (nodes.length) updateStyles([{ nodeIds: nodes.map((n) => n.id), styles: { textAlign: value } }]);
}

// ---- styles clipboard ----------------------------------------------------------

/** Where a layer sits and how it lays out its children: not part of its look. */
const NOT_STYLE = new Set([
  'left', 'top', 'right', 'bottom', 'inset', 'position', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf', 'order', 'gridArea', 'gridColumn', 'gridRow',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'zIndex', 'display', ...FLEX_PROPS,
  'gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow', 'aspectRatio', 'transform',
]);

let copiedStyles: Record<string, string> | null = null;

/** Ctrl+Alt+C. */
export function copyStyles() {
  const node = selectedNodes()[0];
  if (!node) return;
  copiedStyles = Object.fromEntries(Object.entries(node.styles).filter(([k, v]) => !NOT_STYLE.has(k) && v !== undefined && v !== null)) as Record<string, string>;
  notify('styles', 'Copied styles');
}

/** Ctrl+Alt+V: the selection takes the copied look (other visual styles are cleared). */
export function pasteStyles() {
  const nodes = selectedNodes().filter((n) => !n.isLocked);
  if (!copiedStyles || !nodes.length) return;
  const from = copiedStyles;
  updateStyles(
    nodes.map((n) => {
      const styles: StyleInput = { ...from };
      for (const k of Object.keys(n.styles)) if (!NOT_STYLE.has(k) && !(k in from)) styles[k] = null;
      return { nodeIds: [n.id], styles };
    })
  );
  notify('styles', 'Pasted styles');
}

// ---- copy as, export, links ----------------------------------------------------

/** Alt+T / Alt+R: JSX of the selected layer. */
export async function copyAsCode(format: 'tailwind' | 'inline-styles') {
  const s = getState();
  const id = s.selection[0];
  if (!s.doc || !id) return;
  try {
    const code = await client.request<string>('jsx', { fileId: s.doc.id, nodeId: id, format, includeNodeIds: false });
    await navigator.clipboard.writeText(code);
    notify('copy', format === 'tailwind' ? 'Copied as Tailwind' : 'Copied as React');
  } catch (error) {
    notify('copy', error instanceof Error ? error.message : 'Copy failed');
  }
}

/** Ctrl+Shift+C: PNG of the selected layer (rendered by the server at 2x). */
export function copyAsPng() {
  const s = getState();
  const id = s.selection[0];
  if (!s.doc || !id) return;
  const fileId = s.doc.id;
  const png = client.request<{ mimeType: string; data: string }>('export.render', { fileId, nodeId: id, format: 'png', scale: 2 }).then((r) => {
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'image/png' });
  });
  // The clipboard write starts inside the key press; the image arrives later.
  navigator.clipboard
    .write([new ClipboardItem({ 'image/png': png })])
    .then(() => notify('copy', 'Copied as PNG'))
    .catch((error: unknown) => notify('copy', error instanceof Error ? error.message : 'Copy failed'));
}

/** Ctrl+L: link to this file, page and selected layer. */
export function copyLink() {
  const s = getState();
  if (!s.doc) return;
  const id = s.selection.length === 1 ? `/${s.selection[0]}` : '';
  const url = `${location.origin}${location.pathname}#/file/${s.doc.id}${s.pageId ? `/${s.pageId}${id}` : ''}`;
  navigator.clipboard.writeText(url).then(
    () => notify('copy', 'Link copied'),
    () => notify('copy', 'Could not copy the link')
  );
}

/** I: pick a color from the screen; it fills the selection, or is copied when nothing is selected. */
export async function eyedropper() {
  const Picker = (window as unknown as { EyeDropper?: new () => { open(): Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!Picker) {
    notify('eyedropper', 'This browser has no eyedropper');
    return;
  }
  let hex: string;
  try {
    hex = (await new Picker().open()).sRGBHex.toUpperCase();
  } catch {
    return; // cancelled
  }
  const nodes = selectedNodes().filter((n) => !n.isLocked);
  if (!nodes.length) {
    await navigator.clipboard.writeText(hex).catch(() => {});
    notify('eyedropper', `Copied ${hex}`);
    return;
  }
  updateStyles(
    nodes.filter((n) => n.component !== 'SVG').map((n) => ({ nodeIds: [n.id], styles: (n.component === 'Text' ? { color: hex } : { backgroundColor: hex }) as StyleInput }))
  );
}

/** Ctrl+Shift+K. */
export function placeImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = PLACEABLE_FILES;
  input.multiple = true;
  input.onchange = () => {
    if (input.files?.length) void insertImageFiles([...input.files]);
  };
  input.click();
}

/** Ctrl+R / F2. */
export function rename() {
  const node = selectedNodes()[0];
  if (!node || getState().selection.length !== 1) return;
  const name = prompt('Rename layer', node.label);
  if (name?.trim() && name !== node.label) void command({ type: 'rename', nodeId: node.id, name: name.trim() });
}

export function duplicateSelection() {
  const s = getState();
  if (!s.selection.length) return;
  void command<{ ids: string[] }>({ type: 'duplicate', nodeIds: s.selection, offset: { x: 16, y: 16 } }).then((r) => r.ids?.length && setState({ selection: r.ids }));
}

export function deleteSelection() {
  const s = getState();
  if (s.selection.length) void command({ type: 'delete', nodeIds: s.selection });
}
