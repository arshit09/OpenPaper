import { normalizeStyleValue, type StyleMap } from '../styles/css.ts';
import { isAncestorOf, subtreeOf } from './tree.ts';
import type { Transaction } from './transaction.ts';
import { shaderDef } from '../shaders/registry.ts';
import { applyShaderPropsPatch } from '../shaders/props.ts';
import type { ShaderProps } from '../shaders/registry.ts';
import { applyTextRuns, cloneRuns } from './text-runs.ts';
import type { ComponentType, NodeRecord, TextRun } from './types.ts';

/** Thrown for user-facing validation failures (become MCP error results). */
export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export const CONTAINER_COMPONENTS: ReadonlySet<ComponentType> = new Set(['PageRoot', 'Frame']);

export function canHaveChildren(node: NodeRecord | undefined): boolean {
  return !!node && CONTAINER_COMPONENTS.has(node.component);
}

/** Input shape for creating nodes (nested). */
export interface NewNode {
  component: Exclude<ComponentType, 'PageRoot'>;
  label?: string;
  styles?: StyleMap;
  textValue?: string;
  src?: string;
  svg?: string;
  /** Embed layers: the HTML document to run. */
  html?: string;
  attrs?: Record<string, string>;
  props?: ShaderProps;
  isVisible?: boolean;
  isLocked?: boolean;
  children?: NewNode[];
}

export function defaultLabel(n: Pick<NewNode, 'component' | 'textValue'>): string {
  switch (n.component) {
    case 'Text': {
      const t = (n.textValue ?? '').replace(/\s+/g, ' ').trim();
      return t ? t.slice(0, 50) : 'Text';
    }
    case 'Image':
      return 'Image';
    case 'SVG':
      return 'SVG';
    case 'Video':
      return 'Video';
    case 'Lottie':
      return 'Lottie';
    case 'Embed':
      return 'Embed';
    default:
      return shaderDef(n.component)?.label ?? 'Frame';
  }
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || index < 0 || index > length) return length;
  return Math.floor(index);
}

/** Create a (nested) subtree under `parentId` at `index` (append when omitted). Returns the root. */
export function createSubtree(tx: Transaction, parentId: string, input: NewNode, index?: number): NodeRecord {
  const parent = tx.getNode(parentId);
  if (!parent) throw new OpError(`Node not found: "${parentId}"`);
  if (!canHaveChildren(parent)) {
    throw new OpError(`Node "${parentId}" is a ${parent.component} and cannot have children.`);
  }
  const root = buildRecords(tx, input, parentId);
  tx.updateNode(parentId, (p) => {
    p.children.splice(clampIndex(index, p.children.length), 0, root.id);
  });
  return root;
}

function buildRecords(tx: Transaction, input: NewNode, parentId: string): NodeRecord {
  const id = tx.nextNodeId();
  const record: NodeRecord = {
    id,
    component: input.component,
    label: (input.label?.trim() || defaultLabel(input)).slice(0, 500),
    parentId,
    children: [],
    styles: { ...(input.styles ?? {}) },
    isVisible: input.isVisible ?? true,
    isLocked: input.isLocked ?? false,
  };
  if (input.textValue !== undefined) record.textValue = input.textValue;
  if (input.src !== undefined) record.src = input.src;
  if (input.svg !== undefined) record.svg = input.svg;
  if (input.html !== undefined) record.html = input.html;
  if (input.attrs && Object.keys(input.attrs).length) record.attrs = { ...input.attrs };
  const shader = shaderDef(input.component);
  if (shader) {
    try {
      record.props = applyShaderPropsPatch(shader, {}, input.props ?? {});
    } catch (error) {
      throw new OpError(error instanceof Error ? error.message : String(error));
    }
  }
  tx.putNode(record);
  if (input.children?.length) {
    if (!CONTAINER_COMPONENTS.has(input.component)) {
      throw new OpError(`A ${input.component} node cannot have children.`);
    }
    for (const child of input.children) {
      const c = buildRecords(tx, child, id);
      record.children.push(c.id);
    }
    tx.putNode(record);
  }
  return record;
}

/** Remove a node and all its descendants. Returns removed ids (root first). */
export function deleteSubtree(tx: Transaction, id: string): string[] {
  const node = tx.getNode(id);
  if (!node) throw new OpError(`Node not found: "${id}"`);
  if (node.component === 'PageRoot') throw new OpError('Page roots cannot be deleted.');
  const removed = subtreeOf(tx, id).map((n) => n.id);
  if (node.parentId) {
    tx.updateNode(node.parentId, (p) => {
      p.children = p.children.filter((c) => c !== id);
    });
  }
  for (const rid of removed) tx.removeNodeRecord(rid);
  return removed;
}

