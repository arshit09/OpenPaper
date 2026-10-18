import { parseDocument } from 'htmlparser2';
import { Element, Text, type ChildNode } from 'domhandler';
import { computedStyles } from '../query/info.ts';
import type { DocReader } from '../model/transaction.ts';
import type { NodeRecord } from '../model/types.ts';
import { isArtboard } from '../model/tree.ts';
import { parseInlineStyle, toKebabCase, type StyleMap } from '../styles/css.ts';
import { svgAttrToReact } from '../html/sanitize.ts';
import { scopeSvgIds } from '../html/svg.ts';
import { isFreeform } from '../render/render-spec.ts';

export interface JsxOptions {
  format: 'tailwind' | 'inline-styles';
  includeNodeIds: boolean;
  includeRootPositioning: boolean;
  /**
   * Tailwind canonicalizer: arbitrary-property candidates (`[padding:16px]`) →
   * canonical utilities (`p-4`). Without one, arbitrary properties are emitted.
   */
  canonicalize?: (candidates: string[]) => Promise<string[]> | string[];
}

const UNITLESS_NUMERIC = new Set(['fontWeight', 'opacity', 'flexGrow', 'flexShrink', 'zIndex', 'order', 'lineHeight', 'flex', 'aspectRatio']);

/** Values dropped from exported code when equal to these defaults. */
const DROP_DEFAULTS: Record<string, string[]> = {
  alignItems: ['stretch'],
  display: ['block'],
  flexDirection: ['row'],
  flexGrow: ['0'],
  fontWeight: ['400'],
  justifyContent: ['start', 'flex-start'],
  rotate: ['0deg'],
  textAlign: ['left', 'start'],
};
const ZERO_DROPS = /^(borderRadius|border(Top|Bottom)(Left|Right)Radius|padding(Top|Right|Bottom|Left|Block|Inline)?|gap|rowGap|columnGap)$/;
const POSITION_KEYS = ['position', 'top', 'left', 'right', 'bottom', 'inset'];

interface Ctx {
  reader: DocReader;
  opts: JsxOptions;
}

function elementStyles(reader: DocReader, node: NodeRecord, isRoot: boolean, opts: JsxOptions, rootExtras: StyleMap): StyleMap {
  const s: StyleMap = { boxSizing: 'border-box', ...computedStyles(reader, node) };
  if (node.component === 'Text') {
    const text = node.textValue ?? '';
    if (!/ {2}|\n/.test(text)) delete s.whiteSpace;
  }
  for (const [k, v] of Object.entries(s)) {
    if (DROP_DEFAULTS[k]?.includes(v)) delete s[k];
    else if (ZERO_DROPS.test(k) && /^0(px)?$/.test(v)) delete s[k];
  }
  if (isRoot) {
    // Root extras lead (after box-sizing), like Paper's output.
    const { boxSizing, ...rest } = s;
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, { boxSizing: boxSizing!, ...rootExtras, ...rest });
    const artboard = isArtboard(reader, node);
    if (!opts.includeRootPositioning) {
      for (const k of POSITION_KEYS) delete s[k];
      if (node.children.length && isFreeform(node)) s.position = 'relative';
    }
    if (artboard) {
      const dependsOnParent = node.children.some((id) => {
        const c = reader.getNode(id);
        if (!c) return false;
        const cs = c.styles;
        return /%$/.test(cs.width ?? '') || /%$/.test(cs.height ?? '') || !!(cs.flexGrow && cs.flexGrow !== '0') || !!cs.flex;
      });
      if (!dependsOnParent) {
        delete s.width;
        delete s.height;
      }
    }
  }
  return s;
}

function rootExtrasFor(reader: DocReader, root: NodeRecord): StyleMap {
  let hasText = false;
  let hasInline = false;
  const stack = [root.id];
  while (stack.length) {
    const n = reader.getNode(stack.pop()!);
    if (!n || !n.isVisible) continue;
    if (n.component === 'Text') hasText = true;
    if (/^inline/.test(n.styles.display ?? '')) hasInline = true;
    stack.push(...n.children);
  }
  const extras: StyleMap = {};
  if (hasText) {
    extras.WebkitFontSmoothing = 'antialiased';
    extras.MozOsxFontSmoothing = 'grayscale';
    extras.fontSynthesis = 'none';
    extras.overflowWrap = 'anywhere';
  }
  if (hasInline) {
    extras.fontSize = '12px';
    extras.lineHeight = '16px';
  }
  return extras;
}

