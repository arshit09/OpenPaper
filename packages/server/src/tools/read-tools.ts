import { readFile } from 'node:fs/promises';
import {
  basicInfo,
  childrenInfo,
  computedStyles,
  descendantsBfs,
  displayName,
  generateJsx,
  matchNode,
  nodeInfo,
  primaryImageUrl,
  readerOf,
  selectionInfo,
  subtreeOf,
  treeSummary,
  type MatchEntry,
  type NodeRecord,
} from '@openpaper/core';
import { assetUrlToPath } from '../media.ts';
import {
  activePageId,
  doc,
  editorUrl,
  layoutFor,
  nodeNotFoundLong,
  pageIdOfNodeIn,
  record,
  requireNode,
  resolvePageId,
  ToolError,
  type Call,
  type HandlerResult,
} from './context.ts';

function generatingCount(call: Call, ids: string[]): number {
  const d = doc(call);
  const seen = new Set<string>();
  for (const id of ids) {
    for (const n of subtreeOf(readerOf(d), id)) if (n.imageGeneration?.status === 'processing') seen.add(n.id);
  }
  return seen.size;
}

export async function getBasicInfo(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const pageId = resolvePageId(call, call.args.pageId);
  const layout = await layoutFor(call, pageId);
  return {
    data: basicInfo(readerOf(d), { pageId, activePageId: activePageId(call), layout, url: editorUrl(call, d.id, pageId) }),
  };
}

export async function getSelection(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const view = call.env.views.viewFor(d.id);
  const ids = (view?.selection ?? []).filter((id) => d.nodes[id]);
  const layout = await layoutFor(call, view?.pageId ?? null);
  record(call, ids, 'read');
  return { data: selectionInfo(readerOf(d), ids, layout) };
}

export async function getNodeInfo(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const node = requireNode(call, call.args.nodeId);
  const layout = await layoutFor(call, pageIdOfNodeIn(d, node));
  record(call, [node.id], 'read');
  return { data: nodeInfo(readerOf(d), node, layout) };
}

export async function getChildren(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const node = requireNode(call, call.args.nodeId, nodeNotFoundLong(call.args.nodeId, 'Use get_tree_summary or get_selection to discover valid node IDs.'));
  const layout = await layoutFor(call, pageIdOfNodeIn(d, node));
  record(call, [node.id], 'read');
  return { data: childrenInfo(readerOf(d), node, layout) };
}

export async function getTreeSummary(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const node = requireNode(
    call,
    call.args.nodeId,
    nodeNotFoundLong(call.args.nodeId, 'Use get_selection to find selected nodes, or get_children on an artboard to explore the hierarchy.')
  );
  const layout = await layoutFor(call, pageIdOfNodeIn(d, node));
  record(call, [node.id], 'read');
  return { data: treeSummary(readerOf(d), node, call.args.depth, layout) };
}

