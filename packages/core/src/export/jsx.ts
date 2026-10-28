import { parseDocument } from 'htmlparser2';
import { Element, Text, type ChildNode } from 'domhandler';
import { computedStyles } from '../query/info.ts';
import type { DocReader } from '../model/transaction.ts';
import type { NodeRecord, TextRun } from '../model/types.ts';
import { isArtboard } from '../model/tree.ts';
import { parseInlineStyle, toKebabCase, type StyleMap } from '../styles/css.ts';
import { svgAttrToReact } from '../html/sanitize.ts';
import { scopeSvgIds } from '../html/svg.ts';
import { isFreeform } from '../render/render-spec.ts';
import { shaderDef, shaderHasColorBack, type ShaderDef } from '../shaders/registry.ts';
import { shaderColorToHex } from '../shaders/props.ts';
import { SHADER_LIBRARY_VERSION } from '../shaders/presets.generated.ts';
import { formatKeyframes, keyframesUsedBy } from '../animation/keyframes.ts';

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
  /** Shader components used in the subtree (named imports from @paper-design/shaders-react). */
  imports: Set<string>;
  /** A Lottie layer is in the subtree (DotLottieReact from @lottiefiles/dotlottie-react). */
  lottie?: boolean;
}

function elementStyles(reader: DocReader, node: NodeRecord, isRoot: boolean, opts: JsxOptions, rootExtras: StyleMap): StyleMap {
  // Shader components render their own box: no box-sizing prefix (as in Paper's export).
  const base = computedStyles(reader, node);
  const s: StyleMap = shaderDef(node.component) ? { ...base } : { boxSizing: 'border-box', ...base };
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
    Object.assign(s, boxSizing ? { boxSizing, ...rootExtras, ...rest } : { ...rootExtras, ...rest });
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

const JS_STRING_ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029' };

/** Single-quoted JS string literal; line breaks (e.g. in a multi-line gradient) are escaped. */
function jsString(v: string): string {
  return `'${v.replace(/[\\'\n\r\u2028\u2029]/g, (c) => JS_STRING_ESCAPES[c]!)}'`;
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

/** `&` too: JSX text decodes entities, so a literal `&copy;` would turn into ©. */
function escapeJsxText(text: string): string {
  return text.replace(/[{}<>&]/g, (c) => `{'${c}'}`);
}

function textLines(text: string): string[] {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    // JSX drops whitespace next to a line break, so runs of spaces and a line's edge spaces are kept as strings.
    let out = escapeJsxText(line)
      .replace(/ {2,}/g, (m) => `{'${m}'}`)
      .replace(/^ | $/g, "{' '}");
    if (i < lines.length - 1) out += '<br />';
    return out;
  });
}

