import { parseDocument } from 'htmlparser2';
import render from 'dom-serializer';
import { Element, type ChildNode } from 'domhandler';

/**
 * Sanitizers for markup that ends up in the editor DOM. Designs can be written by
 * agents from untrusted sources (scraped pages, pasted HTML), so active content is
 * stripped: scripts, event handlers, javascript: URLs, embedded HTML documents.
 */

const DROP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript']);
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'data']);

function safeUrl(value: string): boolean {
  const v = value.replace(/[\u0000- ]+/g, '').toLowerCase();
  return !(v.startsWith('javascript:') || v.startsWith('vbscript:') || (v.startsWith('data:') && v.startsWith('data:text/html')));
}

function cleanNodes(nodes: ChildNode[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type === 'script' || node.type === 'style' || node.type === 'tag') {
      const el = node as Element;
      const name = el.name.toLowerCase();
      if (DROP_TAGS.has(name) || node.type === 'script') {
        nodes.splice(i, 1);
        continue;
      }
      for (const attr of Object.keys(el.attribs)) {
        const lower = attr.toLowerCase();
        if (lower.startsWith('on')) delete el.attribs[attr];
        else if (URL_ATTRS.has(lower) && !safeUrl(el.attribs[attr]!)) delete el.attribs[attr];
        else if (lower === 'style' && /expression\s*\(|javascript:/i.test(el.attribs[attr]!)) delete el.attribs[attr];
      }
      cleanNodes(el.children);
    } else if (node.type === 'directive' || node.type === 'cdata') {
      nodes.splice(i, 1);
    }
  }
}

/** Sanitize SVG markup and return it re-serialized (XML mode). */
export function sanitizeSvg(markup: string): string {
  const doc = parseDocument(markup, { xmlMode: true, recognizeSelfClosing: true });
  cleanNodes(doc.children);
  return render(doc.children, { xmlMode: true, selfClosingTags: true });
}

export interface SplitSvg {
  attrs: Record<string, string>;
  inner: string;
}

/** Split `<svg …>inner</svg>` into its root attributes and inner markup. */
export function splitSvgMarkup(markup: string): SplitSvg {
  const doc = parseDocument(markup, { xmlMode: true, recognizeSelfClosing: true });
  const root = doc.children.find((n): n is Element => n instanceof Element && n.name.toLowerCase() === 'svg');
  if (!root) return { attrs: {}, inner: '' };
  return { attrs: { ...root.attribs }, inner: render(root.children, { xmlMode: true, selfClosingTags: true }) };
}

/** React prop names for common SVG root attributes. */
const SVG_ATTR_TO_REACT: Record<string, string> = {
  class: 'className',
  'xlink:href': 'xlinkHref',
  'xml:space': 'xmlSpace',
  'xmlns:xlink': 'xmlnsXlink',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
  'preserveaspectratio': 'preserveAspectRatio',
  viewbox: 'viewBox',
};

export function svgAttrToReact(name: string): string {
  const lower = name.toLowerCase();
  if (SVG_ATTR_TO_REACT[lower]) return SVG_ATTR_TO_REACT[lower]!;
  if (name === 'viewBox' || name.startsWith('data-') || name.startsWith('aria-')) return name;
  return name.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase());
}
