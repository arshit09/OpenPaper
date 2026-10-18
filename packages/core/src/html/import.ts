import render from 'dom-serializer';
import type { ChildNode, Element } from 'domhandler';
import { cssUrls, parseInlineStyle, pxValue, type StyleMap } from '../styles/css.ts';
import { hasBoxStyles, INHERITED_TEXT_PROPS, normalizeNodeStyles, stripInertStyles } from '../styles/normalize.ts';
import { FREEFORM_DISPLAY } from '../render/render-spec.ts';
import {
  attr,
  BLOCK_TAGS,
  DEFAULT_INLINE_BLOCK,
  hasAttr,
  INLINE_TAGS,
  inlineStyle,
  isElement,
  isText,
  NON_TEXT_INLINE,
  parseFragment,
  SKIPPED_TAGS,
} from './dom.ts';
import { cleanSvgMarkup } from './svg.ts';

/**
 * HTML → design nodes, following Paper's import rules:
 *  - only inline styles are read (classes, <style>, scripts are ignored)
 *  - containers become Frames, leaves Rectangles, text runs Text nodes
 *  - typography is resolved from ancestors inside the snippet and stored on Text nodes
 *  - <img> becomes a Rectangle with an image fill; <svg> an SVG node
 *  - <x-paper-clone node-id="…"> deep-copies an existing node
 */

export type ImportedComponent = 'Frame' | 'Text' | 'Rectangle' | 'SVG';

export interface ImportedNode {
  component: ImportedComponent;
  label: string;
  labelIsModified: boolean;
  styles: StyleMap;
  textValue?: string;
  svg?: string;
  isVisible: boolean;
  isLocked: boolean;
  children: ImportedNode[];
  /** Deep copy of an existing node (from <x-paper-clone>); `styles` are overrides. */
  cloneOf?: string;
  /** paper-gen:// URL requested for this node (image generation). */
  generate?: string;
}

export interface ResolvedImage {
  /** URL to store (e.g. /media/<hash>.png). */
  url: string;
  width?: number;
  height?: number;
  /** For localhost .svg images: inline the markup as an SVG node. */
  svgMarkup?: string;
}

export interface ImportOptions {
  /** Look up a pre-resolved image (see collectImageUrls). `undefined` = leave URL as written, `null` = failed. */
  resolveImage?: (src: string) => ResolvedImage | null | undefined;
  /** Whether a node id exists in the file (for x-paper-clone). */
  nodeExists?: (id: string) => boolean;
  /** Computed CSS `color` inherited from outside the snippet (for SVG currentColor). */
  defaultColor?: string;
}

export interface ImportResult {
  roots: ImportedNode[];
  warnings: string[];
}

// ---------------------------------------------------------------------------

type WhiteSpace = 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line' | 'break-spaces';

interface Ctx {
  inherited: StyleMap;
  whiteSpace: WhiteSpace;
}

/** Intermediate tree node during the walk. */
interface Build {
  node: ImportedNode;
  /** Raw own styles (before normalization). */
  raw: StyleMap;
  tag: string;
  el: Element | null;
  parent: Build | null;
  children: Build[];
  inheritedAtNode: StyleMap;
  absolute: boolean;
  /** Text nodes created from a parent's text run inherit some non-inherited props from it. */
  createdFrom?: Build;
  isReplaced: boolean;
}

const INHERIT_SET = new Set<string>(INHERITED_TEXT_PROPS);
const COPIED_FROM_PARENT = ['display', 'overflow', 'overflowX', 'overflowY', 'textDecoration', 'textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset', 'WebkitLineClamp'];

function pickInherited(styles: StyleMap): StyleMap {
  const out: StyleMap = {};
  for (const [k, v] of Object.entries(styles)) if (INHERIT_SET.has(k)) out[k] = v;
  return out;
}

function whiteSpaceOf(own: StyleMap, tag: string, parent: WhiteSpace): WhiteSpace {
  const ws = own.whiteSpace ?? (own.whiteSpaceCollapse === 'preserve' ? 'pre-wrap' : undefined);
  if (ws && ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(ws)) return ws as WhiteSpace;
  if (tag === 'pre' || tag === 'textarea') return 'pre';
  return parent;
}

