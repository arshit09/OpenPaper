import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cleanSvgMarkup,
  normalizeDocument,
  SCHEMA_VERSION,
  type CommentThread,
  type CommentUser,
  type DocCounters,
  type KeyframesRecord,
  type NodeRecord,
  type PageListItem,
  type PageRecord,
  type PaperDocument,
  type TokenRecord,
} from '@openpaper/core';
import { writeFileAtomic } from '../fs-utils.ts';

/**
 * A design as a folder of files, so Git can track it and its diffs stay small and readable:
 *
 *   openpaper.json   the file: id, name, pages in order
 *   pages/<id>.json  one page's layers, parents before children, one property per line
 *   tokens.json      design tokens and @keyframes (absent when there are none)
 *   comments.json    comment threads (absent when there are none)
 *   assets/          the images, videos and Lottie files the design uses, named by content hash
 *   README.md        what the folder is, for people browsing the repository
 *   .gitattributes   JSON stays LF, assets stay byte for byte
 *
 * `updatedAt` and the id counters aren't stored (the counters are worked out from the ids): undoing back to
 * the committed design then leaves nothing to commit, and a new layer only changes its own page.
 */

export const MANIFEST = 'openpaper.json';
const FORMAT = 'openpaper-design';
const FORMAT_VERSION = 1;
const TOKENS = 'tokens.json';
const COMMENTS = 'comments.json';
const README = 'README.md';
const GITATTRIBUTES = '.gitattributes';
export const PAGES_DIR = 'pages';
export const ASSETS_DIR = 'assets';

/** Media the design uses: `/media/<hash>.<ext>` anywhere in it (layer sources, CSS urls, tokens). */
const MEDIA_REF = /\/media\/([a-f0-9]{32}\.[a-z0-9]{3,4})/g;
const MEDIA_NAME = /^[a-f0-9]{32}\.[a-z0-9]{3,4}$/;

/** README.md lines below this marker are OpenPaper's; once it's removed the file is the user's. */
const README_MARKER = '<!-- Written by OpenPaper. Remove this line to keep your own text here. -->';

const ATTRIBUTES = `# Written by OpenPaper: design files stay LF on every computer, assets stay byte for byte.
*.json text eol=lf
${ASSETS_DIR}/** -text -diff
`;

type ManifestPage = ({ type: 'page'; unlisted?: true } & PageRecord) | { type: 'divider'; id: string };

interface Manifest {
  format: typeof FORMAT;
  formatVersion: number;
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  pages: ManifestPage[];
  /** Layers no page reaches (kept so nothing is lost on the way through the folder). */
  unplacedNodes?: NodeRecord[];
}

interface PageFile {
  page: string;
  nodes: NodeRecord[];
}

const NODE_KEYS = [
  'id',
  'component',
  'label',
  'labelIsModified',
  'parentId',
  'isVisible',
  'isLocked',
  'textValue',
  'textRuns',
  'src',
  'svg',
  'html',
  'attrs',
  'props',
  'imageGeneration',
  'styles',
  'children',
];

/** The same keys in the same order every time, so a rewrite of a layer only shows what changed. Nested maps keep their order (CSS order matters). */
function orderedNode(node: NodeRecord): NodeRecord {
  const out: Record<string, unknown> = {};
  const record = node as unknown as Record<string, unknown>;
  for (const key of NODE_KEYS) if (record[key] !== undefined) out[key] = record[key];
  for (const [key, value] of Object.entries(record)) if (!(key in out) && value !== undefined) out[key] = value;
  return out as unknown as NodeRecord;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** `pages/<id>.json`, or a hashed name for ids that aren't safe as file names. */
export function pageFile(pageId: string): string {
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pageId) && !WINDOWS_DEVICE.test(pageId);
  return `${PAGES_DIR}/${safe ? pageId : `page-${createHash('sha1').update(pageId).digest('hex').slice(0, 12)}`}.json`;
}