/** Rich text as JSX lines: styled runs become inline <span>s, kept on one line so spaces survive. */
async function runLines(runs: readonly TextRun[], ctx: Ctx): Promise<string[]> {
  const lines: string[] = [];
  let line = '';
  for (const run of runs) {
    let open = '';
    if (run.styles && Object.keys(run.styles).length) {
      if (ctx.opts.format === 'tailwind') {
        const { className, style } = await classesAndStyle(run.styles, ctx.opts);
        open = `<span${className ? ` className="${className}"` : ''}${Object.keys(style).length ? ` style=${styleObject(style, false)}` : ''}>`;
      } else open = `<span style=${styleObject(run.styles, true)}>`;
    }
    run.text.split('\n').forEach((part, i) => {
      if (i > 0) {
        lines.push(`${line}<br />`);
        line = '';
      }
      if (!part) return;
      const body = escapeJsxText(part).replace(/ {2,}/g, (m) => `{'${m}'}`);
      line += open ? `${open}${body}</span>` : body;
    });
  }
  lines.push(line);
  return lines;
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

// ---- shaders ------------------------------------------------------------------

/** JSX props for a shader layer: stored params (colours as hex), then the transparent background. */
function shaderJsxProps(def: ShaderDef, node: NodeRecord, reader: DocReader): string[] {
  const params = new Map(def.params.map((p) => [p.name, p]));
  const out: string[] = [];
  const colorProps: string[] = [];
  for (const [k, v] of Object.entries(node.props ?? {})) {
    const param = params.get(k);
    if (k !== 'frame' && !param) continue;
    if (param?.kind === 'color' && typeof v === 'string') {
      colorProps.push(`${k}="${shaderColorToHex(v, reader.getTokens())}"`);
    } else if (param?.kind === 'colors' && Array.isArray(v)) {
      colorProps.push(`${k}={[${v.map((c) => jsString(shaderColorToHex(c, reader.getTokens()))).join(', ')}]}`);
    } else if (typeof v === 'number') out.push(`${k}={${v}}`);
    else if (typeof v === 'boolean') out.push(v ? k : `${k}={false}`);
    else if (typeof v === 'string') out.push(`${k}="${v.replace(/"/g, '&quot;')}"`);
  }
  out.push(...colorProps);
  if (shaderHasColorBack(def)) out.push('colorBack="#00000000"');
  return out;
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
  const shader = shaderDef(node.component);
  if (shader) {
    ctx.imports.add(shader.name);
    const idAttr = ctx.opts.includeNodeIds ? attrs.splice(0, 1) : [];
    return [`${ind}<${shader.name} ${[...idAttr, ...shaderJsxProps(shader, node, ctx.reader), ...attrs].join(' ')} />`];
  }
  const rest = attrs.length ? ' ' + attrs.join(' ') : '';
  const jsxAttr = (v: string) => `"${v.replace(/"/g, '&quot;')}"`;
  if (node.component === 'Video') {
    return [`${ind}<video src=${jsxAttr(node.src ?? '')} autoPlay muted playsInline${node.attrs?.loop === 'false' ? '' : ' loop'}${rest} />`];
  }
  if (node.component === 'Lottie') {
    ctx.lottie = true;
    const speed = node.attrs?.speed ? ` speed={${Number(node.attrs.speed) || 1}}` : '';
    return [`${ind}<DotLottieReact src=${jsxAttr(node.src ?? '')} autoplay${node.attrs?.loop === 'false' ? '' : ' loop'}${speed}${rest} />`];
  }
  if (node.component === 'Embed') {
    if (node.html === undefined) return [`${ind}<iframe src=${jsxAttr(node.src ?? '')}${rest} />`];
    return [`${ind}<iframe sandbox="allow-scripts" srcDoc={${JSON.stringify(node.html)}}${rest} />`];
  }
  const open = `${ind}<div${rest}`;

  if (node.component === 'Text') {
    const text = node.textValue ?? '';
    if (!text) return [`${open} />`];
    const lines = node.textRuns?.length ? await runLines(node.textRuns, ctx) : textLines(text);
    return [`${open}>`, ...lines.map((l) => `${ind}  ${l}`), `${ind}</div>`];
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
  const ctx: Ctx = { reader, opts, imports: new Set() };
  const lines = await emitNode(root, ctx, 0, true, rootExtrasFor(reader, root));
  if (!lines.length) return '';
  const body = lines.length === 1 ? lines[0]! : `(\n${lines.map((l) => `    ${l}`).join('\n')}\n  )`;
  const head: string[] = [];
  if (ctx.imports.size) {
    const names = [...ctx.imports].sort().join(', ');
    head.push(`/** @paper-design/shaders-react@${SHADER_LIBRARY_VERSION} */\nimport { ${names} } from '@paper-design/shaders-react';`);
  }
  if (ctx.lottie) head.push(`import { DotLottieReact } from '@lottiefiles/dotlottie-react';`);
  const keyframes = keyframesUsedBy(reader, [rootId]);
  if (keyframes.length) head.push(`/* Add to your CSS:\n${keyframes.map(formatKeyframes).join('\n')}\n*/`);
  return head.length ? `${head.join('\n\n')}\n\n${body}` : body;
}
