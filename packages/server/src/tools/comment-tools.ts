import { displayName, type CommentMessage, type CommentThread, type PaperDocument } from '@openpaper/core';
import { record, ToolError, type Call, type HandlerResult } from './context.ts';

export const LOCAL_USER_ID = 'local-user';

function visibleMessages(t: CommentThread): CommentMessage[] {
  return t.messages.filter((m) => !m.deletedAt);
}

function visibleThreads(d: PaperDocument): CommentThread[] {
  return Object.values(d.comments).filter((t) => !t.deletedAt && visibleMessages(t).length > 0);
}

function displayNameOf(d: PaperDocument, userId: string): string | null {
  return d.users?.[userId]?.displayName ?? null;
}

function nodeContext(d: PaperDocument, t: CommentThread) {
  const node = d.nodes[t.nodeId];
  if (!node) return null;
  if (node.component === 'PageRoot') return { id: node.id, name: '(page root)', component: 'PageRoot' };
  return { id: node.id, name: node.labelIsModified ? node.label : displayName(node), component: node.component };
}

function resolveUser(userId: string | undefined): string | undefined {
  if (userId === 'current-user') return LOCAL_USER_ID;
  return userId;
}

function preview(text: string, length: number): { text: string; truncated: boolean } {
  if (text.length <= length) return { text, truncated: false };
  let cut = text.slice(0, Math.max(0, length - 15));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${cut}... [truncated]`, truncated: true };
}

export async function listCommentThreads(call: Call): Promise<HandlerResult> {
  const d = call.live!.doc;
  const a = call.args;
  const status = (a.status as string | undefined) ?? 'open';
  const viewPage = call.env.views.viewFor(d.id)?.pageId ?? null;
  const pageFilter = (a.pageId as string | undefined) ?? (a.currentPageOnly ? viewPage : undefined);
  const participant = resolveUser(a.participantUserId);
  const author = resolveUser(a.threadAuthorUserId);
  const search = typeof a.search === 'string' ? a.search.trim().toLowerCase() : '';
  const scope = (a.searchScope as string | undefined) ?? 'all-messages';

  let threads = visibleThreads(d).filter((t) => {
    if (pageFilter && t.pageId !== pageFilter) return false;
    if (a.nodeId && t.nodeId !== a.nodeId) return false;
    if (author && t.userId !== author) return false;
    if (participant && !visibleMessages(t).some((m) => m.userId === participant)) return false;
    if (status !== 'all' && t.status !== status) return false;
    if (search) {
      const msgs = visibleMessages(t);
      const parts =
        scope === 'first-message'
          ? [displayNameOf(d, msgs[0]!.userId), msgs[0]!.text]
          : [displayNameOf(d, t.userId), ...msgs.map((m) => displayNameOf(d, m.userId)), ...msgs.map((m) => m.text)];
      if (!parts.filter(Boolean).join('\n').toLowerCase().includes(search)) return false;
    }
    return true;
  });

  const sortField = (a.sortField as string | undefined) ?? 'page';
  const dir = a.sortDirection === 'desc' ? -1 : 1;
  const pageIndex = (pid: string) => {
    const i = d.pageList.findIndex((p) => p.id === pid);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  threads = threads
    .map((t, i) => ({ t, i }))
    .sort((x, y) => {
      if (sortField === 'page') return (pageIndex(x.t.pageId) - pageIndex(y.t.pageId)) * dir || x.t.createdAt - y.t.createdAt || x.i - y.i;
      const key = sortField === 'updatedAt' ? 'updatedAt' : 'createdAt';
      return (x.t[key] - y.t[key]) * dir || x.i - y.i;
    })
    .map((x) => x.t);

  const offset = (a.offset as number | undefined) ?? 0;
  const limit = (a.limit as number | undefined) ?? 50;
  const previewLength = (a.previewLength as number | undefined) ?? 240;
  const page = threads.slice(offset, offset + limit);
  const pinned = new Set<string>();
  const out = page.map((t) => {
    const msgs = visibleMessages(t);
    const first = msgs[0]!;
    const p = preview(first.text, previewLength);
    if (d.nodes[t.nodeId]) pinned.add(t.nodeId);
    return {
      commentThreadId: t.id,
      pageId: t.pageId,
      pageName: d.pages[t.pageId]?.name ?? null,
      nodeId: t.nodeId,
      node: nodeContext(d, t),
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: msgs.length,
      replyCount: Math.max(0, msgs.length - 1),
      authorUserId: t.userId,
      authorDisplayName: displayNameOf(d, t.userId),
      firstMessagePreview: {
        messageId: first.id,
        authorUserId: first.userId,
        authorDisplayName: displayNameOf(d, first.userId),
        text: p.text,
        truncated: p.truncated,
        createdAt: first.createdAt,
        updatedAt: first.updatedAt,
      },
    };
  });
  record(call, [...pinned], 'read');
  const result: Record<string, unknown> = { commentThreads: out, count: threads.length, offset };
  if (offset + out.length < threads.length) {
    result.truncated = true;
    result.truncatedMessage = `Showing ${out.length} of ${threads.length} matching comment threads. Increase offset to see more.`;
  }
  return { data: result };
}

export async function getCommentThread(call: Call): Promise<HandlerResult> {
  const d = call.live!.doc;
  const id = String(call.args.commentThreadId);
  const t = visibleThreads(d).find((x) => x.id === id);
  if (!t) throw new ToolError(`Comment thread not found: ${id}`);
  const msgs = visibleMessages(t);
  if (d.nodes[t.nodeId]) record(call, [t.nodeId], 'read');
  return {
    data: {
      commentThreadId: t.id,
      pageId: t.pageId,
      pageName: d.pages[t.pageId]?.name ?? null,
      nodeId: t.nodeId,
      node: nodeContext(d, t),
      status: t.status,
      xOffset: t.xOffset,
      yOffset: t.yOffset,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      authorUserId: t.userId,
      authorDisplayName: displayNameOf(d, t.userId),
      messageCount: msgs.length,
      replyCount: Math.max(0, msgs.length - 1),
      messages: msgs.map((m) => ({
        messageId: m.id,
        authorUserId: m.userId,
        authorDisplayName: displayNameOf(d, m.userId),
        text: m.text,
        mentions: m.mentions,
        reactions: m.reactions,
        attachments: m.attachments,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    },
  };
}

export async function listCommentThreadAuthors(call: Call): Promise<HandlerResult> {
  const d = call.live!.doc;
  const pageId = call.args.pageId as string | undefined;
  const stats = new Map<string, { threadsStarted: number; messageCount: number; lastActivityAt: number }>();
  const bump = (userId: string) => {
    let s = stats.get(userId);
    if (!s) {
      s = { threadsStarted: 0, messageCount: 0, lastActivityAt: 0 };
      stats.set(userId, s);
    }
    return s;
  };
  for (const t of visibleThreads(d)) {
    if (pageId && t.pageId !== pageId) continue;
    const a = bump(t.userId);
    a.threadsStarted++;
    a.lastActivityAt = Math.max(a.lastActivityAt, t.createdAt);
    for (const m of visibleMessages(t)) {
      const s = bump(m.userId);
      s.messageCount++;
      s.lastActivityAt = Math.max(s.lastActivityAt, m.updatedAt);
    }
  }
  const authors = [...stats.entries()]
    .map(([userId, s]) => ({ userId, displayName: displayNameOf(d, userId), ...s }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { data: { authors, count: authors.length } };
}

export async function setCommentThreadStatus(call: Call): Promise<HandlerResult> {
  const live = call.live!;
  const id = String(call.args.commentThreadId);
  const status = call.args.status as 'open' | 'resolved';
  const t = visibleThreads(live.doc).find((x) => x.id === id);
  if (!t) throw new ToolError(`Comment thread not found: ${id}`);
  if (t.status !== status) {
    live.transact(call.actor, `Mark comment ${status}`, (tx) => {
      tx.putThread({ ...t, status, updatedAt: Date.now() });
    });
  }
  return { data: { commentThreadId: id, status } };
}
