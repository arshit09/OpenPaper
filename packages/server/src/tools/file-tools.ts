import {
  basicInfo,
  describePageList,
  newPageRecord,
  pageRootNode,
  parseFileReference,
  readerOf,
  type PageListItem,
} from '@openpaper/core';
import { activePageId, editorUrl, layoutFor, resolvePageId, ToolError, type Call, type HandlerResult } from './context.ts';
import { GUIDE_TOPICS, PAGE_ICONS } from './definitions.ts';
import { guideContent } from './guides.ts';

const ADJECTIVES = ['Quiet', 'Bright', 'Gentle', 'Bold', 'Velvet', 'Crisp', 'Golden', 'Hidden', 'Lucky', 'Amber', 'Silver', 'Misty', 'Brave', 'Calm', 'Wild', 'Sunny'];
const NOUNS = ['harbor', 'meadow', 'canyon', 'lantern', 'orchard', 'comet', 'garden', 'river', 'atlas', 'pebble', 'summit', 'island', 'compass', 'feather', 'grove', 'studio'];

function randomName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

function normalizeName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, 500);
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export async function openFile(call: Call): Promise<HandlerResult> {
  const ref = parseFileReference(call.args.fileId);
  if (!ref) throw new ToolError('Could not parse a file ID from the provided value');
  if (!call.env.store.has(ref.fileId)) throw new ToolError(`File not found: ${ref.fileId}`);
  const live = await call.env.hub.get(ref.fileId);
  const sub: Call = { ...call, live };
  const requested = (typeof call.args.pageId === 'string' && call.args.pageId.trim()) || ref.pageId || undefined;
  const pageId = resolvePageId(sub, requested);
  call.env.agentOpenedFile(live.id, requested ?? null, call.actor.name);
  const layout = await layoutFor(sub, pageId);
  return {
    data: basicInfo(readerOf(live.doc), { pageId, activePageId: activePageId(sub), layout, url: editorUrl(call, live.id, pageId) }),
  };
}

export async function listResources(call: Call): Promise<HandlerResult> {
  const limit = (call.args.limit as number | undefined) ?? 50;
  const all = call.env.store.list();
  const openIds = call.env.views.openFileIds();
  const activeId = call.env.views.activeFileId();
  const byId = new Map(all.map((r) => [r.id, r]));
  const items: Array<Record<string, unknown>> = [];
  for (const id of openIds) {
    const r = byId.get(id);
    if (!r) continue;
    items.push({
      id: r.id,
      name: r.name,
      type: 'file',
      ...(r.parentId && byId.has(r.parentId) ? { parentId: r.parentId } : {}),
      updatedAt: ms(r.updatedAt),
      createdAt: ms(r.createdAt),
      open: true,
      ...(id === activeId ? { active: true } : {}),
    });
  }
  const rest = all
    .filter((r) => !openIds.includes(r.id))
    .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      ...(r.parentId ? { parentId: r.parentId } : {}),
      updatedAt: ms(r.updatedAt),
      createdAt: ms(r.createdAt),
    }));
  const combined = [...items, ...rest];
  const out: Record<string, unknown> = {
    teamId: 'local',
    teamName: 'This computer',
    resources: combined.slice(0, limit),
    count: combined.length,
  };
  if (combined.length > limit) {
    out.truncated = true;
    out.truncatedMessage = `Showing first ${limit} of ${combined.length} files and folders. Pass a larger limit (up to 200) to see more.`;
  }
  return { data: out };
}

export async function createFile(call: Call): Promise<HandlerResult> {
  const name = normalizeName(call.args.name) || randomName();
  let cloneFrom;
  if (call.args.cloneFileId) {
    const ref = parseFileReference(call.args.cloneFileId);
    if (!ref || !call.env.store.has(ref.fileId)) throw new ToolError('Failed to create file');
    const source = await call.env.hub.get(ref.fileId);
    await source.flush();
    cloneFrom = source.doc;
  }
  const doc = await call.env.store.create({ name, cloneFrom });
  call.env.hub.adopt(doc);
  call.env.resourcesChanged();
  return { data: { fileId: doc.id, url: editorUrl(call, doc.id) } };
}

export async function renameResource(call: Call): Promise<HandlerResult> {
  const id = String(call.args.resourceId);
  const entry = call.env.store.get(id);
  if (!entry) throw new ToolError(`Resource not found: ${id}`);
  const name = normalizeName(call.args.name);
  if (!name || name === entry.name) return { data: { resourceId: id, name: entry.name, type: entry.type } };
  try {
    if (entry.type === 'file') {
      const live = await call.env.hub.get(id);
      live.transact(call.actor, 'rename file', (tx) => tx.setName(name));
      await live.flush();
    } else {
      await call.env.store.renameFolder(id, name);
    }
  } catch {
    throw new ToolError(`Couldn't rename "${entry.name}". Please try again.`);
  }
  call.env.resourcesChanged();
  return { data: { resourceId: id, name, type: entry.type } };
}

