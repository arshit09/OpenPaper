import type { DocReader } from './transaction.ts';
import type { NodeRecord } from './types.ts';

const ROOT_PREFIX = 'root_node_';

/** Page id for a PageRoot node id (`root_node_<pageId>`). */
export function pageIdFromRootId(rootId: string): string | null {
  return rootId.startsWith(ROOT_PREFIX) ? rootId.slice(ROOT_PREFIX.length) : null;
}

/** Walk up from a node to its PageRoot and return the page id, or null. */
export function pageIdOfNode(reader: DocReader, nodeId: string): string | null {
  const root = pageRootOfNode(reader, nodeId);
  return root ? pageIdFromRootId(root.id) : null;
}

/** The PageRoot ancestor (or the node itself when it is a PageRoot). */
export function pageRootOfNode(reader: DocReader, nodeId: string): NodeRecord | null {
  let node = reader.getNode(nodeId);
  let guard = 0;
  while (node && guard++ < 10_000) {
    if (node.component === 'PageRoot') return node;
    if (!node.parentId) return null;
    node = reader.getNode(node.parentId);
  }
  return null;
}

/** True when the node is a top-level frame on a page (an artboard). */
export function isArtboard(reader: DocReader, node: NodeRecord | undefined): boolean {
  if (!node || !node.parentId || node.component === 'PageRoot') return false;
  return reader.getNode(node.parentId)?.component === 'PageRoot';
}

/** The artboard containing the node (the node itself when it is an artboard). */
export function artboardOf(reader: DocReader, nodeId: string): NodeRecord | null {
  let node = reader.getNode(nodeId);
  let guard = 0;
  while (node && guard++ < 10_000) {
    if (node.component === 'PageRoot') return null;
    if (isArtboard(reader, node)) return node;
    node = node.parentId ? reader.getNode(node.parentId) : undefined;
  }
  return null;
}

/** Ancestors from parent up to (and including) the PageRoot. */
export function ancestorsOf(reader: DocReader, nodeId: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  let node = reader.getNode(nodeId);
  let guard = 0;
  while (node?.parentId && guard++ < 10_000) {
    const parent = reader.getNode(node.parentId);
    if (!parent) break;
    out.push(parent);
    node = parent;
  }
  return out;
}

/** True if `ancestorId` is a strict ancestor of `nodeId`. */
export function isAncestorOf(reader: DocReader, ancestorId: string, nodeId: string): boolean {
  return ancestorsOf(reader, nodeId).some((n) => n.id === ancestorId);
}

/** Pre-order list of the subtree rooted at `rootId` (root included). */
export function subtreeOf(reader: DocReader, rootId: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  const stack: string[] = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = reader.getNode(id);
    if (!node) continue;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

/** Count of nodes in a subtree, root excluded. */
export function descendantCount(reader: DocReader, rootId: string): number {
  return Math.max(0, subtreeOf(reader, rootId).length - 1);
}

/** Depth-limited walk with the depth of each node (root = 0). */
export function walkWithDepth(
  reader: DocReader,
  rootId: string,
  visit: (node: NodeRecord, depth: number) => boolean | void
): void {
  const recurse = (id: string, depth: number) => {
    const node = reader.getNode(id);
    if (!node) return;
    if (visit(node, depth) === false) return;
    for (const child of node.children) recurse(child, depth + 1);
  };
  recurse(rootId, 0);
}

/** Text of a node's subtree, concatenated (used for reference prompts and search). */
export function subtreeText(reader: DocReader, rootId: string): string {
  return subtreeOf(reader, rootId)
    .filter((n) => n.component === 'Text' && n.textValue)
    .map((n) => n.textValue)
    .join(' ');
}
