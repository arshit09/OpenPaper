import { EventEmitter } from 'node:events';
import {
  applyPatch,
  isEmptyPatch,
  OpError,
  Transaction,
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

interface HistoryEntry {
  label: string;
  forward: Patch;
  inverse: Patch;
  /** Document snapshot right after the commit, used to detect later edits by others. */
  after: PaperDocument;
}

const SAVE_DEBOUNCE_MS = 400;
const MAX_HISTORY = 200;

/** One open document: the authoritative in-memory copy plus history and persistence. */
export class LiveDocument {
  version = 0;
  private readonly undoStacks = new Map<string, HistoryEntry[]>();
  private readonly redoStacks = new Map<string, HistoryEntry[]>();
  private saveTimer: NodeJS.Timeout | null = null;
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
    const tx = new Transaction(this.doc);
    const result = fn(tx);
    if (!tx.hasChanges) return result;
    const { doc, patch, inverse } = tx.commit();
    this.doc = doc;
    this.version++;
    if (opts.undoable !== false) {
      const key = actorKey(actor);
      const stack = this.undoStacks.get(key) ?? [];
      stack.push({ label, forward: patch, inverse, after: doc });
      if (stack.length > MAX_HISTORY) stack.shift();
      this.undoStacks.set(key, stack);
      this.redoStacks.delete(key);
    }
    this.emit({ fileId: doc.id, version: this.version, patch, actor, label });
    this.scheduleSave();
    return result;
  }

  canUndo(actor: ActorRef): boolean {
    return (this.undoStacks.get(actorKey(actor))?.length ?? 0) > 0;
  }

  canRedo(actor: ActorRef): boolean {
    return (this.redoStacks.get(actorKey(actor))?.length ?? 0) > 0;
  }

  /** Undo the actor's last change. Records edited by someone else since are left alone. */
  undo(actor: ActorRef): string | null {
    const key = actorKey(actor);
    const entry = this.undoStacks.get(key)?.pop();
    if (!entry) return null;
    const applied = this.applyHistory(actor, `Undo ${entry.label}`, entry.inverse, entry.after);
    if (applied) {
      const redo = this.redoStacks.get(key) ?? [];
      redo.push({ label: entry.label, forward: entry.forward, inverse: entry.inverse, after: this.doc });
      this.redoStacks.set(key, redo);
    }
    return entry.label;
  }

  redo(actor: ActorRef): string | null {
    const key = actorKey(actor);
    const entry = this.redoStacks.get(key)?.pop();
    if (!entry) return null;
    const applied = this.applyHistory(actor, `Redo ${entry.label}`, entry.forward, entry.after);
    if (applied) {
      const undo = this.undoStacks.get(key) ?? [];
      undo.push({ label: entry.label, forward: entry.forward, inverse: entry.inverse, after: this.doc });
      this.undoStacks.set(key, undo);
    }
    return entry.label;
  }

  /** Apply a history patch, dropping records that changed since `expected` was captured. */
  private applyHistory(actor: ActorRef, label: string, patch: Patch, expected: PaperDocument): boolean {
    const current = this.doc;
    const filtered: Patch = { meta: { updatedAt: new Date().toISOString() } };
    if (patch.nodes) {
      const unchanged = (id: string) => current.nodes[id] === expected.nodes[id];
      filtered.nodes = {
        upsert: patch.nodes.upsert.filter((n) => unchanged(n.id)),
        remove: patch.nodes.remove.filter(unchanged),
      };
    }
    if (patch.pages) {
      const unchanged = (id: string) => current.pages[id] === expected.pages[id];
      filtered.pages = {
        upsert: patch.pages.upsert.filter((p) => unchanged(p.id)),
        remove: patch.pages.remove.filter(unchanged),
      };
    }
    if (patch.pageList && current.pageList === expected.pageList) filtered.pageList = patch.pageList;
    if (patch.tokens && current.tokens === expected.tokens) filtered.tokens = patch.tokens;
    if (patch.users && current.users === expected.users) filtered.users = patch.users;
    if (patch.comments) {
      const unchanged = (id: string) => current.comments[id] === expected.comments[id];
      filtered.comments = {
        upsert: patch.comments.upsert.filter((t) => unchanged(t.id)),
        remove: patch.comments.remove.filter(unchanged),
      };
    }
    if (patch.meta?.name !== undefined && current.name === expected.name) filtered.meta!.name = patch.meta.name;
    if (isEmptyPatch(filtered)) return false;
    this.doc = applyPatch(current, filtered);
    this.version++;
    this.emit({ fileId: this.doc.id, version: this.version, patch: filtered, actor, label });
    this.scheduleSave();
    return true;
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Persist now (also waits for any in-flight save). */
  flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
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

/** All open documents, loaded lazily from the FileStore. */
export class DocumentHub extends EventEmitter<{ commit: [CommitEvent] }> {
  private readonly open = new Map<string, LiveDocument>();
  private readonly loading = new Map<string, Promise<LiveDocument>>();

  constructor(readonly store: FileStore) {
    super();
  }

  isOpen(fileId: string): boolean {
    return this.open.has(fileId);
  }

  openIds(): string[] {
    return [...this.open.keys()];
  }

  peek(fileId: string): LiveDocument | undefined {
    return this.open.get(fileId);
  }

  async get(fileId: string): Promise<LiveDocument> {
    const existing = this.open.get(fileId);
    if (existing) return existing;
    const pending = this.loading.get(fileId);
    if (pending) return pending;
    if (!this.store.has(fileId)) throw new OpError(`File not found: "${fileId}". Use list_resources to find files.`);
    const promise = this.store
      .load(fileId)
      .then((doc) => {
        const live = new LiveDocument(doc, this.store, (e) => this.emit('commit', e));
        this.open.set(fileId, live);
        return live;
      })
      .finally(() => this.loading.delete(fileId));
    this.loading.set(fileId, promise);
    return promise;
  }

  /** Register a freshly created document. */
  adopt(doc: PaperDocument): LiveDocument {
    const live = new LiveDocument(doc, this.store, (e) => this.emit('commit', e));
    this.open.set(doc.id, live);
    return live;
  }

  async close(fileId: string): Promise<void> {
    const live = this.open.get(fileId);
    if (!live) return;
    await live.flush();
    this.open.delete(fileId);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.open.values()].map((d) => d.flush()));
  }
}
