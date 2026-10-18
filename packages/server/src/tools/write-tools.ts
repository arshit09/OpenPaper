import {
  canHaveChildren,
  collectImageUrls,
  cssUrls,
  deleteSubtree,
  displayName,
  duplicateSubtree,
  findFreeSpot,
  FREEFORM_DISPLAY,
  importHtml,
  insertImported,
  isAncestorOf,
  isFreeform,
  normalizeNodeStyles,
  normalizeStyleValue,
  OpError,
  pageRootOfNode,
  positionOf,
  pxValue,
  readerOf,
  sanitizeSvg,
  stripInertStyles,
  topLevelBoxes,
  type Box,
  type NodeRecord,
  type StyleMap,
  type Transaction,
} from '@openpaper/core';
import {
  doc,
  layoutFor,
  pageIdOfNodeIn,
  record,
  resolvePageId,
  ToolError,
  type Call,
  type HandlerResult,
} from './context.ts';

function live(call: Call) {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  return call.live;
}

/** Run a mutation as the calling agent; OpErrors become user-facing ToolErrors. */
function transact<T>(call: Call, label: string, fn: (tx: Transaction) => T): T {
  try {
    return live(call).transact(call.actor, label, fn);
  } catch (error) {
    if (error instanceof OpError) throw new ToolError(error.message);
    throw error;
  }
}

function positionFields(call: Call, node: NodeRecord) {
  return positionOf(readerOf(doc(call)), node, null);
}

// ---------------------------------------------------------------------------
// Style application with update_styles semantics.

const FAMILIES: Record<string, string[]> = {
  padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingBlock', 'paddingInline', 'paddingBlockStart', 'paddingBlockEnd', 'paddingInlineStart', 'paddingInlineEnd'],
  margin: ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginBlock', 'marginInline'],
  gap: ['rowGap', 'columnGap'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
  overflow: ['overflowX', 'overflowY'],
  inset: ['top', 'right', 'bottom', 'left'],
  border: [
    'borderWidth',
    'borderStyle',
    'borderColor',
    'borderTop',
    'borderRight',
    'borderBottom',
    'borderLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'borderTopStyle',
    'borderRightStyle',
    'borderBottomStyle',
    'borderLeftStyle',
  ],
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'backgroundClip', 'backgroundOrigin', 'backgroundAttachment'],
  transform: ['translate', 'rotate', 'scale'],
  whiteSpace: ['whiteSpaceCollapse', 'textWrapMode'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  font: ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight'],
  outline: ['outlineWidth', 'outlineStyle', 'outlineColor'],
};

/** Merge a style patch into a node. Returns the input keys that ended up inert. */
function applyStyles(tx: Transaction, node: NodeRecord, input: Record<string, string | number>): string[] {
  const parent = node.parentId ? tx.getNode(node.parentId) : undefined;
  let ignored: string[] = [];
  tx.updateNode(node.id, (n) => {
    const s = n.styles;
    for (const [prop, raw] of Object.entries(input)) {
      const value = normalizeStyleValue(prop, raw);
      const reset = value === null || (prop === 'transform' && value === 'none');
      const family = FAMILIES[prop] ?? [];
      if (reset) {
        delete s[prop];
        for (const k of family) delete s[k];
        continue;
      }
      // A shorthand overrides its longhands; a longhand goes after its shorthand.
      for (const k of family) delete s[k];
      delete s[prop];
      s[prop] = value!;
    }
    const normalized = normalizeNodeStyles(s, { isText: n.component === 'Text', isSvg: n.component === 'SVG', isReplaced: n.component === 'SVG' });
    const removed = stripInertStyles(normalized, parent?.styles.display ?? (parent?.component === 'PageRoot' ? FREEFORM_DISPLAY : undefined), n.component === 'Text');
    ignored = removed.filter((k) => k in input);
    n.styles = normalized;
  });
  return ignored;
}

// ---------------------------------------------------------------------------

export async function writeHtml(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const { html, targetNodeId, mode } = call.args as { html: string; targetNodeId: string; mode: 'insert-children' | 'replace' };
  const target = d.nodes[targetNodeId];
  if (!target) throw new ToolError(`Node not found: ${targetNodeId}`);
  if (mode === 'replace' && target.component === 'PageRoot') throw new ToolError('Cannot replace a page root node');

  // Writing into an SVG appends markup to the drawing.
  if (mode === 'insert-children' && target.component === 'SVG') {
    transact(call, 'write_html', (tx) => {
      tx.updateNode(targetNodeId, (n) => {
        const markup = n.svg ?? '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
        n.svg = sanitizeSvg(markup.replace(/<\/svg>\s*$/i, `${html}</svg>`));
      });
    });
    record(call, [targetNodeId], 'edit');
    return { data: { createdNodes: [] } };
  }
  if (mode === 'insert-children' && !canHaveChildren(target)) {
    throw new ToolError(`Node "${displayName(target)}" (${target.component}) cannot have children`);
  }

  let resolved: Map<string, import('@openpaper/core').ResolvedImage | null>;
  try {
    resolved = await call.env.assets.resolveAll(collectImageUrls(html));
  } catch (error) {
    throw new ToolError(`HTML parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parentId = mode === 'replace' ? target.parentId! : target.id;
  const parentIsRoot = d.nodes[parentId]?.component === 'PageRoot';
  const pageId = pageIdOfNodeIn(d, target);
  const viewport = pageId ? call.env.views.viewportFor(d.id, pageId) : null;

  const result = transact(call, 'write_html', (tx) => {
    let imported;
    try {
      imported = importHtml(html, {
        resolveImage: (url) => (resolved.has(url) ? resolved.get(url) : undefined),
        nodeExists: (id) => !!tx.getNode(id),
      });
    } catch (error) {
      throw new ToolError(`HTML parsing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!imported.roots.length) throw new ToolError('HTML produced no design nodes');
    const placed: Box[] = [];
    const placeTopLevel = parentIsRoot
      ? (styles: StyleMap) => {
          const root = tx.getNode(parentId)!;
          const obstacles = [...topLevelBoxes(tx, root, null), ...placed];
          const w = pxValue(styles.width) ?? 400;
          const h = pxValue(styles.height) ?? 300;
          const spot = findFreeSpot(obstacles, w, h, { viewport });
          placed.push({ minX: spot.x, minY: spot.y, maxX: spot.x + w, maxY: spot.y + h });
          return spot;
        }
      : undefined;
    return insertImported(tx, imported.roots, targetNodeId, mode, { placeTopLevel });
  });

  const note = await call.env.images.startAll(call, result.generations);
  record(call, result.createdIds, 'write');
  const after = doc(call);
  const createdNodes = result.createdIds
    .map((id) => after.nodes[id])
    .filter((n): n is NodeRecord => !!n)
    .map((n) => ({ id: n.id, name: displayName(n), component: n.component, ...positionFields(call, n) }));
  return { data: { ...(note ? { note } : {}), createdNodes } };
}

