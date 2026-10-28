import { Element, Text, type ChildNode, type Document } from 'domhandler';
import { selectAll } from 'css-select';
import { parse as parseSelector, SelectorType, type Selector } from 'css-what';
import { cssBlocks, keyframesFromCss } from '../animation/keyframes.ts';
import { parseDeclarations, styleMapToCss, type Declaration, type StyleMap } from '../styles/css.ts';
import type { KeyframesRecord } from '../model/types.ts';
import { bodyContent, findElement, parseHtml } from './dom.ts';

/**
 * `<style>` sheets in imported HTML (an OpenPaper extension: Paper reads inline styles only).
 * Layers carry their own styles, so the sheet's rules are resolved the way a browser would
 * (cascade layers, specificity, source order, `!important`, `var()`) and written into each
 * element's inline style before the import runs. `@keyframes` rules become the file's keyframes.
 * Rules that need a state or a generated box (`:hover`, `::before`) can't become layers and are
 * left out.
 */

/** Width and height the page is imagined at for `@media` queries (a desktop artboard). */
export const IMPORT_VIEWPORT_WIDTH = 1440;
const IMPORT_VIEWPORT_HEIGHT = 900;
/** More rules than this (a whole framework's CSS) are cut off rather than slowing every paste. */
const MAX_RULES = 6000;
/** Characters `var()` substitution may produce per value (variables that nest can grow exponentially). */
const MAX_VAR_OUTPUT = 10_000;

/** States a design layer is never in. */
const DYNAMIC_PSEUDOS = new Set([
  'hover',
  'focus',
  'focus-within',
  'focus-visible',
  'active',
  'visited',
  'target',
  'target-within',
  'user-invalid',
  'user-valid',
  'autofill',
  'open',
  'popover-open',
  'modal',
  'fullscreen',
  'playing',
  'paused',
]);

/** Shorthands and the longhands a later shorthand resets. */
const SHORTHANDS: Record<string, string[]> = {
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'backgroundAttachment'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'],
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'],
  border: ['borderWidth', 'borderStyle', 'borderColor', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
  inset: ['top', 'right', 'bottom', 'left'],
  gap: ['rowGap', 'columnGap'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  overflow: ['overflowX', 'overflowY'],
  font: ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight'],
  animation: ['animationName', 'animationDuration', 'animationTimingFunction', 'animationDelay', 'animationIterationCount', 'animationDirection', 'animationFillMode', 'animationPlayState'],
  transition: ['transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay'],
  outline: ['outlineWidth', 'outlineStyle', 'outlineColor'],
};

interface Rule {
  selector: Selector[];
  decls: Declaration[];
  specificity: number;
  /** Cascade layer: its order of first appearance; Infinity for rules outside any layer. */
  layer: number;
  order: number;
}

export interface StyledFragment {
  /** The nodes to import (body content), with sheet rules resolved into their inline styles. */
  nodes: ChildNode[];
  /** `@keyframes` from the sheets. */
  keyframes: KeyframesRecord[];
  /** Styles of `<html>` and `<body>` that their content inherits (typography, colour). */
  rootStyles: StyleMap;
  warnings: string[];
}

/** Browsers always have `<html>` and `<body>`; give a fragment them too, so `body {}` and `:root {}` rules apply. */
function ensureBody(doc: Document): void {
  if (findElement(doc.children, (el) => el.name === 'body')) return;
  const htmlEl = doc.children.find((n): n is Element => n instanceof Element && n.name === 'html');
  const holder = htmlEl ?? doc;
  const body = new Element('body', {}, holder.children);
  for (const c of body.children) c.parent = body;
  if (htmlEl) {
    htmlEl.children = [body];
    body.parent = htmlEl;
    return;
  }
  const root = new Element('html', {}, [body]);
  body.parent = root;
  root.parent = doc;
  doc.children = [root];
}

/** `<style>` elements of the page itself (an SVG's own sheet is inlined with the drawing, an embed keeps its own). */
function styleElements(nodes: ChildNode[], out: Element[] = []): Element[] {
  for (const n of nodes) {
    if (!(n instanceof Element)) continue;
    const name = n.name.toLowerCase();
    if (name === 'style') out.push(n);
    else if (name !== 'svg' && name !== 'x-embed' && name !== 'template') styleElements(n.children, out);
  }
  return out;
}

function textOf(el: Element): string {
  return el.children.map((c) => (c instanceof Text ? c.data : '')).join('');
}

// ---- media queries ---------------------------------------------------------------

function lengthPx(v: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'em' || m[2] === 'rem' ? 16 : 1);
}

const COMPARE: Record<string, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '=': (a, b) => a === b,
};
const FLIP: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' };

