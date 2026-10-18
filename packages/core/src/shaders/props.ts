import { formatHex, formatHex8, parse } from 'culori';
import type { TokenRecord } from '../model/types.ts';
import { resolveTokenValue } from '../tokens/tokens.ts';
import {
  shaderHasColorBack,
  shaderPresets,
  type ShaderDef,
  type ShaderParam,
  type ShaderProps,
  type ShaderPropValue,
} from './registry.ts';

/** Default layer size for a new shader (as in Paper). */
export const SHADER_DEFAULT_SIZE = { width: 800, height: 600 };

/** Library sizing/meta params that are never stored on a layer. */
const NON_PROP_PARAMS = new Set(['colorBack']);

function paramNames(s: ShaderDef): Set<string> {
  return new Set(s.params.map((p) => p.name));
}

/** Params of an optional group whose presence switches the group on. */
function groupKeys(s: ShaderDef, groupId: string): string[] {
  const g = s.groups.find((x) => x.id === groupId);
  return g?.enable ? Object.keys(g.enable) : [];
}

export function isGroupOn(s: ShaderDef, groupId: string, props: ShaderProps): boolean {
  return groupKeys(s, groupId).some((k) => props[k] !== undefined);
}

/**
 * Layer props for a library preset: only the params the layer exposes, `speed`/`frame` for animated
 * effects, and optional groups switched off when all of their strength params are 0. The preset's
 * background colour is returned separately — it becomes the layer's fill.
 */
export function shaderPresetProps(s: ShaderDef, presetName = 'Default'): { props: ShaderProps; background: string | null } {
  const preset = shaderPresets(s).find((p) => p.name.toLowerCase() === presetName.toLowerCase()) ?? shaderPresets(s)[0];
  const names = paramNames(s);
  const props: ShaderProps = {};
  for (const [k, v] of Object.entries(preset?.params ?? {})) {
    if (!names.has(k) || NON_PROP_PARAMS.has(k)) continue;
    props[k] = Array.isArray(v) ? [...v] : v;
  }
  for (const g of s.groups) {
    if (!g.optional || !g.enable) continue;
    const keys = Object.keys(g.enable);
    if (keys.every((k) => !props[k])) for (const k of keys) delete props[k];
  }
  const back = preset?.params.colorBack;
  const background = typeof back === 'string' && !isTransparent(back) ? back : null;
  return { props, background };
}

export function isTransparent(color: string): boolean {
  const c = parse(color);
  return !c || (c.alpha ?? 1) === 0;
}

/** Turn a raw value (attribute text, JSON value) into a valid prop value for `param`, or throw a message. */
export function coerceShaderProp(param: ShaderParam, raw: unknown): ShaderPropValue {
  switch (param.kind) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN;
      if (!Number.isFinite(n)) throw new Error(`${param.name} must be a number between ${param.min} and ${param.max}.`);
      const clamped = Math.min(param.max, Math.max(param.min, n));
      return param.step >= 1 ? Math.round(clamped) : clamped;
    }
    case 'enum': {
      const v = String(raw);
      const match = param.options.find((o) => o.toLowerCase() === v.toLowerCase());
      if (!match) throw new Error(`${param.name} must be one of: ${param.options.join(', ')}.`);
      return match;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === '' || raw === 'true' || raw === '1' || raw === 'on') return true;
      if (raw === 'false' || raw === '0' || raw === 'off') return false;
      throw new Error(`${param.name} must be true or false.`);
    case 'color': {
      const v = String(raw).trim();
      if (!isColorLike(v)) throw new Error(`${param.name} must be a CSS color (e.g. "#ff8800").`);
      return v;
    }
    case 'colors': {
      const list = Array.isArray(raw) ? raw.map(String) : splitColorList(String(raw));
      const bad = list.find((c) => !isColorLike(c));
      if (bad !== undefined) throw new Error(`${param.name} has an invalid color: "${bad}".`);
      if (!list.length) throw new Error(`${param.name} needs at least one color.`);
      return list.slice(0, param.max);
    }
    case 'image':
      return String(raw).trim();
  }
}

function isColorLike(v: string): boolean {
  return /^var\(--[A-Za-z0-9_-]+(\s*,[^)]*)?\)$/.test(v) || !!parse(v);
}

