import { EventEmitter } from 'node:events';
import {
  applyPatch,
  isEmptyPatch,
  OpError,
  Transaction,
  type CommentThread,
  type NodeRecord,
  type PageRecord,
  type Patch,
  type PaperDocument,
} from '@openpaper/core';
import type { FileStore } from './storage.ts';

export interface ActorRef {
  kind: 'user' | 'agent' | 'system';
  /** Editor client id or MCP session id. */
  id: string;
  name: string;
}

export interface CommitEvent {
  fileId: string;
  version: number;
  patch: Patch;
  actor: ActorRef;
  label: string;
}

/**
 * The records a history entry touches, as they were right after it was (re)applied. Later edits by
 * others are found by comparing against these, so an entry keeps only what it touched, not a whole
 * document (500 snapshots of a large file would hold hundreds of MB).
 */
interface Touched {
  nodes: Map<string, NodeRecord | undefined>;
  pages: Map<string, PageRecord | undefined>;
  comments: Map<string, CommentThread | undefined>;
  pageList?: PaperDocument['pageList'];
  tokens?: PaperDocument['tokens'];
  keyframes?: PaperDocument['keyframes'];
  users?: PaperDocument['users'];
  name?: string;
}

interface HistoryEntry {
  /** Who made the change. */
  author: ActorRef;
  label: string;
  forward: Patch;
  inverse: Patch;
  after: Touched;
}

type Keyed = 'nodes' | 'pages' | 'comments';

const SAVE_DEBOUNCE_MS = 400;
/** Longest a change waits to be saved while changes keep coming (an agent streaming writes). */
const SAVE_MAX_WAIT_MS = 3000;
/** Undo steps kept per author, and in all, per file. */
const MAX_HISTORY_PER_AUTHOR = 200;
const MAX_HISTORY = 1000;

/**
 * Whose undo reaches a change: its author's, and for an agent's change, every person's as well
 * (Ctrl+Z steps back through what the agents did too; the Agents panel undoes one agent only).
 */
function reaches(undoer: ActorRef, author: ActorRef): boolean {
  return actorKey(undoer) === actorKey(author) || (undoer.kind === 'user' && author.kind === 'agent');
}

function patchIds(patch: Patch, part: Keyed): string[] {
  const p = patch[part];
  return p ? [...p.upsert.map((r) => r.id), ...p.remove] : [];
}

/** What `forward` and `inverse` touch, as it stands in `doc`. */
function touched(doc: PaperDocument, forward: Patch, inverse: Patch): Touched {
  const pick = <T>(records: Record<string, T>, part: Keyed) => {
    const out = new Map<string, T | undefined>();
    for (const id of [...patchIds(forward, part), ...patchIds(inverse, part)]) out.set(id, records[id]);
    return out;
  };
  const either = (has: (p: Patch) => boolean) => has(forward) || has(inverse);
  return {
    nodes: pick(doc.nodes, 'nodes'),
    pages: pick(doc.pages, 'pages'),
    comments: pick(doc.comments, 'comments'),
    pageList: either((p) => !!p.pageList) ? doc.pageList : undefined,
    tokens: either((p) => !!p.tokens) ? doc.tokens : undefined,
    keyframes: either((p) => !!p.keyframes) ? doc.keyframes : undefined,
    users: either((p) => !!p.users) ? doc.users : undefined,
    name: either((p) => p.meta?.name !== undefined) ? doc.name : undefined,
  };
}

/** `patch` cut down to the records `kept` (an applied subset of it, or of its inverse) contains. */
function restrict(patch: Patch, kept: Patch): Patch {
  const out: Patch = {};
  for (const part of ['nodes', 'pages', 'comments'] as const) {
    const p = patch[part];
    if (!p) continue;
    const ids = new Set(patchIds(kept, part));
    // (The three parts share a shape; TypeScript can't follow `part` through the union.)
    (out as Record<Keyed, unknown>)[part] = { upsert: p.upsert.filter((r) => ids.has(r.id)), remove: p.remove.filter((id) => ids.has(id)) };
  }
  if (patch.pageList && kept.pageList) out.pageList = patch.pageList;
  if (patch.tokens && kept.tokens) out.tokens = patch.tokens;
  if (patch.keyframes && kept.keyframes) out.keyframes = patch.keyframes;
  if (patch.users && kept.users) out.users = patch.users;
  if (patch.meta) {
    out.meta = { ...patch.meta };
    if (kept.meta?.name === undefined) delete out.meta.name;
  }
  return out;
}

