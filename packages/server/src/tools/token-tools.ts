import { parse as parseColor } from 'culori';
import {
  filterTokens,
  resolveTokenValue,
  tokenCssName,
  tokensToCss,
  tokenToJson,
  type TokenRecord,
  type TokenType,
  type Transaction,
} from '@openpaper/core';
import { ToolError, type Call, type HandlerResult } from './context.ts';

const SIZE_TYPES = new Set<TokenType>(['breakpoint', 'container', 'fontSize', 'letterSpacing', 'lineHeight', 'radius', 'spacing']);
const PX_TYPES = new Set<TokenType>(['breakpoint', 'container', 'fontSize', 'letterSpacing', 'radius', 'spacing']);
const NUMERIC = /^-?\d*\.?\d+$/;

function liveOf(call: Call) {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  return call.live;
}

export async function getTokens(call: Call): Promise<HandlerResult> {
  const d = liveOf(call).doc;
  const tokens = filterTokens(d.tokens, { types: call.args.types, namePattern: call.args.namePattern });
  const format = (call.args.format as string | undefined) ?? 'json';
  if (format === 'css') return { data: tokensToCss(tokens, ':root') };
  if (format === 'tailwind') return { data: tokensToCss(tokens, '@theme') };
  return { data: { tokens: tokens.map(tokenToJson) } };
}

/** Parse a token value for its type. Returns the stored CSS value, or an error message. */
function parseValue(type: TokenType, raw: string | number, all: readonly TokenRecord[], selfName?: string): { value: string } | { error: string } {
  const invalid = { error: `Invalid value "${raw}" for token type "${type}".` };
  if (typeof raw === 'string') {
    const alias = /^\s*var\(\s*(--[A-Za-z0-9_-]+)\s*\)\s*$/.exec(raw);
    if (alias) {
      const target = all.find((t) => tokenCssName(t) === alias[1]);
      if (!target) return invalid;
      const compatible = target.type === type || (SIZE_TYPES.has(type) && /^-?\d*\.?\d+px$/.test(resolveTokenValue(target.value, all)));
      if (!compatible) return invalid;
      // Reject cycles: following the alias chain must not reach this token.
      if (selfName) {
        let cursor: TokenRecord | undefined = target;
        for (let guard = 0; cursor && guard < 64; guard++) {
          if (tokenCssName(cursor) === selfName) return { error: `Circular token reference "${raw}".` };
          const nextName: string | undefined = /^\s*var\(\s*(--[A-Za-z0-9_-]+)\s*\)\s*$/.exec(cursor.value)?.[1];
          cursor = nextName ? all.find((t) => tokenCssName(t) === nextName) : undefined;
        }
      }
      return { value: `var(${alias[1]})` };
    }
  }
  const s = String(raw).trim();
  switch (type) {
    case 'color':
      return parseColor(s) ? { value: s } : invalid;
    case 'fontFamily':
      return s ? { value: s } : invalid;
    case 'fontWeight':
      return NUMERIC.test(s) ? { value: String(Number(s)) } : s ? { value: s } : invalid;
    case 'lineHeight':
      if (typeof raw === 'number' || NUMERIC.test(s)) return { value: `${Math.round(Number(s) * 100 * 1000) / 1000}%` };
      return s ? { value: s } : invalid;
    case 'opacity': {
      let n: number | null = null;
      if (typeof raw === 'number' || NUMERIC.test(s)) n = Number(s);
      else if (/^-?\d*\.?\d+%$/.test(s)) n = Number(s.slice(0, -1)) / 100;
      if (n === null || !Number.isFinite(n)) return invalid;
      n = Math.min(1, Math.max(0, n));
      return { value: `${Math.round(n * 100 * 1000) / 1000}%` };
    }
    default:
      if (PX_TYPES.has(type)) {
        if (typeof raw === 'number' || NUMERIC.test(s)) return { value: `${Number(s)}px` };
        return s ? { value: s } : invalid;
      }
      return s ? { value: s } : invalid;
  }
}