/** Page ids → their nodes, parents before children (depth first, in child order). */
function nodesByPage(doc: PaperDocument): { pages: Map<string, NodeRecord[]>; unplaced: NodeRecord[] } {
  const seen = new Set<string>();
  const pages = new Map<string, NodeRecord[]>();
  for (const page of Object.values(doc.pages)) {
    const list: NodeRecord[] = [];
    const visit = (id: string) => {
      const node = doc.nodes[id];
      if (!node || seen.has(id)) return;
      seen.add(id);
      list.push(orderedNode(node));
      for (const child of node.children) visit(child);
    };
    visit(page.rootId);
    pages.set(page.id, list);
  }
  const unplaced = Object.values(doc.nodes)
    .filter((n) => !seen.has(n.id))
    .map(orderedNode);
  return { pages, unplaced };
}

/** The folder's text files for a document (README and .gitattributes aside), by path. `id`: the design id to write, if not the file's. */
export function designFiles(doc: PaperDocument, id = doc.id): Map<string, string> {
  const files = new Map<string, string>();
  const { pages, unplaced } = nodesByPage(doc);
  const listed = new Set(doc.pageList.map((p) => p.id));
  const manifestPages: ManifestPage[] = [];
  for (const item of doc.pageList) {
    if (item.type === 'divider') manifestPages.push({ type: 'divider', id: item.id });
    else if (doc.pages[item.id]) manifestPages.push({ type: 'page', ...doc.pages[item.id]! });
  }
  for (const page of Object.values(doc.pages)) if (!listed.has(page.id)) manifestPages.push({ type: 'page', ...page, unlisted: true });
  const manifest: Manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    schemaVersion: doc.schemaVersion,
    id,
    name: doc.name,
    createdAt: doc.createdAt,
    pages: manifestPages,
    ...(unplaced.length ? { unplacedNodes: unplaced } : {}),
  };
  files.set(MANIFEST, json(manifest));
  for (const [pageId, nodes] of pages) files.set(pageFile(pageId), json({ page: pageId, nodes } satisfies PageFile));
  const keyframes = doc.keyframes ?? [];
  if (doc.tokens.length || keyframes.length) files.set(TOKENS, json({ tokens: doc.tokens, keyframes }));
  const threads = Object.values(doc.comments).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const users = doc.users ?? {};
  if (threads.length || Object.keys(users).length) files.set(COMMENTS, json({ threads, users }));
  return files;
}

/** Media files (`<hash>.<ext>`) the document refers to. */
export function mediaNames(doc: PaperDocument): Set<string> {
  const names = new Set<string>();
  const text = JSON.stringify([doc.nodes, doc.tokens, doc.keyframes ?? []]);
  for (const m of text.matchAll(MEDIA_REF)) names.add(m[1]!);
  return names;
}

export function readmeFor(doc: PaperDocument): string {
  const pages = doc.pageList.filter((p) => p.type === 'page' && doc.pages[p.id]).map((p) => doc.pages[p.id]!.name);
  return [
    `# ${doc.name}`,
    '',
    `An [OpenPaper](https://github.com/arshit09/OpenPaper) design${pages.length ? ` with ${pages.length === 1 ? 'one page' : `${pages.length} pages`}: ${pages.join(', ')}` : ''}.`,
    '',
    'To open it, choose **Open folder** on OpenPaper’s home screen and pick this folder. Each page’s layers',
    `are in \`${PAGES_DIR}/\`, the images it uses in \`${ASSETS_DIR}/\`, and \`${MANIFEST}\` lists the pages in order.`,
    '',
    README_MARKER,
    '',
  ].join('\n');
}

/** Id counters past every id in use (`2F-0` → nodes 87, `p-3-0` → pages 3), so new ids never clash. */
function countersFor(nodes: Record<string, NodeRecord>, pages: Record<string, PageRecord>): DocCounters {
  let n = 0;
  let p = 0;
  for (const id of Object.keys(nodes)) {
    const m = /^([0-9A-Z]+)-[0-9A-Z]+$/.exec(id);
    if (m) n = Math.max(n, parseInt(m[1]!, 36));
  }
  for (const id of Object.keys(pages)) {
    const m = /^p-([0-9a-z]+)-[0-9a-z]+$/.exec(id);
    if (m) p = Math.max(p, parseInt(m[1]!, 36));
  }
  return { nodes: n, pages: p };
}

