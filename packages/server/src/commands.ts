import {
  applyShaderPropsPatch,
  collectImageUrls,
  collectMediaUrls,
  createSubtree,
  deleteSubtree,
  duplicateSubtree,
  findFreeSpot,
  FREEFORM_DISPLAY,
  importHtml,
  insertImported,
  isFreeform,
  moveNode,
  newMessageId,
  newPageRecord,
  newThreadId,
  OpError,
  pageRootNode,
  patchStyles,
  pxValue,
  renameNode,
  setNodeFlags,
  setTextRuns,
  setTextValue,
  shaderDef,
  shaderPresetProps,
  subtreeOf,
  topLevelBoxes,
  type CommandResult,
  type EditorCommand,
  type NodeRecord,
  type Transaction,
} from '@openpaper/core';
import type { AssetResolver } from './assets.ts';
import type { ActorRef, LiveDocument } from './hub.ts';
import { LOCAL_USER_ID } from './tools/comment-tools.ts';

function freeformRect(n: NodeRecord) {
  return {
    left: pxValue(n.styles.left) ?? 0,
    top: pxValue(n.styles.top) ?? 0,
    width: pxValue(n.styles.width) ?? 0,
    height: pxValue(n.styles.height) ?? 0,
  };
}

/** Remember the local user's display name so comment tools can show it. */
function ensureLocalUser(tx: Transaction, displayName: string) {
  if (tx.getUsers()[LOCAL_USER_ID]?.displayName === displayName) return;
  tx.putUser({ userId: LOCAL_USER_ID, displayName });
}

