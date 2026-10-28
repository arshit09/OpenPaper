import { cssUrls, type StyleMap } from '../styles/css.ts';
import type { DocReader } from '../model/transaction.ts';
import type { NodeRecord } from '../model/types.ts';
import { isShaderComponent, shaderDef } from '../shaders/registry.ts';

/**
 * Shared rendering rules. Both the static HTML renderer (headless screenshots,
 * exports) and the editor's React canvas call these, so what agents see in
 * screenshots is exactly what the user sees on the canvas.
 */

/** Sentinel display value for "freeform" containers (children positioned absolutely). */
export const FREEFORM_DISPLAY = '*';

/** Zero-width joiner keeps empty text nodes one line tall. */
export const EMPTY_TEXT = '‍';

export interface RenderContext {
  /** Turn a stored URL (/media/…, paper-asset://…, https://…) into one the renderer can load. */
  resolveUrl(src: string): string;
  /** Origin of the OpenPaper server the render runs on (decides how much an Embed's page may do). */
  origin?: string;
}

export const identityUrls: RenderContext = { resolveUrl: (s) => s };

/** Map `paper-asset://` to the server's local-asset route; leave everything else alone. */
export function defaultResolveUrl(src: string, origin = ''): string {
  if (src.startsWith('paper-asset://')) {
    return `${origin}/local-asset?path=${encodeURIComponent(src.slice('paper-asset://'.length))}`;
  }
  if (src.startsWith('/media/') || src.startsWith(EMBED_ROUTE)) return `${origin}${src}`;
  return src;
}

function rewriteUrls(value: string, ctx: RenderContext): string {
  if (!value.includes('url(')) return value;
  let out = value;
  for (const url of cssUrls(value)) {
    const resolved = ctx.resolveUrl(url);
    if (resolved !== url) out = out.split(url).join(resolved);
  }
  return out;
}

export function isFreeform(node: NodeRecord): boolean {
  return node.component === 'PageRoot' || node.styles.display === FREEFORM_DISPLAY;
}

/** How a node's parent lays it out: canvas root, freeform frame, normal flow, or none. */
export type ParentKind = 'root' | 'freeform' | 'flow' | 'none';

export function parentKindOf(parent: NodeRecord | undefined): ParentKind {
  if (!parent) return 'none';
  if (parent.component === 'PageRoot') return 'root';
  return isFreeform(parent) ? 'freeform' : 'flow';
}

/** CSS for a node as rendered (camelCase). The returned object is safe to mutate. */
export function renderStyle(node: NodeRecord, parentKind: ParentKind, ctx: RenderContext): StyleMap {
  const style: StyleMap = {};
  for (const [k, v] of Object.entries(node.styles)) {
    if (v === undefined || v === null || v === '') continue;
    // Transitions are kept for code export but never run on the canvas: there are no hover or
    // focus states to move between, and an edit (a drag, a new size) must land at once.
    if (k.startsWith('transition')) continue;
    style[k] = rewriteUrls(String(v), ctx);
  }
  if (style.display === FREEFORM_DISPLAY) {
    delete style.display;
    style.position ??= 'relative';
  }
  if (parentKind === 'root') {
    // Top-level items sit on the infinite canvas at their left/top.
    style.position = 'absolute';
    style.left ??= '0px';
    style.top ??= '0px';
    delete style.right;
    delete style.bottom;
  } else if (parentKind === 'freeform') {
    style.position ??= 'absolute';
  }
  if (node.component === 'Text') {
    style.whiteSpace ??= 'pre-wrap';
    style.overflowWrap ??= 'break-word';
  }
  // The effect's canvas host fills the layer box (absolute, inset 0).
  if (isShaderComponent(node.component)) style.position ??= 'relative';
  if (!node.isVisible) style.display = 'none';
  return style;
}

export type RenderKind = 'element' | 'text' | 'svg' | 'shader' | 'lottie' | 'embed';

export interface RenderSpec {
  kind: RenderKind;
  tag: string;
  style: StyleMap;
  /** Text content (Text nodes). */
  text?: string;
  /** Rich text: inline spans inside the one text element (an empty style = the node's own). */
  runs?: Array<{ text: string; style: StyleMap }>;
  /** Raw SVG markup (SVG nodes), with the root <svg> tag included. */
  svg?: string;
  /** Shader layers: the @paper-design/shaders-react component name. */
  shader?: string;
  attrs: Record<string, string>;
}

/**
 * Style of the element that hosts a shader's canvas inside the layer. The layer element keeps its
 * own CSS (background = fill, borders, radius); the host fills its padding box.
 */
export const SHADER_HOST_STYLE = { position: 'absolute', inset: '0', borderRadius: 'inherit' } as const;

/** Script that mounts shader layers in static renders (served by the OpenPaper server). */
export const SHADER_RUNTIME_PATH = '/__op/shaders.js';

