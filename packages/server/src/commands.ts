import {
  collectImageUrls,
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
  setTextValue,
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
    const resolved = await services.assets.resolveAll(collectImageUrls(cmd.html));
    return live.transact(actor, 'Paste', (tx) => {
      const imported = importHtml(cmd.html, {
        resolveImage: (u) => (resolved.has(u) ? resolved.get(u) : undefined),
        nodeExists: (id) => !!tx.getNode(id),
      });
      if (!imported.roots.length) throw new OpError('Nothing to paste');
      const parent = tx.getNode(cmd.parentId);
      if (!parent) throw new OpError(`Node not found: ${cmd.parentId}`);
      const placed: Array<{ minX: number; minY: number; maxX: number; maxY: number }> = [];
      const result = insertImported(tx, imported.roots, cmd.parentId, 'insert-children', {
        placeTopLevel:
          parent.component === 'PageRoot'
            ? (styles) => {
                const w = pxValue(styles.width) ?? 400;
                const h = pxValue(styles.height) ?? 300;
                const spot = findFreeSpot([...topLevelBoxes(tx, tx.getNode(cmd.parentId)!, null), ...placed], w, h);
                placed.push({ minX: spot.x, minY: spot.y, maxX: spot.x + w, maxY: spot.y + h });
                return spot;
              }
            : undefined,
      });
      return { ids: result.topLevelIds };
    });
  }

  return live.transact(actor, labelFor(cmd), (tx): CommandResult => {
    switch (cmd.type) {
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
        setTextValue(tx, cmd.nodeId, cmd.text);
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
          const { rootId, idMap: map } = duplicateSubtree(tx, id, src.parentId, parent.children.indexOf(id) + 1);
          Object.assign(idMap, map);
          ids.push(rootId);
          if (parent.component === 'PageRoot') {
            const r = freeformRect(src);
            const spot = findFreeSpot(topLevelBoxes(tx, parent, null, new Set([rootId])), r.width || 400, r.height || 300, {
              anchor: { minX: r.left, minY: r.top, maxX: r.left + (r.width || 400), maxY: r.top + (r.height || 300) },
            });
            patchStyles(tx, rootId, { left: `${spot.x}px`, top: `${spot.y}px` });
          } else if (cmd.offset && isFreeform(parent)) {
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
      case 'group': {
        const nodes = cmd.nodeIds.map((id) => tx.getNode(id)).filter((n): n is NodeRecord => !!n);
        if (!nodes.length) throw new OpError('Nothing to group');
        const parentId = nodes[0]!.parentId!;
        if (nodes.some((n) => n.parentId !== parentId)) throw new OpError('Only layers with the same parent can be grouped');
        const parent = tx.getNode(parentId)!;
        const order = [...nodes].sort((a, b) => parent.children.indexOf(a.id) - parent.children.indexOf(b.id));
        const index = parent.children.indexOf(order[0]!.id);
        const freeform = isFreeform(parent);
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
            label: 'Group',
            styles: freeform
              ? { left: `${minX}px`, top: `${minY}px`, width: `${maxX - minX}px`, height: `${maxY - minY}px`, display: FREEFORM_DISPLAY }
              : { display: 'flex', flexDirection: parent.styles.flexDirection?.startsWith('row') ? 'row' : 'column', gap: parent.styles.gap ?? '0px' },
          },
          index
        );
        order.forEach((n, i) => {
          moveNode(tx, n.id, frame.id, i);
          if (freeform) {
            const r = freeformRect(n);
            patchStyles(tx, n.id, { left: `${r.left - minX}px`, top: `${r.top - minY}px` });
          }
        });
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
          for (const childId of [...frame.children]) {
            moveNode(tx, childId, parent.id, index++);
            if (isFreeform(parent) && isFreeform(frame)) {
              const r = freeformRect(tx.getNode(childId)!);
              patchStyles(tx, childId, { left: `${r.left + offset.left}px`, top: `${r.top + offset.top}px` });
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
    case 'group':
      return 'Group';
    case 'ungroup':
      return 'Ungroup';
    default:
      return cmd.type;
  }
}
