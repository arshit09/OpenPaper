import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VcsAccount, VcsRepo, VcsRepoTree } from '@openpaper/core';
import { capture, findProgram } from '../agent/cli.ts';
import { git } from './git.ts';
import { MANIFEST } from './folder.ts';

/**
 * GitHub through the login already on this computer: the GitHub CLI's accounts (`gh auth`), else the
 * one Git's credential manager keeps for github.com. Tokens stay on the server; editors only see logins.
 */

const API = 'https://api.github.com';
const TOKEN_TTL_MS = 5 * 60_000;
const MAX_REPO_PAGES = 5;
const MAX_DIRS = 5000;

export interface Login {
  login: string;
  token: string;
  source: 'gh' | 'git';
  active: boolean;
  /** GitHub's numeric user id (for the no-reply commit email). */
  id: number;
  name: string | null;
  avatarUrl: string | null;
}

interface RepoJson {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  default_branch?: string;
  pushed_at: string | null;
  html_url: string;
  clone_url: string;
  size: number;
  permissions?: { push?: boolean };
}

export interface RepoInfo extends VcsRepo {
  cloneUrl: string;
}

function repoInfo(r: RepoJson): RepoInfo {
  return {
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    description: r.description,
    defaultBranch: r.default_branch || 'main',
    pushedAt: r.pushed_at,
    htmlUrl: r.html_url,
    empty: r.size === 0,
    cloneUrl: r.clone_url,
  };
}

/** `owner/name` of a GitHub remote URL (https, ssh or scp-like), else null. */
export function githubFullName(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? m[1]! : null;
}