/** Script that draws Lottie layers in static renders. */
export const LOTTIE_RUNTIME_PATH = '/__op/lottie.js';

/** The frame inside an Embed layer fills it; the canvas, not the page, takes the pointer. */
export const EMBED_FRAME_STYLE = { display: 'block', width: '100%', height: '100%', border: '0', borderRadius: 'inherit', pointerEvents: 'none' } as const;

/** Render spec using a reader to find the parent. */
export function renderSpecIn(reader: DocReader, node: NodeRecord, ctx: RenderContext): RenderSpec {
  return renderSpec(node, parentKindOf(node.parentId ? reader.getNode(node.parentId) : undefined), ctx);
}

export function renderSpec(node: NodeRecord, parentKind: ParentKind, ctx: RenderContext): RenderSpec {
  const style = renderStyle(node, parentKind, ctx);
  const attrs: Record<string, string> = {};
  switch (node.component) {
    case 'Text': {
      const text = node.textValue ? node.textValue : EMPTY_TEXT;
      if (!node.textRuns?.length || !node.textValue) return { kind: 'text', tag: 'div', style, text, attrs };
      const runs = node.textRuns.map((r) => ({ text: r.text, style: { ...r.styles } }));
      return { kind: 'text', tag: 'div', style, text, runs, attrs };
    }
    case 'SVG':
      return { kind: 'svg', tag: 'svg', style, svg: node.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"></svg>', attrs };
    case 'Image': {
      if (node.src) attrs.src = ctx.resolveUrl(node.src);
      if (node.attrs?.alt) attrs.alt = node.attrs.alt;
      return { kind: 'element', tag: 'img', style, attrs };
    }
    case 'Video': {
      if (node.src) attrs.src = ctx.resolveUrl(node.src);
      return { kind: 'element', tag: 'video', style, attrs: { ...attrs, ...playbackAttrs(node) } };
    }
    case 'Lottie': {
      if (node.src) attrs.src = ctx.resolveUrl(node.src);
      return { kind: 'lottie', tag: 'div', style, attrs: { ...attrs, ...playbackAttrs(node) } };
    }
    case 'Embed': {
      // Pages are framed as they are; an embed's own HTML is served by EMBED_ROUTE (see embedFrameUrl).
      if (node.src && node.html === undefined) attrs.src = node.src;
      return { kind: 'embed', tag: 'div', style, attrs };
    }
    default: {
      const shader = shaderDef(node.component);
      if (shader) return { kind: 'shader', tag: 'div', style, attrs, shader: shader.name };
      return { kind: 'element', tag: 'div', style, attrs };
    }
  }
}

/** Video / Lottie playback: `loop` ("false" plays once) and `speed` (a rate, 1 = normal). */
export function playbackAttrs(node: NodeRecord): { loop: string; speed: string } {
  const speed = Number(node.attrs?.speed);
  return { loop: node.attrs?.loop === 'false' ? 'false' : 'true', speed: Number.isFinite(speed) && speed > 0 ? String(speed) : '1' };
}

/** Server route that serves an Embed layer's HTML into its sandboxed frame. */
export const EMBED_ROUTE = '/__op/embed/';

/** Short content hash, so a frame reloads when its HTML changes (FNV-1a). */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Frame URL of an Embed layer: its page, or its own HTML served by the OpenPaper server. */
export function embedFrameUrl(fileId: string, node: NodeRecord): string {
  if (node.html === undefined) return node.src ?? 'about:blank';
  return `${EMBED_ROUTE}${encodeURIComponent(fileId)}/${encodeURIComponent(node.id)}?v=${contentHash(node.html)}`;
}

/**
 * Sandbox of an Embed frame. Its own HTML runs with an opaque origin (scripts, nothing of the
 * editor's); another site keeps its origin, which is what lets players and widgets work.
 */
export function embedSandbox(frameUrl: string, editorOrigin: string): string {
  try {
    const url = new URL(frameUrl, editorOrigin);
    if (url.origin !== editorOrigin && /^https?:$/.test(url.protocol) && !/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url.hostname)) {
      return 'allow-scripts allow-same-origin allow-popups allow-forms';
    }
  } catch {
    // fall through
  }
  return 'allow-scripts';
}

/** CSS custom properties for the file's tokens (applied on the canvas root). */
export function tokensToCssVars(tokens: Array<{ name: string; value: string }>): StyleMap {
  const vars: StyleMap = {};
  for (const t of tokens) if (t.name.startsWith('--')) vars[t.name] = t.value;
  return vars;
}

/** Base stylesheet used by every renderer. */
export const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
[data-op-world]{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:normal;color:#000}
[data-op-world] img,[data-op-world] svg,[data-op-world] video{display:block}`;
