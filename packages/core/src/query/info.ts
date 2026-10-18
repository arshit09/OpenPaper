import { displayName, primaryImageUrl } from '../model/labels.ts';
import type { DocReader } from '../model/transaction.ts';
import { artboardOf, isArtboard } from '../model/tree.ts';
import type { LayoutMap, MeasuredBox, NodeRecord, PageListItem } from '../model/types.ts';
import { FREEFORM_DISPLAY, isFreeform } from '../render/render-spec.ts';
import { pxValue } from '../styles/css.ts';
import { filterTokens, tokenCssName } from '../tokens/tokens.ts';

/** Caps used by read tools (Paper-compatible). */
export const LIMITS = {
  artboards: 100,
  selection: 100,
  children: 100,
  treeNodes: 1000,
  findNodes: 200,
  resources: 50,
  resourcesMax: 200,
  commentThreads: 50,
} as const;

export interface Position {
  worldX: number | null;
  worldY: number | null;
  x: number | null;
  y: number | null;
}

/** Non-deleted children of a node in layer order. */
export function childrenOf(reader: DocReader, node: NodeRecord): NodeRecord[] {
  return node.children.map((id) => reader.getNode(id)).filter((n): n is NodeRecord => !!n);
}

/** Breadth-first list of all descendants. */
export function descendantsBfs(reader: DocReader, node: NodeRecord): NodeRecord[] {
  const out: NodeRecord[] = [];
  const queue = [...childrenOf(reader, node)];
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    queue.push(...childrenOf(reader, n));
  }
  return out;
}

const TRANSFORM_KEYS = ['transform', 'translate', 'rotate', 'scale'];

/** left/top in px when the node is start-anchored on both axes inside a freeform parent. */
function explicitOffset(reader: DocReader, node: NodeRecord): { x: number; y: number } | null {
  const parent = node.parentId ? reader.getNode(node.parentId) : undefined;
  if (!parent || !isFreeform(parent)) {
    if (!(node.styles.position === 'absolute' && parent)) return null;
  }
  if (TRANSFORM_KEYS.some((k) => node.styles[k] && node.styles[k] !== 'none')) return null;
  const isTop = parent?.component === 'PageRoot';
  const left = pxValue(node.styles.left ?? (isTop ? '0px' : undefined));
  const top = pxValue(node.styles.top ?? (isTop ? '0px' : undefined));
  if (left === null || top === null) return null;
  return { x: left, y: top };
}

/** Border widths of a freeform parent are not modeled; padding-box origin ≈ border-box origin. */
function worldOrigin(reader: DocReader, node: NodeRecord, layout: LayoutMap | null): { x: number; y: number } | null {
  if (node.component === 'PageRoot') return { x: 0, y: 0 };
  const measured = layout?.[node.id];
  if (measured) return { x: measured.worldX, y: measured.worldY };
  const own = explicitOffset(reader, node);
  if (!own) return null;
  const parent = node.parentId ? reader.getNode(node.parentId) : undefined;
  if (!parent) return null;
  const base = worldOrigin(reader, parent, layout);
  return base ? { x: base.x + own.x, y: base.y + own.y } : null;
}

export function positionOf(reader: DocReader, node: NodeRecord, layout: LayoutMap | null): Position {
  const measured: MeasuredBox | undefined = layout?.[node.id];
  const own = explicitOffset(reader, node);
  if (measured) {
    return {
      worldX: measured.worldX,
      worldY: measured.worldY,
      x: own ? own.x : measured.x,
      y: own ? own.y : measured.y,
    };
  }
  if (!own) return { worldX: null, worldY: null, x: null, y: null };
  const world = worldOrigin(reader, node, layout);
  return { worldX: world?.x ?? null, worldY: world?.y ?? null, x: own.x, y: own.y };
}

export function sizeOf(node: NodeRecord, layout: LayoutMap | null): { width: number | null; height: number | null } {
  const m = layout?.[node.id];
  const width = m ? m.width : pxValue(node.styles.width) ?? 0;
  const height = m ? m.height : pxValue(node.styles.height) ?? 0;
  return { width: width || null, height: height || null };
}