/** Move a node to a new parent/index, preserving its id. */
export function moveNode(tx: Transaction, id: string, newParentId: string, index?: number): void {
  const node = tx.getNode(id);
  if (!node) throw new OpError(`Node not found: "${id}"`);
  if (node.component === 'PageRoot') throw new OpError('Page roots cannot be moved.');
  const parent = tx.getNode(newParentId);
  if (!parent) throw new OpError(`Parent node not found: "${newParentId}"`);
  if (!canHaveChildren(parent)) {
    throw new OpError(`Node "${newParentId}" is a ${parent.component} and cannot have children.`);
  }
  if (newParentId === id || isAncestorOf(tx, id, newParentId)) {
    throw new OpError(`Cannot move "${id}" into itself or one of its descendants.`);
  }
  const oldParentId = node.parentId;
  if (oldParentId) {
    tx.updateNode(oldParentId, (p) => {
      p.children = p.children.filter((c) => c !== id);
    });
  }
  tx.updateNode(newParentId, (p) => {
    p.children.splice(clampIndex(index, p.children.length), 0, id);
  });
  tx.updateNode(id, (n) => {
    n.parentId = newParentId;
  });
}

/** Deep-clone a node under `newParentId` (default: same parent, right after the source). */
export function duplicateSubtree(
  tx: Transaction,
  id: string,
  newParentId?: string,
  index?: number
): { rootId: string; idMap: Record<string, string> } {
  const source = tx.getNode(id);
  if (!source) throw new OpError(`Node not found: "${id}"`);
  if (source.component === 'PageRoot') throw new OpError('Page roots cannot be duplicated.');
  const parentId = newParentId ?? source.parentId!;
  const parent = tx.getNode(parentId);
  if (!parent) throw new OpError(`Parent node not found: "${parentId}"`);
  if (!canHaveChildren(parent)) {
    throw new OpError(`Node "${parentId}" is a ${parent.component} and cannot have children.`);
  }
  if (isAncestorOf(tx, id, parentId) || parentId === id) {
    throw new OpError(`Cannot duplicate "${id}" into itself or one of its descendants.`);
  }
  const idMap: Record<string, string> = {};
  const cloneRec = (srcId: string, newParent: string): string => {
    const src = tx.getNode(srcId)!;
    const newId = tx.nextNodeId();
    idMap[srcId] = newId;
    const copy: NodeRecord = {
      ...src,
      id: newId,
      parentId: newParent,
      children: [],
      styles: { ...src.styles },
      ...(src.attrs ? { attrs: { ...src.attrs } } : {}),
      ...(src.textRuns ? { textRuns: cloneRuns(src.textRuns) } : {}),
      ...(src.props ? { props: structuredClone(src.props) } : {}),
    };
    delete copy.imageGeneration;
    if (src.imageGeneration?.status === 'ready') copy.imageGeneration = { ...src.imageGeneration };
    tx.putNode(copy);
    copy.children = src.children.filter((c) => tx.getNode(c)).map((c) => cloneRec(c, newId));
    tx.putNode(copy);
    return newId;
  };
  const rootId = cloneRec(id, parentId);
  const insertAt = index ?? (parentId === source.parentId ? parent.children.indexOf(id) + 1 : undefined);
  tx.updateNode(parentId, (p) => {
    p.children.splice(clampIndex(insertAt, p.children.length), 0, rootId);
  });
  return { rootId, idMap };
}

/**
 * Merge styles into a node. `null`, `undefined` or `""` remove a property.
 * Numbers get `px` where CSS expects a length.
 */
export function patchStyles(tx: Transaction, id: string, styles: Record<string, unknown>): NodeRecord {
  const node = tx.updateNode(id, (n) => {
    for (const [prop, raw] of Object.entries(styles)) {
      const value = normalizeStyleValue(prop, raw);
      if (value === null) delete n.styles[prop];
      else n.styles[prop] = value;
    }
  });
  if (!node) throw new OpError(`Node not found: "${id}"`);
  return node;
}

export function setTextValue(tx: Transaction, id: string, text: string): NodeRecord {
  const node = tx.getNode(id);
  if (!node) throw new OpError(`Node not found: "${id}"`);
  if (node.component !== 'Text') {
    throw new OpError(`Node "${id}" is a ${node.component}, not a Text node.`);
  }
  return tx.updateNode(id, (n) => {
    n.textValue = text;
    delete n.textRuns;
  })!;
}

/** Set a Text node's text as styled runs; a single style left over moves onto the node. */
export function setTextRuns(tx: Transaction, id: string, runs: ReadonlyArray<Pick<TextRun, 'text'> & { styles?: Record<string, unknown> }>): NodeRecord {
  const node = tx.getNode(id);
  if (!node) throw new OpError(`Node not found: "${id}"`);
  if (node.component !== 'Text') {
    throw new OpError(`Node "${id}" is a ${node.component}, not a Text node.`);
  }
  return tx.updateNode(id, (n) => applyTextRuns(n, runs))!;
}

export function renameNode(tx: Transaction, id: string, label: string, maxLength = 50): NodeRecord {
  const node = tx.updateNode(id, (n) => {
    n.label = label.trim().slice(0, maxLength) || n.label;
  });
  if (!node) throw new OpError(`Node not found: "${id}"`);
  return node;
}

export function setNodeFlags(tx: Transaction, id: string, flags: { isVisible?: boolean; isLocked?: boolean }): void {
  const node = tx.updateNode(id, (n) => {
    if (flags.isVisible !== undefined) n.isVisible = flags.isVisible;
    if (flags.isLocked !== undefined) n.isLocked = flags.isLocked;
  });
  if (!node) throw new OpError(`Node not found: "${id}"`);
}