/** Rebuild a document from a design folder's files (`read` returns a file's text, or undefined when absent). */
export function parseDesign(read: (path: string) => string | undefined, opts: { updatedAt?: string } = {}): PaperDocument {
  const raw = read(MANIFEST);
  if (raw === undefined) throw new Error(`No ${MANIFEST} here: this isn't an OpenPaper design folder.`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    throw new Error(`${MANIFEST} isn't valid JSON.`);
  }
  if (manifest?.format !== FORMAT) throw new Error(`${MANIFEST} isn't an OpenPaper design.`);
  if (manifest.formatVersion > FORMAT_VERSION) throw new Error('This design was saved by a newer OpenPaper. Update OpenPaper to open it.');
  const nodes: Record<string, NodeRecord> = {};
  const pages: Record<string, PageRecord> = {};
  const pageList: PageListItem[] = [];
  for (const entry of manifest.pages ?? []) {
    if (entry.type === 'divider') {
      pageList.push({ type: 'divider', id: entry.id });
      continue;
    }
    const { type: _type, unlisted, ...page } = entry;
    pages[page.id] = page;
    if (!unlisted) pageList.push({ type: 'page', id: page.id });
    const text = read(pageFile(page.id));
    if (text === undefined) continue;
    const file = JSON.parse(text) as PageFile;
    for (const node of file.nodes ?? []) nodes[node.id] = node;
  }
  for (const node of manifest.unplacedNodes ?? []) nodes[node.id] = node;
  // A folder can come from anyone's repository: its SVG is cleaned like imported SVG (as FileStore.load does).
  for (const node of Object.values(nodes)) if (node.svg) node.svg = cleanSvgMarkup(node.svg);
  const tokensText = read(TOKENS);
  const tokens = tokensText ? (JSON.parse(tokensText) as { tokens?: TokenRecord[]; keyframes?: KeyframesRecord[] }) : {};
  const commentsText = read(COMMENTS);
  const comments = commentsText ? (JSON.parse(commentsText) as { threads?: CommentThread[]; users?: Record<string, CommentUser> }) : {};
  return normalizeDocument({
    schemaVersion: (manifest.schemaVersion ?? SCHEMA_VERSION) as typeof SCHEMA_VERSION,
    id: manifest.id,
    name: manifest.name,
    createdAt: manifest.createdAt,
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
    pageList,
    pages,
    nodes,
    tokens: tokens.tokens ?? [],
    keyframes: tokens.keyframes ?? [],
    comments: Object.fromEntries((comments.threads ?? []).map((t) => [t.id, t])),
    ...(comments.users && Object.keys(comments.users).length ? { users: comments.users } : {}),
    counters: countersFor(nodes, pages),
  } satisfies PaperDocument);
}

/** What a changed path in the design folder is, in the design's own terms. */
export function changeLabel(path: string, doc: PaperDocument | undefined): string {
  if (path === MANIFEST) return 'Page list and file name';
  if (path === TOKENS) return 'Tokens and animations';
  if (path === COMMENTS) return 'Comments';
  if (path === README) return 'Readme';
  if (path === GITATTRIBUTES) return 'Git settings';
  if (path.startsWith(`${PAGES_DIR}/`)) {
    const page = doc && Object.values(doc.pages).find((p) => pageFile(p.id) === path);
    return page ? `Page “${page.name}”` : 'A page';
  }
  if (path.startsWith(`${ASSETS_DIR}/`)) {
    if (/\.(mp4|webm)$/i.test(path)) return 'Video';
    if (/\.json$/i.test(path)) return 'Lottie animation';
    return 'Image';
  }
  return path;
}

// ---- on disk -----------------------------------------------------------------

const sameText = (a: string, b: string) => a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

/**
 * Write a document into its folder. Only files whose content changed are rewritten; pages, tokens,
 * comments and assets the design no longer has are removed. Assets come from the media store.
 */