/** Split "#fff #000", "#fff,#000" or "rgb(0 0 0), red" into colors (commas inside parentheses kept). */
export function splitColorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Validate a props patch. Unknown names and invalid values throw; `null` removes a param (an optional
 * group's params can be removed to switch it off).
 */
export function applyShaderPropsPatch(s: ShaderDef, current: ShaderProps, patch: Record<string, unknown>): ShaderProps {
  const byName = new Map(s.params.map((p) => [p.name.toLowerCase(), p]));
  const next: ShaderProps = { ...current };
  for (const [key, raw] of Object.entries(patch)) {
    if (key === 'frame') {
      if (raw === null) delete next.frame;
      else next.frame = Math.max(0, Number(raw) || 0);
      continue;
    }
    const param = byName.get(key.toLowerCase());
    if (!param) {
      throw new Error(`${s.label} has no parameter "${key}". Parameters: ${s.params.map((p) => p.name).join(', ')}.`);
    }
    if (raw === null || raw === undefined) delete next[param.name];
    else next[param.name] = coerceShaderProp(param, raw);
  }
  return next;
}

/** Any CSS color (or a token reference) → hex the shader library understands. */
export function shaderColorToHex(value: string, tokens: readonly TokenRecord[] = []): string {
  const literal = value.includes('var(') ? resolveTokenValue(value, tokens) : value;
  const c = parse(literal);
  if (!c) return '#808080';
  return (c.alpha ?? 1) < 1 ? formatHex8(c) : formatHex(c);
}

export interface ShaderRenderOptions {
  tokens?: readonly TokenRecord[];
  resolveUrl?: (url: string) => string;
}

const svgDataUrl = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** Sample picture used by image filters until the user picks an image (OpenPaper's own artwork). */
export const DEFAULT_SHADER_IMAGE = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200" viewBox="0 0 1600 1200">' +
    '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2b6f"/>' +
    '<stop offset=".55" stop-color="#ef6a5b"/><stop offset="1" stop-color="#ffd79c"/></linearGradient>' +
    '<linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d6e5c"/><stop offset="1" stop-color="#0f3530"/></linearGradient></defs>' +
    '<rect width="1600" height="1200" fill="url(#s)"/><circle cx="1090" cy="560" r="190" fill="#fff2c2"/>' +
    '<path d="M0 820C260 700 480 720 720 800S1200 900 1600 760V1200H0Z" fill="#3f8169"/>' +
    '<path d="M0 960C320 860 620 900 900 980S1360 1060 1600 950V1200H0Z" fill="url(#h)"/>' +
    '<g fill="#0c2622"><path d="M260 1000l40-150 40 150z"/><path d="M330 1010l50-190 50 190z"/><path d="M1240 1030l45-170 45 170z"/></g>' +
    '<g fill="#fff" opacity=".85"><circle cx="300" cy="230" r="3"/><circle cx="520" cy="150" r="2"/><circle cx="760" cy="260" r="2.5"/><circle cx="1420" cy="190" r="3"/></g></svg>'
);

/** Silhouette used by Heatmap until the user picks a logo. */
export const DEFAULT_SHADER_LOGO = svgDataUrl(
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">' +
    '<path d="M256 24C280 170 342 232 488 256C342 280 280 342 256 488C232 342 170 280 24 256C170 232 232 170 256 24Z" fill="#000"/></svg>'
);

/**
 * The props passed to the library component: stored values with colours resolved to hex, unset
 * optional-group params as 0, a transparent background (the layer's CSS fill shows behind the canvas)
 * and resolved image URLs.
 */
export function shaderRenderProps(s: ShaderDef, props: ShaderProps | undefined, opts: ShaderRenderOptions = {}): Record<string, ShaderPropValue> {
  const out: Record<string, ShaderPropValue> = {};
  const stored = props ?? {};
  for (const p of s.params) {
    const v = stored[p.name];
    if (v === undefined) continue;
    if (p.kind === 'color' && typeof v === 'string') out[p.name] = shaderColorToHex(v, opts.tokens);
    else if (p.kind === 'colors' && Array.isArray(v)) out[p.name] = v.length ? v.map((c) => shaderColorToHex(c, opts.tokens)) : ['#00000000'];
    else if (p.kind === 'image' && typeof v === 'string') out[p.name] = v && opts.resolveUrl ? opts.resolveUrl(v) : v;
    else out[p.name] = v;
  }
  for (const g of s.groups) {
    if (!g.optional || !g.enable) continue;
    for (const k of Object.keys(g.enable)) if (out[k] === undefined) out[k] = 0;
  }
  if (typeof stored.frame === 'number') out.frame = stored.frame;
  if (shaderHasColorBack(s)) out.colorBack = '#00000000';
  if (!out.image && s.category === 'image') out.image = DEFAULT_SHADER_IMAGE;
  if (!out.image && s.name === 'Heatmap') out.image = DEFAULT_SHADER_LOGO;
  return out;
}