/** The artboard containing a node, null for artboards themselves and page-level items. */
export function artboardFrameOf(reader: DocReader, node: NodeRecord): NodeRecord | null {
  const parent = node.parentId ? reader.getNode(node.parentId) : undefined;
  if (!parent || parent.component === 'PageRoot') return null;
  return artboardOf(reader, node.id);
}

export function isNodeLocked(reader: DocReader, node: NodeRecord): boolean {
  let n: NodeRecord | undefined = node;
  while (n) {
    if (n.isLocked) return true;
    n = n.parentId ? reader.getNode(n.parentId) : undefined;
  }
  return false;
}

export function fontFamiliesUsed(reader: DocReader): string[] {
  const seen = new Set<string>();
  for (const node of reader.allNodes()) {
    const ff = node.styles.fontFamily;
    if (!ff) continue;
    const first = ff.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    if (first && !first.startsWith('var(')) seen.add(first);
  }
  return [...seen];
}

export function describePageList(reader: DocReader, activePageId: string | null) {
  return reader.getPageList().map((item: PageListItem) => {
    if (item.type === 'divider') return { type: 'divider' as const, id: item.id };
    const page = reader.getPage(item.id);
    return { type: 'page' as const, id: item.id, name: page?.name ?? '', icon: page?.icon ?? null, isActive: item.id === activePageId };
  });
}

export interface BasicInfoOptions {
  pageId: string;
  activePageId: string | null;
  layout: LayoutMap | null;
  url: string;
}

export function basicInfo(reader: DocReader, opts: BasicInfoOptions) {
  const page = reader.getPage(opts.pageId)!;
  const root = reader.getNode(page.rootId)!;
  const artboards = childrenOf(reader, root).filter((n) => isArtboard(reader, n));
  const shown = artboards.slice(0, LIMITS.artboards);
  const out: Record<string, unknown> = {
    fileName: reader.fileName,
    pageName: page.name,
    pageId: page.id,
    url: opts.url,
    rootNodeId: root.id,
    nodeCount: descendantsBfs(reader, root).length + 1,
    artboardCount: artboards.length,
    artboards: shown.map((n) => {
      const size = sizeOf(n, opts.layout);
      const pos = positionOf(reader, n, opts.layout);
      return {
        id: n.id,
        name: displayName(n),
        childCount: n.children.length,
        width: size.width,
        height: size.height,
        worldX: pos.worldX,
        worldY: pos.worldY,
      };
    }),
  };
  if (artboards.length > LIMITS.artboards) {
    out.truncated = true;
    out.truncatedMessage = `Showing first ${LIMITS.artboards} of ${artboards.length} artboards`;
  }
  out.pages = describePageList(reader, opts.activePageId);
  out.fontFamilies = fontFamiliesUsed(reader);
  out.tokens = { items: filterTokens(reader.getTokens()).map((t) => ({ name: tokenCssName(t), value: t.value })) };
  return out;
}

export function selectionInfo(reader: DocReader, ids: string[], layout: LayoutMap | null) {
  const nodes = ids.map((id) => reader.getNode(id)).filter((n): n is NodeRecord => !!n);
  const shown = nodes.slice(0, LIMITS.selection);
  const out: Record<string, unknown> = {
    selectedNodes: shown.map((n) => {
      const size = sizeOf(n, layout);
      const pos = positionOf(reader, n, layout);
      const board = artboardFrameOf(reader, n);
      return {
        id: n.id,
        name: displayName(n),
        component: n.component,
        width: size.width,
        height: size.height,
        worldX: pos.worldX,
        worldY: pos.worldY,
        x: pos.x,
        y: pos.y,
        artboardId: board?.id ?? null,
        artboardName: board ? displayName(board) : null,
        parentId: n.parentId,
        childCount: n.children.length,
      };
    }),
    count: nodes.length,
  };
  if (nodes.length > LIMITS.selection) {
    out.truncated = true;
    out.truncatedMessage = `Showing first ${LIMITS.selection} of ${nodes.length} selected nodes`;
  }
  return out;
}