export async function writeDesignFolder(dir: string, doc: PaperDocument, mediaDir: string, id = doc.id): Promise<void> {
  await mkdir(dir, { recursive: true });
  const files = designFiles(doc, id);
  const readme = await readText(join(dir, README));
  if (readme === undefined || readme.includes(README_MARKER)) files.set(README, readmeFor(doc));
  if ((await readText(join(dir, GITATTRIBUTES))) === undefined) files.set(GITATTRIBUTES, ATTRIBUTES);
  for (const [rel, content] of files) {
    const current = await readText(join(dir, rel));
    if (current === undefined || !sameText(current, content)) await writeFileAtomic(join(dir, rel), content);
  }
  for (const name of await list(join(dir, PAGES_DIR))) {
    if (name.endsWith('.json') && !files.has(`${PAGES_DIR}/${name}`)) await rm(join(dir, PAGES_DIR, name), { force: true });
  }
  for (const rel of [TOKENS, COMMENTS]) if (!files.has(rel)) await rm(join(dir, rel), { force: true });
  const media = mediaNames(doc);
  const present = new Set(await list(join(dir, ASSETS_DIR)));
  for (const name of media) {
    if (present.has(name)) continue;
    const source = join(mediaDir, name);
    if (!(await stat(source).catch(() => null))?.isFile()) continue;
    await mkdir(join(dir, ASSETS_DIR), { recursive: true });
    await copyFile(source, join(dir, ASSETS_DIR, name));
  }
  for (const name of present) if (MEDIA_NAME.test(name) && !media.has(name)) await rm(join(dir, ASSETS_DIR, name), { force: true });
}

/** Read a design folder; the assets it carries are copied into the media store when missing there. */
export async function readDesignFolder(dir: string, mediaDir: string): Promise<PaperDocument> {
  const texts = new Map<string, string>();
  for (const rel of [MANIFEST, TOKENS, COMMENTS]) {
    const text = await readText(join(dir, rel));
    if (text !== undefined) texts.set(rel, text);
  }
  for (const name of await list(join(dir, PAGES_DIR))) {
    const text = await readText(join(dir, PAGES_DIR, name));
    if (text !== undefined) texts.set(`${PAGES_DIR}/${name}`, text);
  }
  const doc = parseDesign((path) => texts.get(path));
  for (const name of mediaNames(doc)) {
    const target = join(mediaDir, name);
    if ((await stat(target).catch(() => null))?.isFile()) continue;
    const source = join(dir, ASSETS_DIR, name);
    if ((await stat(source).catch(() => null))?.isFile()) await copyFile(source, target);
  }
  return doc;
}

/**
 * A cheap stamp of the folder's design files (names, sizes, modification times): it changes when
 * anything rewrites them, e.g. a branch switch or pull outside OpenPaper. Null when there's no design.
 */
export async function folderStamp(dir: string): Promise<string | null> {
  const parts: string[] = [];
  const add = async (rel: string) => {
    const info = await stat(join(dir, rel)).catch(() => null);
    if (info?.isFile()) parts.push(`${rel}:${info.size}:${Math.round(info.mtimeMs)}`);
  };
  await add(MANIFEST);
  if (!parts.length) return null;
  await add(TOKENS);
  await add(COMMENTS);
  for (const name of await list(join(dir, PAGES_DIR))) await add(`${PAGES_DIR}/${name}`);
  for (const name of await list(join(dir, ASSETS_DIR))) parts.push(`${ASSETS_DIR}/${name}`);
  return createHash('sha1').update(parts.sort().join('\n')).digest('hex');
}

/** The design id a folder holds (null: no design there). */
export async function folderDesignId(dir: string): Promise<string | null> {
  const text = await readText(join(dir, MANIFEST));
  if (text === undefined) return null;
  try {
    const manifest = JSON.parse(text) as Partial<Manifest>;
    return manifest.format === FORMAT && typeof manifest.id === 'string' ? manifest.id : null;
  } catch {
    return null;
  }
}
