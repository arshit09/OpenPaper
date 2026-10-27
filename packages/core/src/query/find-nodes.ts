import { converter, parse } from 'culori';
import type { NodeRecord, TokenRecord } from '../model/types.ts';
import { globMatcher, resolveTokenValue, tokenCssName } from '../tokens/tokens.ts';

/**
 * Style/text matching used by `find_nodes`.
 *
 * - names: lower-cased, `-` removed (`background-color` ≡ `backgroundColor`); aliases
 *   radius→borderRadius, background/bg→backgroundColor; missing → `*`
 * - values: globs (`*` wildcard, case-insensitive, anchored); color values match by
 *   color equivalence (also inside compound values and through color tokens).
 */

export interface StyleFilter {
  styleName?: string;
  styleValue?: string;
}

export interface MatchEntry {
  styleName?: string;
  styleValue?: string;
  textValue?: string;
}

const toRgb = converter('rgb');

/** Quantized color key (8-bit channels + 8-bit alpha) or null when not a color. */
export function colorKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('var(')) return null;
  const parsed = parse(trimmed);
  if (!parsed) return null;
  const rgb = toRgb(parsed);
  if (!rgb) return null;
  const q = (n: number | undefined) => Math.round(Math.min(1, Math.max(0, n ?? 0)) * 255);
  return `${q(rgb.r)},${q(rgb.g)},${q(rgb.b)},${q(rgb.alpha ?? 1)}`;
}

const COLOR_LITERAL_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;
const VAR_RE = /var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/g;

function normName(name: string): string {
  const n = name.toLowerCase().replace(/-/g, '');
  if (n === 'radius') return 'borderradius';
  if (n === 'background' || n === 'bg') return 'backgroundcolor';
  return n;
}

function normVar(value: string): string {
  return value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g, 'var($1)');
}

function normValue(value: string | undefined): string {
  if (value === undefined) return '*';
  let v = normVar(value.trim());
  if (/^--[A-Za-z0-9_-]+$/.test(v)) v = `var(${v})`;
  return v || '*';
}

// Shorthand families: keys sharing a "slot" overlap (e.g. padding ↔ paddingTop).
const SIDE_FAMILIES: Record<string, string[]> = {
  margin: ['margin', 'margintop', 'marginright', 'marginbottom', 'marginleft', 'margininline', 'marginblock'],
  padding: ['padding', 'paddingtop', 'paddingright', 'paddingbottom', 'paddingleft', 'paddinginline', 'paddingblock'],
  inset: ['inset', 'top', 'right', 'bottom', 'left', 'insetinline', 'insetblock'],
  border: [
    'border',
    'borderwidth',
    'borderstyle',
    'bordercolor',
    'bordertop',
    'borderright',
    'borderbottom',
    'borderleft',
    'bordertopwidth',
    'borderrightwidth',
    'borderbottomwidth',
    'borderleftwidth',
    'bordertopcolor',
    'borderrightcolor',
    'borderbottomcolor',
    'borderleftcolor',
    'bordertopstyle',
    'borderrightstyle',
    'borderbottomstyle',
    'borderleftstyle',
  ],
  radius: [
    'borderradius',
    'bordertopleftradius',
    'bordertoprightradius',
    'borderbottomrightradius',
    'borderbottomleftradius',
    'borderstartstartradius',
    'borderstartendradius',
    'borderendstartradius',
    'borderendendradius',
  ],
  size: ['width', 'height', 'inlinesize', 'blocksize', 'minwidth', 'maxwidth', 'minheight', 'maxheight'],
};

function familyOf(key: string): string | null {
  for (const [family, keys] of Object.entries(SIDE_FAMILIES)) if (keys.includes(key)) return family;
  return null;
}

