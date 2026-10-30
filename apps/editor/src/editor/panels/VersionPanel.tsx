import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Globe,
  LoaderCircle,
  Lock,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  Unlink,
} from 'lucide-react';
import type { VcsBranch, VcsChange, VcsCommit, VcsLocalFolder, VcsRepo, VcsRepoTree, VcsSetup, VcsStatus, VcsTrackPlan } from '@openpaper/core';
import { setState, toast, useEditor } from '../../state/store.ts';
import { client, refreshVcs } from '../../sync/session.ts';
import { Select } from '../../ui/Select.tsx';

/** What a version control operation leaves behind (the server's VcsResult). */
interface VcsResult {
  status: VcsStatus;
  warning?: string;
  notice?: string;
}

/** The account choice for keeping versions on this computer only (no GitHub login has a colon). */
const LOCAL = ':local';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "Landing page v2!" → "landing-page-v2", for repository and branch names. */
function slug(text: string, fallback: string): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || fallback;
}

/** A design name as a folder name (without the characters Windows refuses). */
function folderNameFor(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '') || 'Design'
  );
}

/** Join with the separator the server's paths already use. */
function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${sep}${child}`;
}

const lastPart = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const parentOf = (dir: string) => (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function VersionPanel() {
  const fileId = useEditor((s) => s.preview?.live.doc.id ?? s.doc?.id);
  const status = useEditor((s) => s.vcs);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (fileId) refreshVcs().then(() => setFailed(null), (error) => setFailed(errorText(error)));
  }, [fileId]);

  if (!fileId) return null;
  return (
    <>
      <div className="op-vc-title">Version control</div>
      {!status ? (
        <div className="op-empty">{failed ?? 'Checking version control…'}</div>
      ) : status.tracked ? (
        <Tracked key={fileId} fileId={fileId} status={status} />
      ) : (
        <Setup key={fileId} fileId={fileId} />
      )}
    </>
  );
}

// ---- starting to track ----------------------------------------------------------

type Mode = 'existing' | 'new' | 'local';

/** Whether the folder on this computer works for the choice, and what will happen there. */
function localVerdict(mode: Mode | null, info: VcsLocalFolder | null, repo: VcsRepo | null): { ok: boolean; text: string } | null {
  if (!mode || !info) return null;
  if (mode === 'existing') {
    if (info.matches) return { ok: true, text: 'Your copy of the repository is here.' };
    if (info.state === 'missing' || info.state === 'empty') return { ok: true, text: 'The repository will be downloaded here.' };
    if (info.state === 'repo' || info.state === 'in-repo') return { ok: false, text: `This is a copy of another repository. Pick your copy of ${repo?.name ?? 'the repository'}, or another place.` };
    return { ok: false, text: 'This folder has other files in it. Pick your copy of the repository, or an empty folder.' };
  }
  if (mode === 'new') {
    if (info.state === 'missing' || info.state === 'empty') return { ok: true, text: 'The new repository goes here.' };
    return { ok: false, text: 'This folder isn’t empty. Pick another place, or another name.' };
  }
  if (info.state === 'files') return { ok: false, text: 'This folder has other files in it. Pick another name or place.' };
  if (info.repoRoot) return { ok: true, text: `It joins the repository in ${lastPart(info.repoRoot)}.` };
  return { ok: true, text: 'A new Git repository is made here.' };
}

function Field({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="op-vc-field">
      <div className="op-vc-label">
        <span>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Avatar({ url, size = 14 }: { url: string | null; size?: number }) {
  return url ? <img className="op-vc-avatar" src={`${url}${url.includes('?') ? '&' : '?'}s=${size * 2}`} width={size} height={size} alt="" /> : <Globe size={size - 2} />;
}

function Setup({ fileId }: { fileId: string }) {
  const docName = useEditor((s) => (s.preview?.live.doc ?? s.doc)?.name ?? 'Design');
  const [setup, setSetup] = useState<VcsSetup | null>(null);
  const [account, setAccount] = useState('');
  const [repos, setRepos] = useState<VcsRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<{ kind: 'existing'; repo: VcsRepo } | { kind: 'new' } | null>(null);
  const [newName, setNewName] = useState(() => slug(docName, 'design'));
  const [isPrivate, setIsPrivate] = useState(true);
  const [tree, setTree] = useState<VcsRepoTree | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  /** The folder of the repository being looked at. */
  const [at, setAt] = useState('');
  /** The design's own folder name ('' = right in `at`). */
  const [name, setName] = useState(() => folderNameFor(docName));
  /** Where repositories (or, kept on this computer only, designs) go. */
  const [parent, setParent] = useState('');
  /** A folder picked to be used as it is (an existing copy of the repository, or an empty folder). */
  const [exact, setExact] = useState<string | null>(null);
  const [local, setLocal] = useState<VcsLocalFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSetup = (fresh = false) =>
    client.request<VcsSetup>('vcs.setup', { fresh }).then(
      (s) => {
        setSetup(s);
        setParent((p) => p || s.defaultRoot);
        setAccount((a) => (a === LOCAL || s.accounts.some((x) => x.login === a) ? a : ((s.accounts.find((x) => x.active) ?? s.accounts[0])?.login ?? LOCAL)));
      },
      (e) => setError(errorText(e))
    );
  useEffect(() => {
    void loadSetup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const repo = choice?.kind === 'existing' ? choice.repo : null;
  const mode: Mode | null = account === LOCAL ? 'local' : (choice?.kind ?? null);

  useEffect(() => {
    setRepos(null);
    setReposError(null);
    setChoice(null);
    setExact(null);
    if (!account || account === LOCAL) return;
    let current = true;
    client.request<VcsRepo[]>('vcs.repos', { account }).then(
      (list) => current && setRepos(list),
      (e) => current && setReposError(errorText(e))
    );
    return () => {
      current = false;
    };
  }, [account]);

  useEffect(() => {
    setTree(null);
    setTreeError(null);
    setAt('');
    setExact(null);
    if (!repo) return;
    // An empty repository can be the design's folder itself.
    setName(repo.empty ? '' : folderNameFor(docName));
    let current = true;
    client.request<VcsRepoTree>('vcs.tree', { account, fullName: repo.fullName, branch: repo.defaultBranch }).then(
      (t) => current && setTree(t),
      (e) => current && setTreeError(errorText(e))
    );
    return () => {
      current = false;
    };
  }, [repo?.fullName]); // eslint-disable-line react-hooks/exhaustive-deps

  const localPath = exact ?? (parent && mode ? joinPath(parent, mode === 'local' ? name.trim() || folderNameFor(docName) : mode === 'new' ? newName : (repo?.name ?? '')) : '');

  useEffect(() => {
    setLocal(null);
    if (!localPath || !mode) return;
    let current = true;
    const timer = setTimeout(() => {
      client.request<VcsLocalFolder>('vcs.inspect', { path: localPath, fullName: repo?.fullName }).then(
        (info) => current && setLocal(info),
        () => {}
      );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [localPath, mode, repo?.fullName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (repos ?? []).filter((r) => !q || r.fullName.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q));
  }, [repos, query]);
  const folders = useMemo(() => (tree ? tree.dirs.filter((d) => parentOf(d) === at).sort((a, b) => a.localeCompare(b)) : []), [tree, at]);
  const repoPath = [at, name.trim()].filter(Boolean).join('/');
  const designThere = !!tree?.designs.includes(repoPath);
  const verdict = localVerdict(mode, local, repo);
  const ready =
    !!setup?.git &&
    !busy &&
    !!verdict?.ok &&
    (mode === 'local' ? !!name.trim() : mode === 'new' ? /^[A-Za-z0-9._-]{1,100}$/.test(newName) : mode === 'existing' ? !!tree && !designThere : false);

  async function changeFolder() {
    let picked: string | null;
    try {
      picked = await client.request<string | null>('vcs.pickFolder', {
        title: mode === 'local' ? 'Choose where the design’s folder goes' : 'Choose where the repository is kept on this computer',
        start: exact ?? parent,
      });
    } catch (e) {
      return setError(errorText(e));
    }
    if (!picked) return;
    if (mode === 'local') {
      setParent(picked);
      setExact(null);
      return;
    }
    const info = await client.request<VcsLocalFolder>('vcs.inspect', { path: picked, fullName: repo?.fullName });
    // Your copy of the repository, or an empty folder, is used as it is; anywhere else gets a folder of its own.
    if ((info.matches && info.repoRoot) || info.state === 'empty') setExact(info.matches && info.repoRoot ? info.repoRoot : picked);
    else {
      setParent(picked);
      setExact(null);
    }
  }

  async function start() {
    if (!mode) return;
    const plan: VcsTrackPlan =
      mode === 'local'
        ? { kind: 'local', dir: localPath }
        : {
            kind: 'github',
            account,
            repo: mode === 'new' ? { create: { name: newName, private: isPrivate } } : { fullName: repo!.fullName },
            local: localPath,
            path: mode === 'new' ? '' : repoPath,
          };
    setBusy(true);
    setError(null);
    try {
      const result = await client.request<VcsResult>('vcs.track', { fileId, plan });
      setState({ vcs: result.status });
      if (result.warning) toast(result.warning, 7000);
      else toast(mode === 'local' ? 'Saved the first version' : `Saved the first version to ${mode === 'new' ? `${account}/${newName}` : repo!.fullName}`, 4000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!setup) {
    return (
      <div className="op-vc">
        {error ? <div className="op-vc-alert error">{error}</div> : <div className="op-empty">Looking for Git and your GitHub sign-in…</div>}
      </div>
    );
  }

  const accountOptions = [
    ...setup.accounts.map((a) => ({ value: a.login, label: a.name ? `${a.login} · ${a.name}` : a.login, icon: <Avatar url={a.avatarUrl} /> })),
    { value: LOCAL, label: 'This computer only', icon: <Monitor size={13} /> },
  ];
  const busyText = mode === 'new' ? 'Creating the repository…' : mode === 'existing' && verdict?.text.includes('downloaded') ? 'Downloading the repository…' : 'Saving the first version…';

  return (
    <div className="op-vc">
      <div className="op-vc-intro">
        <FolderGit2 size={16} />
        <div>
          <b>Keep versions with Git</b>
          <p>Save “{docName}” as a folder in a Git repository. Each commit is a version you can look at or go back to.</p>
        </div>
      </div>

      {!setup.git && (
        <div className="op-vc-alert error">
          Git isn’t installed on this computer. Get it from{' '}
          <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">
            git-scm.com
          </a>
          , then reopen this tab.
        </div>
      )}

      <Field label="Account">
        <Select value={account} options={accountOptions} onChange={setAccount} aria-label="GitHub account" />
        {!setup.accounts.length && (
          <p className="op-vc-note">
            No GitHub sign-in found on this computer. Sign in with the GitHub CLI (<code>gh auth login</code>) or Git, then{' '}
            <button type="button" className="op-vc-link" onClick={() => void loadSetup(true)}>
              check again
            </button>
            . Until then, versions can stay on this computer.
          </p>
        )}
      </Field>

      {account && account !== LOCAL && (
        <Field label="Repository" aside={repos && <span className="op-label">{repos.length}</span>}>
          <label className="op-vc-search">
            <Search size={13} />
            <input className="op-input" placeholder="Search your repositories" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search repositories" />
          </label>
          <div className="op-vc-list op-scroll" role="listbox" aria-label="Repositories">
            <button type="button" role="option" aria-selected={choice?.kind === 'new'} className={`op-vc-row${choice?.kind === 'new' ? ' selected' : ''}`} onClick={() => setChoice({ kind: 'new' })}>
              <Plus size={13} />
              <span className="op-truncate">New repository</span>
            </button>
            {filtered.map((r) => (
              <button
                key={r.fullName}
                type="button"
                role="option"
                aria-selected={repo?.fullName === r.fullName}
                className={`op-vc-row${repo?.fullName === r.fullName ? ' selected' : ''}`}
                title={r.description ? `${r.fullName}\n${r.description}` : r.fullName}
                onClick={() => setChoice({ kind: 'existing', repo: r })}
              >
                {r.private ? <Lock size={12} /> : <Globe size={12} />}
                <span className="op-truncate">{r.owner === account ? r.name : r.fullName}</span>
                <span className="meta">{timeAgo(r.pushedAt)}</span>
              </button>
            ))}
            {!repos && !reposError && <div className="op-vc-row muted">Loading your repositories…</div>}
            {repos && !filtered.length && query && <div className="op-vc-row muted">No repository matches “{query}”</div>}
          </div>
          {reposError && <p className="op-vc-note bad">{reposError}</p>}
        </Field>
      )}

      {mode === 'new' && (
        <Field label="New repository">
          <input className="op-input" value={newName} onChange={(e) => setNewName(e.target.value.replace(/[^A-Za-z0-9._-]/g, '-'))} aria-label="Repository name" spellCheck={false} />
          <div className="op-toolbar op-segmented op-vc-segmented">
            <button type="button" className={`op-tab${isPrivate ? ' active' : ''}`} onClick={() => setIsPrivate(true)}>
              <Lock size={12} />
              <span className="op-tab-label">Private</span>
            </button>
            <button type="button" className={`op-tab${!isPrivate ? ' active' : ''}`} onClick={() => setIsPrivate(false)}>
              <Globe size={12} />
              <span className="op-tab-label">Public</span>
            </button>
          </div>
          <p className="op-vc-note">
            Made on GitHub as <b>{account}/{newName}</b>. The design’s folder is the whole repository.
          </p>
        </Field>
      )}

      {mode === 'existing' && repo && (
        <Field label="Folder in the repository">
          <div className="op-vc-crumbs">
            <button type="button" onClick={() => setAt('')} className={at ? '' : 'here'}>
              {repo.name}
            </button>
            {at
              .split('/')
              .filter(Boolean)
              .map((part, i, all) => (
                <span key={i} className="op-row" style={{ gap: 2 }}>
                  <ChevronRight size={11} />
                  <button type="button" className={i === all.length - 1 ? 'here' : ''} onClick={() => setAt(all.slice(0, i + 1).join('/'))}>
                    {part}
                  </button>
                </span>
              ))}
          </div>
          <div className="op-vc-list op-scroll short" role="listbox" aria-label="Folders">
            {!tree && !treeError && <div className="op-vc-row muted">Loading folders…</div>}
            {tree && !folders.length && <div className="op-vc-row muted">{at || !repo.empty ? 'No folders here' : 'The repository is empty'}</div>}
            {folders.map((dir) => {
              const design = tree!.designs.includes(dir);
              return (
                <button key={dir} type="button" className="op-vc-row" disabled={design} title={design ? 'A design is kept here' : `Open ${dir}`} onClick={() => setAt(dir)}>
                  {design ? <FolderGit2 size={13} /> : <Folder size={13} />}
                  <span className="op-truncate">{lastPart(dir)}</span>
                  <span className="meta">{design ? 'design' : <ChevronRight size={12} />}</span>
                </button>
              );
            })}
          </div>
          {treeError && <p className="op-vc-note bad">{treeError}</p>}
          <label className="op-vc-inline">
            <span>New folder</span>
            <input className="op-input" value={name} placeholder="none" onChange={(e) => setName(e.target.value)} aria-label="Design folder name" />
          </label>
          <p className={`op-vc-note${designThere ? ' bad' : ''}`}>
            {designThere ? `A design is kept in ${repoPath} already. Pick another name.` : <>Saves to <code>{repoPath || 'the top of the repository'}</code></>}
          </p>
        </Field>
      )}

      {mode === 'local' && (
        <Field label="Folder name">
          <input className="op-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Design folder name" />
        </Field>
      )}

      {mode && (
        <Field label="On this computer">
          <div className="op-vc-path" title={localPath}>
            <Folder size={13} />
            <span>{localPath}</span>
          </div>
          <div className="op-row" style={{ alignItems: 'flex-start' }}>
            <p className={`op-vc-note${verdict && !verdict.ok ? ' bad' : ''}`} style={{ flex: 1 }}>
              {verdict?.text ?? 'Checking the folder…'}
            </p>
            <button type="button" className="op-btn outline compact" onClick={() => void changeFolder()}>
              Change…
            </button>
          </div>
        </Field>
      )}

      {error && <div className="op-vc-alert error">{error}</div>}

      <button type="button" className="op-btn primary op-vc-wide" disabled={!ready} onClick={() => void start()}>
        {busy ? (
          <>
            <LoaderCircle size={14} className="op-spin" /> {busyText}
          </>
        ) : (
          'Start tracking'
        )}
      </button>
      {!mode && account !== LOCAL && <p className="op-vc-note">Pick a repository above, or make a new one.</p>}
    </div>
  );
}

// ---- a tracked design ------------------------------------------------------------

function MoreMenu({ items }: { items: Array<{ label: string; icon: ReactNode; run: () => void; danger?: boolean } | null> }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === 'pointerdown' && (menu.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  return (
    <>
      <button ref={trigger} type="button" className="op-icon-btn small" title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Ellipsis size={14} />
      </button>
      {open &&
        createPortal(
          <div ref={menu} role="menu" className="op-popover op-vc-menu" style={pos} data-op-overlay-ui>
            {items.map((item, i) =>
              item ? (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`op-menu-item${item.danger ? ' danger' : ''}`}
                  onClick={() => {
                    setOpen(false);
                    item.run();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ) : (
                <div key={i} className="op-menu-sep" />
              )
            )}
          </div>,
          document.body
        )}
    </>
  );
}

/** Changes grouped by what they are ("Image ×3"). */
function groupChanges(changes: VcsChange[]) {
  const groups = new Map<string, { label: string; kind: VcsChange['kind']; count: number; paths: string[] }>();
  for (const c of changes) {
    const key = `${c.kind}:${c.label}`;
    const group = groups.get(key) ?? { label: c.label, kind: c.kind, count: 0, paths: [] };
    group.count++;
    group.paths.push(c.path);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const KIND_LETTER: Record<VcsChange['kind'], string> = { added: 'A', modified: 'M', deleted: 'D' };

function Tracked({ fileId, status }: { fileId: string; status: VcsStatus }) {
  const previewing = useEditor((s) => s.preview?.commit.hash ?? null);
  const [branches, setBranches] = useState<VcsBranch[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [target, setTarget] = useState<'current' | 'new'>('current');
  const [newBranch, setNewBranch] = useState('');
  const [branchTyped, setBranchTyped] = useState(false);

  const changes = status.changes ?? [];
  const hasRemote = !!status.remote;
  const branch = status.branch ?? null;

  const loadBranches = () =>
    client.request<VcsBranch[]>('vcs.branches', { fileId }).then(setBranches, () => {});

  /** Ask the remote what's new (the server does it at most once a minute unless `force`). */
  const fetchRemote = (force: boolean) => {
    if (!hasRemote) return;
    setFetching(true);
    client
      .request<VcsResult>('vcs.fetch', { fileId, force })
      .then((r) => {
        setState({ vcs: r.status });
        if (r.warning && force) setError(r.warning);
        void loadBranches();
      })
      .catch((e) => force && setError(errorText(e)))
      .finally(() => setFetching(false));
  };

  useEffect(() => {
    void loadBranches();
    fetchRemote(false);
  }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The branch name follows the message until it's typed in by hand.
  useEffect(() => {
    if (!branchTyped) setNewBranch(slug(message.split('\n')[0]!.split(/\s+/).slice(0, 5).join(' '), 'new-branch'));
  }, [message, branchTyped]);

  async function run(label: string, fn: () => Promise<VcsResult | null>, done?: (r: VcsResult) => string | null) {
    setBusy(label);
    setError(null);
    try {
      const result = await fn();
      if (result) {
        setState({ vcs: result.status });
        if (result.warning) setError(result.warning);
        if (result.notice) toast(result.notice, 5000);
        const said = done?.(result);
        if (said && !result.warning) toast(said, 3500);
      } else void refreshVcs().catch(() => {});
      void loadBranches();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const commit = () =>
    run(
      hasRemote ? 'Committing and pushing…' : 'Committing…',
      async () => {
        if (target === 'new') await client.request<VcsResult>('vcs.switch', { fileId, name: newBranch.trim(), create: true });
        const result = await client.request<VcsResult>('vcs.commit', { fileId, message: message.trim(), push: hasRemote });
        setMessage('');
        setTarget('current');
        setBranchTyped(false);
        return result;
      },
      (r) => (hasRemote ? `Committed and pushed to ${r.status.branch}` : 'Committed')
    );

  const switchTo = (name: string) => run(`Switching to ${name}…`, () => client.request<VcsResult>('vcs.switch', { fileId, name, create: false }), () => `On ${name}`);

  const menu = [
    status.remote?.webUrl ? { label: 'Open on GitHub', icon: <ExternalLink size={13} />, run: () => window.open(status.remote!.webUrl!, '_blank', 'noopener') } : null,
    { label: 'Show the folder', icon: <FolderOpen size={13} />, run: () => void client.request('vcs.reveal', { fileId }).catch((e) => setError(errorText(e))) },
    { label: 'Copy the folder’s path', icon: <Copy size={13} />, run: () => void navigator.clipboard.writeText(status.dir ?? '').then(() => toast('Path copied')) },
    null,
    ...(changes.length
      ? [
          {
            label: 'Discard changes',
            icon: <Undo2 size={13} />,
            run: () =>
              void run('Discarding…', async () => {
                await client.request('vcs.restore', { fileId, discard: true });
                return null;
              }).then(() => toast('Back to the last commit. Undo brings the changes back.', 4000)),
          },
        ]
      : []),
    {
      label: 'Stop tracking',
      icon: <Unlink size={13} />,
      danger: true,
      run: () => {
        if (!confirm('Stop tracking this design? Its folder and the repository stay as they are; OpenPaper just stops writing to them.')) return;
        void client
          .request('vcs.untrack', { fileId })
          .then(() => refreshVcs())
          .catch((e) => setError(errorText(e)));
      },
    },
  ];

  if (status.problem && !status.repoRoot) {
    return (
      <div className="op-vc">
        <div className="op-vc-alert error">{status.problem}</div>
        <button
          type="button"
          className="op-btn outline"
          onClick={() =>
            void client
              .request('vcs.untrack', { fileId })
              .then(() => refreshVcs())
              .catch((e) => setError(errorText(e)))
          }
        >
          <Unlink size={13} /> Stop tracking
        </button>
        {error && <div className="op-vc-alert error">{error}</div>}
      </div>
    );
  }

  const branchOptions = branches.length
    ? branches.map((b) => ({ value: b.name, label: b.local ? b.name : `${b.name} (remote)`, icon: b.local ? <GitBranch size={12} /> : <Globe size={12} /> }))
    : branch
      ? [{ value: branch, label: branch, icon: <GitBranch size={12} /> }]
      : [];
  const canCommit = !!message.trim() && changes.length > 0 && (target === 'current' || !!newBranch.trim()) && !busy && !previewing;
  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  // Committed here, but the branch isn't on the remote yet.
  const unpublished = hasRemote && !status.upstream && !!status.head;

  return (
    <div className="op-vc">
      <div className="op-vc-head">
        <FolderGit2 size={16} className="op-vc-head-icon" />
        <div className="op-vc-head-text">
          {status.remote?.webUrl ? (
            <a className="op-vc-repo op-truncate" href={status.remote.webUrl} target="_blank" rel="noreferrer" title="Open the repository on GitHub">
              {status.remote.fullName}
            </a>
          ) : (
            <span className="op-vc-repo op-truncate" title={status.repoRoot}>
              {lastPart(status.repoRoot ?? status.dir ?? '')}
            </span>
          )}
          <span className="op-label op-truncate" title={status.dir}>
            {status.path ? status.path : 'The whole repository'}
          </span>
        </div>
        <MoreMenu items={menu} />
      </div>

      <div className="op-row">
        <Select
          value={branch ?? ''}
          options={branchOptions}
          onChange={(name) => void switchTo(name)}
          placeholder="No branch"
          disabled={!!busy || !!previewing}
          title="Branch: switching shows that branch’s version of the design"
          aria-label="Branch"
          style={{ flex: 1 }}
        />
        {hasRemote && (
          <button type="button" className="op-icon-btn" title="Check the remote for new commits" disabled={fetching || !!busy} onClick={() => fetchRemote(true)}>
            <RefreshCw size={14} className={fetching ? 'op-spin' : undefined} />
          </button>
        )}
      </div>

      {(behind > 0 || (ahead > 0 && !changes.length) || unpublished) && (
        <div className="op-row op-vc-sync">
          {unpublished && (
            <button type="button" className="op-btn outline compact" disabled={!!busy} onClick={() => void run('Pushing…', () => client.request<VcsResult>('vcs.push', { fileId }), () => `Pushed ${branch} to the remote`)}>
              <ArrowUp size={13} /> Push {branch ?? 'branch'}
            </button>
          )}
          {behind > 0 && (
            <button type="button" className="op-btn outline compact" disabled={!!busy || !!previewing} onClick={() => void run('Pulling…', () => client.request<VcsResult>('vcs.pull', { fileId }), () => 'Up to date with the remote')}>
              <ArrowDown size={13} /> Pull {plural(behind, 'commit')}
            </button>
          )}
          {ahead > 0 && !changes.length && (
            <button type="button" className="op-btn outline compact" disabled={!!busy} onClick={() => void run('Pushing…', () => client.request<VcsResult>('vcs.push', { fileId }), () => `Pushed to ${branch}`)}>
              <ArrowUp size={13} /> Push {plural(ahead, 'commit')}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="op-vc-alert error" role="alert">
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="op-icon-btn small" title="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {status.problem && <div className="op-vc-alert error">{status.problem}</div>}

      <div className="op-vc-field">
        <div className="op-vc-label">
          <span>Changes</span>
          {changes.length > 0 && <span className="op-count">{changes.length}</span>}
        </div>
        {changes.length ? (
          <ul className="op-vc-changes">
            {groupChanges(changes).map((g) => (
              <li key={`${g.kind}:${g.label}`} title={g.paths.join('\n')}>
                <span className={`op-vc-kind ${g.kind}`}>{KIND_LETTER[g.kind]}</span>
                <span className="op-truncate">{g.label}</span>
                {g.count > 1 && <span className="op-label">×{g.count}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="op-vc-note">No changes since the last commit.</p>
        )}
      </div>

      <div className="op-vc-field">
        <textarea
          className="op-input"
          rows={2}
          placeholder={changes.length ? 'Describe what changed' : 'Make a change to commit it'}
          value={message}
          disabled={!!previewing}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
              e.preventDefault();
              void commit();
            }
          }}
          aria-label="Commit message"
        />
        <div className="op-toolbar op-segmented op-vc-segmented" role="radiogroup" aria-label="Commit to">
          <button type="button" role="radio" aria-checked={target === 'current'} className={`op-tab${target === 'current' ? ' active' : ''}`} onClick={() => setTarget('current')} title={`Commit to ${branch ?? 'this commit'}`}>
            <GitBranch size={12} />
            <span className="op-tab-label">{branch ?? 'This commit'}</span>
          </button>
          <button type="button" role="radio" aria-checked={target === 'new'} className={`op-tab${target === 'new' ? ' active' : ''}`} onClick={() => setTarget('new')} title="Commit to a new branch, made from here">
            <Plus size={12} />
            <span className="op-tab-label">New branch</span>
          </button>
        </div>
        {target === 'new' && (
          <input
            className="op-input"
            value={newBranch}
            placeholder="branch-name"
            spellCheck={false}
            onChange={(e) => {
              setBranchTyped(true);
              setNewBranch(e.target.value.replace(/\s+/g, '-'));
            }}
            aria-label="New branch name"
          />
        )}
        <button type="button" className="op-btn primary op-vc-wide" disabled={!canCommit} onClick={() => void commit()} title={`${hasRemote ? 'Commit and push' : 'Commit'} (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter)`}>
          {busy ? (
            <>
              <LoaderCircle size={14} className="op-spin" /> {busy}
            </>
          ) : (
            <span>
              {hasRemote ? 'Commit & push to ' : 'Commit to '}
              {target === 'new' ? newBranch.trim() || 'new branch' : (branch ?? (hasRemote ? 'remote' : 'this commit'))}
            </span>
          )}
        </button>
        {previewing && <p className="op-vc-note">You’re looking at an older version. Go back to the current version to commit.</p>}
      </div>

      <HistoryList fileId={fileId} status={status} previewing={previewing} />
    </div>
  );
}

function HistoryList({ fileId, status, previewing }: { fileId: string; status: VcsStatus; previewing: string | null }) {
  const [log, setLog] = useState<{ commits: VcsCommit[]; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = status.changes?.length ?? 0;

  const load = (skip: number) =>
    client.request<{ commits: VcsCommit[]; more: boolean }>('vcs.log', { fileId, skip }).then(
      (page) => {
        setError(null);
        setLog((prev) => (skip && prev ? { commits: [...prev.commits, ...page.commits], more: page.more } : page));
      },
      (e) => setError(errorText(e))
    );

  // A commit, push, pull or branch switch changes the list.
  useEffect(() => {
    void load(0);
  }, [fileId, status.head, status.branch, status.ahead]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = (hash: string) => (location.hash = `#/file/${fileId}/version/${hash}`);

  return (
    <div className="op-vc-field">
      <div className="op-vc-label">
        <span>History</span>
        {status.branch && <span className="op-label">on {status.branch}</span>}
      </div>
      {error && <p className="op-vc-note bad">{error}</p>}
      <div className="op-vc-timeline">
        <button type="button" className={`op-vc-commit now${previewing ? '' : ' viewing'}`} onClick={() => (location.hash = `#/file/${fileId}`)} title="The design as it is now">
          <span className="op-vc-dot" />
          <span className="op-vc-commit-body">
            <span className="op-vc-subject">Current version</span>
            <span className="op-label">{changes ? `${plural(changes, 'change')} not committed` : 'Same as the last commit'}</span>
          </span>
        </button>
        {log?.commits.map((c) => (
          <div
            key={c.hash}
            role="button"
            tabIndex={0}
            className={`op-vc-commit${previewing === c.hash ? ' viewing' : ''}${c.pushed || !status.remote ? '' : ' local'}`}
            title={`${c.subject}\n${c.author}, ${new Date(c.date).toLocaleString()} · ${c.short}${c.pushed || !status.remote ? '' : '\nNot pushed yet'}\nClick to look at this version`}
            onClick={() => show(c.hash)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), show(c.hash))}
          >
            <span className="op-vc-dot" />
            <span className="op-vc-commit-body">
              <span className="op-vc-subject op-truncate">{c.subject}</span>
              <span className="op-label op-truncate">
                {c.author} · {timeAgo(c.date)}
                {c.pushed || !status.remote ? '' : ' · not pushed'}
              </span>
            </span>
            <a
              className="op-icon-btn small op-vc-commit-action"
              href={`#/file/${fileId}/version/${c.hash}`}
              target="_blank"
              rel="noopener"
              title="Open this version in a new tab"
              aria-label={`Open “${c.subject}” in a new tab`}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={12} />
            </a>
          </div>
        ))}
        {log && !log.commits.length && <p className="op-vc-note" style={{ paddingLeft: 26 }}>No commits yet.</p>}
      </div>
      {log?.more && (
        <button type="button" className="op-btn compact op-vc-more" onClick={() => void load(log.commits.length)}>
          Show older commits
        </button>
      )}
    </div>
  );
}