export async function createArtboard(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const pageId = resolvePageId(call, call.args.pageId);
  const page = d.pages[pageId]!;
  const inputStyles = call.args.styles as Record<string, string | number>;
  const name = String(call.args.name ?? 'Artboard');
  const w = pxValue(String(inputStyles.width ?? '')) ?? 1440;
  const h = pxValue(String(inputStyles.height ?? '')) ?? 900;
  const layout = await layoutFor(call, pageId);
  const viewport = call.env.views.viewportFor(d.id, pageId);

  const id = transact(call, 'create_artboard', (tx) => {
    const root = tx.getNode(page.rootId)!;
    const spot = findFreeSpot(topLevelBoxes(tx, root, layout), w, h, { viewport });
    const newId = tx.nextNodeId();
    const record: NodeRecord = {
      id: newId,
      component: 'Frame',
      label: name.length > 200 ? `${name.slice(0, 200)}…` : name,
      labelIsModified: true,
      parentId: root.id,
      children: [],
      styles: { display: FREEFORM_DISPLAY, overflow: 'clip', width: `${w}px`, height: `${h}px` },
      isVisible: true,
      isLocked: false,
    };
    tx.putNode(record);
    tx.updateNode(root.id, (r) => {
      r.children.push(newId);
    });
    const { left: _l, top: _t, ...rest } = inputStyles;
    applyStyles(tx, tx.getNode(newId)!, { display: 'flex', flexDirection: 'column', ...rest });
    tx.updateNode(newId, (n) => {
      n.styles.left = `${spot.x}px`;
      n.styles.top = `${spot.y}px`;
      const hasFill = !!(n.styles.backgroundColor || n.styles.background || n.styles.backgroundImage);
      if (!hasFill) n.styles.backgroundColor = '#FFFFFF';
    });
    return newId;
  });

  const urls = cssUrls(String(inputStyles.backgroundImage ?? '')).filter((u) => u.startsWith('paper-gen://'));
  const note = await call.env.images.startAll(
    call,
    urls.map((url) => ({ nodeId: id, url }))
  );
  record(call, [id], 'write');
  const node = doc(call).nodes[id]!;
  const pos = positionFields(call, node);
  return {
    data: {
      ...(note ? { note } : {}),
      id,
      name: displayName(node),
      worldX: pos.worldX,
      worldY: pos.worldY,
      width: pxValue(node.styles.width) || null,
      height: pxValue(node.styles.height) || null,
    },
  };
}

