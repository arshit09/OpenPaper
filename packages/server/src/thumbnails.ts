import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PageRecord, PaperDocument, ResourceInfo } from '@openpaper/core';
import { writeFileAtomic } from './fs-utils.ts';
import type { DocumentHub } from './hub.ts';
import type { RenderService } from './render/service.ts';
import type { FileStore } from './storage.ts';
import type { ViewRegistry } from './views.ts';

export const THUMBNAIL_ROUTE = '/api/thumbnails/';

/** Pixel size of a thumbnail: a file card's preview area at 2x. */
const WIDTH = 560;
const HEIGHT = 260;
/** Quiet time after the last change before a file someone has open gets a new thumbnail. */
const IDLE_MS = 15_000;
/** The same for a file nobody has open (an agent working on it while the home screen shows). */
const UNWATCHED_IDLE_MS = 2_000;
const NAME_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.webp$/;

interface Entry {
  /** The document's `updatedAt` when the thumbnail was taken. */
  updatedAt: string;
  /** Canvas colour of the page shown (null: the editor's own). */
  background: string | null;
  /** False when the file had nothing to show, so no image was kept. */
  image: boolean;
}

interface Manifest {
  version: 1;
  files: Record<string, Entry>;
}

export interface ThumbnailOptions {
  dir: string;
  hub: DocumentHub;
  store: FileStore;
  render: RenderService;
  views: ViewRegistry;
  /** A thumbnail was added, replaced or removed (editors refresh their file list). */
  changed: () => void;
}

/** The page a thumbnail shows: the first one with anything on it. */
function pageToShow(doc: PaperDocument): PageRecord | null {
  for (const item of doc.pageList) {
    const page = item.type === 'page' ? doc.pages[item.id] : undefined;
    if (page && doc.nodes[page.rootId]?.children.length) return page;
  }
  return null;
}

/**
 * Previews of each file's canvas for the home screen, rendered in the server's headless browser
 * so the editor does no work for them. A file gets a new one once it has been left alone for a
 * while, and as soon as the user leaves it; files without one are filled in when the file list is
 * asked for. One render runs at a time, and a file is only rendered again after it has changed.
 */
export class ThumbnailService {
  private manifest: Manifest = { version: 1, files: {} };
  private manifestWrite: Promise<void> = Promise.resolve();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  /** Files waiting for a render, most urgent first. */
  private queue: string[] = [];
  private running = false;
  /** `<id>@<updatedAt>` of renders that failed, so the same version isn't retried on every visit. */
  private readonly failed = new Set<string>();
  private closed = false;

  constructor(private readonly opts: ThumbnailOptions) {}

  private get manifestPath(): string {
    return join(this.opts.dir, 'index.json');
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest;
      if (raw?.version === 1 && raw.files) this.manifest = raw;
    } catch {
      // Missing or corrupt: thumbnails are taken again.
    }
    for (const id of Object.keys(this.manifest.files)) if (!this.opts.store.has(id)) void this.removed(id);
    this.opts.hub.on('commit', (e) => this.edited(e.fileId));
  }

  /** What a file card shows, if this file has a thumbnail. */
  thumbnailFor(fileId: string): ResourceInfo['thumbnail'] {
    const entry = this.manifest.files[fileId];
    if (!entry?.image) return undefined;
    return { url: `${THUMBNAIL_ROUTE}${fileId}.webp?v=${Date.parse(entry.updatedAt).toString(36)}`, background: entry.background };
  }

  /** The image behind a `THUMBNAIL_ROUTE` name, or null. */
  pathFor(name: string): string | null {
    const id = NAME_RE.exec(name)?.[1];
    return id && this.manifest.files[id]?.image ? join(this.opts.dir, name) : null;
  }

  /** Fill in every file whose thumbnail is missing or out of date (the file list is showing). */
  backfill(): void {
    for (const entry of this.opts.store.list()) {
      if (entry.type === 'file' && !this.idle.has(entry.id) && this.stale(entry.id)) this.enqueue(entry.id);
    }
  }

  /** The user stopped looking at a file (left it, or the window): catch its thumbnail up now. */
  left(fileId: string): void {
    this.cancelIdle(fileId);
    if (this.stale(fileId)) this.enqueue(fileId, true);
  }

  /** A file was deleted. */
  async removed(fileId: string): Promise<void> {
    this.cancelIdle(fileId);
    this.queue = this.queue.filter((id) => id !== fileId);
    if (!this.manifest.files[fileId]) return;
    delete this.manifest.files[fileId];
    await rm(join(this.opts.dir, `${fileId}.webp`), { force: true }).catch(() => {});
    await this.saveManifest();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.queue = [];
  }

  private edited(fileId: string): void {
    this.cancelIdle(fileId);
    const delay = this.opts.views.editorShowing(fileId) ? IDLE_MS : UNWATCHED_IDLE_MS;
    const timer = setTimeout(() => {
      this.idle.delete(fileId);
      this.enqueue(fileId);
    }, delay);
    timer.unref();
    this.idle.set(fileId, timer);
  }

  private cancelIdle(fileId: string): void {
    clearTimeout(this.idle.get(fileId));
    this.idle.delete(fileId);
  }

  private currentVersion(fileId: string): string | undefined {
    return this.opts.hub.peek(fileId)?.doc.updatedAt ?? this.opts.store.get(fileId)?.updatedAt;
  }

  private stale(fileId: string): boolean {
    const updatedAt = this.currentVersion(fileId);
    if (!updatedAt || this.failed.has(`${fileId}@${updatedAt}`)) return false;
    return this.manifest.files[fileId]?.updatedAt !== updatedAt;
  }

  private enqueue(fileId: string, urgent = false): void {
    if (this.closed || !this.opts.render.canRender) return;
    this.queue = this.queue.filter((id) => id !== fileId);
    if (urgent) this.queue.unshift(fileId);
    else this.queue.push(fileId);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id && !this.closed; id = this.queue.shift()) await this.take(id);
    } finally {
      this.running = false;
    }
  }

  private async take(fileId: string): Promise<void> {
    if (!this.stale(fileId)) return;
    let doc: PaperDocument | undefined;
    try {
      // A file that isn't open is read from disk without opening it in the hub.
      doc = this.opts.hub.peek(fileId)?.doc ?? (this.opts.store.has(fileId) ? await this.opts.store.load(fileId) : undefined);
      if (!doc) return;
      const page = pageToShow(doc);
      const image = page ? await this.opts.render.thumbnail(doc, page.id, WIDTH, HEIGHT) : null;
      // Deleted while it rendered.
      if (this.closed || !this.opts.store.has(fileId)) return;
      const path = join(this.opts.dir, `${fileId}.webp`);
      if (image) await writeFileAtomic(path, image);
      else await rm(path, { force: true });
      this.manifest.files[fileId] = { updatedAt: doc.updatedAt, background: page?.canvasColor ?? null, image: !!image };
      await this.saveManifest();
      this.opts.changed();
    } catch (error) {
      if (this.closed) return;
      this.failed.add(`${fileId}@${doc?.updatedAt ?? this.currentVersion(fileId)}`);
      console.warn(`[openpaper] thumbnail for ${fileId} failed:`, error instanceof Error ? error.message : error);
    }
  }

  private saveManifest(): Promise<void> {
    const snapshot = JSON.stringify(this.manifest);
    this.manifestWrite = this.manifestWrite.then(() => writeFileAtomic(this.manifestPath, snapshot)).catch(() => {});
    return this.manifestWrite;
  }
}