function preserves(ws: WhiteSpace): boolean {
  return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
}

function collapse(text: string, ws: WhiteSpace): string {
  if (preserves(ws)) return text;
  if (ws === 'pre-line') {
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/[\t\f ]+/g, ' ').trim())
      .join('\n');
  }
  return text.replace(/[\t\n\r\f ]+/g, ' ');
}

function displayOf(el: Element, own: StyleMap): string | undefined {
  if (own.display) return own.display;
  const tag = el.name.toLowerCase();
  if (DEFAULT_INLINE_BLOCK.has(tag)) return 'inline-block';
  return undefined;
}

function isBlockLevel(n: ChildNode | undefined): boolean {
  if (!n || !isElement(n)) return false;
  const own = inlineStyle(n);
  const d = own.display;
  if (d) return /^(block|flex|grid|table|list-item|flow-root)$/.test(d);
  return BLOCK_TAGS.has(n.name.toLowerCase());
}

function isAbsoluteEl(n: ChildNode | undefined): boolean {
  if (!n || !isElement(n)) return false;
  const p = inlineStyle(n).position;
  return p === 'absolute' || p === 'fixed';
}

function isBlank(n: ChildNode): boolean {
  return isText(n) && !/[^\t\n\r\f ]/.test(n.data);
}

/** Meaningful = non-blank text or any element (excluding skipped tags). */
function meaningfulChildren(el: Element): ChildNode[] {
  return el.children.filter((c) => (isText(c) ? !isBlank(c) : isElement(c) && !SKIPPED_TAGS.has(c.name.toLowerCase())));
}

/** Can this node be part of a flattened text run? */
function isTextLike(n: ChildNode): boolean {
  if (isText(n)) return true;
  if (!isElement(n)) return false;
  const tag = n.name.toLowerCase();
  if (tag === 'br') return true;
  if (SKIPPED_TAGS.has(tag)) return true;
  if (NON_TEXT_INLINE.has(tag)) return false;
  const own = inlineStyle(n);
  if (own.position === 'absolute' || own.position === 'fixed') return false;
  const display = own.display;
  const inline = display ? /^inline(-block)?$/.test(display) || display === 'contents' : INLINE_TAGS.has(tag);
  if (!inline) return false;
  if (display === 'inline-block' && hasBoxStyles(own)) return false;
  return n.children.every(isTextLike);
}

function canFlatten(el: Element, own: StyleMap): boolean {
  const tag = el.name.toLowerCase();
  const d = own.display;
  const forced = attr(el, 'data-paper-component') === 'Text';
  const okDisplay = d
    ? /^(block|inline|inline-block|list-item|flow-root)$/.test(d)
    : BLOCK_TAGS.has(tag) || INLINE_TAGS.has(tag) || forced;
  if (!okDisplay) return false;
  const meaningful = meaningfulChildren(el);
  if (meaningful.length < (forced ? 1 : 2)) return false;
  return el.children.every((c) => isTextLike(c) || isBlank(c));
}

/** Concatenate a flattened subtree; returns the text and the dominant color. */
function flattenText(el: Element, ws: WhiteSpace, inheritedColor: string | undefined): { text: string; color?: string } {
  const parts: string[] = [];
  const colorChars = new Map<string, number>();
  const walk = (node: ChildNode, mode: WhiteSpace, color: string | undefined) => {
    if (isText(node)) {
      const t = collapse(node.data, mode);
      parts.push(t);
      const weight = t.replace(/\s/g, '').length;
      if (weight && color) colorChars.set(color, (colorChars.get(color) ?? 0) + weight);
      else if (weight) colorChars.set('', (colorChars.get('') ?? 0) + weight);
      return;
    }
    if (!isElement(node)) return;
    const tag = node.name.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    const own = inlineStyle(node);
    const next = whiteSpaceOf(own, tag, mode);
    const c = own.WebkitTextFillColor ?? own.color ?? color;
    for (const child of node.children) walk(child, next, c);
  };
  for (const child of el.children) walk(child, ws, inheritedColor);
  let text = parts.join('');
  if (!preserves(ws)) {
    // Collapse spaces across run boundaries, keep explicit newlines from <br>.
    text = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
    text = text.replace(/^ +| +$/g, '');
    text = text.replace(/\n+$/g, (m) => (m.length > 1 ? m.slice(1) : ''));
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [color, count] of colorChars) {
    if (count > bestCount) {
      best = color || undefined;
      bestCount = count;
    }
  }
  return { text, color: best };
}

