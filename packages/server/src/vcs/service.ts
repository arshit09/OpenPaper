import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  newFileId,
  type PaperDocument,
  type Transaction,
  type VcsBranch,
  type VcsChange,
  type VcsCommit,
  type VcsLocalFolder,
  type VcsSetup,
  type VcsStatus,
  type VcsTrackPlan,
} from '@openpaper/core';
import { writeFileAtomic } from '../fs-utils.ts';
import type { ActorRef, DocumentHub, LiveDocument } from '../hub.ts';
import type { FileStore } from '../storage.ts';
import { ASSETS_DIR, changeLabel, designFiles, folderDesignId, folderStamp, MANIFEST, PAGES_DIR, parseDesign, readDesignFolder, writeDesignFolder } from './folder.ts';
import { git, GitError, gitTest, gitVersion, readBlobs, splitNul } from './git.ts';
import { GitHub, gitAuthEnv, githubFullName } from './github.ts';

/**
 * Version control for designs: a tracked design is mirrored into a folder inside a Git repository
 * (written a moment after each edit), and commits, branches, pushes and pulls are plain Git on that
 * folder. Bindings (file id → folder) live in `<home>/vcs.json`.
 */

export interface VcsOptions {
  hub: DocumentHub;
  store: FileStore;
  /** The media store's folder (`<home>/assets`). */
  mediaDir: string;
  /** Where bindings are kept. */
  file: string;
  /** A file's version control changed: editors showing it ask for its status again. */
  changed: (fileId: string, notice?: string) => void;
  github?: GitHub;
}

/** What an operation leaves behind, plus anything worth telling the user about it. */
export interface VcsResult {
  status: VcsStatus;
  /** Part of it failed (e.g. committed, but the push was turned down). */
  warning?: string;
  /** Worth knowing (e.g. the branch doesn't have the design yet). */
  notice?: string;
}

interface Binding {
  /** The design folder. */
  dir: string;
  /** GitHub login used for pushes and pulls (null: Git's own credentials). */
  account: string | null;
  /**
   * The id the folder's openpaper.json gives the design, when it isn't this file's: a second copy of a
   * repository opened on the same computer gets a file id of its own, and the shared folder keeps its id.
   */
  designId?: string;
  /** `updatedAt` of the document when the folder last matched it. */
  syncedAt?: string;
  /** folderStamp() at that moment. */
  stamp?: string | null;
}

interface VcsFile {
  version: 1;
  files: Record<string, Binding>;
  /** Folder the user last kept repositories in. */
  root?: string;
}

const SYNC_DELAY_MS = 700;
const FETCH_EVERY_MS = 60_000;
const NETWORK_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_CACHE = 6;
const LOG_PAGE = 30;
const VCS_ACTOR: ActorRef = { kind: 'system', id: 'vcs', name: 'Version control' };
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Files a repository commonly starts with, which may sit beside a design kept at its top. */
const REPO_BOILERPLATE = /^(\.git|\.github|\.gitignore|\.gitattributes|readme(\..*)?|license(\..*)?|licence(\..*)?)$/i;

class NothingToCommit extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** A remote URL without any credentials written into it. */
const cleanUrl = (url: string) => url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');

/** The repository's `origin` as configured (not rewritten by `insteadOf` rules), without credentials; null when there is none. */
function originUrl(root: string): Promise<string | null> {
  return git(['config', '--get', 'remote.origin.url'], { cwd: root }).then(
    (s) => cleanUrl(s.trim()) || null,
    () => null
  );
}

/** Where repositories go unless the user picks somewhere else: Documents/OpenPaper, else ~/OpenPaper. */
function defaultRoot(): string {
  const documents = join(homedir(), 'Documents');
  return existsSync(documents) ? join(documents, 'OpenPaper') : join(homedir(), 'OpenPaper');
}

/** A '/'-separated folder path inside a repository, checked segment by segment. */
function cleanRepoPath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.toLowerCase() === '.git' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || WINDOWS_DEVICE.test(part.split('.')[0]!)) {
      throw new Error(`“${part}” can’t be a folder name.`);
    }
  }
  return parts.join('/');
}

/** Turn what git said into what to do about it. */
function friendly(error: unknown, branch?: string | null): Error {
  const text = error instanceof GitError ? `${error.message}\n${error.stderr}` : message(error);
  if (/would be overwritten by (checkout|merge|switch)|Please commit your changes or stash them/i.test(text)) {
    return new Error('You have changes that aren’t committed yet. Commit them first, or make a new branch, which takes them along.');
  }
  if (/non-fast-forward|fetch first|\[rejected\]|Updates were rejected/i.test(text)) {
    return new Error(`The remote has commits on ${branch ?? 'this branch'} that aren’t on this computer. Pull them first, or push to a new branch.`);
  }
  if (/Not possible to fast-forward|have diverged|divergent branches/i.test(text)) {
    return new Error('This branch and the remote both have new commits. Push yours to a new branch instead, or merge them with Git.');
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission to .* denied|returned error: 403/i.test(text)) {
    return new Error('The remote turned down the sign-in. Check that this account can push to the repository, or sign in again with `gh auth login`.');
  }
  if (/Could not resolve host|unable to access|Failed to connect|timed out/i.test(text)) return new Error('Can’t reach the remote. Check your internet connection.');
  if (/a branch named .* already exists/i.test(text)) return new Error(`A branch called “${branch}” already exists. Switch to it, or pick another name.`);
  return error instanceof Error ? error : new Error(text);
}