export function nodeInfo(reader: DocReader, node: NodeRecord, layout: LayoutMap | null) {
  const size = sizeOf(node, layout);
  const pos = positionOf(reader, node, layout);
  const board = artboardFrameOf(reader, node);
  const childIds = node.children.filter((id) => reader.getNode(id));
  const out: Record<string, unknown> = {
    id: node.id,
    name: displayName(node),
    component: node.component,
    width: size.width,
    height: size.height,
    worldX: pos.worldX,
    worldY: pos.worldY,
    x: pos.x,
    y: pos.y,
    isVisible: node.isVisible,
    isLocked: isNodeLocked(reader, node),
    parentId: node.parentId,
    childIds: childIds.slice(0, LIMITS.children),
    childCount: childIds.length,
    artboardId: board?.id ?? null,
    textContent: node.component === 'Text' ? (node.textValue ?? '') : null,
  };
  if (childIds.length > LIMITS.children) {
    out.truncated = true;
    out.truncatedMessage = `Showing first ${LIMITS.children} of ${childIds.length} child IDs`;
  }
  if (node.imageGeneration) out.imageGeneration = { status: node.imageGeneration.status, output: node.imageGeneration.output };
  return out;
}

export function childrenInfo(reader: DocReader, node: NodeRecord, layout: LayoutMap | null) {
  const kids = childrenOf(reader, node);
  const out: Record<string, unknown> = {
    children: kids.slice(0, LIMITS.children).map((c) => {
      const pos = positionOf(reader, c, layout);
      return { id: c.id, name: displayName(c), component: c.component, childCount: c.children.length, ...pos };
    }),
    count: kids.length,
  };
  if (kids.length > LIMITS.children) {
    out.truncated = true;
    out.truncatedMessage = `Showing first ${LIMITS.children} of ${kids.length} children`;
  }
  return out;
}

/**
 * Indented text summary of a subtree:
 *   `«indent»«component» "«name»" («id») «W»×«H»[ "«text»"][ [hidden]]`
 */
export function treeSummary(reader: DocReader, root: NodeRecord, depthInput: number | undefined, layout: LayoutMap | null) {
  const depth = Math.min(10, Math.max(1, depthInput ?? 3));
  const lines: string[] = [];
  let visited = 0;
  let truncated = false;
  const fmt = (n: number | null) => (n ? String(Math.round(n)) : '?');
  const visit = (node: NodeRecord, level: number) => {
    if (truncated) return;
    visited++;
    if (visited > LIMITS.treeNodes) {
      truncated = true;
      return;
    }
    const indent = '  '.repeat(level);
    const size = sizeOf(node, layout);
    const text = node.component === 'Text' && node.textValue ? ` "${node.textValue.slice(0, 60)}"` : '';
    const hidden = node.isVisible ? '' : ' [hidden]';
    lines.push(`${indent}${node.component} "${displayName(node)}" (${node.id}) ${fmt(size.width)}×${fmt(size.height)}${text}${hidden}`);
    const kids = childrenOf(reader, node);
    if (!kids.length) return;
    if (level >= depth) {
      lines.push(`${indent}  ... ${kids.length} children`);
      return;
    }
    for (const kid of kids) visit(kid, level + 1);
  };
  visit(root, 0);
  const out: Record<string, unknown> = { summary: lines.join('\n'), nodeId: root.id, depth };
  if (truncated) {
    out.truncated = true;
    out.truncatedMessage = `Output truncated at ${LIMITS.treeNodes} nodes`;
  }
  return out;
}

/**
 * Model-derived CSS for a node (what code export should use): stored styles with
 * OpenPaper's freeform sentinel resolved to real CSS.
 */
export function computedStyles(reader: DocReader, node: NodeRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.styles)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  if (out.display === FREEFORM_DISPLAY) {
    delete out.display;
    out.position ??= 'relative';
  }
  const parent = node.parentId ? reader.getNode(node.parentId) : undefined;
  if (parent && parent.component !== 'PageRoot' && isFreeform(parent)) out.position ??= 'absolute';
  if (!node.isVisible) out.display = 'none';
  return out;
}

export function hasImageFill(node: NodeRecord): boolean {
  return primaryImageUrl(node) !== null;
}