function labelFor(tag: string, component: ImportedComponent): { label: string; modified: boolean } {
  switch (tag) {
    case 'input':
      return { label: 'Input', modified: true };
    case 'select':
      return { label: 'Select', modified: true };
    case 'textarea':
      return { label: 'Text Area', modified: true };
    case 'button':
      return { label: 'Button', modified: true };
    default:
      return { label: component, modified: false };
  }
}

function objectFitToBackgroundSize(fit: string | undefined): string {
  switch (fit) {
    case 'cover':
      return 'cover';
    case 'contain':
    case 'scale-down':
      return 'contain';
    case 'none':
      return 'auto';
    default:
      return '100% 100%';
  }
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

// ---------------------------------------------------------------------------

export function importHtml(html: string, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const topLevel: Build[] = [];
  const rootCtx: Ctx = { inherited: {}, whiteSpace: 'normal' };

  const resolveUrlsInStyles = (styles: StyleMap) => {
    for (const [k, v] of Object.entries(styles)) {
      if (!v.includes('url(')) continue;
      let out = v;
      for (const url of cssUrls(v)) {
        if (url.startsWith('paper-gen://')) continue;
        const r = opts.resolveImage?.(url);
        if (r === null) {
          // Failed images are dropped silently (matches Paper).
          out = out.replace(/url\([^)]*\)/, 'none');
        } else if (r) out = out.split(url).join(r.url);
      }
      styles[k] = out;
    }
  };

  const makeBuild = (node: ImportedNode, raw: StyleMap, tag: string, el: Element | null, parent: Build | null, inherited: StyleMap): Build => ({
    node,
    raw,
    tag,
    el,
    parent,
    children: [],
    inheritedAtNode: inherited,
    absolute: raw.position === 'absolute' || raw.position === 'fixed',
    isReplaced: tag === 'img' || tag === 'svg',
  });

  const attach = (build: Build, parent: Build | null) => {
    if (build.absolute) {
      // Re-parent absolute/fixed elements to their containing block.
      let cb: Build | null = parent;
      const fixed = build.raw.position === 'fixed';
      while (cb) {
        const p = cb.raw.position;
        const establishes = fixed
          ? !!(cb.raw.transform || cb.raw.filter || cb.raw.perspective || cb.raw.backdropFilter || cb.raw.contain || cb.raw.willChange)
          : p === 'relative' || p === 'absolute' || p === 'fixed' || p === 'sticky' || !!cb.raw.transform;
        if (establishes) break;
        cb = cb.parent;
      }
      if (fixed) {
        build.raw.position = 'absolute';
        build.node.styles.position = 'absolute';
      }
      if (cb !== parent) {
        if (!cb) {
          build.parent = null;
          topLevel.push(build);
          return;
        }
        build.parent = cb;
        cb.children.push(build);
        return;
      }
    }
    build.parent = parent;
    if (parent) parent.children.push(build);
    else topLevel.push(build);
  };

  const textBuild = (text: string, parent: Build, ctx: Ctx): Build => {
    const node: ImportedNode = {
      component: 'Text',
      label: 'Text',
      labelIsModified: false,
      styles: {},
      textValue: text,
      isVisible: true,
      isLocked: false,
      children: [],
    };
    const raw: StyleMap = {};
    for (const k of COPIED_FROM_PARENT) if (parent.raw[k] !== undefined) raw[k] = parent.raw[k]!;
    if (parent.raw.backgroundClip === 'text' || parent.raw.WebkitBackgroundClip === 'text') {
      for (const k of ['backgroundImage', 'backgroundColor', 'backgroundClip', 'WebkitBackgroundClip']) {
        if (parent.raw[k] !== undefined) raw[k] = parent.raw[k]!;
      }
    }
    const b = makeBuild(node, raw, '#text', null, parent, ctx.inherited);
    b.createdFrom = parent;
    return b;
  };

  const visitChildren = (el: Element, build: Build, ctx: Ctx) => {
    const own = build.raw;
    const children = el.children;
    const nonAbsoluteSiblings = (except: ChildNode) =>
      children.some((c) => c !== except && !(isElement(c) && (SKIPPED_TAGS.has(c.name.toLowerCase()) || isAbsoluteEl(c))) && !(isText(c) && !c.data.length));
    const boxy = hasBoxStyles(own);
    const nowrapWithWidth = own.whiteSpace === 'nowrap' && !!own.width;
    const parentDisplay = own.display;
    const flexLike = !!parentDisplay && /(flex|grid|table)/.test(parentDisplay);

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (isText(child)) {
        let text = collapse(child.data, ctx.whiteSpace);
        if (!preserves(ctx.whiteSpace)) {
          const prev = children[i - 1];
          const next = children[i + 1];
          const atStart = !prev || flexLike || isBlockLevel(prev) || (isElement(prev) && flexLike);
          const atEnd = !next || flexLike || isBlockLevel(next) || (isElement(next) && flexLike);
          if (atStart) text = text.replace(/^[ ]+/, '');
          if (atEnd) text = text.replace(/[ ]+$/, '');
          // "Hello<b>World</b>" heuristic: keep a space between words split across inline elements.
          if (!atEnd && next && isElement(next) && /[A-Za-z]$/.test(text)) {
            const nextText = isElement(next) ? next.children.find(isText)?.data ?? '' : '';
            if (/^[A-Za-z]/.test(nextText) && !text.endsWith(' ')) text += ' ';
          }
        }
        if (!text || (!preserves(ctx.whiteSpace) && !text.trim())) continue;
        const separate = nonAbsoluteSiblings(child) || boxy || nowrapWithWidth || build.node.component !== 'Frame';
        if (separate) {
          const tb = textBuild(text, build, ctx);
          attach(tb, build);
        } else {
          // The element itself becomes the Text node.
          becomeText(build, text);
        }
        continue;
      }
      if (isElement(child)) visitElement(child, build, ctx);
    }
  };

  const becomeText = (build: Build, text: string) => {
    const n = build.node;
    n.component = 'Text';
    n.textValue = text;
    if (!n.labelIsModified) n.label = 'Text';
    const s = build.raw;
    const display = s.display;
    if (display === 'flex' || display === 'inline-flex') {
      const column = (s.flexDirection ?? 'row').startsWith('column');
      const horizontal = column ? s.alignItems : s.justifyContent;
      const vertical = column ? s.justifyContent : s.alignItems;
      if (!s.textAlign) {
        if (horizontal === 'center') s.textAlign = 'center';
        else if (horizontal === 'flex-end' || horizontal === 'end' || horizontal === 'right') s.textAlign = 'right';
      }
      if (!s.alignContent) {
        if (vertical === 'center') s.alignContent = 'center';
        else if (vertical === 'flex-end' || vertical === 'end') s.alignContent = 'end';
      }
      if (display === 'inline-flex') s.display = 'inline-block';
      else delete s.display;
      for (const k of ['justifyContent', 'alignItems', 'flexDirection', 'flexWrap', 'gap', 'rowGap', 'columnGap']) delete s[k];
    }
  };

  const visitElement = (el: Element, parent: Build | null, ctx: Ctx) => {
    const tag = el.name.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) return;
    const own = inlineStyle(el);
    const visible = !(hasAttr(el, 'hidden') || own.display === 'none');
    if (own.display === 'none') delete own.display;
    const display = displayOf(el, own);
    if (display && !own.display) own.display = display;
    if (own.display === 'list-item') delete own.display;
    const layerName = attr(el, 'layer-name');
    const locked = hasAttr(el, 'data-paper-locked');
    resolveUrlsInStyles(own);

    // Inherited typography for this element's subtree.
    const nextInherited = { ...ctx.inherited, ...pickInherited(own) };
    const nextCtx: Ctx = { inherited: nextInherited, whiteSpace: whiteSpaceOf(own, tag, ctx.whiteSpace) };

    const base = (component: ImportedComponent): ImportedNode => {
      const l = labelFor(tag, component);
      return {
        component,
        label: layerName !== undefined ? layerName.slice(0, 200) : l.label,
        labelIsModified: layerName !== undefined || l.modified,
        styles: {},
        isVisible: visible,
        isLocked: locked,
        children: [],
      };
    };

    // <x-paper-clone node-id="…">
    if (tag === 'x-paper-clone') {
      const sourceId = attr(el, 'node-id');
      if (!sourceId || !opts.nodeExists?.(sourceId)) return; // silently skipped
      const node = base('Frame');
      node.cloneOf = sourceId;
      if (layerName === undefined) node.labelIsModified = false;
      node.styles = own;
      const b = makeBuild(node, own, tag, el, parent, ctx.inherited);
      attach(b, parent);
      for (const child of el.children) if (isElement(child)) visitElement(child, b, nextCtx);
      return;
    }

    // <svg>
    if (tag === 'svg') {
      const node = base('SVG');
      if (layerName === undefined) node.label = 'SVG';
      node.svg = cleanSvgMarkup(render(el, { xmlMode: true, selfClosingTags: true }));
      const s = { ...own };
      s.display ??= 'inline-block';
      const color = nextInherited.color ?? opts.defaultColor;
      if (color && !s.color) s.color = color;
      node.styles = s;
      attach(makeBuild(node, s, tag, el, parent, ctx.inherited), parent);
      return;
    }

    // <img>
    if (tag === 'img') {
      const src = (attr(el, 'src') ?? '').trim();
      if (src.startsWith('paper-gen://')) {
        const node = base('Rectangle');
        node.generate = src;
        node.styles = { ...own };
        attach(makeBuild(node, node.styles, tag, el, parent, ctx.inherited), parent);
        return;
      }
      const resolved = src ? opts.resolveImage?.(src) : null;
      if (resolved?.svgMarkup) {
        const node = base('SVG');
        if (layerName === undefined) node.label = 'SVG';
        node.svg = cleanSvgMarkup(resolved.svgMarkup);
        node.styles = { ...own, display: own.display ?? 'inline-block' };
        attach(makeBuild(node, node.styles, 'svg', el, parent, ctx.inherited), parent);
        return;
      }
      const node = base('Rectangle');
      const s: StyleMap = { ...own };
      const fit = s.objectFit;
      const position = s.objectPosition;
      delete s.objectFit;
      delete s.objectPosition;
      const url = resolved === undefined ? src : resolved?.url;
      if (url) {
        s.backgroundImage = `url("${url}")`;
        s.backgroundSize = objectFitToBackgroundSize(fit);
        s.backgroundPosition = position ?? 'center';
        s.backgroundRepeat = 'no-repeat';
        const w = resolved?.width;
        const h = resolved?.height;
        const hasW = !!s.width && s.width !== 'auto';
        const hasH = !!s.height && s.height !== 'auto';
        if (w && h) {
          const g = gcd(Math.round(w), Math.round(h)) || 1;
          if (!hasW && !hasH) {
            s.width = `${Math.round(w)}px`;
            s.height = `${Math.round(h)}px`;
          }
          if (!(hasW && hasH)) s.aspectRatio = `${Math.round(w) / g} / ${Math.round(h) / g}`;
        }
      }
      node.styles = s;
      attach(makeBuild(node, s, tag, el, parent, ctx.inherited), parent);
      return;
    }

    // Form controls
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const type = (attr(el, 'type') ?? 'text').toLowerCase();
      if (tag === 'input' && (type === 'checkbox' || type === 'radio') && own.appearance !== 'none') {
        visitCheckbox(el, own, type, parent, ctx, base);
        return;
      }
      if (tag === 'input' && ['hidden', 'file', 'range', 'color', 'image'].includes(type)) return;
      const node = base('Frame');
      const s: StyleMap = { ...own };
      s.display = s.display === 'inline-block' || s.display === 'inline' || !s.display ? 'inline-flex' : s.display;
      if (s.display === 'block') s.display = 'flex';
      s.alignItems ??= 'center';
      node.styles = s;
      const b = makeBuild(node, s, tag, el, parent, ctx.inherited);
      attach(b, parent);
      let value = attr(el, 'value') ?? '';
      if (tag === 'textarea') value = el.children.filter(isText).map((t) => t.data).join('');
      if (tag === 'select') {
        const options = el.children.filter((c): c is Element => isElement(c) && c.name.toLowerCase() === 'option');
        const selected = options.find((o) => hasAttr(o, 'selected')) ?? options[0];
        value = selected ? selected.children.filter(isText).map((t) => t.data).join('').trim() : '';
      }
      if (tag === 'input' && ['submit', 'reset', 'button'].includes(type) && !value) value = type === 'reset' ? 'Reset' : 'Submit';
      const placeholder = attr(el, 'placeholder');
      const text = value || placeholder || '';
      if (text) {
        const tb = textBuild(collapse(text, tag === 'textarea' ? 'pre-wrap' : 'normal').trim() || text, b, nextCtx);
        Object.assign(tb.raw, { height: 'fit-content', width: '100%', overflow: 'clip', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
        delete tb.raw.display;
        if (!value && placeholder) {
          const extra = attr(el, 'data-paper-placeholder-styles');
          Object.assign(tb.raw, extra ? parseInlineStyle(extra) : { opacity: '0.5' });
        }
        attach(tb, b);
      }
      return;
    }

    // Generic element.
    const hasChildNodes = el.children.some((c) => isText(c) || (isElement(c) && !SKIPPED_TAGS.has(c.name.toLowerCase())));
    const forcedRect = attr(el, 'paper-node') === 'Rectangle';
    const component: ImportedComponent = (hasChildNodes || layerName !== undefined) && !forcedRect ? 'Frame' : 'Rectangle';
    const node = base(component);
    node.styles = own;
    const b = makeBuild(node, own, tag, el, parent, ctx.inherited);
    attach(b, parent);
    if (b.absolute) foldAbsoluteMargins(own);
    if (component !== 'Frame') return;

    if (canFlatten(el, own)) {
      const { text, color } = flattenText(el, nextCtx.whiteSpace, nextInherited.WebkitTextFillColor ?? nextInherited.color);
      if (color && color !== (nextInherited.WebkitTextFillColor ?? nextInherited.color)) own.WebkitTextFillColor = color;
      const flatCtx: Ctx = { inherited: { ...nextInherited, ...(color ? { color } : {}) }, whiteSpace: 'pre' };
      if (text) {
        if (hasBoxStyles(own) || (own.whiteSpace === 'nowrap' && own.width)) {
          const tb = textBuild(text, b, flatCtx);
          tb.raw.whiteSpace = 'pre-wrap';
          attach(tb, b);
        } else {
          becomeText(b, text);
          b.inheritedAtNode = { ...ctx.inherited };
          if (/\n|  /.test(text)) own.whiteSpace ??= 'pre-wrap';
        }
      }
      if (b.node.component === 'Text' && color) own.color = color;
      return;
    }
    visitChildren(el, b, nextCtx);
  };

  const visitCheckbox = (
    el: Element,
    own: StyleMap,
    type: string,
    parent: Build | null,
    ctx: Ctx,
    base: (c: ImportedComponent) => ImportedNode
  ) => {
    const checked = hasAttr(el, 'checked');
    const accent = own.accentColor ?? 'rgb(0, 122, 255)';
    const node = base('Frame');
    node.label = type === 'radio' ? 'Radio' : 'Checkbox';
    node.labelIsModified = true;
    const s: StyleMap = {
      width: '13px',
      height: '13px',
      borderRadius: type === 'radio' ? '9999px' : '2px',
      border: `1px solid ${checked ? accent : 'rgb(199, 199, 199)'}`,
      backgroundColor: checked ? accent : '#FFFFFF',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: '0',
      ...own,
    };
    node.styles = s;
    const b = makeBuild(node, s, 'input', el, parent, ctx.inherited);
    attach(b, parent);
    if (checked) {
      const mark: ImportedNode = {
        component: 'Rectangle',
        label: type === 'radio' ? 'Dot' : 'Check',
        labelIsModified: true,
        styles:
          type === 'radio'
            ? { width: '7px', height: '7px', borderRadius: '9999px', backgroundColor: '#FFFFFF' }
            : { width: '5px', height: '9px', borderRight: '2px solid #FFFFFF', borderBottom: '2px solid #FFFFFF', rotate: '45deg', marginTop: '-2px' },
        isVisible: true,
        isLocked: false,
        children: [],
      };
      attach(makeBuild(mark, mark.styles, 'span', null, b, ctx.inherited), b);
    }
  };

  // ---- walk -------------------------------------------------------------
  for (const node of parseFragment(html)) {
    if (isElement(node)) visitElement(node, null, rootCtx);
    // Text directly at the top level is ignored (top-level items must be elements).
  }

  // ---- styles (post-order) ------------------------------------------------
  const finalize = (b: Build) => {
    for (const c of b.children) finalize(c);
    const n = b.node;
    if (n.cloneOf) {
      n.styles = { ...b.raw };
      delete n.styles.position;
      if (b.absolute) n.styles.position = 'absolute';
      return;
    }
    if (n.component === 'Text') {
      const own = { ...b.raw };
      const s: StyleMap = { ...b.inheritedAtNode, ...pickInherited(own), ...own };
      if (b.createdFrom) {
        // Text runs created from an element's text keep only inherited typography + copied props.
        for (const k of Object.keys(s)) if (!INHERIT_SET.has(k) && !(k in own)) delete s[k];
      }
      s.fontSize ??= '16px';
      s.color ??= s.WebkitTextFillColor ?? '#000000';
      s.fontFamily ??= 'system-ui, sans-serif';
      n.styles = normalizeNodeStyles(s, { isText: true, isSvg: false });
      const siblingsInline = (b.parent?.children ?? topLevel).some((x) => x !== b && /^inline/.test(x.raw.display ?? ''));
      if (n.styles.display === 'inline' || (siblingsInline && n.styles.display && /^inline/.test(n.styles.display))) {
        n.styles.display = 'inline-block';
      }
      return;
    }
    n.styles = normalizeNodeStyles(b.raw, { isText: false, isSvg: n.component === 'SVG', isReplaced: b.isReplaced });
  };
  for (const b of topLevel) finalize(b);

  // ---- structural post-passes ------------------------------------------------
  const postPass = (list: Build[], parentStyles: StyleMap | null) => {
    for (const b of list) postPass(b.children, b.node.styles);
    reorderByStacking(list);
    for (const b of list) {
      const s = b.node.styles;
      // Freeform detection: every child absolute → freeform container.
      const kids = b.children;
      if (b.node.component === 'Frame' && kids.length && !b.node.cloneOf) {
        const d = s.display;
        if ((!d || /^(block|inline|inline-block|flow-root)$/.test(d)) && kids.every((k) => k.node.styles.position === 'absolute')) {
          s.display = FREEFORM_DISPLAY;
          for (const k of kids) delete k.node.styles.position;
        }
      }
      if (parentStyles) stripInertStyles(s, parentStyles.display, b.node.component === 'Text');
    }
    negativeMarginsToGap(list, parentStyles);
  };
  postPass(topLevel, null);

  // ---- pruning ------------------------------------------------------------
  const isEmpty = (n: ImportedNode) =>
    !n.children.length && !n.textValue && !n.svg && !n.cloneOf && !n.generate && Object.keys(n.styles).length === 0;
  const positioned = (n: ImportedNode, parentDisplay: string | undefined) =>
    n.styles.position === 'absolute' || parentDisplay === FREEFORM_DISPLAY;
  const invisible = (n: ImportedNode) =>
    n.styles.opacity === '0' || n.styles.visibility === 'hidden' || (n.styles.overflow === 'clip' && (pxValue(n.styles.width) ?? 2) <= 1 && (pxValue(n.styles.height) ?? 2) <= 1);

  const toNodes = (list: Build[], parentDisplay: string | undefined, isTop: boolean): ImportedNode[] => {
    const out: ImportedNode[] = [];
    for (const b of list) {
      const n = b.node;
      n.children = toNodes(b.children, n.styles.display, false);
      const pos = positioned(n, parentDisplay);
      const flexParent = !!parentDisplay && /(flex|grid)/.test(parentDisplay);
      if (isEmpty(n) && (isTop || pos || !flexParent)) continue;
      if (pos && invisible(n) && !n.children.length && !n.textValue) continue;
      out.push(n);
    }
    return out;
  };

  return { roots: toNodes(topLevel, undefined, true), warnings };
}