/** Replace `var(--from)` with `to` across node styles, SVG markup and other tokens. */
function rewriteRefs(tx: Transaction, from: string, to: (match: string) => string) {
  const re = new RegExp(`var\\(\\s*${from.replace(/[-]/g, '\\-')}\\s*(?:,[^)]*)?\\)`, 'g');
  for (const node of [...tx.allNodes()]) {
    let changed = false;
    const styles = { ...node.styles };
    for (const [k, v] of Object.entries(styles)) {
      if (!v.includes(from)) continue;
      const next = v.replace(re, (m) => to(m));
      if (next !== v) {
        styles[k] = next;
        changed = true;
      }
    }
    const svg = node.svg?.includes(from) ? node.svg.replace(re, (m) => to(m)) : node.svg;
    if (changed || svg !== node.svg) {
      tx.updateNode(node.id, (n) => {
        n.styles = styles;
        if (svg !== undefined) n.svg = svg;
      });
    }
  }
}

export async function createTokens(call: Call): Promise<HandlerResult> {
  const live = liveOf(call);
  const entries = call.args.tokens as Array<{ type: TokenType; name: string; value: string | number }>;
  const results: Array<Record<string, unknown>> = [];
  live.transact(call.actor, 'create_tokens', (tx) => {
    const tokens = [...tx.getTokens()];
    // Token ids look like `t:1a-0`; continue after the highest one in the file.
    let counter = tokens.reduce((max, t) => Math.max(max, Number.parseInt(/^t:([0-9a-z]+)-/.exec(t.id)?.[1] ?? '0', 36) || 0), 0);
    for (const e of entries) {
      const stored = e.name.replace(/^--/, '');
      const cssName = tokenCssName({ name: stored });
      const parsed = parseValue(e.type, e.value, tokens, cssName);
      if ('error' in parsed) {
        results.push({ result: 'error', message: parsed.error });
        continue;
      }
      const existing = tokens.find((t) => t.type === e.type && t.name === stored && t.value === parsed.value);
      if (!existing) {
        counter++;
        const token: TokenRecord = { id: `t:${counter.toString(36)}-0`, type: e.type, name: stored, value: parsed.value };
        // Appended at the end of its type group.
        let insertAt = tokens.length;
        for (let i = tokens.length - 1; i >= 0; i--) {
          if (tokens[i]!.type === e.type) {
            insertAt = i + 1;
            break;
          }
        }
        tokens.splice(insertAt, 0, token);
      }
      results.push({ name: cssName, result: 'created' });
    }
    tx.setTokens(tokens);
  });
  return { data: { tokens: results, count: entries.length } };
}

export async function setTokens(call: Call): Promise<HandlerResult> {
  const live = liveOf(call);
  const entries = call.args.tokens as Array<{ name: string; newName?: string; value?: string | number; delete?: boolean }>;
  const results: Array<Record<string, unknown>> = [];
  live.transact(call.actor, 'set_tokens', (tx) => {
    let tokens = [...tx.getTokens()];
    for (const e of entries) {
      const idx = tokens.findIndex((t) => tokenCssName(t) === e.name);
      if (idx < 0) {
        results.push({ name: e.name, result: 'error', message: `Token not found: "${e.name}". No token has that CSS variable name.` });
        continue;
      }
      const token = tokens[idx]!;
      if (e.delete) {
        const literal = resolveTokenValue(token.value, tokens);
        tokens = tokens.filter((t) => t.id !== token.id);
        // Flatten references to the literal value everywhere.
        rewriteRefs(tx, e.name, () => literal);
        tokens = tokens.map((t) => (t.value.includes(e.name) ? { ...t, value: t.value.replace(new RegExp(`var\\(\\s*${e.name}\\s*\\)`, 'g'), literal) } : t));
        results.push({ name: e.name, result: 'deleted' });
        continue;
      }
      let next: TokenRecord = { ...token };
      if (e.value !== undefined) {
        const parsed = parseValue(token.type, e.value, tokens, e.name);
        if ('error' in parsed) {
          results.push({ name: e.name, result: 'error', message: parsed.error });
          continue;
        }
        next.value = parsed.value;
      }
      if (e.newName !== undefined) {
        next = { ...next, name: e.newName.replace(/^--/, '') };
        const newCss = tokenCssName(next);
        if (newCss !== e.name) {
          rewriteRefs(tx, e.name, (m) => m.replace(e.name, newCss));
          tokens = tokens.map((t) => (t.value.includes(e.name) ? { ...t, value: t.value.split(e.name).join(newCss) } : t));
        }
      }
      tokens[tokens.findIndex((t) => t.id === token.id)] = next;
      results.push({ name: tokenCssName(next), result: 'updated' });
    }
    tx.setTokens(tokens);
  });
  return { data: { tokens: results, count: entries.length } };
}
