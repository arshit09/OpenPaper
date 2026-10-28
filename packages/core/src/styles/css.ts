/**
 * Small, dependency-free helpers for working with inline CSS.
 *
 * Styles are stored on nodes as camelCase keys (React style object convention),
 * with custom properties (`--token-name`) kept verbatim. Values are strings.
 */

export type StyleMap = Record<string, string>;

/** Properties whose numeric values must NOT get a `px` suffix. */
const UNITLESS = new Set([
  'animationIterationCount',
  'aspectRatio',
  'borderImageOutset',
  'borderImageSlice',
  'borderImageWidth',
  'columnCount',
  'columns',
  'flex',
  'flexGrow',
  'flexShrink',
  'fontWeight',
  'gridArea',
  'gridColumn',
  'gridColumnEnd',
  'gridColumnStart',
  'gridRow',
  'gridRowEnd',
  'gridRowStart',
  'lineClamp',
  'lineHeight',
  'opacity',
  'order',
  'orphans',
  'scale',
  'tabSize',
  'widows',
  'zIndex',
  'zoom',
  'fillOpacity',
  'floodOpacity',
  'stopOpacity',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
]);

export function isCustomProperty(name: string): boolean {
  return name.startsWith('--');
}

/** `background-color` → `backgroundColor`; `-webkit-line-clamp` → `WebkitLineClamp`; `--x` stays. */
export function toCamelCase(prop: string): string {
  const p = prop.trim();
  if (isCustomProperty(p)) return p;
  const lower = p.toLowerCase();
  // Vendor prefixes: -webkit-foo → WebkitFoo, -ms-foo → msFoo (React convention)
  if (lower.startsWith('-ms-')) return 'ms' + camelTail(lower.slice(3));
  if (lower.startsWith('-')) return camelTail(lower.slice(1), true);
  return camelTail(lower);
}

