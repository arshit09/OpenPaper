import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Shared plumbing for the coding agents the built-in agent can run on (Claude Code, Codex, agy): finding the
 * installed program, starting it headless and reading the JSON lines it prints.
 */

/** How the built-in agent reaches a coding agent's CLI. */
export interface CliHost {
  /** OpenPaper's MCP endpoint, which the CLI connects to for the design tools. */
  mcpUrl: string;
  /** Working directory for runs (holds its config and system prompt). */
  dir: string;
  /** Override for tests: the program (and leading args) to run instead of the installed one. */
  command?: string[];
}

/** An installed program: PATH first, then `extraDirs` (where its own installer puts it). */
export function findProgram(names: { win32: string[]; other: string[] }, extraDirs: string[] = []): string | null {
  const candidates = process.platform === 'win32' ? names.win32 : names.other;
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs, join(homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    for (const name of candidates) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const quoteForCmd = (arg: string) => `"${arg.replace(/"/g, '""')}"`;

/** npm's Windows shims are .cmd files, which only run through the shell. */
export function spawnCli(command: string[], args: string[], cwd?: string): ChildProcess {
  const [file, ...rest] = command;
  const all = [...rest, ...args];
  const options: SpawnOptions = { cwd, windowsHide: true, stdio: 'pipe' };
  if (/\.(cmd|bat)$/i.test(file!)) return spawn([file!, ...all].map(quoteForCmd).join(' '), { ...options, shell: true });
  return spawn(file!, all, options);
}

export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  // Through a .cmd shim the real process is a grandchild; taskkill /T takes the whole tree.
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Run a short command and return its output and exit code (status commands exit 1 when signed out). */
export function capture(command: string[], args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    child.stdin!.end();
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export interface JsonLinesRun {
  command: string[];
  args: string[];
  cwd: string;
  /** Written to stdin, which is then closed. */
  input?: string;
  signal: AbortSignal;
  /** The program's name in errors ("Claude Code"). */
  name: string;
  /** Error when the program can't be found. */
  notInstalled: string;
  /** Whether a line is the run's own final report; a run that exits without one failed. */
  isFinal: (message: Record<string, any>) => boolean;
}

/** Start a headless run and yield each JSON line it prints until it exits; stopping `signal` kills it. */
export async function* runJsonLines(run: JsonLinesRun): AsyncGenerator<Record<string, any>> {
  // Stop pressed while the run was being set up: don't start one nobody can stop any more.
  if (run.signal.aborted) return;
  const child = spawnCli(run.command, run.args, run.cwd);
  const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: null }));
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on('error', () => {}); // The process may exit before reading its input; `exited` reports why.
  child.stdin!.end(run.input ?? '');

  const onAbort = () => killTree(child);
  run.signal.addEventListener('abort', onAbort, { once: true });
  let sawFinal = false;
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      if (!line.startsWith('{')) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line) as Record<string, any>;
      } catch {
        continue;
      }
      if (run.isFinal(message)) sawFinal = true;
      yield message;
    }
    const { code, error } = await exited;
    if (run.signal.aborted || sawFinal) return;
    if (error) {
      throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? run.notInstalled : `Could not start ${run.name}: ${error.message}`);
    }
    throw new Error(`${run.name} exited unexpectedly (code ${code}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
  } finally {
    run.signal.removeEventListener('abort', onAbort);
    killTree(child);
  }
}