export async function updateStyles(call: Call): Promise<HandlerResult> {
  const updatesIn = call.args.updates as Array<{ nodeIds: string[]; styles: Record<string, string | number> }>;
  if (!updatesIn.length) throw new ToolError('No updates provided');
  const updates: Array<{ nodeId: string; ignoredStyles?: string[]; note?: string }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  const generations: Array<{ nodeId: string; url: string }> = [];
  const touched: string[] = [];
  transact(call, 'update_styles', (tx) => {
    for (const u of updatesIn) {
      for (const nodeId of u.nodeIds) {
        const node = tx.getNode(nodeId);
        if (!node) {
          errors.push({ nodeId, error: `Node not found: ${nodeId}` });
          continue;
        }
        if (node.component === 'PageRoot') {
          errors.push({ nodeId, error: 'Cannot update styles on a page root node' });
          continue;
        }
        const ignored = applyStyles(tx, node, u.styles);
        for (const v of Object.values(u.styles)) {
          for (const url of cssUrls(String(v))) if (url.startsWith('paper-gen://')) generations.push({ nodeId, url });
        }
        touched.push(nodeId);
        updates.push({ nodeId, ...(ignored.length ? { ignoredStyles: ignored } : {}) });
      }
    }
  });
  const note = await call.env.images.startAll(call, generations);
  record(call, touched, 'edit');
  return { data: { ...(note ? { note } : {}), updates, ...(errors.length ? { errors } : {}) } };
}

export async function deleteNodes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const ids = call.args.nodeIds as string[];
  for (const id of ids) {
    const n = d.nodes[id];
    if (!n) throw new ToolError(`Node not found: ${id}`);
    if (n.component === 'PageRoot') throw new ToolError('Cannot delete a page root node');
  }
  record(call, ids, 'delete');
  transact(call, 'delete_nodes', (tx) => {
    for (const id of ids) if (tx.getNode(id)) deleteSubtree(tx, id);
  });
  return { data: { deletedNodeIds: ids } };
}

export async function setTextContent(call: Call): Promise<HandlerResult> {
  const items = call.args.updates as Array<{ nodeId: string; textContent: string }>;
  if (!items.length) throw new ToolError('No updates provided');
  const updates: Array<{ nodeId: string; textContent: string }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  transact(call, 'set_text_content', (tx) => {
    for (const item of items) {
      const node = tx.getNode(item.nodeId);
      if (!node) errors.push({ nodeId: item.nodeId, error: `Node not found: ${item.nodeId}` });
      else if (node.component !== 'Text') {
        errors.push({ nodeId: item.nodeId, error: `Node "${displayName(node)}" is a ${node.component}, not a Text node` });
      } else {
        tx.updateNode(item.nodeId, (n) => {
          n.textValue = item.textContent;
          delete n.styles.overflowWrap;
        });
        updates.push({ nodeId: item.nodeId, textContent: item.textContent });
      }
    }
  });
  record(
    call,
    updates.map((u) => u.nodeId),
    'edit'
  );
  return { data: { updates, ...(errors.length ? { errors } : {}) } };
}

export async function renameNodes(call: Call): Promise<HandlerResult> {
  const items = call.args.updates as Array<{ nodeId: string; name: string }>;
  if (!items.length) throw new ToolError('No updates provided');
  const updates: Array<{ nodeId: string; name: string }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  transact(call, 'rename_nodes', (tx) => {
    for (const item of items) {
      const node = tx.getNode(item.nodeId);
      if (!node) {
        errors.push({ nodeId: item.nodeId, error: `Node not found: ${item.nodeId}` });
        continue;
      }
      const label = item.name.length > 200 ? `${item.name.slice(0, 200)}…` : item.name;
      tx.updateNode(item.nodeId, (n) => {
        n.label = label;
        n.labelIsModified = true;
      });
      updates.push({ nodeId: item.nodeId, name: label });
    }
  });
  record(
    call,
    updates.map((u) => u.nodeId),
    'edit'
  );
  return { data: { updates, ...(errors.length ? { errors } : {}) } };
}

