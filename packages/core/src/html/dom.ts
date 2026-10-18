import { parseDocument } from 'htmlparser2';
import { Element, Text, type ChildNode, type ParentNode } from 'domhandler';
import { parseInlineStyle, type StyleMap } from '../styles/css.ts';

/** Elements whose content is never imported. */
export const SKIPPED_TAGS = new Set([
  'head',
  'style',
  'script',
  'link',
  'meta',
  'title',
  'template',
  'noscript',
  'base',
  'iframe',
  'object',
  'embed',
]);

export const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'canvas',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'noscript',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tfoot',
  'ul',
  'video',
  'body',
  'html',
  'menu',
  'search',
  'tbody',
  'thead',
  'tr',
  'td',
  'th',
  'caption',
  'legend',
  'center',
]);

export const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'acronym',
  'b',
  'bdo',
  'big',
  'br',
  'button',
  'cite',
  'code',
  'dfn',
  'em',
  'i',
  'img',
  'input',
  'kbd',
  'label',
  'map',
  'object',
  'output',
  'q',
  'samp',
  'select',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'textarea',
  'time',
  'tt',
  'u',
  'var',
  'mark',
  's',
  'del',
  'ins',
  'strike',
  'font',
  'data',
  'wbr',
]);

/** Inline tags that never count as plain text runs. */
export const NON_TEXT_INLINE = new Set(['button', 'canvas', 'iframe', 'img', 'input', 'object', 'select', 'svg', 'textarea', 'video']);

/** Tags that get `display: inline-block` when no display is given (Paper's import default). */
export const DEFAULT_INLINE_BLOCK = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'u', 'label', 'button', 'input', 'select', 'textarea', 'svg']);

export function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Parse an HTML fragment; returns the nodes that should be imported (body content). */
export function parseFragment(html: string): ChildNode[] {
  const doc = parseDocument(stripComments(html), {
    recognizeSelfClosing: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: false,
    decodeEntities: true,
  });
  const body = findFirst(doc.children, (el) => el.name === 'body');
  if (body) return body.children;
  const htmlEl = doc.children.find((n): n is Element => n instanceof Element && n.name === 'html');
  return htmlEl ? htmlEl.children : doc.children;
}

function findFirst(nodes: ChildNode[], pred: (el: Element) => boolean): Element | null {
  for (const n of nodes) {
    if (!(n instanceof Element)) continue;
    if (pred(n)) return n;
    const inner = findFirst(n.children, pred);
    if (inner) return inner;
  }
  return null;
}

export function isElement(n: ChildNode | ParentNode | null | undefined): n is Element {
  return n instanceof Element;
}

export function isText(n: ChildNode | null | undefined): n is Text {
  return n instanceof Text;
}

/** Case-insensitive attribute lookup (HTML attribute names are not lower-cased by the parser). */
export function attr(el: Element, name: string): string | undefined {
  if (el.attribs[name] !== undefined) return el.attribs[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(el.attribs)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function hasAttr(el: Element, name: string): boolean {
  return attr(el, name) !== undefined;
}

/** Inline style of an element as a camelCase map. */
export function inlineStyle(el: Element): StyleMap {
  return parseInlineStyle(attr(el, 'style'));
}

export function elementChildren(el: ParentNode): Element[] {
  return el.children.filter((c): c is Element => c instanceof Element);
}