export async function getGuide(call: Call): Promise<HandlerResult> {
  const topic = String(call.args.topic);
  const content = guideContent(topic, () => call.env.images.guide());
  if (content === null) {
    return {
      content: [
        { type: 'text', text: `Unknown guide topic: "${topic}". Available topics: ${GUIDE_TOPICS.map(([t]) => t).join(', ')}` },
      ],
    };
  }
  return { content: [{ type: 'text', text: content }] };
}

// ---- pages -----------------------------------------------------------------

function liveOf(call: Call) {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  return call.live;
}

export async function createPage(call: Call): Promise<HandlerResult> {
  const live = liveOf(call);
  const after = activePageId(call);
  const result = live.transact(call.actor, 'create_page', (tx) => {
    const pageId = tx.nextPageId();
    const list = tx.getPageList();
    const names = new Set(list.filter((p) => p.type === 'page').map((p) => tx.getPage(p.id)?.name));
    let n = list.filter((p) => p.type === 'page').length + 1;
    while (names.has(`Page ${n}`)) n++;
    const name = call.args.name ? String(call.args.name) : `Page ${n}`;
    const icon = (call.args.icon as string | undefined) ?? null;
    const page = newPageRecord(pageId, name, icon);
    tx.putPage(page);
    tx.putNode(pageRootNode(pageId));
    const idx = list.findIndex((p) => p.id === after);
    const next = [...list];
    next.splice(idx >= 0 ? idx + 1 : next.length, 0, { type: 'page', id: pageId });
    tx.setPageList(next);
    return { pageId, name, icon };
  });
  return { data: result };
}

export async function updatePages(call: Call): Promise<HandlerResult> {
  const live = liveOf(call);
  const items = call.args.updates as Array<{ pageId: string; name?: string; icon?: string | null }>;
  if (!items.length) throw new ToolError('No updates provided');
  const updates: Array<{ pageId: string; name: string; icon: string | null }> = [];
  const errors: Array<{ pageId: string; error: string }> = [];
  live.transact(call.actor, 'update_pages', (tx) => {
    for (const u of items) {
      const item = tx.getPageList().find((p) => p.id === u.pageId);
      if (item?.type === 'divider') {
        errors.push({ pageId: u.pageId, error: `${u.pageId} is a divider, which has no name or icon` });
        continue;
      }
      const page = tx.getPage(u.pageId);
      if (!page) {
        errors.push({ pageId: u.pageId, error: `Page not found: ${u.pageId}` });
        continue;
      }
      if (u.name === undefined && u.icon === undefined) {
        errors.push({ pageId: u.pageId, error: 'Nothing to update: pass name, icon, or both' });
        continue;
      }
      const next = { ...page };
      if (u.name !== undefined) next.name = u.name;
      if (u.icon !== undefined) next.icon = u.icon;
      tx.putPage(next);
      updates.push({ pageId: next.id, name: next.name, icon: next.icon && (PAGE_ICONS as readonly string[]).includes(next.icon) ? next.icon : null });
    }
  });
  return { data: { updates, ...(errors.length ? { errors } : {}) } };
}

export async function arrangePages(call: Call): Promise<HandlerResult> {
  const live = liveOf(call);
  const order = call.args.order as Array<string | { type: 'divider' }>;
  const remove = (call.args.removeDividerIds as string[] | undefined) ?? [];
  const current = live.doc.pageList;
  const byId = new Map(current.map((p) => [p.id, p]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of order) {
    if (typeof item !== 'string') continue;
    if (seen.has(item)) problems.push(`${item} is listed more than once in order`);
    else if (!byId.has(item)) problems.push(`${item} is not in the page list`);
    seen.add(item);
  }
  for (const id of remove) {
    const item = byId.get(id);
    if (!item) problems.push(`${id} in removeDividerIds is not in the page list`);
    else if (item.type === 'page') problems.push(`${id} in removeDividerIds is a page; only dividers can be removed`);
    if (seen.has(id)) problems.push(`${id} is listed both in order and in removeDividerIds`);
  }
  for (const item of current) {
    if (seen.has(item.id) || remove.includes(item.id)) continue;
    if (item.type === 'divider') problems.push(`Divider ${item.id} is missing from order; list it or add it to removeDividerIds`);
    else problems.push(`Page ${item.id} ("${live.doc.pages[item.id]?.name ?? ''}") is missing from order`);
  }
  if (problems.length) {
    throw new ToolError(`Nothing was changed:\n${problems.map((p) => `- ${p}`).join('\n')}\nCall get_basic_info for the current page list.`);
  }
  live.transact(call.actor, 'arrange_pages', (tx) => {
    const next: PageListItem[] = [];
    for (const item of order) {
      if (typeof item === 'string') next.push(byId.get(item)!);
      else next.push({ type: 'divider', id: tx.nextPageId() });
    }
    tx.setPageList(next);
  });
  return { data: { pages: describePageList(readerOf(live.doc), activePageId(call)) } };
}
