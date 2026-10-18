import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import { Element, Text, type ChildNode } from 'domhandler';
import { sanitizeSvg } from './sanitize.ts';

const STRIP_ELEMENTS = new Set(['title', 'desc', 'metadata', 'foreignobject', 'script']);
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textpath']);

/**
 * `<style>` inside inline SVG is document-wide, so it would leak onto other designs
 * and the editor. Inline simple rules (`.a`, `#b`, `path`, comma lists) into style
 * attributes and drop the `<style>` elements and `class` attributes.
 */
function inlineSvgStyles(root: Element): void {
  const styles: Element[] = [];
  const collect = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      if (n.name.toLowerCase() === 'style') styles.push(n);
      else collect(n.children);
    }
  };
  collect(root.children);
  if (!styles.length) return;
  const rules: Array<{ selector: string; decls: string }> = [];
  for (const s of styles) {
    const css = s.children
      .map((c) => (c instanceof Text ? c.data : ''))
      .join('')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      for (const sel of m[1]!.split(',')) rules.push({ selector: sel.trim(), decls: m[2]!.trim().replace(/;?\s*$/, '') });
    }
  }
  const matches = (el: Element, selector: string): boolean => {
    if (/^\.[\w-]+$/.test(selector)) return (el.attribs.class ?? '').split(/\s+/).includes(selector.slice(1));
    if (/^#[\w-]+$/.test(selector)) return el.attribs.id === selector.slice(1);
    if (/^[a-zA-Z][\w-]*$/.test(selector)) return el.name.toLowerCase() === selector.toLowerCase();
    return false;
  };
  const apply = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!(n instanceof Element)) continue;
      const decls = rules.filter((r) => r.decls && matches(n, r.selector)).map((r) => r.decls);
      if (decls.length) {
        const own = n.attribs.style ? `; ${n.attribs.style}` : '';
        n.attribs.style = `${decls.join('; ')}${own}`;
      }
      delete n.attribs.class;
      apply(n.children);
    }
  };
  apply(root.children);
  for (const s of styles) {
    const parent = s.parent as Element | null;
    if (parent) parent.children = parent.children.filter((c) => c !== s);
  }
}

function num(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(-?\d*\.?\d+)(px)?\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

function clean(nodes: ChildNode[], inText: boolean): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n instanceof Text) {
      if (!inText && !n.data.trim()) nodes.splice(i, 1);
      else if (!inText) n.data = n.data.replace(/\s+/g, ' ');
      continue;
    }
    if (n.type === 'comment' || n.type === 'directive' || n.type === 'cdata') {
      nodes.splice(i, 1);
      continue;
    }
    if (!(n instanceof Element)) continue;
    const name = n.name.toLowerCase();
    if (STRIP_ELEMENTS.has(name)) {
      nodes.splice(i, 1);
      continue;
    }
    for (const key of Object.keys(n.attribs)) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith('data-') ||
        lower.startsWith('sodipodi:') ||
        lower.startsWith('inkscape:') ||
        lower.startsWith('sketch:') ||
        lower === 'xmlns:sodipodi' ||
        lower === 'xmlns:inkscape' ||
        lower === 'xmlns:sketch' ||
        n.attribs[key] === ''
      ) {
        delete n.attribs[key];
      }
    }
    if (name === 'use') {
      for (const key of ['href', 'xlink:href']) {
        const v = n.attribs[key];
        if (v && !v.startsWith('#') && !v.startsWith('data:')) delete n.attribs[key];
      }
    }
    clean(n.children, inText || TEXT_ELEMENTS.has(name));
  }
}

/**
 * Sanitize and tidy SVG markup for storage: strips scripts/handlers, metadata,
 * editor-specific attributes and external references; ensures xmlns, width/height
 * and viewBox are present.
 */
export function cleanSvgMarkup(markup: string): string {
  const safe = sanitizeSvg(markup);
  const doc = parseDocument(safe, { xmlMode: true, recognizeSelfClosing: true });
  clean(doc.children, false);
  const root = doc.children.find((n): n is Element => n instanceof Element && n.name.toLowerCase() === 'svg');
  if (!root) return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  inlineSvgStyles(root);
  root.attribs.xmlns ??= 'http://www.w3.org/2000/svg';
  delete root.attribs['layer-name'];
  const vbKey = Object.keys(root.attribs).find((k) => k.toLowerCase() === 'viewbox');
  const vb = vbKey ? root.attribs[vbKey]!.trim().split(/[\s,]+/).map(Number) : null;
  const w = num(root.attribs.width);
  const h = num(root.attribs.height);
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) {
    if (vbKey !== 'viewBox') {
      root.attribs.viewBox = root.attribs[vbKey!]!;
      delete root.attribs[vbKey!];
    }
    if (root.attribs.width === undefined && root.attribs.height === undefined) {
      root.attribs.width = String(vb[2]);
      root.attribs.height = String(vb[3]);
    }
  } else if (w !== null && h !== null) {
    root.attribs.viewBox = `0 0 ${w} ${h}`;
  }
  return render(doc.children.filter((n) => n === root), { xmlMode: true, selfClosingTags: true });
}

/**
 * Make element ids unique per design node (many SVGs share one DOM on the canvas):
 * `id="a"` → `id="<prefix>a"` and every `url(#a)` / `href="#a"` reference.
 */
export function scopeSvgIds(markup: string, prefix: string): string {
  const ids = new Set<string>();
  for (const m of markup.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]!);
  if (!ids.size) return markup;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = markup;
  for (const id of ids) {
    const e = esc(id);
    out = out
      .replace(new RegExp(`(\\bid\\s*=\\s*["'])${e}(["'])`, 'g'), `$1${prefix}${id}$2`)
      .replace(new RegExp(`url\\(\\s*(["']?)#${e}\\1\\s*\\)`, 'g'), `url(#${prefix}${id})`)
      .replace(new RegExp(`((?:xlink:)?href\\s*=\\s*["'])#${e}(["'])`, 'g'), `$1#${prefix}${id}$2`);
  }
  return out;
}