/**
 * The nodes of a history patch that can still be applied: those nobody changed since `expected`.
 * A node and its parent (when both are in the patch) count as one unit, kept or skipped together:
 * an insert also rewrites the parent's child list, and applying half of it would leave an orphan
 * or a dangling child.
 */
function applicableNodes(current: PaperDocument, patch: Patch, expected: Touched): Set<string> {
  const ids = patchIds(patch, 'nodes');
  const unit = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (unit.get(root) !== root) root = unit.get(root)!;
    unit.set(id, root);
    return root;
  };
  const upserts = new Map(patch.nodes!.upsert.map((n) => [n.id, n]));
  for (const id of ids) {
    for (const parent of [upserts.get(id)?.parentId, current.nodes[id]?.parentId, expected.nodes.get(id)?.parentId]) {
      if (parent && unit.has(parent)) unit.set(find(id), find(parent));
    }
  }
  const blocked = new Set<string>();
  for (const id of ids) if (current.nodes[id] !== expected.nodes.get(id)) blocked.add(find(id));
  return new Set(ids.filter((id) => !blocked.has(find(id))));
}

/** One open document: the authoritative in-memory copy plus history and persistence. */
export class LiveDocument {
  version = 0;
  /** Set once the file is closed for deletion: later commits (a tool still running) are refused, not saved. */
  closed = false;
  /** Last time the file was asked for or changed (epoch ms): the hub lets go of files left alone. */
  lastUsedAt = Date.now();
  /** Every undoable change, oldest first. Each actor undoes the newest one it reaches. */
  private readonly history: HistoryEntry[] = [];
  private readonly redoStacks = new Map<string, HistoryEntry[]>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** When the oldest unsaved change was made (0: everything is saved or saving). */
  private dirtySince = 0;
  private savePromise: Promise<void> = Promise.resolve();

  constructor(
    public doc: PaperDocument,
    private readonly store: FileStore,
    private readonly emit: (event: CommitEvent) => void
  ) {}

  get id(): string {
    return this.doc.id;
  }

  /**
   * Run a synchronous mutation. Throwing (e.g. OpError) aborts without committing.
   * Returns whatever `fn` returns.
   */
  transact<T>(actor: ActorRef, label: string, fn: (tx: Transaction) => T, opts: { undoable?: boolean } = {}): T {
    if (this.closed) throw new OpError('This file was deleted.');
    const before = this.doc;
    const tx = new Transaction(before);
    const result = fn(tx);
    if (!tx.hasChanges) return result;
    const { doc, patch, inverse } = tx.commit();
    this.doc = doc;
    this.version++;
    if (opts.undoable !== false) {
      this.record({ author: actor, label, forward: patch, inverse, after: touched(doc, patch, inverse) });
      // A new change ends the redo chain of everyone whose undo reaches it.
      const key = actorKey(actor);
      for (const k of this.redoStacks.keys()) {
        if (k === key || (actor.kind === 'agent' && k.startsWith('user:'))) this.redoStacks.delete(k);
      }
    } else {
      this.foldIn(before, doc, patch);
    }
    this.emit({ fileId: doc.id, version: this.version, patch, actor, label });
    this.scheduleSave();
    return result;
  }

  private record(entry: HistoryEntry): void {
    this.history.push(entry);
    // Each author has a budget, so one busy agent can't push a person's own steps off the end.
    const key = actorKey(entry.author);
    let own = 0;
    for (const e of this.history) if (actorKey(e.author) === key) own++;
    if (own > MAX_HISTORY_PER_AUTHOR) this.history.splice(this.history.findIndex((e) => actorKey(e.author) === key), 1);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /**
   * Progress on an earlier change (an image finishing, a shader's frame being kept) is folded into
   * the history: the change it completes still counts as untouched, and redoing it brings back the
   * finished result.
   */
  private foldIn(before: PaperDocument, after: PaperDocument, patch: Patch): void {
    const ids = patchIds(patch, 'nodes');
    if (!ids.length) return;
    const fold = (entry: HistoryEntry, forward: boolean) => {
      for (const id of ids) {
        if (!entry.after.nodes.has(id) || entry.after.nodes.get(id) !== before.nodes[id]) continue;
        const next = after.nodes[id];
        entry.after.nodes.set(id, next);
        const upsert = entry.forward.nodes?.upsert;
        if (forward && next && upsert?.some((n) => n.id === id)) {
          entry.forward = { ...entry.forward, nodes: { upsert: upsert.map((n) => (n.id === id ? next : n)), remove: entry.forward.nodes!.remove } };
        }
      }
    };
    for (const entry of this.history) fold(entry, true);
    // An undone change keeps its own result to redo; only what it expects to find is updated.
    for (const stack of this.redoStacks.values()) for (const entry of stack) fold(entry, false);
  }

