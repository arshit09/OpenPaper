import { spawn } from 'node:child_process';

/** A git command that failed; `message` is git's own explanation (its last `fatal:`/`error:` lines). */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd: string;
  /** Extra environment (e.g. the GitHub login for network commands). */
  env?: Record<string, string>;
  /** Written to stdin, which is then closed. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** Exit codes that aren't failures (`diff --quiet` exits 1 when there are changes). */
  okCodes?: number[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Never wait for a person: no terminal prompts, no credential manager windows, no editor. The server has
 * no console, so a prompt would hang the command until it times out.
 */
const QUIET_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  // Reads (status, log) don't take the index lock that the user's own tools may be holding.
  GIT_OPTIONAL_LOCKS: '0',
  // Folder names are names, not patterns ("Landing [v2]" has no wildcard in it).
  GIT_LITERAL_PATHSPECS: '1',
};

/** Paths printed as they are (no octal escapes for non-ASCII names), no colors or pagers. */
const QUIET_CONFIG = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat'];

function explain(stderr: string, args: string[], code: number | null): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'));
  const important = lines.filter((l) => /^(fatal|error|remote|!|\s*\[rejected\])/i.test(l));
  const text = (important.length ? important : lines).slice(-4).join('\n');
  return text.replace(/^(fatal|error): /gim, '') || `git ${args[0]} failed (exit ${code})`;
}

/** Run git and return its stdout as raw bytes. */
export function gitBuffer(args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...QUIET_CONFIG, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...QUIET_ENV, ...opts.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-8000)));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new GitError('Git isn’t installed on this computer. Install it from git-scm.com, then try again.', '', null) : error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) return resolve(Buffer.concat(out));
      if (signal) return reject(new GitError(`git ${args[0]} took too long and was stopped.`, stderr, code));
      reject(new GitError(explain(stderr, args, code), stderr, code));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}

/** Run git and return its stdout as text. */
export async function git(args: string[], opts: GitOptions): Promise<string> {
  return (await gitBuffer(args, opts)).toString('utf8');
}

/** Like `git` but exit code 1 is an answer ("no"), not a failure: returns whether it exited 0. */
export async function gitTest(args: string[], opts: GitOptions): Promise<boolean> {
  try {
    await gitBuffer(args, { ...opts, okCodes: [] });
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false;
    throw error;
  }
}

/** Installed git's version ("2.49.0"), or null when there is none. */
export async function gitVersion(): Promise<string | null> {
  try {
    const out = await git(['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
    return /(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? out.trim();
  } catch {
    return null;
  }
}

/**
 * Read several blobs in one process (`git cat-file --batch`). Missing objects come back absent.
 */
export async function readBlobs(cwd: string, oids: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!oids.length) return out;
  const data = await gitBuffer(['cat-file', '--batch'], { cwd, input: oids.join('\n') + '\n', timeoutMs: 120_000 });
  let at = 0;
  for (const oid of oids) {
    const eol = data.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = data.subarray(at, eol).toString('utf8');
    at = eol + 1;
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<oid> missing"
    const size = Number(m[3]);
    out.set(oid, data.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

/** Split NUL-terminated output (`-z`). */
export function splitNul(text: string): string[] {
  return text.split('\0').filter(Boolean);
}