/** Make `tx` hold `target`'s content, touching only records that differ. */
function replaceContent(tx: Transaction, target: PaperDocument, withComments: boolean): void {
  const base = tx.base;
  // Top-level key order doesn't matter (the folder stores keys in its own order); nested values compare as written.
  const same = (a: object | undefined, b: object) => {
    if (a === b) return true;
    if (!a) return false;
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => JSON.stringify((a as Record<string, unknown>)[k]) === JSON.stringify((b as Record<string, unknown>)[k]));
  };
  const json = (v: unknown) => JSON.stringify(v);
  for (const node of Object.values(target.nodes)) if (!same(base.nodes[node.id], node)) tx.putNode(node);
  for (const id of Object.keys(base.nodes)) if (!target.nodes[id]) tx.removeNodeRecord(id);
  for (const page of Object.values(target.pages)) if (!same(base.pages[page.id], page)) tx.putPage(page);
  for (const id of Object.keys(base.pages)) if (!target.pages[id]) tx.removePage(id);
  if (json(base.pageList) !== json(target.pageList)) tx.setPageList(target.pageList);
  if (json(base.tokens) !== json(target.tokens)) tx.setTokens(target.tokens);
  if (json(base.keyframes ?? []) !== json(target.keyframes ?? [])) tx.setKeyframes(target.keyframes ?? []);
  if (base.name !== target.name) tx.setName(target.name);
  tx.raiseCounters(target.counters);
  if (!withComments) return;
  for (const thread of Object.values(target.comments)) if (!same(base.comments[thread.id], thread)) tx.putThread(thread);
  for (const id of Object.keys(base.comments)) if (!target.comments[id]) tx.removeThread(id);
  for (const user of Object.values(target.users ?? {})) if (json(base.users?.[user.userId]) !== json(user)) tx.putUser(user);
}

interface Where {
  binding: Binding;
  dir: string;
  /** Repository root. */
  root: string;
  /** The design folder inside it ('' = the root). */
  rel: string;
  /** `rel` as a pathspec. */
  spec: string;
}

export class VcsService {
  readonly github: GitHub;
  private data: VcsFile = { version: 1, files: {} };
  private persisting: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Index-changing git commands run one at a time (two designs can share a repository). */
  private gitLock: Promise<unknown> = Promise.resolve();
  private readonly fetchedAt = new Map<string, number>();
  private readonly snapshots = new Map<string, { doc: PaperDocument; commit: VcsCommit }>();
  /** Why a file's folder can't be mirrored right now (e.g. unreadable after a merge conflict). */
  private readonly problems = new Map<string, string>();

  constructor(private readonly opts: VcsOptions) {
    this.github = opts.github ?? new GitHub();
  }

