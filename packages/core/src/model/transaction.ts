import type {
  CommentThread,
  CommentUser,
  DocCounters,
  KeyframesRecord,
  NodeRecord,
  PageListItem,
  PageRecord,
  PaperDocument,
  TokenRecord,
} from './types.ts';
import { formatNodeId, formatPageId } from './ids.ts';
import { cloneRuns } from './text-runs.ts';

/**
 * A Patch is the unit of change that flows from the server to every editor.
 * Records are replaced wholesale (no field-level diffs) which keeps clients trivial.
 */
export interface Patch {
  nodes?: { upsert: NodeRecord[]; remove: string[] };
  pages?: { upsert: PageRecord[]; remove: string[] };
  pageList?: PageListItem[];
  tokens?: TokenRecord[];
  keyframes?: KeyframesRecord[];
  comments?: { upsert: CommentThread[]; remove: string[] };
  /** Full replacement of the comment-author map. */
  users?: Record<string, CommentUser>;
  meta?: { name?: string; counters?: DocCounters; updatedAt?: string };
}

export function isEmptyPatch(p: Patch): boolean {
  return (
    !p.nodes?.upsert.length &&
    !p.nodes?.remove.length &&
    !p.pages?.upsert.length &&
    !p.pages?.remove.length &&
    !p.pageList &&
    !p.tokens &&
    !p.keyframes &&
    !p.comments?.upsert.length &&
    !p.comments?.remove.length &&
    !p.users &&
    (!p.meta || (p.meta.name === undefined && p.meta.counters === undefined))
  );
}

/** Apply a patch, returning a new document (structural sharing for untouched records). */
export function applyPatch(doc: PaperDocument, patch: Patch): PaperDocument {
  const next: PaperDocument = { ...doc };
  if (patch.nodes) {
    const nodes = { ...doc.nodes };
    for (const id of patch.nodes.remove) delete nodes[id];
    for (const n of patch.nodes.upsert) nodes[n.id] = n;
    next.nodes = nodes;
  }
  if (patch.pages) {
    const pages = { ...doc.pages };
    for (const id of patch.pages.remove) delete pages[id];
    for (const p of patch.pages.upsert) pages[p.id] = p;
    next.pages = pages;
  }
  if (patch.pageList) next.pageList = patch.pageList;
  if (patch.tokens) next.tokens = patch.tokens;
  if (patch.keyframes) next.keyframes = patch.keyframes;
  if (patch.comments) {
    const comments = { ...doc.comments };
    for (const id of patch.comments.remove) delete comments[id];
    for (const t of patch.comments.upsert) comments[t.id] = t;
    next.comments = comments;
  }
  if (patch.users) next.users = patch.users;
  if (patch.meta) {
    if (patch.meta.name !== undefined) next.name = patch.meta.name;
    if (patch.meta.counters !== undefined) {
      // Counters only move forward, even when an undo replays an older patch.
      next.counters = {
        nodes: Math.max(doc.counters.nodes, patch.meta.counters.nodes),
        pages: Math.max(doc.counters.pages, patch.meta.counters.pages),
      };
    }
    if (patch.meta.updatedAt !== undefined) next.updatedAt = patch.meta.updatedAt;
  }
  return next;
}

/** Read access shared by documents and in-flight transactions. */
export interface DocReader {
  getNode(id: string): NodeRecord | undefined;
  getPage(id: string): PageRecord | undefined;
  getPageList(): PageListItem[];
  getTokens(): TokenRecord[];
  getKeyframes(): KeyframesRecord[];
  getThread(id: string): CommentThread | undefined;
  allThreads(): CommentThread[];
  allNodes(): Iterable<NodeRecord>;
  readonly fileId: string;
  readonly fileName: string;
}

export function readerOf(doc: PaperDocument): DocReader {
  return {
    getNode: (id) => doc.nodes[id],
    getPage: (id) => doc.pages[id],
    getPageList: () => doc.pageList,
    getTokens: () => doc.tokens,
    getKeyframes: () => doc.keyframes ?? [],
    getThread: (id) => doc.comments[id],
    allThreads: () => Object.values(doc.comments),
    allNodes: () => Object.values(doc.nodes),
    fileId: doc.id,
    fileName: doc.name,
  };
}