/** Git config, through the environment, that signs requests to github.com in as `token` (nothing on the command line). */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class GitHub {
  private gh: string | null | undefined;
  private cache: { at: number; logins: Login[] } | null = null;
  private pending: Promise<Login[]> | null = null;

  /** The GitHub CLI program (null: not installed). */
  ghProgram(): string | null {
    if (this.gh === undefined) {
      const extra = process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI')] : ['/opt/homebrew/bin', '/usr/local/bin'];
      this.gh = findProgram({ win32: ['gh.exe'], other: ['gh'] }, extra);
    }
    return this.gh;
  }

  /** Every usable login, the GitHub CLI's active account first. Cached for a few minutes; `fresh` asks again. */
  async logins(fresh = false): Promise<Login[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < TOKEN_TTL_MS) return this.cache.logins;
    this.pending ??= this.findLogins()
      .then((logins) => {
        this.cache = { at: Date.now(), logins };
        return logins;
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  async accounts(fresh = false): Promise<VcsAccount[]> {
    return (await this.logins(fresh)).map(({ login, source, active, name, avatarUrl }) => ({ login, source, active, name, avatarUrl }));
  }

  async login(login: string): Promise<Login> {
    const found = (await this.logins()).find((l) => l.login.toLowerCase() === login.toLowerCase());
    if (found) return found;
    const again = (await this.logins(true)).find((l) => l.login.toLowerCase() === login.toLowerCase());
    if (!again) throw new Error(`The GitHub account “${login}” isn’t signed in on this computer any more. Sign in with \`gh auth login\`, then try again.`);
    return again;
  }

  private async findLogins(): Promise<Login[]> {
    const tokens: Array<{ login: string | null; token: string; source: 'gh' | 'git'; active: boolean }> = [];
    const gh = this.ghProgram();
    if (gh) {
      for (const account of await this.ghAccounts(gh)) {
        const token = await this.ghToken(gh, account.login, account.active);
        if (token) tokens.push({ login: account.login, token, source: 'gh', active: account.active });
      }
    }
    const stored = await this.credentialManagerToken();
    if (stored && !tokens.some((t) => t.token === stored)) tokens.push({ login: null, token: stored, source: 'git', active: !tokens.length });
    const out: Login[] = [];
    for (const t of tokens) {
      // Ask GitHub who each token is: a token it turns down (expired, revoked) isn't offered.
      const user = await this.request<{ login: string; id: number; name: string | null; avatar_url: string | null }>(t.token, '/user').catch(() => null);
      if (!user || out.some((o) => o.login.toLowerCase() === user.login.toLowerCase())) continue;
      out.push({ login: user.login, token: t.token, source: t.source, active: t.active, id: user.id, name: user.name, avatarUrl: user.avatar_url });
    }
    return out;
  }

  private async ghAccounts(gh: string): Promise<Array<{ login: string; active: boolean }>> {
    const json = await capture([gh], ['auth', 'status', '--json', 'hosts', '--hostname', 'github.com']).catch(() => null);
    if (json?.code === 0) {
      try {
        const hosts = JSON.parse(json.stdout) as { hosts?: Record<string, Array<{ login: string; active: boolean; state: string }>> };
        return (hosts.hosts?.['github.com'] ?? []).filter((a) => a.state === 'success' && a.login).map((a) => ({ login: a.login, active: a.active }));
      } catch {
        // fall through to the text form
      }
    }
    // Older gh (no --json): "Logged in to github.com account <login> (keyring)" and "- Active account: true".
    const text = await capture([gh], ['auth', 'status', '--hostname', 'github.com']).catch(() => null);
    if (!text) return [];
    const accounts: Array<{ login: string; active: boolean }> = [];
    for (const line of `${text.stdout}\n${text.stderr}`.split(/\r?\n/)) {
      const m = /Logged in to github\.com (?:account|as) ([\w-]+)/i.exec(line);
      if (m) accounts.push({ login: m[1]!, active: accounts.length === 0 });
      else if (/Active account: true/i.test(line) && accounts.length) {
        for (const a of accounts) a.active = false;
        accounts[accounts.length - 1]!.active = true;
      }
    }
    return accounts;
  }

  private async ghToken(gh: string, login: string, active: boolean): Promise<string | null> {
    const withUser = await capture([gh], ['auth', 'token', '--hostname', 'github.com', '--user', login]).catch(() => null);
    if (withUser?.code === 0 && withUser.stdout.trim()) return withUser.stdout.trim();
    if (!active) return null;
    // gh before 2.40 has no --user: its one token is the active account's.
    const plain = await capture([gh], ['auth', 'token', '--hostname', 'github.com']).catch(() => null);
    return plain?.code === 0 && plain.stdout.trim() ? plain.stdout.trim() : null;
  }

  /** The github.com password/token Git's credential helper keeps, asked for without any prompt. */
  private async credentialManagerToken(): Promise<string | null> {
    try {
      const out = await git(['-c', 'credential.interactive=never', 'credential', 'fill'], {
        cwd: homedir(),
        input: 'protocol=https\nhost=github.com\n\n',
        timeoutMs: 15_000,
      });
      const password = /^password=(.+)$/m.exec(out)?.[1]?.trim();
      return password || null;
    } catch {
      return null;
    }
  }

  private async request<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'OpenPaper',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GitHubError('Can’t reach GitHub. Check your internet connection.', 0);
    }
    const body = (await res.json().catch(() => null)) as (T & { message?: string; errors?: Array<{ message?: string }> }) | null;
    if (res.ok) return body as T;
    const detail = body?.errors?.map((e) => e.message).filter(Boolean)[0] ?? body?.message;
    if (res.status === 401) throw new GitHubError('GitHub turned down this sign-in. Sign in again with `gh auth login`.', 401);
    throw new GitHubError(detail ? `GitHub: ${detail}` : `GitHub answered ${res.status}.`, res.status);
  }

  /** Repositories the account can push to, most recently pushed first. */
  async repos(login: string): Promise<VcsRepo[]> {
    const { token } = await this.login(login);
    const out: VcsRepo[] = [];
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const list = await this.request<RepoJson[]>(token, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
      for (const r of list) if (r.permissions?.push !== false) out.push(publicRepo(repoInfo(r)));
      if (list.length < 100) break;
    }
    return out;
  }

  async repo(login: string, fullName: string): Promise<RepoInfo> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error(`“${fullName}” isn’t a repository name.`);
    const { token } = await this.login(login);
    return repoInfo(await this.request<RepoJson>(token, `/repos/${fullName}`));
  }

  async createRepo(login: string, opts: { name: string; private: boolean }): Promise<RepoInfo> {
    const { token } = await this.login(login);
    try {
      return repoInfo(
        await this.request<RepoJson>(token, '/user/repos', {
          method: 'POST',
          body: { name: opts.name, private: opts.private, description: 'A design made with OpenPaper', auto_init: false },
        })
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) throw new Error(`You already have a repository called “${opts.name}”, or GitHub won’t take that name. Pick another one.`);
      throw error;
    }
  }

  /** Folders on a repository's default branch, and which of them hold designs. */
  async tree(login: string, fullName: string, branch: string): Promise<VcsRepoTree> {
    const { token } = await this.login(login);
    let tree: { tree: Array<{ path: string; type: string }>; truncated: boolean };
    try {
      tree = await this.request(token, `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    } catch (error) {
      // 409: no commits yet; 404: the branch doesn't exist yet.
      if (error instanceof GitHubError && (error.status === 409 || error.status === 404)) return { dirs: [], designs: [], truncated: false };
      throw error;
    }
    const designs = tree.tree
      .filter((e) => e.type === 'blob' && (e.path === MANIFEST || e.path.endsWith(`/${MANIFEST}`)))
      .map((e) => e.path.slice(0, -MANIFEST.length).replace(/\/$/, ''));
    // Nothing inside a design: a design doesn't go in another one.
    const insideDesign = (path: string) => designs.some((d) => (d === '' ? true : path.startsWith(`${d}/`)));
    const dirs = tree.tree
      .filter((e) => e.type === 'tree' && !insideDesign(e.path))
      .map((e) => e.path)
      .slice(0, MAX_DIRS);
    return { dirs, designs, truncated: tree.truncated || dirs.length >= MAX_DIRS };
  }
}

function publicRepo({ cloneUrl: _clone, ...repo }: RepoInfo): VcsRepo {
  return repo;
}