export async function duplicateNodes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const items = call.args.nodes as Array<{ id: string; parentId?: string }>;
  if (!items.length) throw new ToolError('No node IDs provided');
  for (const item of items) {
    const n = d.nodes[item.id];
    if (!n) throw new ToolError(`Node not found: ${item.id}`);
    if (n.component === 'PageRoot') throw new ToolError('Cannot duplicate a page root node');
    if (item.parentId) {
      const p = d.nodes[item.parentId];
      if (!p) throw new ToolError(`Target parent not found: ${item.parentId}`);
      if (!canHaveChildren(p)) throw new ToolError(`Target parent "${displayName(p)}" (${p.component}) cannot have children`);
    }
  }
  const firstPage = pageIdOfNodeIn(d, d.nodes[items[0]!.id]!);
  const layout = await layoutFor(call, firstPage);

  const results = transact(call, 'duplicate_nodes', (tx) => {
    const out: Array<{ sourceId: string; newId: string; idMap: Record<string, string> }> = [];
    const placedBoxes: Box[] = [];
    for (const item of items) {
      const src = tx.getNode(item.id)!;
      const parentId = item.parentId ?? src.parentId!;
      const parent = tx.getNode(parentId)!;
      // Same parent: right after the source. Other parent: appended (reorder with move_nodes).
      const index = parentId === src.parentId ? parent.children.indexOf(src.id) + 1 : undefined;
      const { rootId, idMap } = duplicateSubtree(tx, src.id, parentId, index);
      // Artboards land in a free spot next to their source.
      if (tx.getNode(parentId)?.component === 'PageRoot' || tx.getNode(src.parentId!)?.component === 'PageRoot') {
        const root = pageRootOfNode(tx, rootId) ?? tx.getNode(parentId)!;
        const sw = layout?.[src.id]?.width ?? pxValue(src.styles.width) ?? 1440;
        const sh = layout?.[src.id]?.height ?? pxValue(src.styles.height) ?? 900;
        const sx = layout?.[src.id]?.worldX ?? pxValue(src.styles.left) ?? 0;
        const sy = layout?.[src.id]?.worldY ?? pxValue(src.styles.top) ?? 0;
        const obstacles = [...topLevelBoxes(tx, root, layout, new Set([rootId, ...out.map((o) => o.newId)])), ...placedBoxes];
        const viewport = firstPage ? call.env.views.viewportFor(d.id, firstPage) : null;
        const spot = findFreeSpot(obstacles, sw, sh, { anchor: { minX: sx, minY: sy, maxX: sx + sw, maxY: sy + sh }, viewport });
        placedBoxes.push({ minX: spot.x, minY: spot.y, maxX: spot.x + sw, maxY: spot.y + sh });
        tx.updateNode(rootId, (n) => {
          n.styles.left = `${spot.x}px`;
          n.styles.top = `${spot.y}px`;
        });
      }
      // descendantIdMap excludes the root itself.
      const descendantIdMap = { ...idMap };
      delete descendantIdMap[src.id];
      out.push({ sourceId: src.id, newId: rootId, idMap: descendantIdMap });
    }
    return out;
  });
  record(
    call,
    results.map((r) => r.newId),
    'write'
  );
  const after = doc(call);
  return {
    data: {
      duplicatedNodes: results.map((r) => {
        const n = after.nodes[r.newId]!;
        return {
          sourceId: r.sourceId,
          newId: r.newId,
          name: displayName(n),
          component: n.component,
          ...positionFields(call, n),
          descendantIdMap: r.idMap,
        };
      }),
    },
  };
}

type Move = { nodeId: string; before?: string; after?: string; parentId?: string; index?: number };