function cloneNode(n: NodeRecord): NodeRecord {
  return {
    ...n,
    children: [...n.children],
    styles: { ...n.styles },
    ...(n.attrs ? { attrs: { ...n.attrs } } : {}),
    ...(n.textRuns ? { textRuns: cloneRuns(n.textRuns) } : {}),
    ...(n.imageGeneration ? { imageGeneration: { ...n.imageGeneration } } : {}),
  };
}

/**
 * Copy-on-write transaction over a document. Mutate through the helpers, then
 * `commit()` to get the new document plus forward/inverse patches.
 */
export class Transaction implements DocReader {
  private readonly touchedNodes = new Map<string, NodeRecord | null>();
  private readonly touchedPages = new Map<string, PageRecord | null>();
  private readonly touchedThreads = new Map<string, CommentThread | null>();
  private pageListValue: PageListItem[] | undefined;
  private tokensValue: TokenRecord[] | undefined;
  private keyframesValue: KeyframesRecord[] | undefined;
  private usersValue: Record<string, CommentUser> | undefined;
  private nameValue: string | undefined;
  private readonly counters: DocCounters;

  constructor(readonly base: PaperDocument) {
    this.counters = { ...base.counters };
  }

  get fileId() {
    return this.base.id;
  }
  get fileName() {
    return this.nameValue ?? this.base.name;
  }

  // ---- reads -------------------------------------------------------------
  getNode(id: string): NodeRecord | undefined {
    if (this.touchedNodes.has(id)) return this.touchedNodes.get(id) ?? undefined;
    return this.base.nodes[id];
  }
  getPage(id: string): PageRecord | undefined {
    if (this.touchedPages.has(id)) return this.touchedPages.get(id) ?? undefined;
    return this.base.pages[id];
  }
  getPageList(): PageListItem[] {
    return this.pageListValue ?? this.base.pageList;
  }
  getTokens(): TokenRecord[] {
    return this.tokensValue ?? this.base.tokens;
  }
  getKeyframes(): KeyframesRecord[] {
    return this.keyframesValue ?? this.base.keyframes ?? [];
  }
  getThread(id: string): CommentThread | undefined {
    if (this.touchedThreads.has(id)) return this.touchedThreads.get(id) ?? undefined;
    return this.base.comments[id];
  }
  allThreads(): CommentThread[] {
    const out = new Map<string, CommentThread>();
    for (const t of Object.values(this.base.comments)) out.set(t.id, t);
    for (const [id, t] of this.touchedThreads) {
      if (t) out.set(id, t);
      else out.delete(id);
    }
    return [...out.values()];
  }
  *allNodes(): Iterable<NodeRecord> {
    for (const n of Object.values(this.base.nodes)) {
      if (!this.touchedNodes.has(n.id)) yield n;
    }
    for (const n of this.touchedNodes.values()) if (n) yield n;
  }

  // ---- writes ------------------------------------------------------------
  /** Mint a fresh node id. */
  nextNodeId(): string {
    let id = formatNodeId(++this.counters.nodes);
    // Guard against collisions with ids imported from elsewhere.
    while (this.getNode(id)) id = formatNodeId(++this.counters.nodes);
    return id;
  }

  /** Mint a fresh page id. */
  nextPageId(): string {
    let id = formatPageId(++this.counters.pages);
    while (this.getPage(id)) id = formatPageId(++this.counters.pages);
    return id;
  }

  putNode(node: NodeRecord): void {
    this.touchedNodes.set(node.id, node);
  }

  /** Clone-then-mutate a node. Returns the new record, or undefined if missing. */
  updateNode(id: string, fn: (draft: NodeRecord) => void): NodeRecord | undefined {
    const current = this.getNode(id);
    if (!current) return undefined;
    const draft = cloneNode(current);
    fn(draft);
    this.touchedNodes.set(id, draft);
    return draft;
  }

  removeNodeRecord(id: string): void {
    this.touchedNodes.set(id, null);
  }

