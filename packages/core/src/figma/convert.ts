import type {
  FigmaColor,
  FigmaEffect,
  FigmaGuid,
  FigmaMatrix,
  FigmaMessage,
  FigmaNode,
  FigmaPaint,
  FigmaPath,
} from './decode.ts';

/**
 * Figma nodes → HTML/CSS in the dialect OpenPaper imports (inline styles, flexbox, layer-name).
 * The result goes through the normal HTML importer, so pasted Figma layers behave like any other
 * layers: frames, text, rectangles and SVG.
 */

export interface FigmaConvertOptions {
  /** Figma file the layers were copied from (for image URLs). */
  fileKey?: string;
  /**
   * Keep each top-level layer's position relative to the copied selection (absolute left/top).
   * Use when pasting onto the canvas; omit when pasting into a frame.
   */
  keepPositions?: boolean;
}

export interface FigmaConvertResult {
  html: string;
  /** Number of top-level layers. */
  layers: number;
  /** Distinct image fills (resolved through `figma-image://<fileKey>/<hash>` URLs). */
  images: number;
  warnings: string[];
}

/** URL scheme for Figma image fills; the server resolves it with the Figma REST API. */
export const FIGMA_IMAGE_SCHEME = 'figma-image://';

const SKIPPED_TYPES = new Set(['DOCUMENT', 'CANVAS', 'SLICE', 'CONNECTOR', 'STICKY', 'SHAPE_WITH_TEXT', 'STAMP', 'WIDGET', 'CODE_BLOCK', 'TABLE', 'WASHI_TAPE', 'HIGHLIGHT', 'VARIABLE', 'VARIABLE_SET']);
const SHAPE_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'LINE']);