/** Range syntax: `(width >= 48rem)`, `(640px < width <= 1440px)`. Null when it isn't one. */
function rangeMatches(inner: string): boolean | null {
  const parts = inner.split(/\s*(<=|>=|<|>|=)\s*/).map((p) => p.trim());
  if (parts.length !== 3 && parts.length !== 5) return null;
  const size = (name: string) => (name === 'width' ? IMPORT_VIEWPORT_WIDTH : name === 'height' ? IMPORT_VIEWPORT_HEIGHT : null);
  const check = (left: string, op: string, right: string): boolean | null => {
    const l = size(left);
    if (l !== null) {
      const r = lengthPx(right);
      return r === null ? null : COMPARE[op]!(l, r);
    }
    const r = size(right);
    const lv = lengthPx(left);
    return r === null || lv === null ? null : COMPARE[FLIP[op]!]!(r, lv);
  };
  if (parts.length === 3) return check(parts[0]!.toLowerCase(), parts[1]!, parts[2]!.toLowerCase());
  const first = check(parts[0]!, parts[1]!, parts[2]!.toLowerCase());
  const second = check(parts[2]!.toLowerCase(), parts[3]!, parts[4]!);
  return first === null || second === null ? null : first && second;
}

function featureMatches(feature: string): boolean {
  const inner = /^\((.*)\)$/s.exec(feature.trim())?.[1]?.trim();
  if (!inner) return false;
  const range = /[<>=]/.test(inner) && !inner.includes(':') ? rangeMatches(inner) : null;
  if (range !== null) return range;
  const m = /^([a-z-]+)\s*(?::\s*(.+))?$/i.exec(inner);
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  const value = (m[2] ?? '').trim().toLowerCase();
  switch (name) {
    case 'min-width':
      return (lengthPx(value) ?? Infinity) <= IMPORT_VIEWPORT_WIDTH;
    case 'max-width':
      return (lengthPx(value) ?? -Infinity) >= IMPORT_VIEWPORT_WIDTH;
    case 'min-height':
      return (lengthPx(value) ?? Infinity) <= IMPORT_VIEWPORT_HEIGHT;
    case 'max-height':
      return (lengthPx(value) ?? -Infinity) >= IMPORT_VIEWPORT_HEIGHT;
    case 'prefers-reduced-motion':
      return value === 'no-preference';
    case 'prefers-color-scheme':
      return value === 'light';
    case 'hover':
    case 'any-hover':
      return value === 'hover';
    case 'pointer':
    case 'any-pointer':
      return value === 'fine';
    case 'orientation':
      return value === 'landscape';
    default:
      return false;
  }
}

/** Does a media query list hold for a desktop screen IMPORT_VIEWPORT_WIDTH wide? */
export function mediaMatches(query: string): boolean {
  return query.split(',').some((q) => {
    let rest = q.trim().toLowerCase();
    if (!rest) return false;
    if (rest.startsWith('not ')) return false;
    rest = rest.replace(/^only\s+/, '');
    const parts = rest.split(/\s+and\s+/);
    if (!parts[0]!.startsWith('(')) {
      const type = parts.shift()!;
      if (type !== 'all' && type !== 'screen') return false;
    }
    return parts.every(featureMatches);
  });
}

// ---- selectors -------------------------------------------------------------------

function specificityOf(selector: Selector[]): number {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const s of selector) {
    if (s.type === SelectorType.Attribute) {
      // `#x` (css-what marks the shorthand), not `[id=x]`, which counts as an attribute.
      if (s.name === 'id' && s.action === 'equals' && s.ignoreCase === 'quirks') a++;
      else b++;
    } else if (s.type === SelectorType.Pseudo) {
      if (s.name === 'where') continue;
      if (Array.isArray(s.data) && ['not', 'is', 'matches', 'has', 'any'].includes(s.name)) {
        const inner = Math.max(0, ...s.data.map(specificityOf));
        a += Math.floor(inner / 1e6);
        b += Math.floor((inner % 1e6) / 1e3);
        c += inner % 1e3;
      } else b++;
    } else if (s.type === SelectorType.Tag || s.type === SelectorType.PseudoElement) c++;
  }
  return a * 1e6 + b * 1e3 + c;
}

