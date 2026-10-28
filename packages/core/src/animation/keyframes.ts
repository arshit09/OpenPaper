import { parseInlineStyle, splitDeclarations, toKebabCase } from '../styles/css.ts';
import type { KeyframesRecord, NodeRecord } from '../model/types.ts';
import type { DocReader } from '../model/transaction.ts';
import { subtreeOf } from '../model/tree.ts';

/**
 * CSS animations. A file keeps its `@keyframes` rules in one list (like tokens), and layers play
 * them through their own `animation` styles, exactly as on the web. Rules are validated and
 * re-serialized from their parsed parts, so a stored body can never close its block and style
 * anything else on the page.
 */

/** The editor's own animations are named `op-…`; a design's keyframes stay out of that namespace. */
const RESERVED_PREFIX = 'op-';
const MAX_NAME = 100;
const MAX_BODY = 20_000;

const NAME = /^-?[_a-zA-Z][\w-]*$/;
const NOT_NAMES = new Set(['none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default']);
/** `from`, `to`, `42.5%`, or a timeline range (`entry 10%`) for scroll-driven animations. */
const SELECTOR = /^(?:(?:entry|exit|cover|contain|entry-crossing|exit-crossing)\s+)?(?:from|to|-?\d*\.?\d+%)$/i;
/** Braces, `<`, escapes and line breaks could end a block, a string or the `<style>` element early. */
const UNSAFE_VALUE = /[{}<\\\n\r\f]|expression\s*\(|javascript:/i;
const PROPERTY = /^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/;

/** A declaration that can go back into CSS as it is: a plain property name and a value whose quotes close. */
function safeDeclaration(prop: string, value: string): boolean {
  if (!PROPERTY.test(prop) || UNSAFE_VALUE.test(value)) return false;
  return (value.match(/"/g)?.length ?? 0) % 2 === 0 && (value.match(/'/g)?.length ?? 0) % 2 === 0;
}

export class KeyframesError extends Error {}

/** A usable `@keyframes` name, or null (`op-` names get a prefix so they can't replace the editor's own). */
export function keyframesName(raw: string): string | null {
  let name = raw.trim().replace(/^["']|["']$/g, '');
  if (!NAME.test(name) || NOT_NAMES.has(name.toLowerCase()) || name.length > MAX_NAME) return null;
  if (name.startsWith(RESERVED_PREFIX)) name = `design-${name}`;
  return name;
}

/** Split CSS on top-level `{…}` blocks: `[prelude, body]` pairs (comments and strings respected). */
export function cssBlocks(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let prelude = '';
  let body = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      if (depth) body += ch;
      else prelude += ch;
      if (ch === '\\' && i + 1 < css.length) {
        const next = css[++i]!;
        if (depth) body += next;
        else prelude += next;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    // An escape (`\"`, `\}`) is one character, never a quote or brace, as browsers read it.
    if (ch === '\\' && i + 1 < css.length) {
      const pair = ch + css[++i]!;
      if (depth) body += pair;
      else prelude += pair;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '{') {
      if (depth++ === 0) continue;
    } else if (ch === '}') {
      if (depth === 0) continue; // stray
      if (--depth === 0) {
        out.push([prelude.trim(), body]);
        prelude = '';
        body = '';
        continue;
      }
    } else if (ch === ';' && depth === 0) {
      // A statement at-rule (`@import …;`): no block.
      prelude = '';
      continue;
    }
    if (depth) body += ch;
    else prelude += ch;
  }
  return out;
}

/**
 * Normalize a keyframes body (`from { opacity: 0 } to { opacity: 1 }`): selectors checked,
 * declarations re-serialized. Throws KeyframesError when nothing usable is left.
 */
export function normalizeKeyframesBody(body: string): string {
  if (body.length > MAX_BODY) throw new KeyframesError(`Keyframes are limited to ${MAX_BODY} characters.`);
  const parts: string[] = [];
  for (const [prelude, decls] of cssBlocks(body)) {
    const selectors = prelude.split(',').map((s) => s.trim().toLowerCase());
    if (!selectors.length || !selectors.every((s) => SELECTOR.test(s))) {
      throw new KeyframesError(`"${prelude}" is not a keyframe selector (use from, to or percentages).`);
    }
    const out: string[] = [];
    for (const [prop, value] of Object.entries(parseInlineStyle(decls))) {
      const name = toKebabCase(prop);
      if (safeDeclaration(name, value)) out.push(`${name}: ${value};`);
    }
    parts.push(`${selectors.join(', ')}{${out.join(' ')}}`);
  }
  if (!parts.length) throw new KeyframesError('Keyframes need at least one step, e.g. "from { opacity: 0 } to { opacity: 1 }".');
  return parts.join(' ');
}

/** Keyframes from a stylesheet's `@keyframes` / `@-webkit-keyframes` rules (others are ignored). */
export function keyframesFromCss(css: string, warnings: string[] = []): KeyframesRecord[] {
  const out = new Map<string, KeyframesRecord>();
  const visit = (text: string) => {
    for (const [prelude, body] of cssBlocks(text)) {
      const m = /^@(-webkit-|-moz-)?keyframes\s+(.+)$/i.exec(prelude);
      if (m) {
        const name = keyframesName(m[2]!);
        if (!name) {
          warnings.push(`Skipped @keyframes with an unusable name: ${m[2]}`);
          continue;
        }
        // The unprefixed rule wins over a vendor-prefixed twin.
        if (m[1] && out.has(name)) continue;
        try {
          out.set(name, { name, css: normalizeKeyframesBody(body) });
        } catch (error) {
          warnings.push(`@keyframes ${name}: ${(error as Error).message}`);
        }
      } else if (/^@(media|supports|layer|container)\b/i.test(prelude)) visit(body);
    }
  };
  visit(css);
  return [...out.values()];
}

/** `@keyframes` CSS for a `<style>` element. */
export function keyframesCss(keyframes: readonly KeyframesRecord[]): string {
  const rules: string[] = [];
  for (const k of keyframes) {
    // Checked again here: a file can be edited on disk, and this text goes into the editor's own page.
    if (keyframesName(k.name) !== k.name) continue;
    try {
      rules.push(`@keyframes ${k.name}{${normalizeKeyframesBody(k.css)}}`);
    } catch {
      // not keyframes: left out
    }
  }
  return rules.join('\n').replace(/</g, '\\3c ');
}

// ---- animation-name references ---------------------------------------------------

const NOT_A_NAME = new Set([
  ...NOT_NAMES,
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'step-start',
  'step-end',
  'infinite',
  'normal',
  'reverse',
  'alternate',
  'alternate-reverse',
  'forwards',
  'backwards',
  'both',
  'running',
  'paused',
  'auto',
]);

/** Split on a separator at the top level (outside parentheses and quotes). */
function splitTop(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    const splits = depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep);
    if (splits) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Index of the keyframes name among one animation's shorthand tokens, or -1. */
function nameIndex(tokens: string[]): number {
  return tokens.findIndex((t) => {
    if (/^["']/.test(t)) return true;
    if (t.includes('(') || /^-?[\d.]+(m?s)?$/i.test(t)) return false;
    return NAME.test(t) && !NOT_A_NAME.has(t.toLowerCase());
  });
}

/** Keyframes names an `animation` (shorthand) or `animationName` value plays. */
export function animationNames(prop: string, value: string | undefined): string[] {
  if (!value) return [];
  const names: string[] = [];
  for (const part of splitTop(value, ',')) {
    if (prop === 'animationName') {
      const n = part.replace(/^["']|["']$/g, '');
      if (n && !NOT_NAMES.has(n.toLowerCase())) names.push(n);
      continue;
    }
    const tokens = splitTop(part, ' ');
    const i = nameIndex(tokens);
    if (i >= 0) names.push(tokens[i]!.replace(/^["']|["']$/g, ''));
  }
  return names;
}

/** The value with keyframes names swapped through `renames` (unchanged when none apply). */
export function renameAnimationValue(prop: string, value: string, renames: ReadonlyMap<string, string>): string {
  if (!renames.size) return value;
  let changed = false;
  const parts = splitTop(value, ',').map((part) => {
    if (prop === 'animationName') {
      const to = renames.get(part.replace(/^["']|["']$/g, ''));
      if (!to) return part;
      changed = true;
      return to;
    }
    const tokens = splitTop(part, ' ');
    const i = nameIndex(tokens);
    const to = i >= 0 ? renames.get(tokens[i]!.replace(/^["']|["']$/g, '')) : undefined;
    if (!to) return part;
    tokens[i] = to;
    changed = true;
    return tokens.join(' ');
  });
  return changed ? parts.join(', ') : value;
}

const ANIMATION_DECL = /(animation(?:-name)?\s*:\s*)([^;"'>]+)/gi;

/** Keyframes names used in inline SVG markup (style attributes inside the drawing). */
export function svgAnimationNames(markup: string | undefined): string[] {
  if (!markup || !/animation/i.test(markup)) return [];
  const out: string[] = [];
  for (const m of markup.matchAll(ANIMATION_DECL)) {
    out.push(...animationNames(/-name/i.test(m[1]!) ? 'animationName' : 'animation', m[2]!.trim()));
  }
  return out;
}

/** SVG markup with keyframes names swapped through `renames`. */
export function renameSvgAnimations(markup: string, renames: ReadonlyMap<string, string>): string {
  if (!renames.size || !/animation/i.test(markup)) return markup;
  return markup.replace(ANIMATION_DECL, (_m, head: string, value: string) => {
    const trailing = /\s*$/.exec(value)![0];
    return head + renameAnimationValue(/-name/i.test(head) ? 'animationName' : 'animation', value.trim(), renames) + trailing;
  });
}

/** Keyframes names a node plays (its styles and, for SVG layers, its drawing). */
export function nodeAnimationNames(node: Pick<NodeRecord, 'styles' | 'svg'>): string[] {
  return [
    ...animationNames('animation', node.styles.animation),
    ...animationNames('animationName', node.styles.animationName),
    ...svgAnimationNames(node.svg),
  ];
}

/** The file's keyframes that the given subtrees play (for copy and code export). */
export function keyframesUsedBy(reader: DocReader, rootIds: string[]): KeyframesRecord[] {
  const all = reader.getKeyframes();
  if (!all.length) return [];
  const names = new Set<string>();
  for (const id of rootIds) for (const n of subtreeOf(reader, id)) for (const name of nodeAnimationNames(n)) names.add(name);
  return all.filter((k) => names.has(k.name));
}

export interface KeyframesMerge {
  keyframes: KeyframesRecord[];
  /** Incoming names that were given a new name (keyframes with that name already differ). */
  renames: Map<string, string>;
  changed: boolean;
}

/**
 * Add keyframes to a file's list. `replace`: a rule with the same name is redefined (an agent
 * updating its animation). `rename`: an identical rule is reused, a different one gets a fresh
 * name (pasting from another file must not change the animations already here).
 */
export function mergeKeyframes(existing: readonly KeyframesRecord[], incoming: readonly KeyframesRecord[], mode: 'replace' | 'rename'): KeyframesMerge {
  const list = [...existing];
  const renames = new Map<string, string>();
  let changed = false;
  const taken = new Set([...existing.map((k) => k.name), ...incoming.map((k) => k.name)]);
  for (const k of incoming) {
    const i = list.findIndex((e) => e.name === k.name);
    if (i < 0) {
      list.push({ ...k });
      changed = true;
    } else if (list[i]!.css === k.css) {
      continue;
    } else if (mode === 'replace') {
      list[i] = { ...k };
      changed = true;
    } else {
      // The same rule pasted before already has a name here.
      const twin = list.find((e) => e.css === k.css && e.name.startsWith(`${k.name}-`) && /^\d+$/.test(e.name.slice(k.name.length + 1)));
      if (twin) {
        renames.set(k.name, twin.name);
        continue;
      }
      let n = 2;
      while (taken.has(`${k.name}-${n}`)) n++;
      const name = `${k.name}-${n}`;
      taken.add(name);
      renames.set(k.name, name);
      list.push({ name, css: k.css });
      changed = true;
    }
  }
  return { keyframes: changed ? list : [...existing], renames, changed };
}

/** Parse a whole `@keyframes name { … }` rule, or a bare body for `name` (tool input). */
export function parseKeyframesInput(name: string, css: string): KeyframesRecord {
  const valid = keyframesName(name);
  if (!valid) throw new KeyframesError(`"${name}" is not a usable keyframes name (letters, digits, - and _; not none/initial).`);
  const whole = /^\s*@(-webkit-)?keyframes\s+[^{]+\{([\s\S]*)\}\s*$/i.exec(css);
  return { name: valid, css: normalizeKeyframesBody(whole ? whole[2]! : css) };
}

/** Readable form of a stored body, one step per line (tool output). */
export function formatKeyframes(k: KeyframesRecord): string {
  return `@keyframes ${k.name} {\n${cssBlocks(k.css)
    .map(([sel, body]) => `  ${sel} { ${splitDeclarations(body).join('; ')} }`)
    .join('\n')}\n}`;
}
