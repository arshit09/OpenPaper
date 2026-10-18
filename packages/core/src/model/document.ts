import { formatPageId, newFileId, pageRootIdFor } from './ids.ts';
import type { NodeRecord, PageRecord, PaperDocument } from './types.ts';

export const SCHEMA_VERSION = 1 as const;

export function pageRootNode(pageId: string): NodeRecord {
  return {
    id: pageRootIdFor(pageId),
    component: 'PageRoot',
    label: '(page root)',
    parentId: null,
    children: [],
    styles: {},
    isVisible: true,
    isLocked: false,
  };
}

export function newPageRecord(id: string, name: string, icon: string | null = null): PageRecord {
  return { id, name, icon, rootId: pageRootIdFor(id) };
}

/** A brand-new document with a single empty page. */
export function createDocument(opts: { id?: string; name?: string; now?: string } = {}): PaperDocument {
  const now = opts.now ?? new Date().toISOString();
  const page = newPageRecord(formatPageId(1), 'Page 1');
  const root = pageRootNode(page.id);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id ?? newFileId(),
    name: opts.name?.trim() || 'Untitled',
    createdAt: now,
    updatedAt: now,
    pageList: [{ type: 'page', id: page.id }],
    pages: { [page.id]: page },
    nodes: { [root.id]: root },
    tokens: [],
    comments: {},
    counters: { nodes: 0, pages: 1 },
  };
}

/** Deep-copy a document under a new id/name (used by create_file with cloneFileId). */
export function cloneDocument(doc: PaperDocument, opts: { id?: string; name?: string; now?: string } = {}): PaperDocument {
  const now = opts.now ?? new Date().toISOString();
  const copy = JSON.parse(JSON.stringify(doc)) as PaperDocument;
  copy.id = opts.id ?? newFileId();
  copy.name = opts.name?.trim() || `${doc.name} (copy)`;
  copy.createdAt = now;
  copy.updatedAt = now;
  copy.comments = {};
  return copy;
}

/** Validate/upgrade a parsed document; throws on unrecoverable input. */
export function normalizeDocument(raw: unknown): PaperDocument {
  if (!raw || typeof raw !== 'object') throw new Error('Not an OpenPaper document');
  const doc = raw as PaperDocument;
  if (doc.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported schemaVersion ${String(doc.schemaVersion)}`);
  if (!doc.id || !doc.nodes || !doc.pages || !Array.isArray(doc.pageList)) throw new Error('Malformed OpenPaper document');
  doc.tokens ??= [];
  doc.comments ??= {};
  doc.counters ??= { nodes: Object.keys(doc.nodes).length, pages: Object.keys(doc.pages).length };
  for (const node of Object.values(doc.nodes)) {
    node.children ??= [];
    node.styles ??= {};
    node.isVisible ??= true;
    node.isLocked ??= false;
  }
  return doc;
}
