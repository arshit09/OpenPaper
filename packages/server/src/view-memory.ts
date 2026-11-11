import { readFile } from 'node:fs/promises';
import type { SavedPageView, SavedView, ViewState, Viewport } from '@openpaper/core';
import { writeFileAtomic } from './fs-utils.ts';

/** Files remembered at most: the ones left longest ago are forgotten first. */
const MAX_FILES = 500;
/** Layers remembered per page at most (as many as a view report carries). */
const MAX_SELECTION = 1000;
/** Longer strings aren't ids. */
const MAX_ID = 200;
/** Changes are written at most this often: panning reports the camera a few times a second. */
const SAVE_DELAY_MS = 1000;

interface Entry extends SavedView {
  /** When the view last changed (ms since the epoch). */
  at: number;
}

interface ViewsFile {
  version: 1;
  files: Record<string, Entry>;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;

function cleanViewport(value: unknown): Viewport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { x, y, zoom, width, height } = value as Viewport;
  if (![x, y, zoom, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  if (zoom <= 0 || width <= 0 || height <= 0) return undefined;
  return { x, y, zoom, width, height };
}

function cleanSelection(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isId).slice(0, MAX_SELECTION) : [];
}

function cleanPage(value: unknown): SavedPageView | null {
  if (!value || typeof value !== 'object') return null;
  const viewport = cleanViewport((value as SavedPageView).viewport);
  return { ...(viewport ? { viewport } : {}), selection: cleanSelection((value as SavedPageView).selection) };
}

function samePage(a: SavedPageView | undefined, b: SavedPageView): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where the user left each file, from the editors' view reports: the page on screen, and each page's
 * camera and selection. Opening the file again, after a reload, in another browser or in the desktop
 * app, continues there. Kept in `<home>/views.json`, apart from the design: moving around isn't an
 * edit, and a tracked design's history shouldn't fill up with camera moves.
 */
export class ViewMemory {
  /** Least recently changed first (a Map keeps insertion order; a changed file moves to the end). */
  private files = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** Load what was remembered, leaving out files that no longer exist. */
  async init(exists: (fileId: string) => boolean = () => true): Promise<void> {
    let raw: ViewsFile;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8')) as ViewsFile;
    } catch {
      return; // Missing or unreadable: files open fitted, as before.
    }
    if (raw?.version !== 1 || !raw.files || typeof raw.files !== 'object') return;
    const entries: Array<[string, Entry]> = [];
    let dropped = false;
    for (const [fileId, entry] of Object.entries(raw.files)) {
      if (!isId(fileId) || !exists(fileId) || !entry || !isId(entry.pageId)) {
        dropped = true;
        continue;
      }
      const pages: Record<string, SavedPageView> = {};
      for (const [pageId, page] of Object.entries(entry.pages ?? {})) {
        const clean = isId(pageId) ? cleanPage(page) : null;
        if (clean) pages[pageId] = clean;
      }
      entries.push([fileId, { pageId: entry.pageId, pages, at: typeof entry.at === 'number' ? entry.at : 0 }]);
    }
    entries.sort((a, b) => a[1].at - b[1].at);
    this.files = new Map(entries.slice(-MAX_FILES));
    if (dropped || entries.length > MAX_FILES) this.schedule();
  }

  /** Where the user left a file, if it has been viewed. */
  get(fileId: string): SavedView | undefined {
    const entry = this.files.get(fileId);
    return entry ? { pageId: entry.pageId, pages: entry.pages } : undefined;
  }

  /**
   * Note an editor's view of a file. A report without a camera (the page has none yet) keeps the
   * page's last one; `pageExists` lets pages deleted from the file be forgotten.
   */
  record(view: ViewState, pageExists?: (pageId: string) => boolean): void {
    const { fileId, pageId } = view;
    if (view.previewing || !isId(fileId) || !isId(pageId)) return;
    const prev = this.files.get(fileId);
    const viewport = cleanViewport(view.viewport) ?? prev?.pages[pageId]?.viewport;
    const page: SavedPageView = { ...(viewport ? { viewport } : {}), selection: cleanSelection(view.selection) };
    // Focus changes report the same view again.
    if (prev?.pageId === pageId && samePage(prev.pages[pageId], page)) return;
    const pages: Record<string, SavedPageView> = {};
    for (const [id, other] of Object.entries(prev?.pages ?? {})) {
      if (id !== pageId && (!pageExists || pageExists(id))) pages[id] = other;
    }
    pages[pageId] = page;
    this.files.delete(fileId);
    this.files.set(fileId, { pageId, pages, at: Date.now() });
    for (const oldest of this.files.keys()) {
      if (this.files.size <= MAX_FILES) break;
      this.files.delete(oldest);
    }
    this.schedule();
  }

  /** A file was deleted. */
  forget(fileId: string): void {
    if (this.files.delete(fileId)) this.schedule();
  }

  /** Write what isn't saved yet (the server is stopping). */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.save();
    }
    await this.writes;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  private save(): void {
    const snapshot = JSON.stringify({ version: 1, files: Object.fromEntries(this.files) } satisfies ViewsFile);
    this.writes = this.writes
      .then(() => writeFileAtomic(this.path, snapshot))
      .catch((error) => console.warn(`[openpaper] Could not save where files were left: ${error instanceof Error ? error.message : error}`));
  }
}