/**
 * Can a rule with this selector style a layer? Not one for a state (`:hover`) or a generated box
 * (`::before`). Inside `:not()` a state is fine: a layer is never hovered, so `:not(:hover)` holds.
 */
function usable(selector: Selector[], negated = false): boolean {
  return selector.every((s) => {
    if (s.type === SelectorType.PseudoElement) return false;
    if (s.type === SelectorType.Pseudo) {
      if (DYNAMIC_PSEUDOS.has(s.name)) return negated;
      if (Array.isArray(s.data)) return s.data.every((inner) => usable(inner, s.name === 'not' ? !negated : negated));
    }
    return true;
  });
}

interface Collect {
  rules: Rule[];
  warnings: string[];
  /** Cascade layers in order of first appearance. */
  layers: Map<string, number>;
  anonymous: number;
}

function layerRank(c: Collect, name: string): number {
  let rank = c.layers.get(name);
  if (rank === undefined) c.layers.set(name, (rank = c.layers.size));
  return rank;
}

function collectRules(css: string, c: Collect, layer: string | null): void {
  // `@layer a, b;` fixes the order of layers before their rules appear.
  for (const m of css.matchAll(/@layer\s+([^{};]+);/g)) {
    for (const name of m[1]!.split(',')) layerRank(c, layer ? `${layer}.${name.trim()}` : name.trim());
  }
  for (const [prelude, body] of cssBlocks(css)) {
    if (c.rules.length >= MAX_RULES) {
      c.warnings.push(`Only the first ${MAX_RULES} style rules were applied.`);
      return;
    }
    if (prelude.startsWith('@')) {
      const at = /^@([a-z-]+)\s*(.*)$/is.exec(prelude);
      const kind = at?.[1]?.toLowerCase();
      const condition = at?.[2]?.trim() ?? '';
      if (kind === 'media') {
        if (mediaMatches(condition)) collectRules(body, c, layer);
      } else if (kind === 'layer') {
        const name = condition || `<anonymous ${++c.anonymous}>`;
        const path = layer ? `${layer}.${name}` : name;
        layerRank(c, path);
        collectRules(body, c, path);
      } else if (kind === 'supports') {
        // Assume a current browser: what a page tests for is there, unless it asks for its absence.
        if (!/^not\b/i.test(condition)) collectRules(body, c, layer);
      } else if (kind === 'container') {
        // The container is taken to be as wide as the page.
        const query = condition.slice(Math.max(0, condition.indexOf('(')));
        if (!query || mediaMatches(query)) collectRules(body, c, layer);
      } else if (kind === 'scope') collectRules(body, c, layer);
      continue;
    }
    let selectors: Selector[][];
    try {
      selectors = parseSelector(prelude);
    } catch {
      continue;
    }
    const decls = parseDeclarations(body);
    if (!decls.length) continue;
    for (const selector of selectors) {
      if (!usable(selector)) continue;
      c.rules.push({ selector, decls, specificity: specificityOf(selector), layer: layer === null ? Infinity : layerRank(c, layer), order: c.rules.length });
    }
  }
}

// ---- var() -------------------------------------------------------------------------

class TooLong extends Error {}

/** Substitute `var(--x, fallback)` from `env`; references `env` doesn't know are kept (they may be tokens). */
function substituteVars(value: string, env: ReadonlyMap<string, string>): string {
  if (!value.includes('var(') || !env.size) return value;
  const budget = { left: MAX_VAR_OUTPUT };
  try {
    return substitute(value, env, 0, budget);
  } catch (error) {
    if (error instanceof TooLong) return value;
    throw error;
  }
}

