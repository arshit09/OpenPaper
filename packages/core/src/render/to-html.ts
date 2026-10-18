import { scopeSvgIds } from '../html/svg.ts';
import type { DocReader } from '../model/transaction.ts';
import type { NodeRecord } from '../model/types.ts';
import { styleMapToCss, type StyleMap } from '../styles/css.ts';
import { tokenVars } from '../tokens/tokens.ts';
import { shaderRenderProps } from '../shaders/props.ts';
import { shaderDef } from '../shaders/registry.ts';
import { BASE_CSS, parentKindOf, renderSpec, SHADER_RUNTIME_PATH, type RenderContext } from './render-spec.ts';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Inject a style attribute and data-op-id into the root <svg> tag of a markup string. */
function decorateSvgRoot(markup: string, id: string, style: StyleMap): string {
  const css = styleMapToCss(style);
  return markup.replace(/^<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i, '');
    a = a.replace(/\sdata-op-id\s*=\s*("[^"]*"|'[^']*')/i, '');
    return `<svg${a} data-op-id="${escapeAttr(id)}"${css ? ` style="${escapeAttr(css)}"` : ''}>`;
  });
}

/** Static HTML for a node subtree (same rules as the editor canvas). */
export function renderNodeHtml(reader: DocReader, node: NodeRecord, ctx: RenderContext): string {
  const parent = node.parentId ? reader.getNode(node.parentId) : undefined;
  const spec = renderSpec(node, parentKindOf(parent), ctx);
  const id = escapeAttr(node.id);
  if (spec.kind === 'svg') return decorateSvgRoot(scopeSvgIds(spec.svg!, `_${node.id}_`), node.id, spec.style);
  const css = styleMapToCss(spec.style);
  const styleAttr = css ? ` style="${escapeAttr(css)}"` : '';
  if (spec.kind === 'text') return `<div data-op-id="${id}"${styleAttr}>${escapeHtml(spec.text ?? '')}</div>`;
  if (spec.kind === 'shader') {
    // Mounted by the shader runtime script (SHADER_RUNTIME_PATH) at the stored frame.
    const props = shaderRenderProps(shaderDef(node.component)!, node.props, { tokens: reader.getTokens(), resolveUrl: (u) => ctx.resolveUrl(u) });
    return `<div data-op-id="${id}"${styleAttr} data-op-shader="${escapeAttr(spec.shader!)}" data-op-shader-props="${escapeAttr(JSON.stringify(props))}"></div>`;
  }
  if (spec.tag === 'img') return `<img data-op-id="${id}"${styleAttr} src="${escapeAttr(spec.attrs.src ?? '')}" alt="">`;
  if (spec.tag === 'video') return `<video data-op-id="${id}"${styleAttr} src="${escapeAttr(spec.attrs.src ?? '')}" muted></video>`;
  let inner = '';
  for (const childId of node.children) {
    const child = reader.getNode(childId);
    if (child) inner += renderNodeHtml(reader, child, ctx);
  }
  return `<div data-op-id="${id}"${styleAttr}>${inner}</div>`;
}

export interface DocumentHtmlOptions {
  /** Ids of top-level nodes to include (default: every child of the page root). */
  rootIds: string[];
  /** World translation so that the rendered content starts near (0,0). */
  offsetX: number;
  offsetY: number;
  background: string;
  /** Stylesheet URLs for fonts (Google Fonts CSS). */
  fontCss: string[];
  extraCss?: string;
}

/** Complete HTML document rendering a page (or some of its top-level nodes). */
export function renderDocumentHtml(reader: DocReader, ctx: RenderContext, opts: DocumentHtmlOptions): string {
  const vars = tokenVars(reader.getTokens());
  const varsCss = Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  let body = '';
  for (const id of opts.rootIds) {
    const node = reader.getNode(id);
    if (node) body += renderNodeHtml(reader, node, ctx);
  }
  const links = opts.fontCss.map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`).join('');
  const scripts = body.includes('data-op-shader=') ? `<script src="${SHADER_RUNTIME_PATH}" defer></script>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">${links}${scripts}<style>${BASE_CSS}
html,body{background:${opts.background};overflow:hidden}
[data-op-world]{position:absolute;left:0;top:0;transform:translate(${-opts.offsetX}px,${-opts.offsetY}px);${varsCss}}
${opts.extraCss ?? ''}</style></head><body><div data-op-world>${body}</div></body></html>`;
}
