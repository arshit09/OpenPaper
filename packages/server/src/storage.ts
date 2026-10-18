import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneDocument, createDocument, normalizeDocument, ulid, type PaperDocument } from '@openpaper/core';
import { writeFileAtomic } from './fs-utils.ts';
import type { OpenPaperPaths } from './paths.ts';

export interface ResourceEntry {
  id: string;
  type: 'file' | 'folder';
  name: string;
  /** Folder id, or null for top-level ("drafts"). */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IndexFile {
  version: 1;
  resources: Record<string, ResourceEntry>;
}

const FILE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Local file storage. Each design lives in `<home>/files/<id>.json`; `index.json`
 * keeps lightweight metadata (names, folders, timestamps) so listing is cheap.
 */
export class FileStore {
  private index: IndexFile = { version: 1, resources: {} };
  private indexWrite: Promise<void> = Promise.resolve();

  constructor(readonly paths: OpenPaperPaths) {}

  async init(): Promise<void> {
    for (const dir of [this.paths.home, this.paths.files, this.paths.assets, this.paths.cache]) {
      await mkdir(dir, { recursive: true });
    }
    try {
      const raw = JSON.parse(await readFile(this.paths.index, 'utf8')) as IndexFile;
      if (raw?.version === 1 && raw.resources) this.index = raw;
    } catch {
      // Missing or corrupt index: rebuilt from disk below.
    }
    await this.reconcile();
  }

  /** Make the index agree with the files actually on disk. */
  private async reconcile(): Promise<void> {
    const onDisk = new Set<string>();
    for (const name of await readdir(this.paths.files)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!FILE_ID_RE.test(id)) continue;
      onDisk.add(id);
      if (!this.index.resources[id]) {
        try {
          const doc = normalizeDocument(JSON.parse(await readFile(join(this.paths.files, name), 'utf8')));
          this.index.resources[id] = {
            id,
            type: 'file',
            name: doc.name,
            parentId: null,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
          };
        } catch {
          // Skip unreadable files rather than failing startup.
        }
      }
    }
    for (const entry of Object.values(this.index.resources)) {
      if (entry.type === 'file' && !onDisk.has(entry.id)) delete this.index.resources[entry.id];
    }
    await this.flushIndex();
  }

  private flushIndex(): Promise<void> {
    const snapshot = JSON.stringify(this.index, null, 2);
    this.indexWrite = this.indexWrite.then(() => writeFileAtomic(this.paths.index, snapshot)).catch(() => {});
    return this.indexWrite;
  }

  private filePath(id: string): string {
    if (!FILE_ID_RE.test(id)) throw new Error(`Invalid file id "${id}"`);
    return join(this.paths.files, `${id}.json`);
  }

  list(): ResourceEntry[] {
    return Object.values(this.index.resources);
  }

  get(id: string): ResourceEntry | undefined {
    return this.index.resources[id];
  }

  has(id: string): boolean {
    return this.index.resources[id]?.type === 'file';
  }

  async load(id: string): Promise<PaperDocument> {
    const text = await readFile(this.filePath(id), 'utf8');
    return normalizeDocument(JSON.parse(text));
  }

  async save(doc: PaperDocument): Promise<void> {
    await writeFileAtomic(this.filePath(doc.id), JSON.stringify(doc));
    const entry = this.index.resources[doc.id];
    this.index.resources[doc.id] = {
      id: doc.id,
      type: 'file',
      name: doc.name,
      parentId: entry?.parentId ?? null,
      createdAt: entry?.createdAt ?? doc.createdAt,
      updatedAt: doc.updatedAt,
    };
    await this.flushIndex();
  }

  async create(opts: { name?: string; cloneFrom?: PaperDocument; parentId?: string | null } = {}): Promise<PaperDocument> {
    const doc = opts.cloneFrom ? cloneDocument(opts.cloneFrom, { name: opts.name }) : createDocument({ name: opts.name });
    await this.save(doc);
    if (opts.parentId && this.index.resources[opts.parentId]?.type === 'folder') {
      this.index.resources[doc.id]!.parentId = opts.parentId;
      await this.flushIndex();
    }
    return doc;
  }

  async createFolder(name: string, parentId: string | null = null): Promise<ResourceEntry> {
    const now = new Date().toISOString();
    const entry: ResourceEntry = {
      id: ulid(),
      type: 'folder',
      name: name.trim().slice(0, 500) || 'Untitled folder',
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    this.index.resources[entry.id] = entry;
    await this.flushIndex();
    return entry;
  }

  /** Rename a folder (files are renamed through their open document). */
  async renameFolder(id: string, name: string): Promise<ResourceEntry> {
    const entry = this.index.resources[id];
    if (!entry || entry.type !== 'folder') throw new Error(`Folder not found: "${id}"`);
    entry.name = name;
    entry.updatedAt = new Date().toISOString();
    await this.flushIndex();
    return entry;
  }

  async moveResource(id: string, parentId: string | null): Promise<void> {
    const entry = this.index.resources[id];
    if (!entry) throw new Error(`Resource not found: "${id}"`);
    if (parentId && this.index.resources[parentId]?.type !== 'folder') throw new Error(`Folder not found: "${parentId}"`);
    entry.parentId = parentId;
    await this.flushIndex();
  }

  async delete(id: string): Promise<void> {
    const entry = this.index.resources[id];
    if (!entry) return;
    if (entry.type === 'file') await rm(this.filePath(id), { force: true });
    else {
      for (const child of Object.values(this.index.resources)) if (child.parentId === id) child.parentId = entry.parentId;
    }
    delete this.index.resources[id];
    await this.flushIndex();
  }
}
