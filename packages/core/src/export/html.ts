import { scopeSvgIds } from '../html/svg.ts';
import { displayName } from '../model/labels.ts';
import type { DocReader } from '../model/transaction.ts';
import type { NodeRecord } from '../model/types.ts';
import { computedStyles } from '../query/info.ts';
import { styleMapToCss } from '../styles/css.ts';
import { shaderDef, type ShaderProps } from '../shaders/registry.ts';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Shader params as <x-shader> attributes (colour lists space-separated). */
function shaderAttrs(props: ShaderProps | undefined, resolve: (u: string) => string): string {
  let out = '';
  for (const [k, v] of Object.entries(props ?? {})) {
    const text = Array.isArray(v) ? v.join(' ') : k === 'image' && typeof v === 'string' ? resolve(v) : String(v);
    out += ` ${k}="${escAttr(text)}"`;
  }
  return out;
}

/**
 * Clean, portable HTML for nodes (clipboard "copy", "Copy as HTML"). Re-importing
 * it with write_html / paste reproduces the layers; it also reads well in any chat.
 */
export function nodesToHtml(reader: DocReader, ids: string[], opts: { resolveUrl?: (url: string) => string } = {}): string {
  const resolve = opts.resolveUrl ?? ((u: string) => u);
  const emit = (node: NodeRecord, top: boolean, indent: string): string => {
    const styles = computedStyles(reader, node);
    if (top) {
      // Canvas position is not part of the copied design.
      for (const k of ['left', 'top', 'right', 'bottom']) delete styles[k];
      if (styles.position === 'absolute') delete styles.position;
    }
    for (const [k, v] of Object.entries(styles)) {
      if (v.includes('url(')) styles[k] = v.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (_m, _q, u: string) => `url("${resolve(u)}")`);
    }
    if (!node.isVisible) styles.display = 'none';
    const css = styleMapToCss(styles);
    const name = node.labelIsModified ? ` layer-name="${escAttr(node.label)}"` : '';
    const style = css ? ` style="${escAttr(css)}"` : '';
    if (node.component === 'SVG') {
      const markup = scopeSvgIds(node.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"></svg>', `_${node.id}_`);
      return indent + markup.replace(/^<svg\b/i, `<svg${name}${style}`);
    }
    if (node.component === 'Text') {
      return `${indent}<div${name}${style}>${esc(node.textValue ?? '')}</div>`;
    }
    const shader = shaderDef(node.component);
    if (shader) return `${indent}<x-shader type="${shader.name}"${name}${shaderAttrs(node.props, resolve)}${style}></x-shader>`;
    const kids = node.children.map((id) => reader.getNode(id)).filter((n): n is NodeRecord => !!n);
    const tag = node.component === 'Rectangle' ? ' paper-node="Rectangle"' : '';
    if (!kids.length) return `${indent}<div${name}${tag}${style}></div>`;
    const inner = kids.map((k) => emit(k, false, indent + '  ')).join('\n');
    return `${indent}<div${name}${style}>\n${inner}\n${indent}</div>`;
  };
  return ids
    .map((id) => reader.getNode(id))
    .filter((n): n is NodeRecord => !!n && n.component !== 'PageRoot')
    .map((n) => emit(n, true, ''))
    .join('\n');
}

export function describeNodes(reader: DocReader, ids: string[]): string {
  return ids
    .map((id) => reader.getNode(id))
    .filter((n): n is NodeRecord => !!n)
    .map((n) => displayName(n))
    .join(', ');
}