  canUndo(actor: ActorRef): boolean {
    return this.history.some((e) => reaches(actor, e.author));
  }

  canRedo(actor: ActorRef): boolean {
    return (this.redoStacks.get(actorKey(actor))?.length ?? 0) > 0;
  }

  /** Forget every undo and redo step: the content was replaced from elsewhere (another Git branch, a pull). */
  clearHistory(): void {
    this.history.length = 0;
    this.redoStacks.clear();
  }

  /**
   * Undo the newest change the actor reaches. Records edited by someone else since are left alone,
   * and a change others have since overwritten completely is skipped.
   */
  undo(actor: ActorRef): string | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const entry = this.history[i]!;
      if (!reaches(actor, entry.author)) continue;
      this.history.splice(i, 1);
      const applied = this.applyHistory(actor, `Undo ${entry.label}`, entry.inverse, entry.after);
      if (!applied) continue;
      // Redo brings back only what this undo took back, never records left alone for someone else.
      const forward = restrict(entry.forward, applied);
      const inverse = restrict(entry.inverse, applied);
      const key = actorKey(actor);
      const redo = this.redoStacks.get(key) ?? [];
      redo.push({ ...entry, forward, inverse, after: touched(this.doc, forward, inverse) });
      this.redoStacks.set(key, redo);
      return entry.label;
    }
    return null;
  }

  redo(actor: ActorRef): string | null {
    const stack = this.redoStacks.get(actorKey(actor));
    for (let entry = stack?.pop(); entry; entry = stack!.pop()) {
      const applied = this.applyHistory(actor, `Redo ${entry.label}`, entry.forward, entry.after);
      if (!applied) continue;
      // Back on the timeline under its author, so the Agents panel can still undo an agent's change.
      const forward = restrict(entry.forward, applied);
      const inverse = restrict(entry.inverse, applied);
      this.record({ ...entry, forward, inverse, after: touched(this.doc, forward, inverse) });
      return entry.label;
    }
    return null;
  }

  /**
   * Apply a history patch, dropping records that changed since `expected` was captured.
   * Returns the part that was applied, or null when nothing was left to apply.
   */
  private applyHistory(actor: ActorRef, label: string, patch: Patch, expected: Touched): Patch | null {
    if (this.closed) return null;
    const current = this.doc;
    const filtered: Patch = { meta: { updatedAt: new Date().toISOString() } };
    if (patch.nodes) {
      const ok = applicableNodes(current, patch, expected);
      filtered.nodes = {
        upsert: patch.nodes.upsert.filter((n) => ok.has(n.id)),
        remove: patch.nodes.remove.filter((id) => ok.has(id)),
      };
    }
    if (patch.pages) {
      const unchanged = (id: string) => current.pages[id] === expected.pages.get(id);
      filtered.pages = {
        upsert: patch.pages.upsert.filter((p) => unchanged(p.id)),
        remove: patch.pages.remove.filter(unchanged),
      };
    }
    if (patch.pageList && current.pageList === expected.pageList) filtered.pageList = patch.pageList;
    if (patch.tokens && current.tokens === expected.tokens) filtered.tokens = patch.tokens;
    if (patch.keyframes && current.keyframes === expected.keyframes) filtered.keyframes = patch.keyframes;
    if (patch.users && current.users === expected.users) filtered.users = patch.users;
    if (patch.comments) {
      const unchanged = (id: string) => current.comments[id] === expected.comments.get(id);
      filtered.comments = {
        upsert: patch.comments.upsert.filter((t) => unchanged(t.id)),
        remove: patch.comments.remove.filter(unchanged),
      };
    }
    if (patch.meta?.name !== undefined && current.name === expected.name) filtered.meta!.name = patch.meta.name;
    if (isEmptyPatch(filtered)) return null;
    this.doc = applyPatch(current, filtered);
    this.version++;
    this.emit({ fileId: this.doc.id, version: this.version, patch: filtered, actor, label });
    this.scheduleSave();
    return filtered;
  }

  private scheduleSave(): void {
    if (this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.dirtySince ||= Date.now();
    // Saved once changes pause, and at least every few seconds while they don't: a crash during a
    // long run of edits loses seconds, not the whole run.
    const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, this.dirtySince + SAVE_MAX_WAIT_MS - Date.now()));
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, wait);
  }

  /** Persist now (also waits for any in-flight save). */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirtySince = 0;
    const snapshot = this.doc;
    this.savePromise = this.savePromise
      .then(() => this.store.save(snapshot))
      .catch((error) => console.error(`[openpaper] failed to save ${snapshot.id}:`, error));
    return this.savePromise;
  }
}