const key = (g: FigmaGuid | undefined) => (g ? `${g.sessionID}:${g.localID}` : '');
const pathKey = (path: FigmaGuid[]) => path.map(key).join('/');
const round = (n: number, d = 2) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};
const px = (n: number) => `${round(n)}px`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function rgba(c: FigmaColor | undefined, opacity = 1): string {
  if (!c) return 'transparent';
  const a = round((c.a ?? 1) * opacity, 3);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  if (a >= 1) return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const visible = <T extends { visible?: boolean }>(list: T[] | undefined): T[] => (list ?? []).filter((p) => p.visible !== false);

function hex(bytes: Uint8Array | undefined): string {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') : '';
}

function invert(t: FigmaMatrix) {
  const det = t.m00 * t.m11 - t.m01 * t.m10 || 1e-12;
  return {
    m00: t.m11 / det,
    m01: -t.m01 / det,
    m02: (t.m01 * t.m12 - t.m11 * t.m02) / det,
    m10: -t.m10 / det,
    m11: t.m00 / det,
    m12: (t.m10 * t.m02 - t.m00 * t.m12) / det,
  };
}

const BLEND: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

interface Ctx {
  nodes: Map<string, FigmaNode>;
  children: Map<string, FigmaNode[]>;
  blobs: Uint8Array[];
  fileKey: string;
  images: Set<string>;
  warnings: Set<string>;
}

/** Instance expansion: overrides and derived layout keyed by guid path from the outermost instance. */
interface Scope {
  prefix: FigmaGuid[];
  overrides: Map<string, FigmaNode>;
  derived: Map<string, FigmaNode>;
}

const ROOT_SCOPE: Scope = { prefix: [], overrides: new Map(), derived: new Map() };

function effective(n: FigmaNode, scope: Scope): FigmaNode {
  if (!scope.prefix.length || !n.guid) return n;
  const k = pathKey([...scope.prefix, n.guid]);
  const o = scope.overrides.get(k);
  const d = scope.derived.get(k);
  if (!o && !d) return n;
  const merged: FigmaNode = { ...n, ...(o ?? {}) };
  if (d?.size) merged.size = d.size;
  if (d?.transform) merged.transform = d.transform;
  merged.guid = n.guid;
  merged.parentIndex = n.parentIndex;
  if (o?.textData && n.textData) merged.textData = { ...n.textData, ...o.textData };
  return merged;
}

/** Children of a node in this scope; instances expand to their component's children. */
function childrenOf(n: FigmaNode, ctx: Ctx, scope: Scope): { kids: FigmaNode[]; scope: Scope } {
  if (n.type === 'INSTANCE' && n.symbolData?.symbolID) {
    const symbol = ctx.nodes.get(key(n.symbolData.symbolID));
    if (!symbol) {
      ctx.warnings.add('Some component instances could not be expanded (their main component was not copied).');
      return { kids: [], scope };
    }
    const prefix = n.guid ? [...scope.prefix, n.guid] : scope.prefix;
    const overrides = new Map(scope.overrides);
    const derived = new Map(scope.derived);
    // The instance's own overrides are relative to it; outer overrides win.
    for (const o of n.symbolData.symbolOverrides ?? []) {
      const k = pathKey([...prefix, ...(o.guidPath?.guids ?? [])]);
      if (!overrides.has(k)) overrides.set(k, o);
    }
    for (const d of n.derivedSymbolData ?? []) {
      const k = pathKey([...prefix, ...(d.guidPath?.guids ?? [])]);
      if (!derived.has(k)) derived.set(k, d);
    }
    return { kids: ctx.children.get(key(symbol.guid)) ?? [], scope: { prefix, overrides, derived } };
  }
  return { kids: ctx.children.get(key(n.guid)) ?? [], scope };
}

// ---- paint ----------------------------------------------------------------------------

function gradientCss(p: FigmaPaint, w: number, h: number): string | null {
  const stops = (p.stops ?? []).slice().sort((a, b) => a.position - b.position);
  if (!stops.length) return null;
  const op = p.opacity ?? 1;
  const inv = p.transform ? invert(p.transform) : { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const at = (x: number, y: number) => ({ x: (inv.m00 * x + inv.m01 * y + inv.m02) * w, y: (inv.m10 * x + inv.m11 * y + inv.m12) * h });
  if (p.type === 'GRADIENT_LINEAR') {
    const a = at(0, 0.5);
    const b = at(1, 0.5);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const rad = (angle * Math.PI) / 180;
    const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
    const len = Math.abs(w * dir.x) + Math.abs(h * dir.y) || 1;
    const start = { x: w / 2 - (dir.x * len) / 2, y: h / 2 - (dir.y * len) / 2 };
    const list = stops.map((s) => {
      const pt = { x: a.x + dx * s.position, y: a.y + dy * s.position };
      const t = ((pt.x - start.x) * dir.x + (pt.y - start.y) * dir.y) / len;
      return `${rgba(s.color, op)} ${round(t * 100, 1)}%`;
    });
    return `linear-gradient(${round(angle, 1)}deg, ${list.join(', ')})`;
  }
  const c = at(0.5, 0.5);
  const list = stops.map((s) => `${rgba(s.color, op)} ${round(s.position * 100, 1)}%`);
  if (p.type === 'GRADIENT_ANGULAR') {
    const b = at(1, 0.5);
    const from = (Math.atan2(b.x - c.x, -(b.y - c.y)) * 180) / Math.PI;
    return `conic-gradient(from ${round(from, 1)}deg at ${round(c.x)}px ${round(c.y)}px, ${list.join(', ')})`;
  }
  const b = at(1, 0.5);
  const d = at(0.5, 1);
  const rx = Math.hypot(b.x - c.x, b.y - c.y);
  const ry = Math.hypot(d.x - c.x, d.y - c.y);
  return `radial-gradient(${round(rx)}px ${round(ry)}px at ${round(c.x)}px ${round(c.y)}px, ${list.join(', ')})`;
}

/** CSS background for fills (Figma lists paints bottom → top; CSS layers top → bottom). */
function backgroundStyles(paints: FigmaPaint[] | undefined, w: number, h: number, ctx: Ctx, s: Record<string, string>) {
  const list = visible(paints);
  if (!list.length) return;
  const layers: string[] = [];
  const sizes: string[] = [];
  let color: string | null = null;
  list.forEach((p, i) => {
    const bottom = i === 0;
    if (p.type === 'SOLID') {
      const c = rgba(p.color, p.opacity ?? 1);
      if (bottom) color = c;
      else {
        layers.unshift(`linear-gradient(${c}, ${c})`);
        sizes.unshift('auto');
      }
    } else if (p.type?.startsWith('GRADIENT_')) {
      const g = gradientCss(p, w, h);
      if (g) {
        layers.unshift(g);
        sizes.unshift('auto');
      }
    } else if (p.type === 'IMAGE') {
      const hash = hex(p.image?.hash);
      if (!hash) return;
      ctx.images.add(hash);
      layers.unshift(`url("${FIGMA_IMAGE_SCHEME}${ctx.fileKey}/${hash}")`);
      const mode = p.imageScaleMode ?? 'FILL';
      sizes.unshift(mode === 'FIT' ? 'contain' : mode === 'STRETCH' ? '100% 100%' : mode === 'TILE' ? 'auto' : 'cover');
      // Shown until the image arrives (or if it cannot be fetched).
      if (bottom) color ??= '#E8E8E8';
    } else {
      ctx.warnings.add(`${p.type?.toLowerCase().replace(/_/g, ' ')} fills are not supported and were skipped.`);
    }
  });
  if (color) s.backgroundColor = color;
  if (layers.length) {
    s.backgroundImage = layers.join(', ');
    if (sizes.some((x) => x !== 'auto')) {
      s.backgroundSize = sizes.join(', ');
      s.backgroundPosition = 'center';
      s.backgroundRepeat = 'no-repeat';
    }
  }
}

function firstSolid(paints: FigmaPaint[] | undefined): string | null {
  for (const p of visible(paints).slice().reverse()) {
    if (p.type === 'SOLID') return rgba(p.color, p.opacity ?? 1);
    if (p.type?.startsWith('GRADIENT_') && p.stops?.length) return rgba(p.stops[0]!.color, p.opacity ?? 1);
  }
  return null;
}

// ---- strokes, effects, corners ----------------------------------------------------------

function strokeAndEffects(n: FigmaNode, s: Record<string, string>, ctx: Ctx) {
  const shadows: string[] = [];
  const stroke = firstSolid(n.strokePaints);
  const weight = n.strokeWeight ?? 0;
  if (stroke && (weight > 0 || n.borderStrokeWeightsIndependent)) {
    if (n.borderStrokeWeightsIndependent) {
      for (const [side, w] of [
        ['Top', n.borderTopWeight],
        ['Right', n.borderRightWeight],
        ['Bottom', n.borderBottomWeight],
        ['Left', n.borderLeftWeight],
      ] as const) {
        if (w) s[`border${side}`] = `${px(w)} solid ${stroke}`;
      }
    } else if (n.dashPattern?.length) {
      s.border = `${px(weight)} dashed ${stroke}`;
    } else if (n.strokeAlign === 'OUTSIDE') shadows.push(`0 0 0 ${px(weight)} ${stroke}`);
    else if (n.strokeAlign === 'CENTER') shadows.push(`inset 0 0 0 ${px(weight / 2)} ${stroke}`, `0 0 0 ${px(weight / 2)} ${stroke}`);
    else shadows.push(`inset 0 0 0 ${px(weight)} ${stroke}`);
  }
  const filters: string[] = [];
  for (const e of visible(n.effects)) {
    const c = rgba(e.color);
    const x = e.offset?.x ?? 0;
    const y = e.offset?.y ?? 0;
    if (e.type === 'DROP_SHADOW') shadows.push(`${px(x)} ${px(y)} ${px(e.radius ?? 0)} ${px(e.spread ?? 0)} ${c}`);
    else if (e.type === 'INNER_SHADOW') shadows.push(`inset ${px(x)} ${px(y)} ${px(e.radius ?? 0)} ${px(e.spread ?? 0)} ${c}`);
    else if (e.type === 'FOREGROUND_BLUR') filters.push(`blur(${px((e.radius ?? 0) / 2)})`);
    else if (e.type === 'BACKGROUND_BLUR') s.backdropFilter = `blur(${px((e.radius ?? 0) / 2)})`;
    else ctx.warnings.add(`${e.type?.toLowerCase().replace(/_/g, ' ')} effects are not supported and were skipped.`);
  }
  if (shadows.length) s.boxShadow = shadows.join(', ');
  if (filters.length) s.filter = filters.join(' ');
}

function corners(n: FigmaNode, s: Record<string, string>) {
  if (n.rectangleCornerRadiiIndependent) {
    const r = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map(
      (v) => v ?? 0
    );
    if (r.some((v) => v > 0)) s.borderRadius = r.map(px).join(' ');
  } else if (n.cornerRadius) s.borderRadius = px(n.cornerRadius);
}

function common(n: FigmaNode, s: Record<string, string>) {
  if (n.opacity !== undefined && n.opacity < 1) s.opacity = String(round(n.opacity, 3));
  const blend = n.blendMode && BLEND[n.blendMode];
  if (blend) s.mixBlendMode = blend;
}

// ---- geometry -------------------------------------------------------------------------

function pathData(path: FigmaPath, ctx: Ctx): string | null {
  const bytes = path.commandsBlob !== undefined ? ctx.blobs[path.commandsBlob] : undefined;
  if (!bytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (o: number) => round(view.getFloat32(o, true), 3);
  const out: string[] = [];
  let o = 0;
  while (o < bytes.length) {
    const cmd = bytes[o++];
    const need = cmd === 0 ? 0 : cmd === 1 || cmd === 2 ? 8 : cmd === 3 ? 16 : cmd === 4 ? 24 : -1;
    if (need < 0 || o + need > bytes.length) return null;
    if (cmd === 0) out.push('Z');
    else if (cmd === 1) out.push(`M${f(o)} ${f(o + 4)}`);
    else if (cmd === 2) out.push(`L${f(o)} ${f(o + 4)}`);
    else if (cmd === 3) out.push(`Q${f(o)} ${f(o + 4)} ${f(o + 8)} ${f(o + 12)}`);
    else out.push(`C${f(o)} ${f(o + 4)} ${f(o + 8)} ${f(o + 12)} ${f(o + 16)} ${f(o + 20)}`);
    o += need;
  }
  return out.join('');
}

function polygonPoints(n: FigmaNode, w: number, h: number): string {
  const count = Math.max(3, n.count ?? 5);
  const star = n.type === 'STAR';
  const inner = n.starInnerScale ?? 0.38;
  const pts: string[] = [];
  const steps = star ? count * 2 : count;
  for (let i = 0; i < steps; i++) {
    const r = star && i % 2 === 1 ? inner : 1;
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps;
    pts.push(`${round(w / 2 + (Math.cos(a) * r * w) / 2)},${round(h / 2 + (Math.sin(a) * r * h) / 2)}`);
  }
  return pts.join(' ');
}

/** SVG markup for vector-like layers, or null when there is no usable geometry. */
function shapeSvg(n: FigmaNode, w: number, h: number, ctx: Ctx): string | null {
  const fill = firstSolid(n.fillPaints);
  const stroke = firstSolid(n.strokePaints);
  const parts: string[] = [];
  const fills = (n.fillGeometry ?? []).map((p) => [pathData(p, ctx), p.windingRule] as const).filter(([d]) => d);
  const strokes = (n.strokeGeometry ?? []).map((p) => pathData(p, ctx)).filter(Boolean);
  if (fills.length || strokes.length) {
    if (fill) for (const [d, rule] of fills) parts.push(`<path d="${d}" fill="${fill}"${rule === 'ODD' ? ' fill-rule="evenodd"' : ''}/>`);
    // Figma bakes stroke outlines as fillable geometry.
    if (stroke) for (const d of strokes) parts.push(`<path d="${d}" fill="${stroke}"/>`);
  } else if (n.type === 'STAR' || n.type === 'REGULAR_POLYGON') {
    parts.push(`<polygon points="${polygonPoints(n, w, h)}"${fill ? ` fill="${fill}"` : ' fill="none"'}${stroke && n.strokeWeight ? ` stroke="${stroke}" stroke-width="${round(n.strokeWeight)}"` : ''}/>`);
  } else if (n.type === 'LINE') {
    const sw = n.strokeWeight || 1;
    parts.push(`<line x1="0" y1="${round(sw / 2)}" x2="${round(w)}" y2="${round(sw / 2)}" stroke="${stroke ?? '#000000'}" stroke-width="${round(sw)}"/>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(Math.max(sw, 1))}" viewBox="0 0 ${round(w)} ${round(Math.max(sw, 1))}">${parts.join('')}</svg>`;
  }
  if (!parts.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round(w)}" height="${round(h)}" viewBox="0 0 ${round(w)} ${round(h)}">${parts.join('')}</svg>`;
}

// ---- text --------------------------------------------------------------------------------

function textStyles(n: FigmaNode, s: Record<string, string>, base?: FigmaNode) {
  const fontName = n.fontName ?? base?.fontName;
  const meta = (base?.textData ?? n.textData)?.fontMetaData?.find((m) => m.key?.family === fontName?.family && m.key?.style === fontName?.style);
  if (fontName?.family) s.fontFamily = /[\s,]/.test(fontName.family) ? `"${fontName.family}"` : fontName.family;
  const styleName = fontName?.style ?? '';
  const weight = meta?.fontWeight ?? WEIGHTS.find(([re]) => re.test(styleName))?.[1] ?? 400;
  if (weight !== 400 || base) s.fontWeight = String(weight);
  if (meta?.fontStyle === 'ITALIC' || /italic|oblique/i.test(styleName)) s.fontStyle = 'italic';
  const size = n.fontSize ?? base?.fontSize;
  if (size) s.fontSize = px(size);
  const lh = n.lineHeight;
  if (lh) {
    if (lh.units === 'PIXELS') s.lineHeight = px(lh.value);
    else if (lh.units === 'PERCENT') s.lineHeight = lh.value === 100 ? 'normal' : String(round(lh.value / 100, 3));
    else if (lh.value) s.lineHeight = String(round(lh.value, 3));
  }
  const ls = n.letterSpacing;
  if (ls?.value) s.letterSpacing = ls.units === 'PERCENT' ? `${round(ls.value / 100, 4)}em` : px(ls.value);
  const color = firstSolid(n.fillPaints);
  if (color) s.color = color;
  if (n.textCase === 'UPPER') s.textTransform = 'uppercase';
  else if (n.textCase === 'LOWER') s.textTransform = 'lowercase';
  else if (n.textCase === 'TITLE') s.textTransform = 'capitalize';
  else if (n.textCase === 'SMALL_CAPS' || n.textCase === 'SMALL_CAPS_FORCED') s.fontVariant = 'small-caps';
  if (n.textDecoration === 'UNDERLINE') s.textDecoration = 'underline';
  else if (n.textDecoration === 'STRIKETHROUGH') s.textDecoration = 'line-through';
}

interface TextRun {
  text: string;
  /** Style override for the run (undefined = the node's own style). */
  override?: FigmaNode;
}

/** Character runs sharing a style (Figma's characterStyleIDs + styleOverrideTable). */
function textRuns(n: FigmaNode): TextRun[] {
  const chars = n.textData?.characters ?? '';
  const ids = n.textData?.characterStyleIDs ?? [];
  const table = new Map((n.textData?.styleOverrideTable ?? []).map((o) => [o.styleID ?? -1, o]));
  if (!ids.length || !table.size) return [{ text: chars }];
  const runs: TextRun[] = [];
  let start = 0;
  const styleAt = (i: number) => ids[i] ?? 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && styleAt(i) === styleAt(start)) continue;
    const override = table.get(styleAt(start));
    const prev = runs[runs.length - 1];
    if (prev && prev.override === override) prev.text += chars.slice(start, i);
    else runs.push({ text: chars.slice(start, i), override });
    start = i;
  }
  return runs;
}

/** The node's style with a run's overrides applied. */
function runStyles(n: FigmaNode, run: TextRun): Record<string, string> {
  const s: Record<string, string> = {};
  textStyles(n, s);
  if (run.override) {
    const o: Record<string, string> = {};
    textStyles(run.override, o, n);
    Object.assign(s, o);
  }
  s.fontWeight ??= '400';
  return s;
}

// ---- layout & emission -----------------------------------------------------------------------

function toCss(s: Record<string, string>): string {
  return Object.entries(s)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v}`)
    .join('; ');
}

type ParentLayout = { kind: 'root' | 'free'; origin: { x: number; y: number } } | { kind: 'flex'; dir: 'row' | 'column' };

function rotationOf(t: FigmaMatrix | undefined): number {
  if (!t) return 0;
  return (Math.atan2(t.m10, t.m00) * 180) / Math.PI;
}

/** Unrotated top-left (relative to the parent) of a node's box. */
function boxPosition(n: FigmaNode): { x: number; y: number } {
  const t = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const cx = t.m00 * (w / 2) + t.m01 * (h / 2) + t.m02;
  const cy = t.m10 * (w / 2) + t.m11 * (h / 2) + t.m12;
  return { x: cx - w / 2, y: cy - h / 2 };
}

const HUG = (v: string | undefined) => v === 'RESIZE_TO_FIT' || v === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE';

function emit(raw: FigmaNode, ctx: Ctx, scope: Scope, parent: ParentLayout, depth: number): string {
  const n = effective(raw, scope);
  if (!n.type || SKIPPED_TYPES.has(n.type)) {
    if (n.type && !['DOCUMENT', 'CANVAS'].includes(n.type)) ctx.warnings.add(`${n.type.toLowerCase().replace(/_/g, ' ')} layers are not supported and were skipped.`);
    return '';
  }
  if (n.mask) {
    ctx.warnings.add('Masks are not supported; masked layers are pasted unmasked.');
    return '';
  }
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  const s: Record<string, string> = {};
  const indent = '  '.repeat(depth);
  const absolute = parent.kind !== 'flex' || n.stackPositioning === 'ABSOLUTE';

  // Position.
  if (absolute) {
    const pos = boxPosition(n);
    const origin = parent.kind === 'flex' ? { x: 0, y: 0 } : parent.origin;
    if (parent.kind !== 'root' || origin.x !== Infinity) {
      s.position = 'absolute';
      s.left = px(pos.x - origin.x);
      s.top = px(pos.y - origin.y);
    }
  }
  const rot = rotationOf(n.transform);
  if (Math.abs(rot) > 0.01) s.rotate = `${round(rot, 2)}deg`;

  // Size.
  const isText = n.type === 'TEXT';
  const auto = n.stackMode === 'HORIZONTAL' || n.stackMode === 'VERTICAL' || n.stackMode === 'GRID';
  const ownDir = n.stackMode === 'VERTICAL' ? 'column' : 'row';
  let width: string | null = px(w);
  let height: string | null = px(h);
  if (auto) {
    if (HUG(n.stackPrimarySizing)) ownDir === 'row' ? (width = 'fit-content') : (height = 'fit-content');
    if (HUG(n.stackCounterSizing)) ownDir === 'row' ? (height = 'fit-content') : (width = 'fit-content');
  }
  if (isText) {
    if (n.textAutoResize === 'WIDTH_AND_HEIGHT') {
      width = null;
      height = null;
      s.whiteSpace = 'pre';
    } else if (n.textAutoResize === 'HEIGHT') height = null;
  }
  if (parent.kind === 'flex' && !absolute) {
    const primaryIsWidth = parent.dir === 'row';
    if (n.stackChildPrimaryGrow && n.stackChildPrimaryGrow > 0) {
      s.flexGrow = '1';
      s.flexBasis = '0px';
      if (primaryIsWidth) {
        width = null;
        s.minWidth = '0px';
      } else {
        height = null;
        s.minHeight = '0px';
      }
    } else s.flexShrink = '0';
    if (n.stackChildAlignSelf === 'STRETCH') {
      s.alignSelf = 'stretch';
      if (primaryIsWidth) height = null;
      else width = null;
    }
  }
  if (width) s.width = width;
  if (height) s.height = height;

  common(n, s);
  const name = n.name ? ` layer-name="${escAttr(n.name.slice(0, 200))}"` : '';
  const hidden = n.visible === false ? ' hidden' : '';

  // Text.
  if (isText) {
    textStyles(n, s);
    if (!s.whiteSpace) s.whiteSpace = 'pre-wrap';
    if (n.textAlignHorizontal === 'CENTER') s.textAlign = 'center';
    else if (n.textAlignHorizontal === 'RIGHT') s.textAlign = 'right';
    else if (n.textAlignHorizontal === 'JUSTIFIED') s.textAlign = 'justify';
    if (n.textAlignVertical === 'CENTER') s.alignContent = 'center';
    else if (n.textAlignVertical === 'BOTTOM') s.alignContent = 'end';
    strokeAndEffects({ ...n, strokePaints: [] }, s, ctx);
    const runs = textRuns(n);
    const chars = n.textData?.characters ?? '';
    if (runs.length > 1) {
      // Mixed styles stay one text layer: each override is a span (imported as a text run).
      const inner = runs
        .map((run) => {
          if (!run.override) return esc(run.text);
          const rs = runStyles(n, run);
          const diff: Record<string, string> = {};
          for (const [k, v] of Object.entries(rs)) if (s[k] !== v) diff[k] = v;
          return Object.keys(diff).length ? `<span style="${escAttr(toCss(diff))}">${esc(run.text)}</span>` : esc(run.text);
        })
        .join('');
      return `${indent}<div${name}${hidden} data-paper-component="Text" style="${escAttr(toCss(s))}">${inner}</div>`;
    }
    return `${indent}<div${name}${hidden} style="${escAttr(toCss(s))}">${esc(chars)}</div>`;
  }

  // Vector-like shapes.
  if (SHAPE_TYPES.has(n.type) || (n.type === 'ELLIPSE' && n.arcData && ((n.arcData.innerRadius ?? 0) > 0 || Math.abs((n.arcData.endingAngle ?? 6.2832) - (n.arcData.startingAngle ?? 0)) < 6.28))) {
    const svg = shapeSvg(n, w, h, ctx);
    if (svg) {
      strokeAndEffects({ ...n, strokePaints: [] }, s, ctx);
      return `${indent}${svg.replace(/^<svg/, `<svg${name}${hidden} style="${escAttr(toCss(s))}"`)}`;
    }
    if (n.type !== 'ELLIPSE') ctx.warnings.add('Some vector shapes had no path data in the clipboard and were pasted as plain boxes.');
  }

  // Boxes: frames, groups, rectangles, ellipses, components, instances, sections.
  backgroundStyles(n.fillPaints, w, h, ctx, s);
  if (n.type === 'ELLIPSE') s.borderRadius = '50%';
  else corners(n, s);
  strokeAndEffects(n, s, ctx);

  const { kids, scope: childScope } = childrenOf(n, ctx, scope);
  const container = kids.length > 0 || ['FRAME', 'GROUP', 'SECTION', 'SYMBOL', 'INSTANCE', 'COMPONENT_SET'].includes(n.type);
  const clips = n.type === 'SECTION' || (n.frameMaskDisabled === false && !n.resizeToFit) || (n.type === 'INSTANCE' && n.frameMaskDisabled !== true && !n.resizeToFit);
  if (container && clips && kids.length) s.overflow = 'hidden';

  let childLayout: ParentLayout = { kind: 'free', origin: { x: 0, y: 0 } };
  if (auto && kids.length) {
    s.display = 'flex';
    s.flexDirection = ownDir;
    if (n.stackMode === 'GRID' || n.stackWrap === 'WRAP') s.flexWrap = 'wrap';
    if (n.stackSpacing) s.gap = n.stackWrap === 'WRAP' && n.stackCounterSpacing !== undefined ? `${px(n.stackCounterSpacing)} ${px(n.stackSpacing)}` : px(n.stackSpacing);
    const left = n.stackHorizontalPadding ?? n.stackPadding ?? 0;
    const top = n.stackVerticalPadding ?? n.stackPadding ?? 0;
    const right = n.stackPaddingRight ?? left;
    const bottom = n.stackPaddingBottom ?? top;
    if (left || top || right || bottom) s.padding = [top, right, bottom, left].map(px).join(' ');
    const justify = { CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between', SPACE_EVENLY: 'space-evenly' }[n.stackPrimaryAlignItems ?? ''];
    if (justify) s.justifyContent = justify;
    const align = { CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[n.stackCounterAlignItems ?? ''] ?? 'flex-start';
    s.alignItems = align;
    childLayout = { kind: 'flex', dir: ownDir };
    if (kids.some((k) => effective(k, childScope).stackPositioning === 'ABSOLUTE')) s.position ??= 'relative';
  } else if (kids.length) {
    s.position ??= 'relative';
  }

  const tag = n.type === 'RECTANGLE' || n.type === 'ROUNDED_RECTANGLE' || (n.type === 'ELLIPSE' && !kids.length) ? ' paper-node="Rectangle"' : '';
  const inner = kids
    .map((k) => emit(k, ctx, childScope, childLayout, depth + 1))
    .filter(Boolean)
    .join('\n');
  const open = `${indent}<div${name}${hidden}${tag} style="${escAttr(toCss(s))}">`;
  return inner ? `${open}\n${inner}\n${indent}</div>` : `${open}</div>`;
}

/** Convert decoded Figma clipboard data to OpenPaper-importable HTML. */
export function figmaToHtml(message: FigmaMessage, opts: FigmaConvertOptions = {}): FigmaConvertResult {
  const ctx: Ctx = {
    nodes: new Map(),
    children: new Map(),
    blobs: (message.blobs ?? []).map((b) => b.bytes),
    fileKey: opts.fileKey ?? message.pasteFileKey ?? 'unknown',
    images: new Set(),
    warnings: new Set(),
  };
  const all = message.nodeChanges ?? [];
  for (const n of all) if (n.guid) ctx.nodes.set(key(n.guid), n);
  for (const n of all) {
    if (!n.parentIndex) continue;
    const k = key(n.parentIndex.guid);
    const list = ctx.children.get(k) ?? [];
    list.push(n);
    ctx.children.set(k, list);
  }
  // Fractional-index positions order siblings; the first child is at the bottom of the stack (first in HTML).
  for (const list of ctx.children.values()) list.sort((a, b) => (a.parentIndex!.position < b.parentIndex!.position ? -1 : a.parentIndex!.position > b.parentIndex!.position ? 1 : 0));

  const pages = all.filter((n) => n.type === 'CANVAS' && !n.internalOnly);
  const top = pages.flatMap((p) => ctx.children.get(key(p.guid)) ?? []).filter((n) => n.type && !SKIPPED_TYPES.has(n.type));
  let origin = { x: Infinity, y: 0 };
  if (opts.keepPositions && top.length) {
    const boxes = top.map(boxPosition);
    origin = { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
  }
  const html = top
    .map((n) => emit(n, ctx, ROOT_SCOPE, { kind: 'root', origin }, 0))
    .filter(Boolean)
    .join('\n');
  return { html, layers: top.length, images: ctx.images.size, warnings: [...ctx.warnings] };
}
