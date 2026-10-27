import { readFile } from 'node:fs/promises';
import { ulid } from '@openpaper/core';
import { writeFileAtomic } from '../fs-utils.ts';
import { inspectFolder } from './folders.ts';

/** A live site: the user's own dev server plus the project folder the agent edits. */
export interface SiteRecord {
  id: string;
  name: string;
  /** The dev server's URL: an http(s) origin plus an optional start path, e.g. `http://localhost:5173`. */
  url: string;
  /** Absolute path of the project folder. */
  folder: string;
  /** Loopback port the site's proxy last listened on. Reused so the proxied origin (and its storage) stays stable. */
  proxyPort?: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type SitePatch = Partial<Pick<SiteRecord, 'name' | 'url' | 'folder' | 'proxyPort' | 'lastOpenedAt'>>;

interface SitesFile {
  version: 1;
  sites: SiteRecord[];
}

/**
 * Normalize what the user typed into an http(s) origin + path: adds `http://`, turns a bare port into
 * `localhost:<port>`, maps the wildcard addresses dev servers print (0.0.0.0, [::]) to localhost and drops the hash.
 */
export function normalizeSiteUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new Error('Enter the URL of your dev server, e.g. http://localhost:5173');
  if (/^\d{2,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Not a valid URL: ${input.trim()}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// sites can be opened.');
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.origin}${path}${url.search}`;
}

function validRecord(raw: unknown): raw is SiteRecord {
  const r = raw as SiteRecord;
  return !!r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.url === 'string' && typeof r.folder === 'string';
}

function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536;
}

/** Saved live sites, kept in `<home>/sites.json`. */
export class SiteStore {
  private sites = new Map<string, SiteRecord>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as SitesFile;
      for (const site of Array.isArray(raw?.sites) ? raw.sites : []) {
        if (!validRecord(site)) continue;
        if (!validPort(site.proxyPort)) delete site.proxyPort;
        this.sites.set(site.id, site);
      }
    } catch {
      // Missing or unreadable: start empty.
    }
  }

  /** Most recently opened (or edited) first. */
  list(): SiteRecord[] {
    const recency = (s: SiteRecord) => s.lastOpenedAt ?? s.updatedAt;
    return [...this.sites.values()].sort((a, b) => recency(b).localeCompare(recency(a)));
  }

  get(id: string): SiteRecord | undefined {
    return this.sites.get(id);
  }

  /** Add a site. The folder must exist; the name defaults to its package.json name or folder name. Same URL + folder returns the existing site. */
  async create(input: { url: string; folder: string; name?: string }): Promise<SiteRecord> {
    const url = normalizeSiteUrl(input.url);
    const folder = await checkedFolder(input.folder);
    const existing = [...this.sites.values()].find((s) => s.url === url && s.folder === folder.path);
    if (existing) return existing;
    const now = new Date().toISOString();
    const site: SiteRecord = {
      id: ulid(),
      name: cleanName(input.name) || folder.name,
      url,
      folder: folder.path,
      createdAt: now,
      updatedAt: now,
    };
    this.sites.set(site.id, site);
    await this.flush();
    return site;
  }

  async update(id: string, patch: SitePatch): Promise<SiteRecord> {
    const site = this.sites.get(id);
    if (!site) throw new Error(`Site not found: "${id}"`);
    const next: SiteRecord = { ...site };
    if (patch.name !== undefined) next.name = cleanName(patch.name) || site.name;
    if (patch.url !== undefined) next.url = normalizeSiteUrl(patch.url);
    if (patch.folder !== undefined) next.folder = (await checkedFolder(patch.folder)).path;
    if (patch.proxyPort !== undefined) {
      if (validPort(patch.proxyPort)) next.proxyPort = patch.proxyPort;
      else delete next.proxyPort;
    }
    if (patch.lastOpenedAt !== undefined) next.lastOpenedAt = patch.lastOpenedAt;
    // Port bookkeeping and "opened" stamps aren't edits.
    if (patch.name !== undefined || patch.url !== undefined || patch.folder !== undefined) next.updatedAt = new Date().toISOString();
    this.sites.set(id, next);
    await this.flush();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.sites.delete(id)) return false;
    await this.flush();
    return true;
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, sites: [...this.sites.values()] } satisfies SitesFile, null, 2);
    const write = this.writes.then(() => writeFileAtomic(this.path, snapshot));
    this.writes = write.catch(() => {});
    return write;
  }
}

function cleanName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, 200);
}

async function checkedFolder(path: string) {
  const info = await inspectFolder(path);
  if (!info.exists) throw new Error(`Folder not found: ${info.path}`);
  if (!info.isDirectory) throw new Error(`Not a folder: ${info.path}`);
  return info;
}