function actorKey(actor: ActorRef): string {
  return `${actor.kind}:${actor.id}`;
}

/**
 * All open documents, loaded lazily from the FileStore.
 *
 * Files left alone are let go of (`releaseIdle`), so a long session doesn't keep every file it ever
 * opened, with its undo history, in memory. A released file is only held weakly: whatever still has
 * it (a tool call or image generation in progress) keeps using that same copy, and asking for the
 * file brings it back rather than loading a second copy from disk that the two would fight over.
 */
export class DocumentHub extends EventEmitter<{ commit: [CommitEvent] }> {
  private readonly open = new Map<string, LiveDocument>();
  private readonly loading = new Map<string, Promise<LiveDocument>>();
  private readonly released = new Map<string, WeakRef<LiveDocument>>();
  /** A released file's version, so loading it again counts on from there: versions never go back. */
  private readonly versions = new Map<string, number>();

  constructor(readonly store: FileStore) {
    super();
  }

  isOpen(fileId: string): boolean {
    return this.find(fileId) !== undefined;
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }

  peek(fileId: string): LiveDocument | undefined {
    return this.find(fileId);
  }

  async get(fileId: string): Promise<LiveDocument> {
    const existing = this.find(fileId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const pending = this.loading.get(fileId);
    if (pending) return pending;
    if (!this.store.has(fileId)) throw new OpError(`File not found: "${fileId}". Use list_resources to find files.`);
    const promise = this.store
      .load(fileId)
      .then((doc) => {
        const live = this.track(doc);
        live.version = this.versions.get(fileId) ?? 0;
        this.versions.delete(fileId);
        return live;
      })
      .finally(() => this.loading.delete(fileId));
    this.loading.set(fileId, promise);
    return promise;
  }

  /** Register a freshly created document. */
  adopt(doc: PaperDocument): LiveDocument {
    return this.track(doc);
  }

  private track(doc: PaperDocument): LiveDocument {
    const live: LiveDocument = new LiveDocument(doc, this.store, (e) => {
      live.lastUsedAt = Date.now();
      // Changed while released (by whoever still held it): it's in use again.
      if (this.open.get(e.fileId) !== live && this.released.get(e.fileId)?.deref() === live) this.reopen(e.fileId, live);
      this.emit('commit', e);
    });
    this.open.set(doc.id, live);
    return live;
  }

  /** The loaded copy of a file: open, or released but still held somewhere (then it's open again). */
  private find(fileId: string): LiveDocument | undefined {
    const open = this.open.get(fileId);
    if (open) return open;
    const live = this.released.get(fileId)?.deref();
    if (live) this.reopen(fileId, live);
    else this.released.delete(fileId);
    return live;
  }

  private reopen(fileId: string, live: LiveDocument): void {
    this.released.delete(fileId);
    this.versions.delete(fileId);
    this.open.set(fileId, live);
  }

  /**
   * Save and let go of every file nobody has asked for or changed in `idleMs` that `inUse` doesn't
   * claim (an editor showing it). Its undo history goes too, once nothing holds the file any more.
   * Returns the ids let go of.
   */
  async releaseIdle(idleMs: number, inUse: (fileId: string) => boolean): Promise<string[]> {
    const idle = (live: LiveDocument) => !live.closed && Date.now() - live.lastUsedAt >= idleMs && !inUse(live.id);
    const out: string[] = [];
    for (const [fileId, live] of [...this.open]) {
      if (!idle(live)) continue;
      await live.flush();
      // Asked for or changed while it saved.
      if (this.open.get(fileId) !== live || !idle(live)) continue;
      this.open.delete(fileId);
      this.released.set(fileId, new WeakRef(live));
      this.versions.set(fileId, live.version);
      out.push(fileId);
    }
    return out;
  }

  /** Close a file that is about to be deleted: it saves what it has and refuses later changes. */
  async close(fileId: string): Promise<void> {
    const live = this.find(fileId);
    this.versions.delete(fileId);
    if (!live) return;
    live.closed = true;
    await live.flush();
    this.open.delete(fileId);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.open.values()].map((d) => d.flush()));
  }
}