/** Do two normalized keys of the same family share a slot? (shorthand ↔ longhand, same side) */
function sharesSlot(a: string, b: string): boolean {
  const fa = familyOf(a);
  if (!fa || fa !== familyOf(b)) return false;
  if (a === b) return true;
  if (fa === 'size') {
    const axis = (k: string) => (k.includes('width') || k === 'inlinesize' ? 'w' : 'h');
    return axis(a) === axis(b);
  }
  const shorthand = (k: string) => SIDE_FAMILIES[fa]![0] === k || k === 'borderwidth' || k === 'borderstyle' || k === 'bordercolor';
  if (shorthand(a) || shorthand(b)) return true;
  const side = (k: string) => (/top/.test(k) ? 'top' : /right/.test(k) ? 'right' : /bottom/.test(k) ? 'bottom' : /left/.test(k) ? 'left' : k);
  return side(a) === side(b);
}

function fillSet(node: NodeRecord): Set<string> {
  return node.component === 'Text'
    ? new Set(['color', 'backgroundcolor', 'backgroundimage'])
    : new Set(['backgroundcolor', 'backgroundimage']);
}

/** Color token value for a `var(--x)` reference, resolved through aliases. */
function tokenColorKey(ref: string, tokens: readonly TokenRecord[]): string | null {
  const name = /var\(\s*(--[A-Za-z0-9_-]+)/.exec(ref)?.[1];
  if (!name) return null;
  const token = tokens.find((t) => tokenCssName(t) === name);
  if (!token || token.type !== 'color') return null;
  return colorKey(resolveTokenValue(token.value, tokens));
}

function matchValue(key: string, raw: string, query: string, tokens: readonly TokenRecord[]): string | null {
  const value = normVar(raw);
  const wildcard = query.includes('*');
  if (!wildcard) {
    const qKey = colorKey(query);
    if (qKey) {
      if (colorKey(value) === qKey) return value;
      for (const m of value.matchAll(COLOR_LITERAL_RE)) if (colorKey(m[0]) === qKey) return m[0];
      for (const m of value.matchAll(VAR_RE)) if (tokenColorKey(m[0], tokens) === qKey) return normVar(m[0]);
      return null;
    }
  }
  const re = globMatcher(query);
  if (query.startsWith('var(--')) {
    if (re.test(value)) return value;
    for (const m of value.matchAll(VAR_RE)) if (re.test(normVar(m[0]))) return normVar(m[0]);
    return null;
  }
  if (key === 'fontfamily') {
    if (re.test(value)) return value;
    for (const fam of value.split(',')) {
      const clean = fam.trim().replace(/^["']|["']$/g, '');
      if (re.test(clean)) return clean;
    }
    return null;
  }
  return re.test(value) ? value : null;
}

/** Evaluate filters/text against one node. Returns match entries or null when it fails. */
export function matchNode(
  node: NodeRecord,
  styles: Record<string, string>,
  filters: StyleFilter[],
  textValue: string | undefined,
  tokens: readonly TokenRecord[]
): MatchEntry[] | null {
  if (textValue !== undefined) {
    if (node.component !== 'Text') return null;
    if (!globMatcher(textValue).test(node.textValue ?? '')) return null;
  }
  const matched: MatchEntry[] = [];
  const seen = new Set<string>();
  for (const filter of filters) {
    const rawName = filter.styleName?.trim() || '*';
    const qName = rawName === '*' ? '*' : normName(rawName);
    const qValue = normValue(filter.styleValue);
    const nameRe = globMatcher(qName);
    const fills = fillSet(node);
    let passed = false;
    for (const [entryKey, entryValue] of Object.entries(styles)) {
      if (entryValue === undefined || entryValue === null || entryValue === '') continue;
      const k = normName(entryKey);
      const candidate =
        nameRe.test(k) ||
        (fills.has(qName) && fills.has(k)) ||
        (!qName.includes('*') && sharesSlot(qName, k));
      if (!candidate) continue;
      const hit = matchValue(k, String(entryValue), qValue, tokens);
      if (hit === null) continue;
      passed = true;
      const dedupe = `${entryKey}|${hit}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        matched.push({ styleName: entryKey, styleValue: hit });
      }
    }
    if (!passed) return null;
  }
  if (textValue !== undefined) matched.push({ textValue: node.textValue ?? '' });
  return matched;
}