function jsString(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function styleObject(s: StyleMap, sort: boolean): string {
  const entries = Object.entries(s);
  if (sort) entries.sort(([a], [b]) => a.localeCompare(b));
  const body = entries
    .map(([k, v]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : jsString(k);
      const value = UNITLESS_NUMERIC.has(k) && /^-?\d*\.?\d+$/.test(v) ? v : jsString(v);
      return `${key}: ${value}`;
    })
    .join(', ');
  return `{{ ${body} }}`;
}

/** Inline-only properties in Tailwind mode (complex values read better as style). */
const INLINE_IN_TAILWIND = new Set(['backgroundImage', 'translate', 'rotate']);

function tailwindCandidate(k: string, v: string): string {
  let prop = toKebabCase(k);
  let value = v;
  if ((k === 'alignItems' || k === 'justifyContent') && (v === 'start' || v === 'end')) value = `flex-${v}`;
  value = value.replace(/"/g, "'").replace(/\s+/g, '_');
  return `[${prop}:${value}]`;
}

const POST_MAP: Record<string, string> = {
  'box-border': '',
  'bg-[#FFFFFF]': 'bg-white',
  'bg-[#ffffff]': 'bg-white',
  'bg-[#fff]': 'bg-white',
  'bg-[#000000]': 'bg-black',
  'bg-[#000]': 'bg-black',
  'text-[#000000]': 'text-black',
  'text-[#000]': 'text-black',
  'text-[#FFFFFF]': 'text-white',
  'text-[#ffffff]': 'text-white',
  'text-[#fff]': 'text-white',
  'origin-[50%_50%]': 'origin-center',
  'origin-[0%_0%]': 'origin-top-left',
};

function postMapClass(c: string): string {
  if (c in POST_MAP) return POST_MAP[c]!;
  const bw = /^\[border(-(top|right|bottom|left))?-width:(1|2|4|8)px\]$/.exec(c);
  if (bw) {
    const side = bw[2] ? `-${bw[2]![0]}` : '';
    return bw[3] === '1' ? `border${side}` : `border${side}-${bw[3]}`;
  }
  const bs = /^\[border(-(top|right|bottom|left))?-style:(dashed|solid|dotted)\]$/.exec(c);
  if (bs) return bs[2] ? `border-${bs[2]![0]}-${bs[3]}` : `border-${bs[3]}`;
  const contain = /^contain-\[(layout|content)\]$/.exec(c);
  if (contain) return `contain-${contain[1]}`;
  return c;
}

async function classesAndStyle(s: StyleMap, opts: JsxOptions): Promise<{ className: string; style: StyleMap }> {
  const style: StyleMap = {};
  const candidates: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (k === 'boxSizing' && v === 'border-box') continue;
    if (INLINE_IN_TAILWIND.has(k)) style[k] = v;
    else candidates.push(tailwindCandidate(k, v));
  }
  let classes = candidates;
  if (opts.canonicalize && candidates.length) {
    try {
      classes = await opts.canonicalize(candidates);
    } catch {
      classes = candidates;
    }
  }
  return { className: classes.map(postMapClass).filter(Boolean).join(' '), style };
}

function escapeJsxText(text: string): string {
  return text.replace(/[{}<>]/g, (c) => `{'${c}'}`);
}

function textLines(text: string): string[] {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    let out = escapeJsxText(line).replace(/ {2,}/g, (m) => `{'${m}'}`);
    if (i < lines.length - 1) out += '<br />';
    return out;
  });
}

// ---- SVG → JSX --------------------------------------------------------------

function svgAttrValue(name: string, value: string): string {
  if (name === 'style') {
    const s = parseInlineStyle(value);
    return `=${styleObject(s, false)}`;
  }
  return `="${value.replace(/"/g, '&quot;')}"`;
}

