import { FREEFORM_DISPLAY, isFreeform } from '../render/render-spec.ts';
import { normalizeStyleValue, type StyleMap } from '../styles/css.ts';
import type { ImportedNode } from '../html/import.ts';
import { deleteSubtree, duplicateSubtree, OpError, patchStyles } from '../model/ops.ts';
import type { Transaction } from '../model/transaction.ts';
import type { NodeRecord } from '../model/types.ts';
import { subtreeOf } from '../model/tree.ts';

/** Styles that make no sense on items placed directly on the canvas (Paper strips them). */
const CANVAS_STRIP = [
  'bottom',
  'inset',
  'insetBlock',
  'insetInline',
  'left',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'marginBlock',
  'marginInline',
  'maxWidth',
  'minWidth',
  'maxHeight',
  'minHeight',
  'position',
  'right',
  'scale',
  'top',
  'transform',
  'translate',
];

export interface InsertOptions {
  /** Pick a canvas position for a new top-level node (page-root inserts). */
  placeTopLevel?: (styles: StyleMap) => { x: number; y: number };
}

export interface InsertResult {
  /** Every inserted node id, depth-first pre-order. */
  createdIds: string[];
  topLevelIds: string[];
  /** Nodes that requested AI image generation (paper-gen://). */
  generations: Array<{ nodeId: string; url: string }>;
}

function createRecord(tx: Transaction, n: ImportedNode, parentId: string, out: InsertResult): string {
  if (n.cloneOf) {
    const parent = tx.getNode(parentId)!;
    const { rootId } = duplicateSubtree(tx, n.cloneOf, parentId, parent.children.length);
    // Overrides from the clone tag's inline style ("" removes a property).
    if (Object.keys(n.styles).length) patchStyles(tx, rootId, n.styles);
    tx.updateNode(rootId, (r) => {
      if (n.labelIsModified) {
        r.label = n.label;
        r.labelIsModified = true;
      }
      if (!n.isVisible) r.isVisible = false;
      if (n.isLocked) r.isLocked = true;
    });
    for (const rec of subtreeOf(tx, rootId)) out.createdIds.push(rec.id);
    for (const child of n.children) createRecord(tx, child, rootId, out);
    return rootId;
  }
  const id = tx.nextNodeId();
  const record: NodeRecord = {
    id,
    component: n.component,
    label: n.label,
    ...(n.labelIsModified ? { labelIsModified: true } : {}),
    parentId,
    children: [],
    styles: { ...n.styles },
    isVisible: n.isVisible,
    isLocked: n.isLocked,
  };
  if (n.textValue !== undefined) record.textValue = n.textValue;
  if (n.svg !== undefined) record.svg = n.svg;
  tx.putNode(record);
  tx.updateNode(parentId, (p) => {
    p.children.push(id);
  });
  out.createdIds.push(id);
  if (n.generate) out.generations.push({ nodeId: id, url: n.generate });
  for (const child of n.children) createRecord(tx, child, id, out);
  return id;
}

/**
 * Insert imported nodes relative to `targetId`.
 * - insert-children: appended after the target's last child.
 * - replace: the target is removed and the new nodes take its place.
 */
export function insertImported(
  tx: Transaction,
  roots: ImportedNode[],
  targetId: string,
  mode: 'insert-children' | 'replace',
  opts: InsertOptions = {}
): InsertResult {
  const target = tx.getNode(targetId);
  if (!target) throw new OpError(`Node not found: ${targetId}`);
  const out: InsertResult = { createdIds: [], topLevelIds: [], generations: [] };

  let parent: NodeRecord;
  let insertIndex: number;
  let replacedPosition: { left?: string; top?: string } | null = null;
  if (mode === 'replace') {
    if (target.component === 'PageRoot') throw new OpError('Cannot replace a page root node');
    parent = tx.getNode(target.parentId!)!;
    insertIndex = parent.children.indexOf(targetId);
    replacedPosition = { left: target.styles.left, top: target.styles.top };
    deleteSubtree(tx, targetId);
    parent = tx.getNode(parent.id)!;
  } else {
    parent = target;
    insertIndex = parent.children.length;
  }

  const isRoot = parent.component === 'PageRoot';
  const freeform = isFreeform(parent);

  for (const n of roots) {
    if (isRoot) {
      for (const k of CANVAS_STRIP) delete n.styles[k];
      if (n.styles.width === '100%') n.styles.width = 'fit-content';
      if (n.styles.height === '100%') n.styles.height = 'fit-content';
      const spot = opts.placeTopLevel?.(n.styles);
      if (spot) {
        n.styles.left = `${spot.x}px`;
        n.styles.top = `${spot.y}px`;
      }
    } else if (freeform) {
      if (mode === 'replace' && replacedPosition) {
        delete n.styles.position;
        if (replacedPosition.left) n.styles.left = replacedPosition.left;
        if (replacedPosition.top) n.styles.top = replacedPosition.top;
      } else if (n.styles.position === 'absolute') {
        delete n.styles.position; // freeform children are positioned by left/top
      }
    }
  }

  // Flow content written into a freeform frame turns it into a flex column; its
  // existing children keep their spot as absolutely positioned layers.
  if (!isRoot && freeform && mode === 'insert-children' && roots.some((n) => n.styles.position !== 'absolute' && !n.styles.left && !n.styles.top)) {
    tx.updateNode(parent.id, (p) => {
      p.styles.display = 'flex';
      p.styles.flexDirection ??= 'column';
    });
    for (const childId of parent.children) {
      tx.updateNode(childId, (c) => {
        c.styles.position = 'absolute';
        c.styles.left ??= '0px';
        c.styles.top ??= '0px';
      });
    }
  }

  for (const n of roots) {
    const before = tx.getNode(parent.id)!.children.length;
    const id = createRecord(tx, n, parent.id, out);
    out.topLevelIds.push(id);
    // createRecord appends; move into the requested slot (replace keeps the old position).
    const after = tx.getNode(parent.id)!;
    const at = after.children.indexOf(id);
    const desired = insertIndex + out.topLevelIds.length - 1;
    if (at !== desired && at === before) {
      tx.updateNode(parent.id, (p) => {
        p.children.splice(at, 1);
        p.children.splice(Math.min(desired, p.children.length), 0, id);
      });
    }
  }
  return out;
}

/** Apply a style patch with update_styles semantics ("" removes). Returns removed/ignored keys from the stripper. */
export function applyStylePatch(tx: Transaction, nodeId: string, styles: Record<string, string | number>): NodeRecord {
  const patch: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(styles)) {
    const value = normalizeStyleValue(k, v);
    patch[k] = value;
  }
  return patchStyles(tx, nodeId, patch);
}

export { FREEFORM_DISPLAY };