function foldAbsoluteMargins(s: StyleMap) {
  const sides: Array<[string, string]> = [
    ['left', 'marginLeft'],
    ['top', 'marginTop'],
    ['right', 'marginRight'],
    ['bottom', 'marginBottom'],
  ];
  const m = s.margin?.split(/\s+/);
  if (m?.length) {
    const [t, r = t, b = t, l = r] = m;
    s.marginTop ??= t!;
    s.marginRight ??= r!;
    s.marginBottom ??= b!;
    s.marginLeft ??= l!;
  }
  for (const [inset, margin] of sides) {
    const mv = s[margin];
    if (!mv || mv === '0' || mv === '0px' || mv === 'auto') continue;
    const iv = s[inset];
    if (!iv) continue;
    const a = pxValue(iv);
    const b = pxValue(mv);
    s[inset] = a !== null && b !== null ? `${a + b}px` : `calc(${iv} + ${mv})`;
  }
  // Centering with auto margins and both insets.
  if (s.marginLeft === 'auto' && s.marginRight === 'auto' && s.left !== undefined && s.right !== undefined && s.width) {
    s.left = '50%';
    delete s.right;
    if (!s.transform && !s.translate) s.translate = '-50% 0';
  }
  for (const k of ['margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginBlock', 'marginInline']) delete s[k];
}