function camelTail(s: string, capitalizeFirst = false): string {
  const out = s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return capitalizeFirst ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

/** `backgroundColor` → `background-color`; `WebkitLineClamp` → `-webkit-line-clamp`; `--x` stays. */
export function toKebabCase(prop: string): string {
  if (isCustomProperty(prop)) return prop;
  if (prop.includes('-')) return prop.toLowerCase();
  let out = prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  if (/^(webkit|moz|o)-/.test(out) && /^[A-Z]/.test(prop)) out = '-' + out;
  if (out.startsWith('ms-')) out = '-' + out;
  return out;
}

/**
 * Split a CSS declaration list on top-level `;`, respecting quotes, parentheses
 * and comments (so `url("a;b")` and `var(--x, ";")` survive).
 */
export function splitDeclarations(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < text.length) {
        current += text[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Index of the first top-level `:` in a declaration (property/value separator). */
function declarationColon(decl: string): number {
  let quote: string | null = null;
  for (let i = 0; i < decl.length; i++) {
    const ch = decl[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ':') return i;
  }
  return -1;
}

export interface Declaration {
  /** camelCase property (custom properties verbatim). */
  prop: string;
  value: string;
  important: boolean;
}

/** Parse a declaration list (`a: 1; b: 2 !important`) in order, keeping `!important`. */
export function parseDeclarations(text: string | null | undefined): Declaration[] {
  const out: Declaration[] = [];
  if (!text) return out;
  for (const decl of splitDeclarations(text)) {
    const colon = declarationColon(decl);
    if (colon <= 0) continue;
    const name = decl.slice(0, colon).trim();
    const raw = decl.slice(colon + 1).trim();
    if (!name || !raw) continue;
    const value = raw.replace(/\s*!important\s*$/i, '').trim();
    if (!value) continue;
    out.push({ prop: toCamelCase(name), value, important: value !== raw });
  }
  return out;
}

/** Parse a `style="..."` attribute into a camelCase StyleMap. Later declarations win; `font` becomes its longhands. */
export function parseInlineStyle(text: string | null | undefined): StyleMap {
  const out: StyleMap = {};
  for (const d of parseDeclarations(text)) {
    const longhands = d.prop === 'font' ? expandFont(d.value) : null;
    if (longhands) Object.assign(out, longhands);
    else out[d.prop] = d.value;
  }
  return out;
}

const FONT_SIZE = /^(\d*\.?\d+(px|em|rem|%|pt|vw|vh|vmin|vmax|ch|ex|cqw|cqh)|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(calc|clamp|min|max|var)\(.*\))$/i;
const FONT_WEIGHT = /^(normal|bold|bolder|lighter|[1-9]00)$/i;

/**
 * The `font` shorthand as longhands (`700 44px/52px Inter, sans-serif` → weight, size, line height,
 * family), or null for what isn't one (system fonts such as `caption`, a bare `inherit`).
 */
export function expandFont(value: string): StyleMap | null {
  const text = value.replace(/\s*\/\s*/g, '/');
  const matches = [...text.matchAll(/"[^"]*"|'[^']*'|[^\s"']+\([^)]*\)|[^\s"']+/g)];
  const tokens = matches.map((m) => m[0]);
  const i = tokens.findIndex((t) => FONT_SIZE.test(t.split('/')[0]!));
  if (i < 0 || i === tokens.length - 1) return null;
  // The shorthand resets what it leaves out.
  const out: StyleMap = { fontStyle: 'normal', fontWeight: '400' };
  for (const t of tokens.slice(0, i)) {
    if (/^(italic|oblique)$/i.test(t)) out.fontStyle = t;
    else if (FONT_WEIGHT.test(t)) out.fontWeight = t.toLowerCase() === 'bold' ? '700' : t;
    else if (/^small-caps$/i.test(t)) out.fontVariant = t;
    else if (!/^normal$/i.test(t) && !/condensed|expanded/i.test(t)) return null;
  }
  const [size, lineHeight] = tokens[i]!.split('/');
  out.fontSize = size!;
  out.lineHeight = lineHeight || 'normal';
  out.fontFamily = text.slice(matches[i]!.index! + tokens[i]!.length).trim();
  return out;
}

/** Normalize an incoming style value (from JSON tool input) to the stored string form. */
export function normalizeStyleValue(prop: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (isCustomProperty(prop) || UNITLESS.has(prop) || value === 0) return String(value);
    return `${value}px`;
  }
  if (typeof value === 'boolean') return null;
  const s = String(value).replace(/\s*!important\s*$/i, '').trim();
  return s === '' ? null : s;
}

/** Serialize a StyleMap to `prop: value; ...` CSS text (kebab-case keys). */
export function styleMapToCss(styles: StyleMap, separator = ' '): string {
  return Object.entries(styles)
    .filter(([, v]) => v !== '' && v !== undefined && v !== null)
    .map(([k, v]) => `${toKebabCase(k)}: ${v};`)
    .join(separator);
}

/** Parse a CSS length like `12px` / `1.5em` / `0` into number+unit. */
export function parseLength(value: string | undefined | null): { value: number; unit: string } | null {
  if (value == null) return null;
  const m = /^\s*(-?\d*\.?\d+(?:e-?\d+)?)\s*([a-z%]*)\s*$/i.exec(String(value));
  if (!m) return null;
  return { value: Number(m[1]), unit: (m[2] || '').toLowerCase() };
}

/** Pixel value of a `Npx` (or unitless 0) length, else null. */
export function pxValue(value: string | undefined | null): number | null {
  const len = parseLength(value);
  if (!len) return null;
  if (len.unit === 'px' || (len.unit === '' && len.value === 0)) return len.value;
  return null;
}

export function formatPx(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

/** Extract `var(--name)` references from a value. */
export function cssVarRefs(value: string): string[] {
  const refs: string[] = [];
  const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) refs.push(m[1]!);
  return refs;
}

/** Extract url(...) targets from a CSS value. */
export function cssUrls(value: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (u) urls.push(u);
  }
  return urls;
}