  putPage(page: PageRecord): void {
    this.touchedPages.set(page.id, page);
  }
  removePage(id: string): void {
    this.touchedPages.set(id, null);
  }
  setPageList(list: PageListItem[]): void {
    this.pageListValue = list;
  }
  setTokens(tokens: TokenRecord[]): void {
    this.tokensValue = tokens;
  }
  setKeyframes(keyframes: KeyframesRecord[]): void {
    this.keyframesValue = keyframes;
  }
  putThread(thread: CommentThread): void {
    this.touchedThreads.set(thread.id, thread);
  }
  removeThread(id: string): void {
    this.touchedThreads.set(id, null);
  }
  setName(name: string): void {
    this.nameValue = name;
  }
  /** Raise the id counters to at least `counters` (content from elsewhere may already use the ids below them). */
  raiseCounters(counters: DocCounters): void {
    this.counters.nodes = Math.max(this.counters.nodes, counters.nodes);
    this.counters.pages = Math.max(this.counters.pages, counters.pages);
  }
  getUsers(): Record<string, CommentUser> {
    return this.usersValue ?? this.base.users ?? {};
  }
  putUser(user: CommentUser): void {
    this.usersValue = { ...this.getUsers(), [user.userId]: user };
  }

  get hasChanges(): boolean {
    return (
      this.touchedNodes.size > 0 ||
      this.touchedPages.size > 0 ||
      this.touchedThreads.size > 0 ||
      this.pageListValue !== undefined ||
      this.tokensValue !== undefined ||
      this.keyframesValue !== undefined ||
      this.usersValue !== undefined ||
      this.nameValue !== undefined ||
      this.counters.nodes !== this.base.counters.nodes ||
      this.counters.pages !== this.base.counters.pages
    );
  }

  /** Build forward + inverse patches and the resulting document. */
  commit(now = new Date().toISOString()): { doc: PaperDocument; patch: Patch; inverse: Patch } {
    const base = this.base;
    const patch: Patch = {};
    const inverse: Patch = {};

    if (this.touchedNodes.size) {
      const fwd = { upsert: [] as NodeRecord[], remove: [] as string[] };
      const inv = { upsert: [] as NodeRecord[], remove: [] as string[] };
      for (const [id, value] of this.touchedNodes) {
        const before = base.nodes[id];
        if (value) fwd.upsert.push(value);
        else if (before) fwd.remove.push(id);
        if (before) inv.upsert.push(before);
        else if (value) inv.remove.push(id);
      }
      patch.nodes = fwd;
      inverse.nodes = inv;
    }
    if (this.touchedPages.size) {
      const fwd = { upsert: [] as PageRecord[], remove: [] as string[] };
      const inv = { upsert: [] as PageRecord[], remove: [] as string[] };
      for (const [id, value] of this.touchedPages) {
        const before = base.pages[id];
        if (value) fwd.upsert.push(value);
        else if (before) fwd.remove.push(id);
        if (before) inv.upsert.push(before);
        else if (value) inv.remove.push(id);
      }
      patch.pages = fwd;
      inverse.pages = inv;
    }
    if (this.touchedThreads.size) {
      const fwd = { upsert: [] as CommentThread[], remove: [] as string[] };
      const inv = { upsert: [] as CommentThread[], remove: [] as string[] };
      for (const [id, value] of this.touchedThreads) {
        const before = base.comments[id];
        if (value) fwd.upsert.push(value);
        else if (before) fwd.remove.push(id);
        if (before) inv.upsert.push(before);
        else if (value) inv.remove.push(id);
      }
      patch.comments = fwd;
      inverse.comments = inv;
    }
    if (this.pageListValue) {
      patch.pageList = this.pageListValue;
      inverse.pageList = base.pageList;
    }
    if (this.tokensValue) {
      patch.tokens = this.tokensValue;
      inverse.tokens = base.tokens;
    }
    if (this.keyframesValue) {
      patch.keyframes = this.keyframesValue;
      inverse.keyframes = base.keyframes ?? [];
    }
    if (this.usersValue) {
      patch.users = this.usersValue;
      inverse.users = base.users ?? {};
    }
    patch.meta = { updatedAt: now };
    inverse.meta = { updatedAt: now };
    if (this.nameValue !== undefined) {
      patch.meta.name = this.nameValue;
      inverse.meta.name = base.name;
    }
    if (this.counters.nodes !== base.counters.nodes || this.counters.pages !== base.counters.pages) {
      patch.meta.counters = { ...this.counters };
    }

    return { doc: applyPatch(base, patch), patch, inverse };
  }
}