export async function getScreenshot(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const id: string = call.args.nodeId;
  const node = d.nodes[id];
  if (!node) return { content: [{ type: 'text', text: nodeNotFoundLong(id) }], isError: true };
  if (node.component === 'PageRoot') {
    return {
      content: [
        {
          type: 'text',
          text: 'Cannot screenshot a page root node. Screenshot an artboard instead; use get_basic_info to list the artboards on the page.',
        },
      ],
      isError: true,
    };
  }
  const scale = typeof call.args.scale === 'number' && call.args.scale >= 2 ? 2 : 1;
  const animationTime = typeof call.args.animationTime === 'number' && call.args.animationTime >= 0 ? call.args.animationTime : null;
  const generating = generatingCount(call, [id]);
  try {
    const shot = await call.env.render.screenshot(d, id, scale, animationTime);
    record(call, [id], 'read');
    const content: NonNullable<Extract<HandlerResult, { content: unknown }>['content']> = [
      { type: 'image', data: shot.data, mimeType: shot.mimeType },
    ];
    if (shot.resized) content.push({ type: 'text', text: `Note: Image was resized to ${shot.width}x${shot.height}px to fit size limits.` });
    if (generating) {
      content.push({
        type: 'text',
        text: `Note: ${generating} image(s) are still generating; the capture may show placeholders. Poll get_node_info and retry once they are ready.`,
      });
    }
    return { content };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Failed to capture screenshot of node "${id}": ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function getJsx(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const id: string = call.args.nodeId;
  if (!d.nodes[id]) throw new ToolError(`Node not found: ${id}`);
  const format = call.args.format ?? 'tailwind';
  try {
    const jsx = await generateJsx(readerOf(d), id, {
      format,
      includeNodeIds: call.args.includeNodeIds ?? true,
      includeRootPositioning: call.args.includeRootPositioning ?? false,
      canonicalize: format === 'tailwind' ? await call.env.tailwind.canonicalizerFor(d.tokens) : undefined,
    });
    record(call, [id], 'read');
    return { data: jsx };
  } catch (error) {
    throw new ToolError(`JSX generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function getComputedStyles(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const reader = readerOf(d);
  const styles: Record<string, Record<string, string> | null> = {};
  const found: string[] = [];
  for (const id of call.args.nodeIds as string[]) {
    const node = d.nodes[id];
    styles[id] = node ? computedStyles(reader, node) : null;
    if (node) found.push(id);
  }
  record(call, found, 'read');
  return { data: { styles } };
}

async function loadImageBytes(call: Call, url: string): Promise<{ bytes: Buffer; mimeType: string; originalUrl: string }> {
  const base = call.env.baseUrl();
  if (url.startsWith('/media/')) {
    const path = call.env.media.pathFor(url);
    if (!path) throw new Error('missing');
    const bytes = await readFile(path);
    return { bytes, mimeType: mimeOf(bytes), originalUrl: `${base}${url}` };
  }
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new Error('bad data uri');
    const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
    return { bytes, mimeType: m[1]!, originalUrl: url.slice(0, 64) + '…' };
  }
  if (url.startsWith('paper-asset://')) {
    const path = assetUrlToPath(url);
    if (!path) throw new Error('bad path');
    const bytes = await readFile(path);
    return { bytes, mimeType: mimeOf(bytes), originalUrl: url };
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mimeType: res.headers.get('content-type')?.split(';')[0] ?? mimeOf(bytes), originalUrl: url };
}

function mimeOf(bytes: Buffer): string {
  if (bytes[0] === 0x89) return 'image/png';
  if (bytes[0] === 0xff) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('utf8', 0, 256).includes('<svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

export async function getFillImage(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const id: string = call.args.nodeId;
  const node = d.nodes[id];
  if (!node) return { content: [{ type: 'text', text: nodeNotFoundLong(id) }], isError: true };
  if (node.imageGeneration?.status === 'processing') {
    return { content: [{ type: 'text', text: `Node "${id}" is still generating an image. Poll get_node_info to know when it completes.` }] };
  }
  if (node.component === 'SVG') {
    return { content: [{ type: 'text', text: `Node "${id}" is an SVG, not an image fill. Use get_jsx to read the drawing.` }] };
  }
  const url = primaryImageUrl(node);
  if (!url || node.styles.backgroundImage === 'none') {
    return { content: [{ type: 'text', text: `Node "${id}" exists but does not have an image fill.` }] };
  }
  try {
    const { bytes, mimeType, originalUrl } = await loadImageBytes(call, url);
    const encoded = await call.env.render.encodeForModel(bytes, mimeType);
    record(call, [id], 'read');
    const meta: Record<string, unknown> = { originalUrl, mimeType: encoded.mimeType, width: encoded.width, height: encoded.height };
    if (url.startsWith('/media/')) meta.localPath = call.env.media.pathFor(url);
    if (encoded.resized) meta.note = 'Image was resized to fit size limits.';
    return {
      content: [
        { type: 'image', data: encoded.data, mimeType: encoded.mimeType },
        { type: 'text', text: JSON.stringify(meta) },
      ],
    };
  } catch {
    return { content: [{ type: 'text', text: `Failed to fetch image from node "${id}". The image URL may be expired or inaccessible.` }], isError: true };
  }
}

export async function findNodes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const reader = readerOf(d);
  const { nodeId, pageId, textValue } = call.args as { nodeId?: string; pageId?: string; textValue?: string };
  const filters = (call.args.filters ?? []) as Array<{ styleName?: string; styleValue?: string }>;
  let scope: NodeRecord[] = [];
  if (nodeId) {
    const node = d.nodes[nodeId];
    if (!node) throw new ToolError(`Node not found: "${nodeId}". Use get_tree_summary or get_children to discover valid node IDs.`);
    scope = [node, ...descendantsBfs(reader, node)];
  } else if (pageId) {
    const id = resolvePageId(call, pageId);
    scope = descendantsBfs(reader, d.nodes[d.pages[id]!.rootId]!);
  } else {
    for (const item of d.pageList) {
      if (item.type !== 'page') continue;
      const page = d.pages[item.id];
      const root = page ? d.nodes[page.rootId] : undefined;
      if (root) scope.push(...descendantsBfs(reader, root));
    }
  }
  const hits: Array<{ id: string; name: string; component: string; matched: MatchEntry[] }> = [];
  let truncated = false;
  for (const node of scope) {
    if (node.component === 'PageRoot') continue;
    const matched = matchNode(node, computedStyles(reader, node), filters, textValue, d.tokens);
    if (!matched) continue;
    if (hits.length >= 200) {
      truncated = true;
      break;
    }
    hits.push({ id: node.id, name: displayName(node), component: node.component, matched });
  }
  record(
    call,
    hits.map((h) => h.id),
    'read'
  );
  const out: Record<string, unknown> = { nodes: hits, count: hits.length };
  if (truncated) {
    out.truncated = true;
    out.truncatedMessage = 'Stopped at the first 200 matches; narrow your filters to see more.';
  }
  return { data: out };
}

export async function getFontFamilyInfo(call: Call): Promise<HandlerResult> {
  return { data: await call.env.fonts.familyInfo(call.args.familyNames as string[]) };
}
