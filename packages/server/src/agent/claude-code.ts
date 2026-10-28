import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs-utils.ts';
import { capture, findProgram, runJsonLines, type CliHost } from './cli.ts';

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
export type ClaudeCodeHost = CliHost;

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
  return findProgram({ win32: ['claude.exe', 'claude.cmd'], other: ['claude'] });
}

function defaultCommand(): string[] | null {
  const path = findClaudeCode();
  return path ? [path] : null;
}

const NOT_INSTALLED = 'Claude Code is not installed. Install it from https://claude.com/claude-code, sign in, then try again.';

/** Whether Claude Code is installed and signed in, as reported by Claude Code itself. */
export async function claudeCodeStatus(command = defaultCommand()): Promise<ClaudeCodeStatus | null> {
  if (!command) return null;
  try {
    const version = (await capture(command, ['--version'])).stdout.trim().split(/\s+/)[0] ?? '';
    if (!version) return null;
    let loggedIn = false;
    let plan: string | null = null;
    try {
      const status = JSON.parse((await capture(command, ['auth', 'status', '--json'])).stdout) as { loggedIn?: boolean; subscriptionType?: unknown };
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
  yield* runJsonLines({
    command: exe,
    args,
    cwd: run.project ?? host.dir,
    input: run.prompt,
    signal: run.signal,
    name: 'Claude Code',
    notInstalled: NOT_INSTALLED,
    isFinal: (m) => m.type === 'result',
  }) as AsyncGenerator<ClaudeCodeMessage>;
}