function substitute(value: string, env: ReadonlyMap<string, string>, depth: number, budget: { left: number }): string {
  if (!value.includes('var(') || depth > 8) return value;
  let out = '';
  let i = 0;
  const add = (text: string) => {
    budget.left -= text.length;
    if (budget.left < 0) throw new TooLong();
    out += text;
  };
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start < 0) {
      add(value.slice(i));
      break;
    }
    add(value.slice(i, start));
    // Find the matching parenthesis.
    let depthP = 0;
    let end = start + 3;
    for (; end < value.length; end++) {
      if (value[end] === '(') depthP++;
      else if (value[end] === ')' && --depthP === 0) break;
    }
    const inner = value.slice(start + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const known = env.get(name);
    if (known !== undefined) add(substitute(known, env, depth + 1, budget));
    else add(value.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

function topLevelComma(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return i;
  }
  return -1;
}

function setDecl(map: StyleMap, prop: string, value: string): void {
  for (const k of SHORTHANDS[prop] ?? []) delete map[k];
  // Re-inserted last: style objects apply in key order, so a later shorthand still wins over a longhand.
  delete map[prop];
  map[prop] = value;
}

/** Normal declarations: later layers win, rules outside a layer win over layered ones. Important: the reverse. */
function cascadeOrder(important: boolean) {
  return (x: Rule, y: Rule) => (important ? y.layer - x.layer : x.layer - y.layer) || x.specificity - y.specificity || x.order - y.order;
}

// ---- the cascade -------------------------------------------------------------------

/** Import, image and media collection all parse the same HTML in a row: the last result is kept. */
let last: { html: string; result: StyledFragment } | null = null;

/**
 * Parse HTML for import. Without `<style>` elements this is a plain parse; with them, every
 * element's inline style becomes its cascaded style. The result must be treated as read-only.
 */
export function parseStyledFragment(html: string): StyledFragment {
  if (last?.html === html) return last.result;
  const result = parse(html);
  last = { html, result };
  return result;
}

function parse(html: string): StyledFragment {
  const doc = parseHtml(html);
  const sheets = styleElements(doc.children);
  const warnings: string[] = [];
  if (!sheets.length) return { nodes: bodyContent(doc), keyframes: [], rootStyles: {}, warnings };

  ensureBody(doc);
  const css = sheets.map(textOf).join('\n');
  const keyframes = keyframesFromCss(css, warnings);
  const collected: Collect = { rules: [], warnings, layers: new Map(), anonymous: 0 };
  collectRules(css, collected, null);

  const matched = new Map<Element, Rule[]>();
  for (const rule of collected.rules) {
    let hits: Element[];
    try {
      hits = selectAll<ChildNode, Element>([rule.selector], doc);
    } catch {
      continue; // a selector css-select doesn't support
    }
    for (const el of hits) {
      const list = matched.get(el);
      if (list) list.push(rule);
      else matched.set(el, [rule]);
    }
  }

  const rootStyles: StyleMap = {};
  const visit = (nodes: ChildNode[], env: ReadonlyMap<string, string>) => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      const tag = n.name.toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'template') continue;
      const own = matched.get(n) ?? [];
      const inline = parseDeclarations(n.attribs.style);
      const ordered = [
        ...[...own].sort(cascadeOrder(false)).flatMap((r) => r.decls.filter((d) => !d.important)),
        ...inline.filter((d) => !d.important),
        ...[...own].sort(cascadeOrder(true)).flatMap((r) => r.decls.filter((d) => d.important)),
        ...inline.filter((d) => d.important),
      ];
      let scope = env;
      const custom = ordered.filter((d) => d.prop.startsWith('--'));
      if (custom.length) {
        const next = new Map(env);
        for (const d of custom) next.set(d.prop, d.value);
        scope = next;
      }
      const root = tag === 'html' || tag === 'body';
      if (own.length || root || (scope.size && n.attribs.style?.includes('var('))) {
        const styles: StyleMap = {};
        for (const d of ordered) if (!d.prop.startsWith('--')) setDecl(styles, d.prop, substituteVars(d.value, scope));
        const text = styleMapToCss(styles);
        if (text) n.attribs.style = text;
        else delete n.attribs.style;
        if (root) Object.assign(rootStyles, styles);
      }
      // An embed's own document keeps its own styles.
      if (tag !== 'x-embed') visit(n.children, scope);
    }
  };
  visit(doc.children, new Map());
  return { nodes: bodyContent(doc), keyframes, rootStyles, warnings };
}