/** Execute a command from the editor UI. */
export async function executeCommand(
  live: LiveDocument,
  actor: ActorRef,
  cmd: EditorCommand,
  services: { assets: AssetResolver; userName: string }
): Promise<CommandResult> {
  // Async preparation (image downloads) happens before the synchronous transaction.
  if (cmd.type === 'insertHtml') {
    const [resolved, media] = await Promise.all([
      services.assets.resolveAll(collectImageUrls(cmd.html)),
      services.assets.resolveAll(collectMediaUrls(cmd.html), 'motion'),
    ]);
    return live.transact(actor, 'Paste', (tx) => {
      const importRoots = () => {
        const imported = importHtml(cmd.html, {
          resolveImage: (u) => (resolved.has(u) ? resolved.get(u) : undefined),
          resolveMedia: (u) => (media.has(u) ? media.get(u) : undefined),
          nodeExists: (id) => !!tx.getNode(id),
        });
        if (!imported.roots.length) throw new OpError('Nothing to paste');
        return imported;
      };
      // Paste to replace: every target gets its own copy, in its slot and position.
      if (cmd.replaceIds?.length) {
        const ids: string[] = [];
        for (const targetId of cmd.replaceIds) {
          const target = tx.getNode(targetId);
          if (!target?.parentId || target.component === 'PageRoot') continue;
          const spot = { x: pxValue(target.styles.left) ?? 0, y: pxValue(target.styles.top) ?? 0 };
          const parent = tx.getNode(target.parentId)!;
          const onRoot = parent.component === 'PageRoot';
          const imported = importRoots();
          const roots = imported.roots;
          // An absolutely positioned layer in a flow frame: its replacement keeps that spot.
          if (!onRoot && !isFreeform(parent) && target.styles.position === 'absolute') {
            for (const r of roots) Object.assign(r.styles, { position: 'absolute', left: `${spot.x}px`, top: `${spot.y}px` });
          }
          const keyframes = { list: imported.keyframes, mode: 'rename' as const };
          ids.push(...insertImported(tx, roots, targetId, 'replace', onRoot ? { placeTopLevel: () => spot, keyframes } : { keyframes }).topLevelIds);
        }
        return { ids };
      }
      const imported = importRoots();
      const parent = tx.getNode(cmd.parentId);
      if (!parent) throw new OpError(`Node not found: ${cmd.parentId}`);
      const placed: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
      // Keep the pasted layers' arrangement: one free spot for their bounding box.
      let spots: Array<{ x: number; y: number }> | null = null;
      if (cmd.at && parent.component === 'PageRoot') {
        spots = imported.roots.map(() => ({ x: cmd.at!.x, y: cmd.at!.y }));
      } else if (cmd.at) {
        // In a flow frame the layers float at that spot, like the absolutely positioned layers they cover.
        const pos = isFreeform(parent) ? {} : { position: 'absolute' };
        for (const r of imported.roots) Object.assign(r.styles, pos, { left: `${cmd.at.x}px`, top: `${cmd.at.y}px` });
      } else if (cmd.keepLayout && parent.component === 'PageRoot') {
        const boxes = imported.roots.map((r) => ({
          x: pxValue(r.styles.left) ?? 0,
          y: pxValue(r.styles.top) ?? 0,
          w: pxValue(r.styles.width) ?? 400,
          h: pxValue(r.styles.height) ?? 300,
        }));
        const minX = Math.min(...boxes.map((b) => b.x));
        const minY = Math.min(...boxes.map((b) => b.y));
        const w = Math.max(...boxes.map((b) => b.x + b.w)) - minX;
        const h = Math.max(...boxes.map((b) => b.y + b.h)) - minY;
        const spot = findFreeSpot(topLevelBoxes(tx, parent, null), w, h);
        spots = boxes.map((b) => ({ x: spot.x + b.x - minX, y: spot.y + b.y - minY }));
      }
      const result = insertImported(tx, imported.roots, cmd.parentId, 'insert-children', {
        placeTopLevel:
          parent.component === 'PageRoot' && spots
            ? () => spots!.shift()!
            : parent.component === 'PageRoot'
            ? (styles) => {
                const w = pxValue(styles.width) ?? 400;
                const h = pxValue(styles.height) ?? 300;
                const spot = findFreeSpot([...topLevelBoxes(tx, tx.getNode(cmd.parentId)!, null), ...placed], w, h);
                placed.push({ minX: spot.x, minY: spot.y, maxX: spot.x + w, maxY: spot.y + h });
                return spot;
              }
            : undefined,
        // Pasted animations never change the ones already in this file.
        keyframes: { list: imported.keyframes, mode: 'rename' },
      });
      if (cmd.index !== undefined) result.topLevelIds.forEach((id, i) => moveNode(tx, id, cmd.parentId, cmd.index! + i));
      return { ids: result.topLevelIds };
    });
  }

  if (cmd.type === 'setShaderFrame') {
    return live.transact(
      actor,
      'Shader frame',
      (tx): CommandResult => {
        for (const [id, frame] of Object.entries(cmd.frames)) {
          const node = tx.getNode(id);
          if (!node || !shaderDef(node.component) || !Number.isFinite(frame)) continue;
          tx.updateNode(id, (n) => {
            n.props = { ...(n.props ?? {}), frame: Math.max(0, Math.round(frame * 10) / 10) };
          });
        }
        return {};
      },
      { undoable: false }
    );
  }

  return live.transact(actor, labelFor(cmd), (tx): CommandResult => {
    switch (cmd.type) {
      case 'setShaderProps': {
        for (const id of cmd.nodeIds) {
          const node = tx.getNode(id);
          const shader = node && shaderDef(node.component);
          if (!node || !shader) throw new OpError(`Node "${id}" is not a shader layer.`);
          let props = { ...(node.props ?? {}) };
          let background: string | null | undefined;
          if (cmd.preset) {
            const applied = shaderPresetProps(shader, cmd.preset);
            props = { ...applied.props, ...(props.image ? { image: props.image } : {}), ...(props.frame !== undefined ? { frame: props.frame } : {}) };
            background = applied.background;
          }
          try {
            props = applyShaderPropsPatch(shader, props, cmd.patch ?? {});
          } catch (error) {
            throw new OpError(error instanceof Error ? error.message : String(error));
          }
          tx.updateNode(id, (n) => {
            n.props = props;
            if (background !== undefined) {
              if (background) n.styles.backgroundColor = background;
              else delete n.styles.backgroundColor;
            }
          });
        }
        return {};
      }
      case 'createNodes': {
        const ids: string[] = [];
        cmd.nodes.forEach((node, i) => ids.push(createSubtree(tx, cmd.parentId, node, cmd.index === undefined ? undefined : cmd.index + i).id));
        return { ids };
      }
      case 'updateStyles': {
        for (const u of cmd.updates) for (const id of u.nodeIds) patchStyles(tx, id, u.styles);
        return {};
      }
      case 'setText':
        if (cmd.runs?.length) setTextRuns(tx, cmd.nodeId, cmd.runs);
        else setTextValue(tx, cmd.nodeId, cmd.text);
        return {};
      case 'rename': {
        renameNode(tx, cmd.nodeId, cmd.name, 200);
        tx.updateNode(cmd.nodeId, (n) => {
          n.labelIsModified = true;
        });
        return {};
      }
      case 'delete': {
        for (const id of cmd.nodeIds) if (tx.getNode(id)) deleteSubtree(tx, id);
        return {};
      }
      case 'move': {
        for (const m of cmd.moves) {
          moveNode(tx, m.nodeId, m.parentId, m.index);
          if (m.styles) patchStyles(tx, m.nodeId, m.styles);
        }
        return {};
      }
      case 'duplicate': {
        const ids: string[] = [];
        const idMap: Record<string, string> = {};
        for (const id of cmd.nodeIds) {
          const src = tx.getNode(id);
          if (!src?.parentId) continue;
          const parent = tx.getNode(src.parentId)!;
          const place = cmd.place?.[id];
          const { rootId, idMap: map } = duplicateSubtree(tx, id, src.parentId, place?.index ?? parent.children.indexOf(id) + 1);
          Object.assign(idMap, map);
          ids.push(rootId);
          if (place) {
            if (place.styles) patchStyles(tx, rootId, place.styles);
          } else if (parent.component === 'PageRoot') {
            const r = freeformRect(src);
            const spot = findFreeSpot(topLevelBoxes(tx, parent, null, new Set([rootId])), r.width || 400, r.height || 300, {
              anchor: { minX: r.left, minY: r.top, maxX: r.left + (r.width || 400), maxY: r.top + (r.height || 300) },
            });
            patchStyles(tx, rootId, { left: `${spot.x}px`, top: `${spot.y}px` });
          } else if (cmd.offset && (isFreeform(parent) || src.styles.position === 'absolute')) {
            const r = freeformRect(src);
            patchStyles(tx, rootId, { left: `${r.left + cmd.offset.x}px`, top: `${r.top + cmd.offset.y}px` });
          }
        }
        return { ids, idMap };
      }
      case 'setFlags': {
        for (const id of cmd.nodeIds) setNodeFlags(tx, id, { isVisible: cmd.isVisible, isLocked: cmd.isLocked });
        return {};
      }
      case 'setPlayback': {
        for (const id of cmd.nodeIds) {
          const node = tx.getNode(id);
          if (node?.component !== 'Video' && node?.component !== 'Lottie') continue;
          tx.updateNode(id, (n) => {
            const attrs = { ...n.attrs };
            if (cmd.loop !== undefined) {
              if (cmd.loop) delete attrs.loop;
              else attrs.loop = 'false';
            }
            if (cmd.speed !== undefined) {
              const speed = Math.min(16, Math.max(0.1, cmd.speed));
              if (!Number.isFinite(speed) || speed === 1) delete attrs.speed;
              else attrs.speed = String(Math.round(speed * 100) / 100);
            }
            if (Object.keys(attrs).length) n.attrs = attrs;
            else delete n.attrs;
          });
        }
        return {};
      }
      case 'group': {
        const nodes = cmd.nodeIds.map((id) => tx.getNode(id)).filter((n): n is NodeRecord => !!n);
        if (!nodes.length) throw new OpError('Nothing to group');
        const parentId = nodes[0]!.parentId!;
        if (nodes.some((n) => n.parentId !== parentId)) throw new OpError('Only layers with the same parent can be grouped');
        const parent = tx.getNode(parentId)!;
        const byLayer = [...nodes].sort((a, b) => parent.children.indexOf(a.id) - parent.children.indexOf(b.id));
        const order = cmd.ordered ? nodes : byLayer;
        const index = parent.children.indexOf(byLayer[0]!.id);
        // Absolutely positioned layers in a flow frame are wrapped like freeform ones, in place.
        const absolute = !isFreeform(parent) && nodes.every((n) => n.styles.position === 'absolute');
        const freeform = isFreeform(parent) || absolute;
        const rects = order.map(freeformRect);
        const minX = Math.min(...rects.map((r) => r.left));
        const minY = Math.min(...rects.map((r) => r.top));
        const maxX = Math.max(...rects.map((r) => r.left + r.width));
        const maxY = Math.max(...rects.map((r) => r.top + r.height));
        const frame = createSubtree(
          tx,
          parentId,
          {
            component: 'Frame',
            label: cmd.label?.trim() || 'Group',
            styles: freeform
              ? {
                  ...(absolute ? { position: 'absolute' } : {}),
                  left: `${minX}px`,
                  top: `${minY}px`,
                  width: `${maxX - minX}px`,
                  height: `${maxY - minY}px`,
                  display: FREEFORM_DISPLAY,
                }
              : { display: 'flex', flexDirection: parent.styles.flexDirection?.startsWith('row') ? 'row' : 'column', gap: parent.styles.gap ?? '0px' },
          },
          index
        );
        // A wrapper that lays out its children (flex, grid) takes them out of absolute positioning.
        const laidOut = /flex|grid/.test(String(cmd.styles?.display ?? ''));
        order.forEach((n, i) => {
          moveNode(tx, n.id, frame.id, i);
          if (laidOut) patchStyles(tx, n.id, { position: null, left: null, top: null, right: null, bottom: null });
          else if (freeform) {
            const r = freeformRect(n);
            patchStyles(tx, n.id, { left: `${r.left - minX}px`, top: `${r.top - minY}px` });
          }
        });
        if (cmd.styles) patchStyles(tx, frame.id, cmd.styles);
        return { ids: [frame.id] };
      }
      case 'ungroup': {
        const ids: string[] = [];
        for (const id of cmd.nodeIds) {
          const frame = tx.getNode(id);
          if (!frame || frame.component !== 'Frame' || !frame.parentId) continue;
          const parent = tx.getNode(frame.parentId)!;
          let index = parent.children.indexOf(id);
          const offset = freeformRect(frame);
          // Children of a freeform frame keep their place (as absolute layers when the parent is a flow frame).
          const keepPlace = isFreeform(frame) && (isFreeform(parent) || frame.styles.position === 'absolute');
          for (const childId of [...frame.children]) {
            moveNode(tx, childId, parent.id, index++);
            if (keepPlace) {
              const r = freeformRect(tx.getNode(childId)!);
              patchStyles(tx, childId, { ...(isFreeform(parent) ? {} : { position: 'absolute' }), left: `${r.left + offset.left}px`, top: `${r.top + offset.top}px` });
            }
            ids.push(childId);
          }
          deleteSubtree(tx, id);
        }
        return { ids };
      }
      case 'createPage': {
        const pageId = tx.nextPageId();
        const list = tx.getPageList();
        const count = list.filter((p) => p.type === 'page').length;
        tx.putPage(newPageRecord(pageId, cmd.name?.trim() || `Page ${count + 1}`));
        tx.putNode(pageRootNode(pageId));
        tx.setPageList([...list, { type: 'page', id: pageId }]);
        return { pageId };
      }
      case 'updatePage': {
        const page = tx.getPage(cmd.pageId);
        if (!page) throw new OpError(`Page not found: ${cmd.pageId}`);
        const next = { ...page };
        if (cmd.name !== undefined) next.name = cmd.name;
        if (cmd.icon !== undefined) next.icon = cmd.icon;
        if (cmd.canvasColor !== undefined) {
          if (cmd.canvasColor) next.canvasColor = cmd.canvasColor;
          else delete next.canvasColor;
        }
        tx.putPage(next);
        return {};
      }
      case 'deletePage': {
        const list = tx.getPageList();
        const item = list.find((p) => p.id === cmd.pageId);
        if (!item) throw new OpError(`Page not found: ${cmd.pageId}`);
        if (item.type === 'page' && list.filter((p) => p.type === 'page').length <= 1) throw new OpError("The last page can't be deleted");
        if (item.type === 'page') {
          const page = tx.getPage(cmd.pageId)!;
          for (const n of subtreeOf(tx, page.rootId)) tx.removeNodeRecord(n.id);
          tx.removePage(cmd.pageId);
        }
        tx.setPageList(list.filter((p) => p.id !== cmd.pageId));
        return {};
      }
      case 'duplicatePage': {
        const page = tx.getPage(cmd.pageId);
        if (!page) throw new OpError(`Page not found: ${cmd.pageId}`);
        const pageId = tx.nextPageId();
        tx.putPage(newPageRecord(pageId, `${page.name} copy`, page.icon));
        const root = pageRootNode(pageId);
        tx.putNode(root);
        const srcRoot = tx.getNode(page.rootId)!;
        for (const childId of srcRoot.children) duplicateSubtree(tx, childId, root.id);
        const list = tx.getPageList();
        const idx = list.findIndex((p) => p.id === cmd.pageId);
        const next = [...list];
        next.splice(idx + 1, 0, { type: 'page', id: pageId });
        tx.setPageList(next);
        return { pageId };
      }
      case 'arrangePages':
        tx.setPageList(cmd.order);
        return {};
      case 'addDivider': {
        const list = tx.getPageList();
        const idx = cmd.afterId ? list.findIndex((p) => p.id === cmd.afterId) : list.length - 1;
        const next = [...list];
        next.splice(idx + 1, 0, { type: 'divider', id: tx.nextPageId() });
        tx.setPageList(next);
        return {};
      }
      case 'setTokens':
        tx.setTokens(cmd.tokens);
        return {};
      case 'renameFile':
        tx.setName(cmd.name.trim().slice(0, 500) || tx.fileName);
        return {};
      case 'createComment': {
        ensureLocalUser(tx, services.userName);
        const now = Date.now();
        const threadId = newThreadId();
        const nodeId = cmd.nodeId ?? tx.getPage(cmd.pageId)?.rootId;
        if (!nodeId) throw new OpError('Page not found');
        tx.putThread({
          id: threadId,
          pageId: cmd.pageId,
          nodeId,
          xOffset: cmd.position.x,
          yOffset: cmd.position.y,
          status: 'open',
          userId: LOCAL_USER_ID,
          messages: [{ id: newMessageId(), userId: LOCAL_USER_ID, text: cmd.text, mentions: [], reactions: [], attachments: [], createdAt: now, updatedAt: now }],
          createdAt: now,
          updatedAt: now,
        });
        return { threadId };
      }
      case 'replyComment': {
        ensureLocalUser(tx, services.userName);
        const t = tx.getThread(cmd.threadId);
        if (!t) throw new OpError('Comment thread not found');
        const now = Date.now();
        tx.putThread({
          ...t,
          updatedAt: now,
          messages: [...t.messages, { id: newMessageId(), userId: LOCAL_USER_ID, text: cmd.text, mentions: [], reactions: [], attachments: [], createdAt: now, updatedAt: now }],
        });
        return {};
      }
      case 'setCommentStatus': {
        const t = tx.getThread(cmd.threadId);
        if (!t) throw new OpError('Comment thread not found');
        tx.putThread({ ...t, status: cmd.status, updatedAt: Date.now() });
        return {};
      }
      case 'deleteComment': {
        const t = tx.getThread(cmd.threadId);
        if (!t) throw new OpError('Comment thread not found');
        tx.putThread({ ...t, deletedAt: Date.now() });
        return {};
      }
    }
  });
}

function labelFor(cmd: EditorCommand): string {
  switch (cmd.type) {
    case 'createNodes':
      return 'Create';
    case 'updateStyles':
      return 'Edit styles';
    case 'setShaderProps':
      return 'Edit shader';
    case 'setShaderFrame':
      return 'Shader frame';
    case 'setText':
      return 'Edit text';
    case 'rename':
      return 'Rename';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'duplicate':
      return 'Duplicate';
    case 'setFlags':
      return 'Change visibility';
    case 'setPlayback':
      return 'Change playback';
    case 'group':
      return 'Group';
    case 'ungroup':
      return 'Ungroup';
    default:
      return cmd.type;
  }
}
