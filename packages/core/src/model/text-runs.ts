import { colorKey } from '../query/find-nodes.ts';
import { normalizeStyleValue, type StyleMap } from '../styles/css.ts';
import type { NodeRecord, TextRun } from './types.ts';

/**
 * Rich text runs: parts of one Text node's text with their own inline style. The node keeps
 * everything that shapes the paragraph (line height, alignment, width); runs only override
 * properties that make sense on an inline span.
 */

export const TEXT_RUN_PROPS: readonly string[] = [
  'color',
  'fontWeight',
  'fontStyle',
  'fontFamily',
  'fontSize',
  'letterSpacing',
  'textDecoration',
  'textDecorationLine',
  'textDecorationColor',
  'textDecorationStyle',
  'textDecorationThickness',
  'textUnderlineOffset',
  'textTransform',
  'backgroundColor',
];

const RUN_PROPS = new Set(TEXT_RUN_PROPS);

/** What a property is when neither the run nor the node sets it. */
const RUN_DEFAULTS: Record<string, string[]> = {
  fontWeight: ['400', 'normal'],
  fontStyle: ['normal'],
  letterSpacing: ['normal'],
  textDecoration: ['none'],
  textDecorationLine: ['none'],
  textTransform: ['none'],
  backgroundColor: ['transparent'],
};

const COLOR_PROPS = new Set(['color', 'backgroundColor', 'textDecorationColor']);

/** Properties that don't show on a space: a whitespace-only run takes them from its neighbour. */
const INK_PROPS = ['color', 'fontWeight', 'fontStyle', 'textTransform'];

/** A single run keeps these as a run: as node styles they would paint the whole box, not the text. */
const NOT_HOISTED = new Set(['backgroundColor']);

/** Inline styles implied by formatting tags (b = 700, i = italic, u = underline, …). */
const TAG_RUN_STYLES: Record<string, StyleMap> = {
  b: { fontWeight: '700' },
  strong: { fontWeight: '700' },
  i: { fontStyle: 'italic' },
  em: { fontStyle: 'italic' },
  u: { textDecoration: 'underline' },
  ins: { textDecoration: 'underline' },
  s: { textDecoration: 'line-through' },
  strike: { textDecoration: 'line-through' },
  del: { textDecoration: 'line-through' },
  mark: { backgroundColor: '#ffff00', color: '#000000' },
  code: { fontFamily: 'monospace' },
  kbd: { fontFamily: 'monospace' },
  samp: { fontFamily: 'monospace' },
};

const DECORATION_LINES = /^(underline|overline|line-through)(\s+(underline|overline|line-through))*$/;

/** Decorations add up through nested elements; `none` can't remove an outer one (as in CSS). */
function combineDecoration(outer: string | undefined, inner: string): string {
  if (!outer || outer === 'none') return inner;
  if (inner === 'none') return outer;
  if (!DECORATION_LINES.test(outer) || !DECORATION_LINES.test(inner)) return inner;
  return [...new Set([...outer.split(/\s+/), ...inner.split(/\s+/)])].join(' ');
}

/**
 * Run styles inside an inline element: the enclosing run's styles, the tag's defaults, then the
 * element's own inline styles (run properties only). Used by HTML import and the text editor.
 */
export function inlineRunStyles(tag: string, own: StyleMap, outer: StyleMap): StyleMap {
  const s: StyleMap = { ...outer };
  const set = (k: string, v: string) => {
    s[k] = k === 'textDecoration' || k === 'textDecorationLine' ? combineDecoration(s[k], v) : v;
  };
  for (const [k, v] of Object.entries(TAG_RUN_STYLES[tag] ?? {})) set(k, v);
  for (const k of TEXT_RUN_PROPS) {
    const v = k === 'color' ? (own.WebkitTextFillColor ?? own.color) : own[k];
    if (v !== undefined) set(k, v);
  }
  return s;
}

