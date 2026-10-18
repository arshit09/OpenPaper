import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { LayoutMap, NodeRecord, PaperDocument } from '@openpaper/core';
import type { AssetResolver } from '../assets.ts';
import type { FontService } from '../fonts/fonts.ts';
import type { ActorRef, DocumentHub, LiveDocument } from '../hub.ts';
import type { McpSession } from '../mcp/http.ts';
import type { MediaStore } from '../media.ts';
import type { OpenPaperPaths } from '../paths.ts';
import type { ActivityKind, PresenceService } from '../presence.ts';
import type { RenderService } from '../render/service.ts';
import type { FileStore } from '../storage.ts';
import type { ViewRegistry } from '../views.ts';
import type { ImageGenService } from '../images.ts';
import type { TailwindService } from '../tailwind.ts';
import type { ToolDefinition } from './definitions.ts';

/** Services available to tool handlers. */
export interface ToolEnv {
  hub: DocumentHub;
  store: FileStore;
  views: ViewRegistry;
  presence: PresenceService;
  render: RenderService;
  fonts: FontService;
  assets: AssetResolver;
  media: MediaStore;
  tailwind: TailwindService;
  images: ImageGenService;
  paths: OpenPaperPaths;
  baseUrl(): string;
  /** Tell editors an agent opened a file (they may offer to show it). */
  agentOpenedFile(fileId: string, pageId: string | null, agentName: string): void;
  resourcesChanged(): void;
}

/** User-facing failure: becomes an `isError` text result (with the file header). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export type HandlerResult = { data: unknown } | { error: string } | { content: CallToolResult['content']; isError?: boolean };

export interface Call {
  env: ToolEnv;
  session: McpSession;
  actor: ActorRef;
  def: ToolDefinition;
  /** Validated arguments. */
  args: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Present for file-scoped tools. */
  live: LiveDocument | null;
}

export function doc(call: Call): PaperDocument {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  return call.live.doc;
}

/** The page the user is viewing in this file (falls back to the first page). */
export function activePageId(call: Call): string {
  const d = doc(call);
  const viewed = call.env.views.viewFor(d.id)?.pageId;
  if (viewed && d.pages[viewed]) return viewed;
  const first = d.pageList.find((p) => p.type === 'page' && d.pages[p.id]);
  if (!first) throw new ToolError('This file has no pages.');
  return first.id;
}

/** Resolve an explicit or default page id, with Paper's error messages. */
export function resolvePageId(call: Call, pageId: string | undefined): string {
  const d = doc(call);
  const id = pageId ?? activePageId(call);
  const item = d.pageList.find((p) => p.id === id);
  if (item?.type === 'divider') {
    throw new ToolError(`"${id}" is a divider in the page list, which has no canvas. Use a page ID from get_basic_info.`);
  }
  const page = d.pages[id];
  if (!page) throw new ToolError(`Page not found: "${id}". Use get_basic_info to list the pages in the currently open file.`);
  if (!d.nodes[page.rootId]) throw new ToolError(`Page root not found: "${id}".`);
  return id;
}

export function pageIdOfNodeIn(d: PaperDocument, node: NodeRecord): string | null {
  let n: NodeRecord | undefined = node;
  while (n && n.component !== 'PageRoot') n = n.parentId ? d.nodes[n.parentId] : undefined;
  if (!n) return null;
  return Object.values(d.pages).find((p) => p.rootId === n!.id)?.id ?? null;
}

/** Measured layout for a page (null when nothing can render it). */
export async function layoutFor(call: Call, pageId: string | null): Promise<LayoutMap | null> {
  if (!pageId || !call.live) return null;
  try {
    return await call.env.render.measurePage(call.live.doc, call.live.version, pageId);
  } catch {
    return null;
  }
}

export function record(call: Call, nodeIds: string[], kind: ActivityKind) {
  if (!call.live) return;
  call.env.presence.record(call.session, call.live.id, nodeIds, kind, call.def.name);
}

export function nodeNotFoundLong(id: string, hint = 'Use get_tree_summary or get_children to discover valid node IDs.'): string {
  return `Node not found: "${id}". The node may have been deleted, the ID is incorrect, or it exists in a different file. ${hint}`;
}

export function requireNode(call: Call, id: string, message = nodeNotFoundLong(id)): NodeRecord {
  const node = doc(call).nodes[id];
  if (!node) throw new ToolError(message);
  return node;
}

export function editorUrl(call: Call, fileId: string, pageId?: string | null): string {
  return `${call.env.baseUrl()}/#/file/${fileId}${pageId ? `/${pageId}` : ''}`;
}