/**
 * Emulate CSS stacking with layer order: absolutely positioned siblings (out of flow)
 * are ordered by z-index above in-flow ones; in-flow siblings keep DOM order.
 */
function reorderByStacking(list: Build[]) {
  if (!list.some((b) => b.node.styles.position === 'absolute')) return;
  const level = (b: Build) => {
    if (b.node.styles.position !== 'absolute') return 0;
    const z = Number.parseInt(b.node.styles.zIndex ?? '', 10);
    return Number.isFinite(z) ? (z < 0 ? -1 : z + 1) : 0.5;
  };
  const indexed = list.map((b, i) => ({ b, i, l: level(b) }));
  indexed.sort((x, y) => x.l - y.l || x.i - y.i);
  for (let k = 0; k < indexed.length; k++) list[k] = indexed[k]!.b;
  // Layer order now encodes stacking for absolute siblings.
  for (const b of list) if (b.node.styles.position === 'absolute') delete b.node.styles.zIndex;
}

/** Equal negative margins between flex children → negative gap on the parent. */
function negativeMarginsToGap(list: Build[], parentStyles: StyleMap | null) {
  if (!parentStyles || !/flex/.test(parentStyles.display ?? '') || parentStyles.gap) return;
  const inflow = list.filter((b) => b.node.styles.position !== 'absolute');
  if (inflow.length < 2) return;
  const column = (parentStyles.flexDirection ?? 'row').startsWith('column');
  const lead = column ? 'marginTop' : 'marginLeft';
  const values = inflow.slice(1).map((b) => b.node.styles[lead]);
  const v = values[0];
  if (!v || !v.startsWith('-') || !values.every((x) => x === v)) return;
  parentStyles.gap = v;
  for (const b of inflow.slice(1)) delete b.node.styles[lead];
}

/** Image URLs referenced by the HTML (img src + CSS url()), for pre-resolution. */
export function collectImageUrls(html: string): string[] {
  const urls = new Set<string>();
  const visit = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      const tag = n.name.toLowerCase();
      if (SKIPPED_TAGS.has(tag)) continue;
      if (tag === 'img') {
        const src = attr(n, 'src')?.trim();
        if (src && !src.startsWith('paper-gen://')) urls.add(src);
      }
      const style = attr(n, 'style');
      if (style && style.includes('url(')) for (const u of cssUrls(style)) if (!u.startsWith('paper-gen://') && !u.startsWith('#')) urls.add(u);
      if (tag !== 'svg') visit(n.children);
    }
  };
  visit(parseFragment(html));
  return [...urls];
}

/** paper-gen:// URLs referenced by the HTML. */
export function collectGenerationUrls(html: string): string[] {
  const out: string[] = [];
  const re = /paper-gen:\/\/[^"'\s)]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}