export async function moveNodes(call: Call): Promise<HandlerResult> {
  const d0 = doc(call);
  const first = d0.nodes[(call.args.moves as Move[])[0]?.nodeId ?? ''];
  const layout = first ? await layoutFor(call, pageIdOfNodeIn(d0, first)) : null;
  const moves: Array<{ nodeId: string; parentId: string; index: number }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  const affected: string[] = [];
  transact(call, 'move_nodes', (tx) => {
    for (const m of call.args.moves as Move[]) {
      const node = tx.getNode(m.nodeId);
      if (!node) {
        errors.push({ nodeId: m.nodeId, error: `Node not found: ${m.nodeId}` });
        continue;
      }
      if (node.component === 'PageRoot') {
        errors.push({ nodeId: m.nodeId, error: 'Cannot move a page root node' });
        continue;
      }
      let parentId: string;
      let index: number | undefined;
      const siblingId = m.before ?? m.after;
      if (siblingId !== undefined) {
        const sib = tx.getNode(siblingId);
        if (!sib) {
          errors.push({ nodeId: m.nodeId, error: `Sibling not found: ${siblingId}` });
          continue;
        }
        if (sib.id === node.id) {
          errors.push({ nodeId: m.nodeId, error: 'Sibling cannot be the moved node itself' });
          continue;
        }
        if (!sib.parentId) {
          errors.push({ nodeId: m.nodeId, error: `Sibling "${siblingId}" has no parent (is it the root?)` });
          continue;
        }
        parentId = sib.parentId;
        const without = tx.getNode(parentId)!.children.filter((c) => c !== node.id);
        index = without.indexOf(sib.id) + (m.after !== undefined ? 1 : 0);
      } else {
        let pid = m.parentId!;
        if (pid === 'root') pid = pageRootOfNode(tx, node.id)?.id ?? pid;
        const parent = tx.getNode(pid);
        if (!parent) {
          errors.push({ nodeId: m.nodeId, error: `Target parent not found: ${m.parentId}` });
          continue;
        }
        parentId = pid;
        index = m.index;
      }
      const parent = tx.getNode(parentId)!;
      if (!canHaveChildren(parent)) {
        errors.push({ nodeId: m.nodeId, error: `Target parent "${displayName(parent)}" (${parent.component}) cannot have children` });
        continue;
      }
      if (parentId === node.id || isAncestorOf(tx, node.id, parentId)) {
        errors.push({ nodeId: m.nodeId, error: 'Cannot move node under itself or one of its descendants' });
        continue;
      }
      const oldParentId = node.parentId!;
      const without = parent.children.filter((c) => c !== node.id);
      const clamped = index === undefined ? without.length : Math.max(0, Math.min(index, without.length));
      if (oldParentId === parentId && parent.children.indexOf(node.id) === clamped) {
        moves.push({ nodeId: node.id, parentId, index: clamped });
        continue;
      }
      // Keep the canvas position when moving into a freeform parent (or the page root).
      const world = layout?.[node.id];
      tx.updateNode(oldParentId, (p) => {
        p.children = p.children.filter((c) => c !== node.id);
      });
      tx.updateNode(parentId, (p) => {
        p.children.splice(clamped, 0, node.id);
      });
      tx.updateNode(node.id, (n) => {
        n.parentId = parentId;
        if (oldParentId !== parentId) {
          const dest = tx.getNode(parentId)!;
          if (isFreeform(dest)) {
            const destWorld = dest.component === 'PageRoot' ? { worldX: 0, worldY: 0 } : layout?.[dest.id];
            if (world && destWorld) {
              n.styles.left = `${Math.round(world.worldX - destWorld.worldX)}px`;
              n.styles.top = `${Math.round(world.worldY - destWorld.worldY)}px`;
            }
            delete n.styles.position;
          } else if (n.styles.position !== 'absolute') {
            for (const k of ['left', 'top', 'right', 'bottom']) delete n.styles[k];
          }
          stripInertStyles(n.styles, dest.component === 'PageRoot' ? FREEFORM_DISPLAY : dest.styles.display, n.component === 'Text');
        }
      });
      if (!affected.includes(parentId)) affected.push(parentId);
      if (oldParentId !== parentId && !affected.includes(oldParentId)) affected.push(oldParentId);
      moves.push({ nodeId: node.id, parentId, index: tx.getNode(parentId)!.children.indexOf(node.id) });
    }
  });
  record(
    call,
    moves.map((m) => m.nodeId),
    'edit'
  );
  const after = doc(call);
  const affectedParents = affected.map((id) => ({ parentId: id, childIds: after.nodes[id]?.children ?? [] }));
  return { data: { moves, ...(affectedParents.length ? { affectedParents } : {}), ...(errors.length ? { errors } : {}) } };
}

export async function finishWorkingOnNodes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  call.env.presence.finish(call.session, d.id, call.args.nodeIds as string[] | undefined);
  return { data: 'OK' };
}
