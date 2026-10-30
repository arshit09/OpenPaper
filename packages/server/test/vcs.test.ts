import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createSubtree, Transaction, type PaperDocument } from '@openpaper/core';
import { DocumentHub, type ActorRef } from '../src/hub.ts';
import { resolvePaths } from '../src/paths.ts';
import { FileStore } from '../src/storage.ts';
import { designFiles, mediaNames, pageFile, parseDesign } from '../src/vcs/folder.ts';
import { githubFullName, type GitHub } from '../src/vcs/github.ts';
import { VcsService } from '../src/vcs/service.ts';

const user: ActorRef = { kind: 'user', id: 'u', name: 'User' };
const IMAGE = '0123456789abcdef0123456789abcdef.png';

/** A page with a board holding a title and an image, a token, a keyframes rule and a comment. */
function sampleDoc(name = 'Landing'): PaperDocument {
  const doc = createDocument({ name });
  const rootId = doc.pages[doc.pageList[0]!.id]!.rootId;
  const tx = new Transaction(doc);
  const board = createSubtree(tx, rootId, {
    component: 'Frame',
    label: 'Board',
    styles: { left: '0px', top: '0px', width: '400px', height: '300px', backgroundColor: '#ffffff' },
    children: [
      { component: 'Text', textValue: 'Hello', styles: { fontSize: '24px', color: '#111111' } },
      { component: 'Image', src: `/media/${IMAGE}`, styles: { width: '100px', height: '100px' } },
    ],
  });
  tx.setTokens([{ id: 't1', type: 'color', name: 'brand', value: '#ff0000' }]);
  tx.setKeyframes([{ name: 'fade', css: 'from{opacity: 0;}to{opacity: 1;}' }]);
  tx.putThread({
    id: '01JTHREAD0000000000000000A',
    pageId: doc.pageList[0]!.id,
    nodeId: board.id,
    xOffset: 4,
    yOffset: 8,
    status: 'open',
    userId: 'local-user',
    messages: [{ id: 'm1', userId: 'local-user', text: 'Bigger?', mentions: [], reactions: [], attachments: [], createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
    updatedAt: 1,
  });
  return tx.commit().doc;
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('design folder format', () => {
  it('round-trips a document through its files', () => {
    const doc = sampleDoc();
    const files = designFiles(doc);
    expect([...files.keys()].sort()).toEqual(['comments.json', 'openpaper.json', pageFile(doc.pageList[0]!.id), 'tokens.json'].sort());
    const back = parseDesign((p) => files.get(p), { updatedAt: doc.updatedAt });
    expect(back).toEqual({ ...doc, counters: back.counters });
    // Counters are worked out from the ids: new ids never clash with existing ones.
    expect(back.counters.nodes).toBeGreaterThanOrEqual(doc.counters.nodes);
    expect(back.counters.pages).toBe(doc.counters.pages);
  });

  it('writes one property per line, keys in a fixed order, and finds the media used', () => {
    const doc = sampleDoc();
    const page = designFiles(doc).get(pageFile(doc.pageList[0]!.id))!;
    expect(page).toContain('\n        "backgroundColor": "#ffffff"');
    const board = JSON.parse(page).nodes[1];
    expect(Object.keys(board).slice(0, 3)).toEqual(['id', 'component', 'label']);
    expect(Object.keys(board).at(-1)).toBe('children');
    expect([...mediaNames(doc)]).toEqual([IMAGE]);
  });

  it('keeps file names safe whatever the page id', () => {
    expect(pageFile('p-1-0')).toBe('pages/p-1-0.json');
    expect(pageFile('../../evil')).toMatch(/^pages\/page-[0-9a-f]{12}\.json$/);
    expect(pageFile('CON')).toMatch(/^pages\/page-/);
  });

  it('reads GitHub repository names from remote URLs', () => {
    expect(githubFullName('https://github.com/arshit09/OpenPaper.git')).toBe('arshit09/OpenPaper');
    expect(githubFullName('git@github.com:a-b/c.d.git')).toBe('a-b/c.d');
    expect(githubFullName('https://x-access-token:abc@github.com/o/r')).toBe('o/r');
    expect(githubFullName('https://gitlab.com/o/r.git')).toBeNull();
  });
});

describe('version control', () => {
  let home: string;
  let origin: string;
  let work: string;
  let store: FileStore;
  let hub: DocumentHub;
  let vcs: VcsService;
  const notices: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'openpaper-vcs-test-'));
    const paths = { ...resolvePaths(join(home, 'openpaper')), exports: join(home, 'exports') };
    store = new FileStore(paths);
    await store.init();
    await writeFile(join(paths.assets, IMAGE), 'not really a png');
    hub = new DocumentHub(store);
    vcs = new VcsService({ hub, store, mediaDir: paths.assets, file: join(paths.home, 'vcs.json'), changed: (_id, notice) => notice && notices.push(notice) });
    await vcs.init();
    // A bare repository stands in for GitHub; `work` is the user's copy of it.
    origin = join(home, 'origin.git');
    await mkdir(origin);
    gitIn(origin, 'init', '--bare', '-b', 'main');
    work = join(home, 'work');
    gitIn(home, 'clone', origin, work);
    gitIn(work, 'config', 'user.name', 'Test');
    gitIn(work, 'config', 'user.email', 'test@example.com');
    await writeFile(join(work, 'notes.txt'), 'the rest of the repository\n');
    gitIn(work, 'add', 'notes.txt');
    gitIn(work, 'commit', '-m', 'Start');
    gitIn(work, 'push', '-u', 'origin', 'main');
  });

  afterAll(async () => {
    await vcs?.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  let fileId: string;
  let firstCommit: string;
  const dir = () => join(work, 'designs', 'Landing');
  const title = () => Object.values(hub.peek(fileId)!.doc.nodes).find((n) => n.component === 'Text')!;

  it('tracks a design as a folder inside an existing repository, committing and pushing its first version', async () => {
    const doc = sampleDoc();
    await store.save(doc);
    fileId = doc.id;
    // Someone has other work staged in the repository: it must stay out of the design's commits.
    await writeFile(join(work, 'staged.txt'), 'not mine\n');
    gitIn(work, 'add', 'staged.txt');
    const { status, warning } = await vcs.track(fileId, { kind: 'local', dir: dir() });
    expect(warning).toBeUndefined();
    expect(status).toMatchObject({ tracked: true, path: 'designs/Landing', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] });
    expect(existsSync(join(dir(), 'openpaper.json'))).toBe(true);
    expect(await readdir(join(dir(), 'assets'))).toEqual([IMAGE]);
    expect(gitIn(work, 'log', '-1', '--format=%s')).toBe('Add Landing');
    expect(gitIn(work, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('staged.txt');
    expect(gitIn(work, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(gitIn(origin, 'log', '-1', '--format=%s', 'main')).toBe('Add Landing');
    firstCommit = gitIn(work, 'rev-parse', 'HEAD');
  });

  it('writes edits to the folder and names what changed', async () => {
    hub.peek(fileId)!.transact(user, 'Recolor', (tx) => tx.updateNode(title().id, (n) => void (n.styles.color = '#ff0000')));
    const status = await vcs.status(fileId);
    expect(status.changes).toEqual([{ path: pageFile(hub.peek(fileId)!.doc.pageList[0]!.id), kind: 'modified', label: 'Page “Page 1”' }]);
    expect(await readFile(join(dir(), pageFile(hub.peek(fileId)!.doc.pageList[0]!.id)), 'utf8')).toContain('"color": "#ff0000"');
  });

  it('commits and pushes, and lists the design’s history', async () => {
    const { status, warning } = await vcs.commit(fileId, 'Make the title red', true);
    expect(warning).toBeUndefined();
    expect(status).toMatchObject({ changes: [], ahead: 0 });
    const { commits, more } = await vcs.log(fileId);
    expect(more).toBe(false);
    expect(commits.map((c) => [c.subject, c.pushed])).toEqual([
      ['Make the title red', true],
      ['Add Landing', true],
    ]);
    await expect(vcs.commit(fileId, 'Again', false)).rejects.toThrow(/Nothing to commit/);
  });

  it('shows an old version without touching the design, and restores it as one undoable step', async () => {
    const { doc, commit } = await vcs.snapshot(fileId, firstCommit);
    expect(commit.subject).toBe('Add Landing');
    expect(doc.id).toBe(fileId);
    expect(Object.values(doc.nodes).find((n) => n.component === 'Text')!.styles.color).toBe('#111111');
    expect(title().styles.color).toBe('#ff0000');
    await vcs.restore(fileId, firstCommit, user);
    expect(title().styles.color).toBe('#111111');
    expect((await vcs.status(fileId)).changes).toHaveLength(1);
    expect(hub.peek(fileId)!.undo(user)).toBe(`Restore version ${commit.short}`);
    expect(title().styles.color).toBe('#ff0000');
    expect((await vcs.status(fileId)).changes).toEqual([]);
  });

  it('makes a branch that takes changes along, and switching back shows that branch’s design', async () => {
    hub.peek(fileId)!.transact(user, 'Rename', (tx) => tx.setName('Landing v2'));
    const created = await vcs.switchBranch(fileId, 'redesign', true);
    expect(created.status.branch).toBe('redesign');
    expect(created.status.changes!.map((c) => c.label)).toContain('Page list and file name');
    const pushed = await vcs.commit(fileId, 'Rename the file', true);
    expect(pushed.warning).toBeUndefined();
    expect(pushed.status.upstream).toBe('origin/redesign');
    expect((await vcs.branches(fileId)).map((b) => [b.name, b.current])).toEqual([
      ['redesign', true],
      ['main', false],
    ]);
    const back = await vcs.switchBranch(fileId, 'main', false);
    expect(back.status.branch).toBe('main');
    expect(hub.peek(fileId)!.doc.name).toBe('Landing');
    // Undo can't step across a branch switch.
    expect(hub.peek(fileId)!.canUndo(user)).toBe(false);
  });

  it('loads the folder when it changes outside OpenPaper, e.g. a branch switch in a terminal', async () => {
    gitIn(work, 'switch', 'redesign');
    const status = await vcs.status(fileId);
    expect(status.branch).toBe('redesign');
    expect(hub.peek(fileId)!.doc.name).toBe('Landing v2');
    expect(status.changes).toEqual([]);
    expect(notices.at(-1) ?? '').toBe('');
    gitIn(work, 'switch', 'main');
    await vcs.status(fileId);
    expect(hub.peek(fileId)!.doc.name).toBe('Landing');
  });

  it('refuses to put a design where another design or other files are', async () => {
    const other = sampleDoc('Other');
    await store.save(other);
    await expect(vcs.track(other.id, { kind: 'local', dir: dir() })).rejects.toThrow(/Another design/);
    await expect(vcs.track(other.id, { kind: 'local', dir: join(dir(), 'pages') })).rejects.toThrow(/can’t go inside another one/);
    await expect(vcs.track(other.id, { kind: 'local', dir: work })).rejects.toThrow(/other files/);
  });

  it('opens a design folder from another copy of the repository', async () => {
    const copy = join(home, 'copy');
    gitIn(home, 'clone', origin, copy);
    const opened = await vcs.openFolder(join(copy, 'designs', 'Landing'));
    // The same design is already in OpenPaper (tracked in `work`), so the copy gets its own id.
    expect(opened).not.toBe(fileId);
    expect(hub.peek(opened)!.doc.name).toBe('Landing');
    expect((await vcs.status(opened)).branch).toBe('main');
    expect(await vcs.openFolder(join(copy, 'designs', 'Landing'))).toBe(opened);
  });

  it('pulls new commits made elsewhere and shows them', async () => {
    const copy = join(home, 'copy');
    const page = JSON.parse(await readFile(join(copy, 'designs', 'Landing', pageFile(hub.peek(fileId)!.doc.pageList[0]!.id)), 'utf8'));
    page.nodes.find((n: { component: string }) => n.component === 'Text').textValue = 'Hello from the other copy';
    await writeFile(join(copy, 'designs', 'Landing', pageFile(hub.peek(fileId)!.doc.pageList[0]!.id)), JSON.stringify(page, null, 2) + '\n');
    gitIn(copy, 'commit', '-am', 'Change the greeting');
    gitIn(copy, 'push', 'origin', 'main');
    const fetched = await vcs.fetch(fileId, true);
    expect(fetched.status.behind).toBe(1);
    const pulled = await vcs.pull(fileId);
    expect(pulled.status).toMatchObject({ behind: 0, changes: [] });
    expect(title().textValue).toBe('Hello from the other copy');
  });

  it('stops tracking without touching the folder', async () => {
    await vcs.untrack(fileId);
    expect(vcs.isTracked(fileId)).toBe(false);
    expect((await vcs.status(fileId)).tracked).toBe(false);
    expect(existsSync(join(dir(), 'openpaper.json'))).toBe(true);
  });
});

describe('version control with GitHub repositories', () => {
  let home: string;
  let github: string;
  let store: FileStore;
  let vcs: VcsService;
  let restoreConfig: () => void;

  const repoInfo = (fullName: string) => ({
    fullName,
    owner: 'octo',
    name: fullName.split('/')[1]!,
    private: true,
    description: null,
    defaultBranch: 'main',
    pushedAt: null,
    htmlUrl: `https://github.com/${fullName}`,
    empty: false,
    cloneUrl: `https://github.com/${fullName}.git`,
  });
  /** The GitHub API, answered here; the repositories behind its URLs are local (see `insteadOf` below). */
  const fakeGitHub = {
    ghProgram: () => null,
    accounts: async () => [{ login: 'octo', name: 'Octo', avatarUrl: null, source: 'gh', active: true }],
    login: async () => ({ login: 'octo', token: 'token', source: 'gh', active: true, id: 7, name: 'Octo', avatarUrl: null }),
    repo: async (_login: string, fullName: string) => repoInfo(fullName),
    createRepo: async (_login: string, opts: { name: string }) => {
      gitIn(home, 'init', '--bare', '-b', 'main', join(github, 'octo', `${opts.name}.git`));
      return repoInfo(`octo/${opts.name}`);
    },
  } as unknown as GitHub;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'openpaper-vcs-github-test-'));
    github = join(home, 'github');
    await mkdir(join(github, 'octo'), { recursive: true });
    // https://github.com/<owner>/<repo> goes to <home>/github/<owner>/<repo>, and there is no git identity
    // (commits then use the GitHub account's).
    const config = join(home, 'gitconfig');
    await writeFile(config, `[url "${github.replace(/\\/g, '/')}/"]\n\tinsteadOf = https://github.com/\n`);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    restoreConfig = () => {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before;
    };
    // octo/site: a repository with code in it already.
    const site = join(github, 'octo', 'site.git');
    gitIn(home, 'init', '--bare', '-b', 'main', site);
    const seed = join(home, 'seed');
    gitIn(home, 'clone', site, seed);
    await mkdir(join(seed, 'src'));
    await writeFile(join(seed, 'src', 'app.ts'), 'export {};\n');
    gitIn(seed, 'add', '.');
    gitIn(seed, 'commit', '-m', 'Code');
    gitIn(seed, 'push', 'origin', 'main');

    const paths = { ...resolvePaths(join(home, 'openpaper')), exports: join(home, 'exports') };
    store = new FileStore(paths);
    await store.init();
    await writeFile(join(paths.assets, IMAGE), 'not really a png');
    vcs = new VcsService({ hub: new DocumentHub(store), store, mediaDir: paths.assets, file: join(paths.home, 'vcs.json'), changed: () => {}, github: fakeGitHub });
    await vcs.init();
  });

  afterAll(async () => {
    restoreConfig?.();
    await vcs?.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const tracked = async (name: string) => {
    const doc = sampleDoc(name);
    await store.save(doc);
    return doc.id;
  };

  it('downloads a repository and keeps the design in a folder inside it, committed as the account', async () => {
    const local = join(home, 'clones', 'site');
    expect((await vcs.inspectLocal(local, 'octo/site')).state).toBe('missing');
    const { status, warning } = await vcs.track(await tracked('Hero'), { kind: 'github', account: 'octo', repo: { fullName: 'octo/site' }, local, path: 'designs/Hero' });
    expect(warning).toBeUndefined();
    expect(status).toMatchObject({ path: 'designs/Hero', branch: 'main', upstream: 'origin/main', ahead: 0, remote: { fullName: 'octo/site', webUrl: 'https://github.com/octo/site' } });
    const origin = join(github, 'octo', 'site.git');
    expect(gitIn(origin, 'log', '-1', '--format=%s|%an <%ae>', 'main')).toBe('Add Hero|Octo <7+octo@users.noreply.github.com>');
    expect(gitIn(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n')).toEqual(expect.arrayContaining(['src/app.ts', 'designs/Hero/openpaper.json', `designs/Hero/assets/${IMAGE}`]));
    // The copy on this computer is recognised from now on.
    expect(await vcs.inspectLocal(local, 'octo/site')).toMatchObject({ state: 'repo', matches: true });
  });

  it('puts a second design in the same copy of the repository', async () => {
    const { status, warning } = await vcs.track(await tracked('Footer'), { kind: 'github', account: 'octo', repo: { fullName: 'octo/site' }, local: join(home, 'clones', 'site'), path: 'designs/Footer' });
    expect(warning).toBeUndefined();
    expect(status).toMatchObject({ path: 'designs/Footer', ahead: 0 });
    expect(gitIn(join(github, 'octo', 'site.git'), 'log', '--format=%s', 'main').split('\n')).toEqual(['Add Footer', 'Add Hero', 'Code']);
  });

  it('creates a repository whose top is the design folder', async () => {
    const { status, warning } = await vcs.track(await tracked('Brand'), { kind: 'github', account: 'octo', repo: { create: { name: 'brand', private: true } }, local: join(home, 'clones', 'brand'), path: '' });
    expect(warning).toBeUndefined();
    expect(status).toMatchObject({ path: '', branch: 'main', upstream: 'origin/main', remote: { fullName: 'octo/brand' } });
    expect(gitIn(join(github, 'octo', 'brand.git'), 'ls-tree', '--name-only', 'main').split('\n')).toEqual(
      expect.arrayContaining(['.gitattributes', 'README.md', 'assets', 'comments.json', 'openpaper.json', 'pages', 'tokens.json'])
    );
  });

  it('refuses a folder that holds another repository, or a design already there', async () => {
    const id = await tracked('Other');
    await expect(vcs.track(id, { kind: 'github', account: 'octo', repo: { fullName: 'octo/site' }, local: join(home, 'clones', 'brand'), path: 'x' })).rejects.toThrow(/copy of https:\/\/github\.com\/octo\/brand/);
    await expect(vcs.track(id, { kind: 'github', account: 'octo', repo: { fullName: 'octo/site' }, local: join(home, 'clones', 'site'), path: 'designs/Hero' })).rejects.toThrow(/Another design/);
    await expect(vcs.track(id, { kind: 'github', account: 'octo', repo: { fullName: 'octo/site' }, local: join(home, 'clones', 'site'), path: '../escape' })).rejects.toThrow(/can’t be a folder name/);
  });
});
