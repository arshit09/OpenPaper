import type { StyleMap } from '../styles/css.ts';
import { SHADER_COMPONENTS, type ShaderComponent, type ShaderProps } from '../shaders/registry.ts';

/**
 * Node "component" types. These names are visible to agents through the MCP
 * tools (get_node_info, get_tree_summary, ...), so they follow Paper's naming.
 */
export type ComponentType = 'PageRoot' | 'Frame' | 'Text' | 'Rectangle' | 'SVG' | 'Image' | 'Video' | 'Lottie' | 'Embed' | ShaderComponent;

export const COMPONENT_TYPES: readonly ComponentType[] = ['PageRoot', 'Frame', 'Text', 'Rectangle', 'SVG', 'Image', 'Video', 'Lottie', 'Embed', ...SHADER_COMPONENTS];

/** Status of an AI image generation attached to a node (paper-gen:// URLs). */
export interface ImageGenerationState {
  status: 'processing' | 'ready' | 'error';
  output: 'raster' | 'svg';
  url: string;
  error?: string;
}

/** Part of a Text node's text with its own inline style. */
export interface TextRun {
  text: string;
  /** Overrides of the node's styles (TEXT_RUN_PROPS only). Absent = the node's own style. */
  styles?: StyleMap;
}

export interface NodeRecord {
  id: string;
  component: ComponentType;
  /** Layer name shown in the layer tree. */
  label: string;
  /** True once the user/agent named the layer explicitly (layer-name, rename). */
  labelIsModified?: boolean;
  /** Parent node id; null only for page roots. */
  parentId: string | null;
  /** Ordered child ids (Frame / PageRoot). Leaf components keep an empty array. */
  children: string[];
  /** camelCase CSS properties → string values. */
  styles: StyleMap;
  /** Text content for Text nodes. Newlines are preserved. */
  textValue?: string;
  /** Mixed styles inside one Text node (OpenPaper extension). Run texts join to exactly `textValue`. Absent = one style. */
  textRuns?: TextRun[];
  /** Image / Video / Lottie source URL (https:, data:, asset:, paper-asset:, paper-gen:); a web page for Embed layers. */
  src?: string;
  /** Raw SVG markup (the full <svg> element) for SVG nodes. */
  svg?: string;
  /** Embed layers: an HTML document (scripts allowed) that runs in a sandboxed frame. */
  html?: string;
  /** Extra HTML attributes kept for round-tripping (alt, href, ...); media playback (`loop`, `speed`). */
  attrs?: Record<string, string>;
  isVisible: boolean;
  isLocked: boolean;
  /** Set when a paper-gen:// image is being generated into this node. */
  imageGeneration?: ImageGenerationState;
  /** Shader layers: effect parameters by library name (colours as CSS colours, `frame` in ms). */
  props?: ShaderProps;
}

export interface PageRecord {
  id: string;
  name: string;
  /** Decorative icon name shown in the page list, or null for the default. */
  icon: string | null;
  /** Id of the PageRoot node (`root_node_<pageId>`) that holds this page's artboards. */
  rootId: string;
  /** Canvas background color for this page. */
  canvasColor?: string;
}

export type PageListItem = { type: 'page'; id: string } | { type: 'divider'; id: string };

/** Design token types (Paper's set). */
export type TokenType =
  | 'color'
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'letterSpacing'
  | 'lineHeight'
  | 'opacity'
  | 'breakpoint'
  | 'container'
  | 'spacing'
  | 'radius';

export const TOKEN_TYPES: readonly TokenType[] = [
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'opacity',
  'breakpoint',
  'container',
  'spacing',
  'radius',
];

export interface TokenRecord {
  id: string;
  type: TokenType;
  /** Token name; the CSS custom property is `--` + slug(name) (so `--color-primary` stays as is). */
  name: string;
  /** CSS value, or `var(--other-token)` for aliases. */
  value: string;
  description?: string;
}

/** A CSS `@keyframes` rule shared by the whole file (layers use it through their `animation` styles). */
export interface KeyframesRecord {
  name: string;
  /** The rule's body, normalized: `from{opacity: 0;}to{opacity: 1;}`. */
  css: string;
}

export interface CommentUser {
  userId: string;
  displayName: string | null;
}

export interface CommentMessage {
  id: string;
  userId: string;
  text: string;
  mentions: string[];
  reactions: Array<{ userId: string; emoji: string }>;
  attachments: Array<{ url: string; type: 'image' | 'video' | 'file'; name?: string }>;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface CommentThread {
  id: string;
  pageId: string;
  /** Node the thread is pinned to (a page root id for free canvas pins). */
  nodeId: string;
  /** Pin offset, node-local (world offset for page-root pins). */
  xOffset: number;
  yOffset: number;
  status: 'open' | 'resolved';
  /** Thread author. */
  userId: string;
  messages: CommentMessage[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface PaperDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  pageList: PageListItem[];
  pages: Record<string, PageRecord>;
  nodes: Record<string, NodeRecord>;
  tokens: TokenRecord[];
  /** `@keyframes` rules (absent in files written before animations were kept). */
  keyframes?: KeyframesRecord[];
  comments: Record<string, CommentThread>;
  /** People who wrote comments in this file (display names for comment tools). */
  users?: Record<string, CommentUser>;
  /** Monotonic counters used to mint short, readable ids. */
  counters: DocCounters;
}

export interface DocCounters {
  nodes: number;
  pages: number;
  tokens?: number;
}

/** Axis-aligned box in canvas ("world") coordinates, as measured by a renderer. */
export interface MeasuredBox {
  /** Position relative to the canvas origin. */
  worldX: number;
  worldY: number;
  /** Position relative to the parent's border box. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutMap = Record<string, MeasuredBox>;