function svgToJsx(node: NodeRecord, ctx: Ctx, rootStyle: StyleMap, depth: number, isRoot: boolean): string[] {
  const markup = scopeSvgIds(node.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"></svg>', `_${node.id}_`);
  const doc = parseDocument(markup, { xmlMode: true, recognizeSelfClosing: true });
  const root = doc.children.find((n): n is Element => n instanceof Element && n.name.toLowerCase() === 'svg');
  if (!root) return [];
  const ind = (d: number) => '  '.repeat(d);
  const emit = (el: Element, d: number, top: boolean): string[] => {
    const attrs: string[] = [];
    for (const [k, v] of Object.entries(el.attribs)) {
      if (top && (k === 'style' || ((k === 'fill' && (v === '#000000' || v === 'black'))))) continue;
      attrs.push(`${svgAttrToReact(k)}${svgAttrValue(k, v)}`);
    }
    if (top) {
      if (!el.attribs.xmlns) attrs.push('xmlns="http://www.w3.org/2000/svg"');
      if (ctx.opts.includeNodeIds) attrs.push(`id="${node.id}"`);
      const own = parseInlineStyle(el.attribs.style);
      const merged = { ...own, ...rootStyle };
      delete merged.boxSizing;
      if (Object.keys(merged).length) attrs.push(`style=${styleObject(merged, false)}`);
    }
    const open = `${ind(d)}<${el.name}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    const kids = el.children.filter((c: ChildNode) => c instanceof Element || (c instanceof Text && c.data.trim()));
    if (!kids.length) return [`${open} />`];
    const lines = [`${open}>`];
    for (const c of kids) {
      if (c instanceof Element) lines.push(...emit(c, d + 1, false));
      else if (c instanceof Text) lines.push(`${ind(d + 1)}${escapeJsxText(c.data.trim())}`);
    }
    lines.push(`${ind(d)}</${el.name}>`);
    return lines;
  };
  void isRoot;
  return emit(root, depth, true);
}

// ---- main ---------------------------------------------------------------------

async function emitNode(node: NodeRecord, ctx: Ctx, depth: number, isRoot: boolean, rootExtras: StyleMap): Promise<string[]> {
  if (!node.isVisible) return [];
  const ind = '  '.repeat(depth);
  const styles = elementStyles(ctx.reader, node, isRoot, ctx.opts, rootExtras);
  if (node.component === 'SVG') return svgToJsx(node, ctx, styles, depth, isRoot);

  const attrs: string[] = [];
  if (ctx.opts.includeNodeIds) attrs.push(`id="${node.id}"`);
  if (ctx.opts.format === 'tailwind') {
    const { className, style } = await classesAndStyle(styles, ctx.opts);
    if (className) attrs.push(`className="${className}"`);
    if (Object.keys(style).length) attrs.push(`style=${styleObject(style, false)}`);
  } else {
    attrs.push(`style=${styleObject(styles, true)}`);
  }
  const open = `${ind}<div${attrs.length ? ' ' + attrs.join(' ') : ''}`;

  if (node.component === 'Text') {
    const text = node.textValue ?? '';
    if (!text) return [`${open} />`];
    return [`${open}>`, ...textLines(text).map((l) => `${ind}  ${l}`), `${ind}</div>`];
  }
  const children: string[] = [];
  for (const id of node.children) {
    const child = ctx.reader.getNode(id);
    if (child) children.push(...(await emitNode(child, ctx, depth + 1, false, rootExtras)));
  }
  if (!children.length) return [`${open} />`];
  return [`${open}>`, ...children, `${ind}</div>`];
}

/** JSX for a node subtree (Paper-compatible formatting). Empty string for hidden roots. */
export async function generateJsx(reader: DocReader, rootId: string, opts: JsxOptions): Promise<string> {
  const root = reader.getNode(rootId);
  if (!root) throw new Error(`Node not found: ${rootId}`);
  const ctx: Ctx = { reader, opts };
  const lines = await emitNode(root, ctx, 0, true, rootExtrasFor(reader, root));
  if (!lines.length) return '';
  if (lines.length === 1) return lines[0]!;
  return `(\n${lines.map((l) => `    ${l}`).join('\n')}\n  )`;
}