function sameValue(prop: string, a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) {
    const v = a ?? b!;
    return RUN_DEFAULTS[prop]?.includes(v) ?? false;
  }
  if (COLOR_PROPS.has(prop)) {
    const ka = colorKey(a);
    return ka !== null && ka === colorKey(b);
  }
  if (prop === 'fontWeight') return (a === 'normal' ? '400' : a === 'bold' ? '700' : a) === (b === 'normal' ? '400' : b === 'bold' ? '700' : b);
  return false;
}

function sameStyles(a: StyleMap, b: StyleMap): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] !== undefined && sameValue(k, a[k], b[k]));
}

/** Text of a run list. */
export function runsText(runs: ReadonlyArray<{ text: string }>): string {
  return runs.map((r) => r.text).join('');
}

export function cloneRuns(runs: readonly TextRun[]): TextRun[] {
  return runs.map((r) => (r.styles ? { text: r.text, styles: { ...r.styles } } : { text: r.text }));
}

/** Style keys in the runs that runs can't carry (reported back to agents). */
export function unsupportedRunProps(runs: ReadonlyArray<{ styles?: Record<string, unknown> }>): string[] {
  const out = new Set<string>();
  for (const r of runs) for (const k of Object.keys(r.styles ?? {})) if (!RUN_PROPS.has(k)) out.add(k);
  return [...out];
}

/** A run's own overrides: supported properties only, values that differ from the node. */
function ownStyles(styles: Record<string, unknown> | undefined, base: StyleMap): StyleMap {
  const out: StyleMap = {};
  for (const [k, raw] of Object.entries(styles ?? {})) {
    if (!RUN_PROPS.has(k)) continue;
    const v = normalizeStyleValue(k, raw);
    if (v === null || sameValue(k, v, base[k])) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Normalize runs against the node's styles: unsupported and redundant properties are dropped,
 * empty runs removed and equal neighbours merged. When one style is left, `runs` is undefined
 * and `hoist` holds the styles that move onto the node.
 */
export function normalizeRuns(
  input: ReadonlyArray<{ text: string; styles?: Record<string, unknown> }>,
  base: StyleMap
): { runs?: TextRun[]; hoist: StyleMap } {
  const runs = input.filter((r) => r.text !== '').map((r) => ({ text: r.text, styles: ownStyles(r.styles, base) }));
  runs.forEach((r, i) => {
    if (/\S/.test(r.text)) return;
    const from = runs[i - 1] ?? runs[i + 1];
    if (!from) return;
    for (const k of INK_PROPS) {
      if (from.styles[k] === undefined) delete r.styles[k];
      else r.styles[k] = from.styles[k]!;
    }
  });
  const merged: Array<{ text: string; styles: StyleMap }> = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && sameStyles(prev.styles, r.styles)) prev.text += r.text;
    else merged.push(r);
  }
  if (merged.length <= 1) {
    const hoist: StyleMap = { ...merged[0]?.styles };
    const kept: StyleMap = {};
    for (const k of Object.keys(hoist)) {
      if (!NOT_HOISTED.has(k)) continue;
      kept[k] = hoist[k]!;
      delete hoist[k];
    }
    if (Object.keys(kept).length) return { runs: [{ text: merged[0]!.text, styles: kept }], hoist };
    return { hoist };
  }
  return { runs: merged.map((r) => (Object.keys(r.styles).length ? r : { text: r.text })), hoist: {} };
}

/** Set a Text record's text from runs (mutates a draft): textValue, normalized runs, hoisted styles. */
export function applyTextRuns(draft: NodeRecord, input: ReadonlyArray<{ text: string; styles?: Record<string, unknown> }>): void {
  const { runs, hoist } = normalizeRuns(input, draft.styles);
  draft.textValue = runsText(input);
  Object.assign(draft.styles, hoist);
  if (runs) draft.textRuns = runs;
  else delete draft.textRuns;
}
