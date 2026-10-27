import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { writeFileAtomic } from '../fs-utils.ts';

/**
 * Runs the built-in agent on the user's own Claude Code install, so it uses their Claude Code sign-in.
 * OpenPaper never reads or handles those credentials: it launches the unmodified `claude` program in
 * headless mode, connected to OpenPaper's MCP endpoint with only the design tools enabled. For a live
 * site it runs in the site's project folder with only the file tools instead.
 */

export interface ClaudeCodeStatus {
  version: string;
  loggedIn: boolean;
  /** Subscription plan reported by `claude auth status` (e.g. "pro", "max"), if any. */
  plan: string | null;
}

/** How the built-in agent reaches Claude Code. */
export interface ClaudeCodeHost {
  /** OpenPaper's MCP endpoint, which Claude Code connects to for the design tools. */
  mcpUrl: string;
  /** Working directory for runs (holds the MCP config and system prompt). */
  dir: string;
  /** Override for tests: the program (and leading args) to run instead of `claude`. */
  command?: string[];
}

/** One stream-json line from `claude -p --output-format stream-json` (only the fields we read are typed). */
export interface ClaudeCodeMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  [key: string]: any;
}

/** The installed `claude` executable: PATH first, then the native installer's default location. */
export function findClaudeCode(): string | null {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), join(homedir(), '.local', 'bin')];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function defaultCommand(): string[] | null {
  const path = findClaudeCode();
  return path ? [path] : null;
}

const NOT_INSTALLED = 'Claude Code is not installed. Install it from https://claude.com/claude-code, sign in, then try again.';

const quoteForCmd = (arg: string) =>`"${arg.replace(/"/g, '""')}"`;

/** npm's Windows shim is a .cmd, which only runs through the shell. */
function spawnClaude(command: string[], args: string[], cwd?: string): ChildProcess {
  const [file, ...rest] = command;
  const all = [...rest, ...args];
  const options: SpawnOptions = { cwd, windowsHide: true, stdio: 'pipe' };
  if (/\.(cmd|bat)$/i.test(file!)) return spawn([file!, ...all].map(quoteForCmd).join(' '), { ...options, shell: true });
  return spawn(file!, all, options);
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  // Through a .cmd shim the real process is a grandchild; taskkill /T takes the whole tree.
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

/** Run a short command and return its stdout, whatever the exit code (`auth status` exits 1 when signed out). */
function capture(command: string[], args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(command, args);
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stdin!.end();
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** Whether Claude Code is installed and signed in, as reported by Claude Code itself. */
export async function claudeCodeStatus(command = defaultCommand()): Promise<ClaudeCodeStatus | null> {
  if (!command) return null;
  try {
    const version = (await capture(command, ['--version'])).trim().split(/\s+/)[0] ?? '';
    if (!version) return null;
    let loggedIn = false;
    let plan: string | null = null;
    try {
      const status = JSON.parse(await capture(command, ['auth', 'status', '--json'])) as { loggedIn?: boolean; subscriptionType?: unknown };
      loggedIn = status.loggedIn === true;
      plan = typeof status.subscriptionType === 'string' ? status.subscriptionType : null;
    } catch {
      // Unreadable status: report signed out; a run would fail the same way.
    }
    return { version, loggedIn, plan };
  } catch {
    return null;
  }
}

export interface ClaudeCodeRun {
  prompt: string;
  /** Claude Code session to continue (null starts a new one). */
  resume: string | null;
  model: string;
  effort: string;
  systemPrompt: string;
  signal: AbortSignal;
  /**
   * Edit code in this project folder instead of designing: Claude Code's own file tools and default
   * system prompt (with `systemPrompt` appended), run from the folder, so it also reads its CLAUDE.md.
   */
  project?: string;
}

/** File tools for live-site runs. No shell: the user's dev server is already running and hot-reloads. */
const PROJECT_TOOLS = 'Read,Edit,Write,Glob,Grep';

/** Run one turn of headless Claude Code and yield its stream-json messages until it exits. */
export async function* runClaudeCode(host: ClaudeCodeHost, run: ClaudeCodeRun): AsyncGenerator<ClaudeCodeMessage> {
  const exe = host.command ?? defaultCommand();
  if (!exe) throw new Error(NOT_INSTALLED);

  await mkdir(host.dir, { recursive: true });
  const stream = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  const turn = ['--model', run.model, '--effort', run.effort, ...(run.resume ? ['--resume', run.resume] : [])];
  let args: string[];
  if (run.project) {
    const promptFile = join(host.dir, 'site-prompt.md');
    await writeFileAtomic(promptFile, run.systemPrompt);
    args = [
      ...stream,
      '--strict-mcp-config',
      // File tools only. Edits inside the project folder are accepted; anything that would ask is refused.
      '--tools', PROJECT_TOOLS,
      '--allowedTools', PROJECT_TOOLS,
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none',
      '--append-system-prompt-file', promptFile,
      ...turn,
    ];
  } else {
    const mcpConfig = join(host.dir, 'mcp.json');
    const promptFile = join(host.dir, 'system-prompt.md');
    await writeFileAtomic(mcpConfig, JSON.stringify({ mcpServers: { openpaper: { type: 'http', url: host.mcpUrl } } }, null, 2));
    await writeFileAtomic(promptFile, run.systemPrompt);
    args = [
      ...stream,
      '--mcp-config', mcpConfig,
      '--strict-mcp-config',
      // Only the design tools: no shell, file or web tools, and nothing waits on a permission prompt.
      '--tools', '',
      '--allowedTools', 'mcp__openpaper',
      '--permission-mode', 'dontAsk',
      '--system-prompt-file', promptFile,
      ...turn,
    ];
  }
  const child = spawnClaude(exe, args, run.project ?? host.dir);
  const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: null }));
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on('error', () => {}); // The process may exit before reading the prompt; `exited` reports why.
  child.stdin!.end(run.prompt);

  const onAbort = () => killTree(child);
  run.signal.addEventListener('abort', onAbort, { once: true });
  let sawResult = false;
  try {
    for await (const line of createInterface({ input: child.stdout! })) {
      if (!line.startsWith('{')) continue;
      let message: ClaudeCodeMessage;
      try {
        message = JSON.parse(line) as ClaudeCodeMessage;
      } catch {
        continue;
      }
      if (message.type === 'result') sawResult = true;
      yield message;
    }
    const { code, error } = await exited;
    if (run.signal.aborted || sawResult) return;
    if (error) {
      throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? NOT_INSTALLED : `Could not start Claude Code: ${error.message}`);
    }
    throw new Error(`Claude Code exited unexpectedly (code ${code}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
  } finally {
    run.signal.removeEventListener('abort', onAbort);
    killTree(child);
  }
}
