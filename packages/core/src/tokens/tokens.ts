import { TOKEN_TYPES, type TokenRecord, type TokenType } from '../model/types.ts';

/** Output order of token types (get_tokens / get_basic_info). */
export const TOKEN_TYPE_ORDER: readonly TokenType[] = [
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'opacity',
  'breakpoint',
  'container',
  'spacing',
  'radius',
];

export function isTokenType(value: unknown): value is TokenType {
  return typeof value === 'string' && (TOKEN_TYPES as readonly string[]).includes(value);
}

/** Slug used for CSS custom property names. */
export function slugTokenName(name: string): string {
  return name
    .replace(/[\s–—'"`.]+/g, '-')
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9_-]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** CSS custom property for a token: `--` + slug(name). */
export function tokenCssName(token: Pick<TokenRecord, 'name'>): string {
  return `--${slugTokenName(token.name)}`;
}

/** Tokens sorted by type order, then by their position in the file. */
export function orderedTokens(tokens: readonly TokenRecord[]): TokenRecord[] {
  const rank = new Map(TOKEN_TYPE_ORDER.map((t, i) => [t, i]));
  return tokens
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank.get(a.t.type) ?? 99) - (rank.get(b.t.type) ?? 99) || a.i - b.i)
    .map((x) => x.t);
}

export interface GlobMatcher {
  test(value: string): boolean;
}

/**
 * Case-insensitive, anchored glob where only `*` is special (it also spans newlines).
 * Matched segment by segment instead of as a RegExp, whose backtracking on `*a*a*a*…b` is polynomial.
 */
export function globMatcher(pattern: string): GlobMatcher {
  const parts = pattern.toLowerCase().split('*');
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return {
    test(value) {
      const s = value.toLowerCase();
      if (parts.length === 1) return s === first;
      if (s.length < first.length + last.length || !s.startsWith(first) || !s.endsWith(last)) return false;
      // Taking each middle segment at its earliest position leaves the most room for the rest.
      const end = s.length - last.length;
      let pos = first.length;
      for (let i = 1; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (!part) continue;
        const at = s.indexOf(part, pos);
        if (at < 0 || at + part.length > end) return false;
        pos = at + part.length;
      }
      return true;
    },
  };
}

export interface TokenFilter {
  types?: TokenType[];
  namePattern?: string;
}

export function filterTokens(tokens: readonly TokenRecord[], filter: TokenFilter = {}): TokenRecord[] {
  const types = filter.types?.length ? new Set(filter.types) : null;
  const re = filter.namePattern ? globMatcher(filter.namePattern) : null;
  return orderedTokens(tokens).filter((t) => (!types || types.has(t.type)) && (!re || re.test(tokenCssName(t))));
}

export interface TokenJson {
  name: string;
  type: TokenType;
  value: string;
  description?: string;
}

export function tokenToJson(t: TokenRecord): TokenJson {
  const out: TokenJson = { name: tokenCssName(t), type: t.type, value: t.value };
  if (t.description) out.description = t.description;
  return out;
}

export function tokensToCss(tokens: readonly TokenRecord[], wrapper: ':root' | '@theme' = ':root'): string {
  const lines = tokens.map((t) => `  ${tokenCssName(t)}: ${t.value};`);
  return `${wrapper} {\n${lines.length ? lines.join('\n') + '\n' : ''}}\n`;
}

/** CSS custom properties for rendering (`--name` → value). */
export function tokenVars(tokens: readonly TokenRecord[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const t of tokens) vars[tokenCssName(t)] = t.value;
  return vars;
}

/** Resolve `var(--x)` chains to a literal value (cycle-safe). */
export function resolveTokenValue(value: string, tokens: readonly TokenRecord[], depth = 0): string {
  if (depth > 16) return value;
  const byName = new Map(tokens.map((t) => [tokenCssName(t), t.value]));
  return value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)/g, (match, name: string, fallback?: string) => {
    const v = byName.get(name);
    if (v !== undefined) return resolveTokenValue(v, tokens, depth + 1);
    return fallback?.trim() ? fallback.trim() : match;
  });
}

// ---- contentHash ---------------------------------------------------------

function fnvMix(h: number, n: number): number {
  return Math.imul(h ^ n, 16777619) >>> 0;
}

function fnvStr(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) x = fnvMix(x, s.charCodeAt(i));
  return x;
}

/**
 * Opaque 8-hex-digit hash of the file's tokens. Agents compare it between calls to
 * notice token edits made outside their session.
 */
export function tokensContentHash(tokens: readonly TokenRecord[]): string {
  let h = 2166136261;
  for (const t of [...tokens].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    h = fnvMix(h, 1);
    h = fnvStr(h, t.type);
    h = fnvMix(h, 31);
    h = fnvStr(h, t.id);
    h = fnvMix(h, 31);
    h = fnvStr(h, t.name);
    h = fnvMix(h, 31);
    if (t.description !== undefined) h = fnvStr(h, t.description);
    h = fnvMix(h, 31);
    h = fnvStr(h, JSON.stringify(t.value));
  }
  return h.toString(16).padStart(8, '0');
}