  async init(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.opts.file, 'utf8')) as VcsFile;
      if (raw?.version === 1 && raw.files) this.data = raw;
    } catch {
      // No bindings yet.
    }
    this.opts.hub.on('commit', (e) => {
      if (this.data.files[e.fileId]) this.schedule(e.fileId);
    });
  }

  isTracked(fileId: string): boolean {
    return !!this.data.files[fileId];
  }

  /** Bring every pending folder up to date (the server is stopping). */
  async close(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(pending.map((id) => this.run(id, () => this.syncNow(id)).catch(() => {})));
    await this.persisting;
  }

  // ---- queueing ------------------------------------------------------------

  /** Run `fn` after every earlier operation on the same file (folder writes and git commands never interleave). */
  private run<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(fileId) ?? Promise.resolve()).then(fn);
    const tail = next.catch(() => {});
    this.queues.set(fileId, tail);
    void tail.then(() => {
      if (this.queues.get(fileId) === tail) this.queues.delete(fileId);
    });
    return next;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitLock.then(fn);
    this.gitLock = next.catch(() => {});
    return next;
  }

  private schedule(fileId: string): void {
    clearTimeout(this.timers.get(fileId));
    this.timers.set(
      fileId,
      setTimeout(() => {
        this.timers.delete(fileId);
        this.run(fileId, () => this.syncNow(fileId)).then(
          (notice) => this.opts.changed(fileId, notice),
          (error) => console.error(`[openpaper] couldn't write ${fileId} to its folder:`, error)
        );
      }, SYNC_DELAY_MS)
    );
  }

  private persistNow(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2);
    this.persisting = this.persisting.then(() => writeFileAtomic(this.opts.file, text)).catch((error) => console.error('[openpaper] failed to save vcs.json:', error));
    return this.persisting;
  }

  // ---- the folder ------------------------------------------------------------

  /**
   * Make the folder match the design. If the folder changed outside OpenPaper (a pull or branch switch in a
   * terminal) while the design wasn't edited here, the folder's version is loaded instead. Returns a notice then.
   */
  private async syncNow(fileId: string): Promise<string | undefined> {
    clearTimeout(this.timers.get(fileId));
    this.timers.delete(fileId);
    const b = this.data.files[fileId];
    if (!b || !(await isDir(b.dir))) return;
    const live = await this.opts.hub.get(fileId);
    const stamp = await folderStamp(b.dir);
    let notice: string | undefined;
    let loaded = false;
    if (stamp && b.stamp && stamp !== b.stamp) {
      if (live.doc.updatedAt === b.syncedAt) {
        let doc: PaperDocument;
        try {
          doc = await readDesignFolder(b.dir, this.opts.mediaDir);
        } catch (error) {
          // Don't write over files someone is fixing (a merge conflict): wait until they can be read.
          this.problems.set(fileId, `The design’s files can’t be read (${message(error)}). Fix them, or discard the changes with Git.`);
          return;
        }
        this.replaceFromFolder(live, doc, 'Load the design from its folder');
        loaded = true;
        notice = 'The design’s folder changed outside OpenPaper, so the design now shows what’s in it.';
      } else {
        notice = 'The design’s folder changed outside OpenPaper while you were editing; your version was kept.';
      }
    }
    this.problems.delete(fileId);
    if (!loaded) await writeDesignFolder(b.dir, live.doc, this.opts.mediaDir, b.designId);
    b.syncedAt = live.doc.updatedAt;
    b.stamp = await folderStamp(b.dir);
    await this.persistNow();
    return notice;
  }

  /** Show what's in the folder (after a branch switch or pull): replaces the content, and undo can't cross it. */
  private replaceFromFolder(live: LiveDocument, doc: PaperDocument, label: string): void {
    live.transact(VCS_ACTOR, label, (tx) => replaceContent(tx, doc, true), { undoable: false });
    live.clearHistory();
  }

  /** After git changed the working tree: load the design from the folder (or, if this branch has none, write it there). */
  private async reloadNow(fileId: string, label: string): Promise<string | undefined> {
    const b = this.data.files[fileId]!;
    const live = await this.opts.hub.get(fileId);
    let notice: string | undefined;
    if (await folderDesignId(b.dir)) this.replaceFromFolder(live, await readDesignFolder(b.dir, this.opts.mediaDir), label);
    else {
      await writeDesignFolder(b.dir, live.doc, this.opts.mediaDir, b.designId);
      notice = 'This branch doesn’t have the design yet. Commit to add it.';
    }
    b.syncedAt = live.doc.updatedAt;
    b.stamp = await folderStamp(b.dir);
    await this.persistNow();
    return notice;
  }

  private async locate(fileId: string): Promise<Where> {
    const binding = this.data.files[fileId];
    if (!binding) throw new Error('This design isn’t tracked yet.');
    if (!(await isDir(binding.dir))) throw new Error(`The design’s folder is gone: ${binding.dir}`);
    let root: string;
    try {
      root = resolve((await git(['rev-parse', '--show-toplevel'], { cwd: binding.dir })).trim());
    } catch (error) {
      if (error instanceof GitError && error.code === null) throw error;
      throw new Error(`${binding.dir} isn’t in a Git repository any more.`);
    }
    const rel = relative(root, binding.dir).split(sep).join('/');
    return { binding, dir: binding.dir, root, rel, spec: rel || '.' };
  }

  /** Our own files in the design folder, as paths from the repository root. */
  private async ownFiles(where: Where, doc: PaperDocument): Promise<string[]> {
    const names = [...designFiles(doc, where.binding.designId).keys(), 'README.md', '.gitattributes'];
    for (const name of await readdir(join(where.dir, ASSETS_DIR)).catch(() => [] as string[])) names.push(`${ASSETS_DIR}/${name}`);
    const out: string[] = [];
    for (const name of names) if (existsSync(join(where.dir, name))) out.push(where.rel ? `${where.rel}/${name}` : name);
    return out;
  }

  private async authEnv(binding: Binding): Promise<Record<string, string>> {
    if (!binding.account) return {};
    try {
      return gitAuthEnv((await this.github.login(binding.account)).token);
    } catch {
      // Signed out since: Git's own credentials may still work.
      return {};
    }
  }

  private async defaultAccount(): Promise<string | null> {
    const accounts = await this.github.accounts().catch(() => []);
    return (accounts.find((a) => a.active) ?? accounts[0])?.login ?? null;
  }

  // ---- status ------------------------------------------------------------------

  async status(fileId: string): Promise<VcsStatus> {
    if (!this.data.files[fileId]) return { tracked: false };
    return this.run(fileId, () => this.statusNow(fileId));
  }

  private async statusNow(fileId: string): Promise<VcsStatus> {
    const binding = this.data.files[fileId];
    if (!binding) return { tracked: false };
    const base: VcsStatus = { tracked: true, dir: binding.dir, account: binding.account };
    let where: Where;
    try {
      where = await this.locate(fileId);
      await this.syncNow(fileId);
    } catch (error) {
      return { ...base, problem: message(error) };
    }
    const problem = this.problems.get(fileId);
    const out = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', where.spec], { cwd: where.root });
    const doc = this.opts.hub.peek(fileId)?.doc;
    const status: VcsStatus = { ...base, repoRoot: where.root, path: where.rel, branch: null, upstream: null, ahead: 0, behind: 0, head: null, changes: [], ...(problem ? { problem } : {}) };
    const entries = out.split('\0');
    const prefix = where.rel ? `${where.rel}/` : '';
    const change = (path: string, kind: VcsChange['kind']) => {
      if (!path.startsWith(prefix)) return;
      const inner = path.slice(prefix.length);
      status.changes!.push({ path: inner, kind, label: changeLabel(inner, doc) });
    };
    const kindOf = (xy: string): VcsChange['kind'] => (xy.includes('D') ? 'deleted' : xy.includes('A') ? 'added' : 'modified');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.startsWith('# branch.oid ')) status.head = entry.slice(13) === '(initial)' ? null : entry.slice(13);
      else if (entry.startsWith('# branch.head ')) status.branch = entry.slice(14) === '(detached)' ? null : entry.slice(14);
      else if (entry.startsWith('# branch.upstream ')) status.upstream = entry.slice(18);
      else if (entry.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(entry);
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])];
      } else if (entry.startsWith('1 ')) {
        const parts = entry.split(' ');
        change(parts.slice(8).join(' '), kindOf(parts[1]!));
      } else if (entry.startsWith('2 ')) {
        const parts = entry.split(' ');
        change(parts.slice(9).join(' '), kindOf(parts[1]!));
        i++; // the original path
      } else if (entry.startsWith('u ')) change(entry.split(' ').slice(10).join(' '), 'modified');
      else if (entry.startsWith('? ')) change(entry.slice(2), 'added');
    }
    const url = await originUrl(where.root);
    const fullName = githubFullName(url);
    status.remote = url ? { url, fullName, webUrl: fullName ? `https://github.com/${fullName}` : null } : null;
    return status;
  }

  /** Ask the remote what's new (at most once a minute unless `force`), then the status. */
  async fetch(fileId: string, force = false): Promise<VcsResult> {
    return this.run(fileId, async () => {
      let warning: string | undefined;
      const binding = this.data.files[fileId];
      if (binding && (force || Date.now() - (this.fetchedAt.get(fileId) ?? 0) > FETCH_EVERY_MS)) {
        this.fetchedAt.set(fileId, Date.now());
        try {
          const where = await this.locate(fileId);
          const remotes = splitLines(await git(['remote'], { cwd: where.root }));
          if (remotes.includes('origin')) await git(['fetch', '--prune', 'origin'], { cwd: where.root, env: await this.authEnv(binding), timeoutMs: NETWORK_TIMEOUT_MS });
        } catch (error) {
          warning = `Couldn’t check the remote for new commits: ${message(friendly(error))}`;
        }
      }
      return { status: await this.statusNow(fileId), warning };
    });
  }

  // ---- history -----------------------------------------------------------------

  /** Commits on the current branch that changed the design, newest first. */
  async log(fileId: string, skip = 0, limit = LOG_PAGE): Promise<{ commits: VcsCommit[]; more: boolean }> {
    return this.run(fileId, async () => {
      const where = await this.locate(fileId);
      if (!(await gitTest(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: where.root }))) return { commits: [], more: false };
      const out = await git(['log', `--max-count=${limit + 1}`, `--skip=${Math.max(0, skip)}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e', 'HEAD', '--', where.spec], { cwd: where.root });
      const rows = out
        .split('\x1e')
        .map((r) => r.trim())
        .filter(Boolean)
        .map((r) => r.split('\x1f'));
      const remotes = splitLines(await git(['remote'], { cwd: where.root }));
      const unpushed = remotes.length ? new Set(splitLines(await git(['rev-list', '--max-count=2000', 'HEAD', '--not', '--remotes'], { cwd: where.root }))) : null;
      const web = githubFullName(await originUrl(where.root));
      const commits = rows.slice(0, limit).map(([hash, short, subject, author, date]): VcsCommit => {
        const pushed = !!unpushed && !unpushed.has(hash!);
        return { hash: hash!, short: short!, subject: subject!, author: author!, date: date!, pushed, url: pushed && web ? `https://github.com/${web}/commit/${hash}` : null };
      });
      return { commits, more: rows.length > limit };
    });
  }

  /** The design as it was at a commit (assets it needs are copied into the media store). */
  async snapshot(fileId: string, commit: string): Promise<{ doc: PaperDocument; commit: VcsCommit }> {
    if (!/^([0-9a-f]{4,64}|HEAD)$/i.test(commit)) throw new Error('That isn’t a commit.');
    return this.run(fileId, async () => {
      const where = await this.locate(fileId);
      let hash: string;
      try {
        hash = (await git(['rev-parse', '--verify', '-q', `${commit}^{commit}`], { cwd: where.root })).trim();
      } catch {
        throw new Error(commit === 'HEAD' ? 'Nothing has been committed yet.' : `Commit ${commit} isn’t in this repository.`);
      }
      const cached = this.snapshots.get(`${fileId}:${hash}`);
      if (cached) return cached;
      const listing = splitNul(await git(['ls-tree', '-r', '-z', '--full-tree', hash, '--', where.spec], { cwd: where.root }));
      const prefix = where.rel ? `${where.rel}/` : '';
      const texts = new Map<string, string>(); // inner path → blob id, then → text
      const assets = new Map<string, string>(); // file name → blob id
      for (const line of listing) {
        const tab = line.indexOf('\t');
        const [, type, oid] = line.slice(0, tab).split(' ');
        const path = line.slice(tab + 1);
        if (type !== 'blob' || !path.startsWith(prefix)) continue;
        const inner = path.slice(prefix.length);
        if (inner === MANIFEST || inner === 'tokens.json' || inner === 'comments.json' || (inner.startsWith(`${PAGES_DIR}/`) && inner.endsWith('.json'))) texts.set(inner, oid!);
        else if (inner.startsWith(`${ASSETS_DIR}/`) && /^[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(inner.slice(ASSETS_DIR.length + 1))) assets.set(inner.slice(ASSETS_DIR.length + 1), oid!);
      }
      if (!texts.has(MANIFEST)) throw new Error(`The design wasn’t in this folder at commit ${hash.slice(0, 7)}.`);
      const missing = [...assets].filter(([name]) => !existsSync(join(this.opts.mediaDir, name)));
      const blobs = await readBlobs(where.root, [...new Set([...texts.values(), ...missing.map(([, oid]) => oid)])]);
      for (const [name, oid] of missing) {
        const data = blobs.get(oid);
        if (data) await writeFileAtomic(join(this.opts.mediaDir, name), data);
      }
      const [short, subject, author, date] = (await git(['show', '-s', '--format=%h%x1f%s%x1f%an%x1f%aI', hash], { cwd: where.root })).trim().split('\x1f');
      const doc = parseDesign((path) => (texts.has(path) ? blobs.get(texts.get(path)!)?.toString('utf8') : undefined), { updatedAt: date });
      doc.id = fileId;
      const onRemote = splitLines(await git(['branch', '-r', '--contains', hash, '--format=%(refname)'], { cwd: where.root }).catch(() => '')).length > 0;
      const web = githubFullName(await originUrl(where.root));
      const result = {
        doc,
        commit: { hash, short: short!, subject: subject!, author: author!, date: date!, pushed: onRemote, url: onRemote && web ? `https://github.com/${web}/commit/${hash}` : null },
      };
      this.snapshots.set(`${fileId}:${hash}`, result);
      if (this.snapshots.size > SNAPSHOT_CACHE) this.snapshots.delete(this.snapshots.keys().next().value!);
      return result;
    });
  }

  /**
   * Bring back the design as it was at a commit, as one change the user can undo. Comments stay as they
   * are unless `comments` (discarding changes puts everything back).
   */
  async restore(fileId: string, commit: string, actor: ActorRef, opts: { comments?: boolean; label?: string } = {}): Promise<VcsCommit> {
    const { doc, commit: info } = await this.snapshot(fileId, commit);
    const live = await this.opts.hub.get(fileId);
    live.transact(actor, opts.label ?? `Restore version ${info.short}`, (tx) => replaceContent(tx, doc, !!opts.comments));
    return info;
  }

  // ---- branches ------------------------------------------------------------------

  async branches(fileId: string): Promise<VcsBranch[]> {
    return this.run(fileId, async () => {
      const where = await this.locate(fileId);
      const out = await git(['for-each-ref', '--format=%(refname)%1f%(HEAD)', 'refs/heads', 'refs/remotes/origin'], { cwd: where.root });
      const branches = new Map<string, VcsBranch>();
      for (const line of splitLines(out)) {
        const [ref, head] = line.split('\x1f');
        const local = ref!.startsWith('refs/heads/');
        const name = local ? ref!.slice(11) : ref!.slice('refs/remotes/origin/'.length);
        if (!local && name === 'HEAD') continue;
        const b = branches.get(name) ?? { name, current: false, local: false, remote: false };
        if (local) b.local = true;
        else b.remote = true;
        if (head === '*') b.current = true;
        branches.set(name, b);
      }
      // A new repository's branch has no commits yet, so no ref.
      const current = (await git(['branch', '--show-current'], { cwd: where.root })).trim();
      if (current && !branches.has(current)) branches.set(current, { name: current, current: true, local: true, remote: false });
      return [...branches.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    });
  }

  /** Switch to a branch (`create`: a new one from here, taking uncommitted changes along) and show its version of the design. */
  async switchBranch(fileId: string, name: string, create: boolean): Promise<VcsResult> {
    return this.run(fileId, async () => {
      const where = await this.locate(fileId);
      await this.syncNow(fileId);
      const branch = String(name).trim();
      if (!branch || !(await gitTest(['check-ref-format', '--branch', branch], { cwd: where.root }).catch(() => false))) {
        throw new Error(`“${branch}” can’t be a branch name. Use letters, numbers, dashes and slashes.`);
      }
      await this.exclusive(async () => {
        try {
          await git(create ? ['switch', '-c', branch] : ['switch', branch], { cwd: where.root });
        } catch (error) {
          throw friendly(error, branch);
        }
      });
      const notice = create ? undefined : await this.reloadNow(fileId, `Switch to ${branch}`);
      return { status: await this.statusNow(fileId), notice };
    });
  }

  // ---- commit, push, pull ------------------------------------------------------------

  async commit(fileId: string, text: string, push: boolean): Promise<VcsResult> {
    const msg = String(text ?? '').trim();
    if (!msg) throw new Error('Write a message that says what changed.');
    return this.run(fileId, async () => {
      try {
        await this.commitNow(fileId, msg);
      } catch (error) {
        if (error instanceof NothingToCommit && push) {
          // Nothing new, but there may be commits to push.
        } else throw error;
      }
      let warning: string | undefined;
      if (push) {
        try {
          await this.pushNow(fileId);
        } catch (error) {
          warning = `Committed, but the push didn’t go through: ${message(error)}`;
        }
      }
      return { status: await this.statusNow(fileId), warning };
    });
  }

  private async commitNow(fileId: string, msg: string): Promise<void> {
    const where = await this.locate(fileId);
    await this.syncNow(fileId);
    const live = await this.opts.hub.get(fileId);
    const own = await this.ownFiles(where, live.doc);
    const identity = await this.identity(where.root, where.binding.account);
    await this.exclusive(async () => {
      await git(['add', '-A', '--', where.spec], { cwd: where.root });
      // Our own files go in even where a .gitignore would leave them out.
      if (own.length) await git(['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: where.root, input: own.join('\0') });
      if (await gitTest(['diff', '--cached', '--quiet', '--', where.spec], { cwd: where.root })) throw new NothingToCommit('Nothing to commit: the design is the same as in its last commit.');
      // Only the design folder: anything else the user has staged in the repository stays staged.
      await git([...identity, 'commit', '-F', '-', '--', where.spec], { cwd: where.root, input: msg });
    });
  }

  /** `-c user.name/email` when the repository has no identity: the GitHub account's, else the computer user's. */
  private async identity(root: string, account: string | null): Promise<string[]> {
    const get = (key: string) => git(['config', key], { cwd: root }).then((s) => s.trim(), () => '');
    const [name, email] = await Promise.all([get('user.name'), get('user.email')]);
    if (name && email) return [];
    const login = account ? await this.github.login(account).catch(() => null) : null;
    let user = 'OpenPaper';
    try {
      user = userInfo().username || user;
    } catch {
      // keep the fallback
    }
    return [
      ...(name ? [] : ['-c', `user.name=${login ? login.name || login.login : user}`]),
      ...(email ? [] : ['-c', `user.email=${login ? `${login.id}+${login.login}@users.noreply.github.com` : `${user}@localhost`}`]),
    ];
  }

  async push(fileId: string): Promise<VcsResult> {
    return this.run(fileId, async () => {
      await this.pushNow(fileId);
      return { status: await this.statusNow(fileId) };
    });
  }

  private async pushNow(fileId: string): Promise<void> {
    const where = await this.locate(fileId);
    const branch = (await git(['branch', '--show-current'], { cwd: where.root })).trim();
    if (!branch) throw new Error('The design is on a commit, not a branch. Switch to a branch to push.');
    if (!splitLines(await git(['remote'], { cwd: where.root })).includes('origin')) throw new Error('This repository isn’t connected to a remote, so there’s nowhere to push.');
    if (!(await gitTest(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: where.root }))) throw new Error('Commit something first: there’s nothing to push yet.');
    try {
      await git(['push', '-u', 'origin', branch], { cwd: where.root, env: await this.authEnv(where.binding), timeoutMs: NETWORK_TIMEOUT_MS });
    } catch (error) {
      throw friendly(error, branch);
    }
    this.fetchedAt.set(fileId, Date.now());
  }

  /** Bring in new commits from the remote branch (fast-forward only) and show them. */
  async pull(fileId: string): Promise<VcsResult> {
    return this.run(fileId, async () => {
      const where = await this.locate(fileId);
      await this.syncNow(fileId);
      const branch = (await git(['branch', '--show-current'], { cwd: where.root })).trim() || null;
      if (!(await gitTest(['rev-parse', '--verify', '-q', '@{u}'], { cwd: where.root }))) throw new Error(`${branch ?? 'This branch'} isn’t on the remote yet, so there’s nothing to pull.`);
      const env = await this.authEnv(where.binding);
      await this.exclusive(async () => {
        try {
          await git(['pull', '--ff-only', '--no-rebase'], { cwd: where.root, env, timeoutMs: NETWORK_TIMEOUT_MS });
        } catch (error) {
          throw friendly(error, branch);
        }
      });
      this.fetchedAt.set(fileId, Date.now());
      const notice = await this.reloadNow(fileId, 'Pull');
      return { status: await this.statusNow(fileId), notice };
    });
  }

  // ---- starting and stopping -------------------------------------------------------

  async setup(fresh = false): Promise<VcsSetup> {
    const [version, accounts] = await Promise.all([gitVersion(), this.github.accounts(fresh).catch(() => [])]);
    return { git: version, accounts, gh: !!this.github.ghProgram(), defaultRoot: this.data.root ?? defaultRoot() };
  }

  /**
   * What a folder on this computer holds (`fullName`: does its `origin` point at that GitHub repository?).
   * A folder that doesn't exist yet reports the repository it would be made in, if any.
   */
  async inspectLocal(path: string, fullName?: string): Promise<VcsLocalFolder> {
    const abs = resolve(String(path));
    const info = await stat(abs).catch(() => null);
    if (info && !info.isDirectory()) return { path: abs, state: 'files' };
    let near = abs;
    while (!info && !(await isDir(near)) && dirname(near) !== near) near = dirname(near);
    const root = (await isDir(near)) ? await git(['rev-parse', '--show-toplevel'], { cwd: near }).then((s) => resolve(s.trim()), () => null) : null;
    if (!info) return root ? { path: abs, state: 'missing', repoRoot: root } : { path: abs, state: 'missing' };
    if (root) {
      const url = await originUrl(root);
      const matches = fullName ? githubFullName(url)?.toLowerCase() === fullName.toLowerCase() : undefined;
      return { path: abs, state: samePath(root, abs) ? 'repo' : 'in-repo', repoRoot: root, remoteUrl: url, ...(matches !== undefined ? { matches } : {}) };
    }
    return { path: abs, state: (await readdir(abs)).length ? 'files' : 'empty' };
  }

  /** A design may go in a folder that's new, empty, holds this same design, or (a repository's top) only the usual repository files. */
  private async ensureFree(dir: string, fileId: string): Promise<void> {
    for (const [id, b] of Object.entries(this.data.files)) {
      if (id !== fileId && samePath(b.dir, dir)) throw new Error(`Another design is kept in ${dir} already. Pick another folder.`);
    }
    const id = await folderDesignId(dir);
    if (id && id !== (this.data.files[fileId]?.designId ?? fileId)) throw new Error(`${dir} already holds another design. Pick another folder.`);
    for (let up = dirname(dir); up !== dirname(up); up = dirname(up)) {
      if (await folderDesignId(up)) throw new Error(`${up} is a design’s folder, and a design can’t go inside another one. Pick another folder.`);
    }
    if (!id && (await isDir(dir))) {
      const others = (await readdir(dir)).filter((name) => !REPO_BOILERPLATE.test(name));
      if (others.length) throw new Error(`${dir} already has other files in it. Pick a new or empty folder for the design.`);
    }
  }

  /** Start tracking a design: set up the repository (create or clone it if need be), write the folder, commit and push. */
  async track(fileId: string, plan: VcsTrackPlan): Promise<VcsResult> {
    if (this.data.files[fileId]) throw new Error('This design is tracked already.');
    const live = await this.opts.hub.get(fileId);
    let dir: string;
    let account: string | null = null;
    let remote = false;
    if (plan.kind === 'local') {
      dir = resolve(String(plan.dir));
      await this.ensureFree(dir, fileId);
      await mkdir(dir, { recursive: true });
      const root = await git(['rev-parse', '--show-toplevel'], { cwd: dir }).then((s) => resolve(s.trim()), () => null);
      if (!root) await git(['init', '-b', 'main'], { cwd: dir });
      else {
        const url = await originUrl(root);
        remote = !!url;
        if (githubFullName(url)) account = await this.defaultAccount();
      }
    } else {
      const login = await this.github.login(String(plan.account));
      account = login.login;
      const local = resolve(String(plan.local));
      const path = cleanRepoPath(String(plan.path ?? ''));
      let root: string;
      if ('create' in plan.repo) {
        const name = String(plan.repo.create.name ?? '').trim();
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') throw new Error('A repository name can only use letters, numbers, dots, dashes and underscores.');
        const here = await this.inspectLocal(local);
        if (here.state !== 'missing' && here.state !== 'empty') throw new Error(`${local} already has files in it. Pick an empty folder for the new repository.`);
        // GitHub last: nothing is created there until the folder is known to be usable.
        const repo = await this.github.createRepo(account, { name, private: plan.repo.create.private !== false });
        await mkdir(local, { recursive: true });
        await git(['init', '-b', repo.defaultBranch], { cwd: local });
        await git(['remote', 'add', 'origin', repo.cloneUrl], { cwd: local });
        root = local;
      } else {
        const repo = await this.github.repo(account, plan.repo.fullName);
        const here = await this.inspectLocal(local, repo.fullName);
        if (here.state === 'missing' || here.state === 'empty') {
          await mkdir(dirname(local), { recursive: true });
          try {
            await git(['clone', repo.cloneUrl, local], { cwd: dirname(local), env: gitAuthEnv(login.token), timeoutMs: NETWORK_TIMEOUT_MS });
          } catch (error) {
            throw friendly(error);
          }
          root = local;
        } else if (here.repoRoot && here.matches) root = here.repoRoot;
        else if (here.repoRoot) {
          throw new Error(`${local} is a copy of ${here.remoteUrl ? cleanUrl(here.remoteUrl) : 'another repository'}. Pick your copy of ${repo.fullName}, or an empty folder to download it into.`);
        } else throw new Error(`${local} already has other files in it. Pick your copy of ${repo.fullName}, or an empty folder to download it into.`);
      }
      dir = path ? join(root, ...path.split('/')) : root;
      await this.ensureFree(dir, fileId);
      await mkdir(dir, { recursive: true });
      remote = true;
      this.data.root = dirname(root);
    }
    this.data.files[fileId] = { dir, account };
    await this.persistNow();
    let warning: string | undefined;
    await this.run(fileId, async () => {
      try {
        await this.commitNow(fileId, `Add ${live.doc.name}`);
      } catch (error) {
        if (!(error instanceof NothingToCommit)) warning = `The design is in its folder, but the first commit failed: ${message(error)}`;
      }
      if (remote && !warning) {
        try {
          await this.pushNow(fileId);
        } catch (error) {
          warning = `Committed the first version, but couldn’t push it: ${message(error)}`;
        }
      }
    });
    return { status: await this.status(fileId), warning };
  }

  /** Show the design's folder in the computer's file manager. */
  async reveal(fileId: string): Promise<void> {
    const dir = this.data.files[fileId]?.dir;
    if (!dir || !(await isDir(dir))) throw new Error('The design’s folder isn’t there any more.');
    const [program, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
    const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
  }

  /** Stop tracking (the folder and the repository stay as they are). */
  async untrack(fileId: string): Promise<void> {
    await this.run(fileId, async () => {
      clearTimeout(this.timers.get(fileId));
      this.timers.delete(fileId);
      delete this.data.files[fileId];
      this.problems.delete(fileId);
      await this.persistNow();
    });
  }

  /**
   * Open a design folder (e.g. from a cloned repository) as a file, tracked from there. If the same design is
   * already open from that folder, that file; if OpenPaper has the design elsewhere, a copy with a new id.
   */
  async openFolder(path: string): Promise<string> {
    const dir = resolve(String(path));
    for (const [id, b] of Object.entries(this.data.files)) if (samePath(b.dir, dir) && this.opts.store.has(id)) return id;
    const doc = await readDesignFolder(dir, this.opts.mediaDir);
    const designId = doc.id;
    if (this.opts.store.has(doc.id)) doc.id = newFileId();
    const root = await git(['rev-parse', '--show-toplevel'], { cwd: dir }).then((s) => resolve(s.trim()), () => null);
    const url = root ? await originUrl(root) : null;
    await this.opts.store.save(doc);
    this.opts.hub.adopt(doc);
    this.data.files[doc.id] = { dir, account: githubFullName(url) ? await this.defaultAccount() : null, ...(designId !== doc.id ? { designId } : {}) };
    await this.persistNow();
    if (!root) await git(['init', '-b', 'main'], { cwd: dir });
    await this.run(doc.id, () => this.syncNow(doc.id));
    return doc.id;
  }
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
