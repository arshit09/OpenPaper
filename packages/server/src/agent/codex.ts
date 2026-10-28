import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs-utils.ts';
import { capture, findProgram, runJsonLines, type CliHost } from './cli.ts';

/**
 * Runs the built-in agent on the user's own Codex CLI, so it uses their ChatGPT (or OpenAI API) sign-in.
 * Like Claude Code it is launched unmodified and headless (`codex exec --json`), connected to OpenPaper's
 * MCP endpoint. Their config.toml stays out of these runs (its plugins and MCP servers would add tools),
 * the shell is off and the sandbox read-only: it designs through OpenPaper's tools, and makes images with
 * its own image generator, whose files it places on the canvas.
 */

export interface CodexStatus {
  version: string;
  loggedIn: boolean;
  /** How it signs in: "ChatGPT" or "API key". */
  plan: string | null;
}

/** One line from `codex exec --json` (only the fields we read are typed). */
export interface CodexEvent {
  type: string;
  [key: string]: any;
}

/** Where Codex keeps its sign-in, sessions and generated images. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** The installed `codex` executable: PATH first, then the Windows installer's location. */
export function findCodex(): string | null {
  const local = process.env.LOCALAPPDATA;
  return findProgram({ win32: ['codex.exe', 'codex.cmd'], other: ['codex'] }, local ? [join(local, 'Programs', 'OpenAI', 'Codex', 'bin')] : []);
}

function defaultCommand(): string[] | null {
  const path = findCodex();
  return path ? [path] : null;
}

const NOT_INSTALLED = 'Codex is not installed. Install the Codex CLI from https://developers.openai.com/codex, sign in with `codex login`, then try again.';

/** Whether Codex is installed and signed in, as reported by Codex itself. */
export async function codexStatus(command = defaultCommand()): Promise<CodexStatus | null> {
  if (!command) return null;
  try {
    const version = /\d+\.\d+[\w.-]*/.exec((await capture(command, ['--version'])).stdout)?.[0];
    if (!version) return null;
    let loggedIn = false;
    let plan: string | null = null;
    try {
      // "Logged in using ChatGPT" (on stderr), exit 0; exit 1 when signed out.
      const { stdout, stderr, code } = await capture(command, ['login', 'status']);
      const text = `${stdout}\n${stderr}`;
      loggedIn = code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
      if (loggedIn) plan = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : null;
    } catch {
      // Unreadable status: report signed out; a run would fail the same way.
    }
    return { version, loggedIn, plan };
  } catch {
    return null;
  }
}

/** The model the user's config.toml picks (runs ignore that file, so OpenPaper passes it on). */
export async function codexConfiguredModel(): Promise<string | null> {
  try {
    const toml = await readFile(join(codexHome(), 'config.toml'), 'utf8');
    // Top-level keys only: everything before the first [table].
    const top = toml.split(/^\s*\[/m)[0] ?? '';
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Models the user's Codex offers, from the list Codex itself keeps (empty if it can't be read). */
export async function codexModels(): Promise<Array<{ id: string; label: string }>> {
  try {
    const cache = JSON.parse(await readFile(join(codexHome(), 'models_cache.json'), 'utf8')) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };
    return (cache.models ?? [])
      .filter((m) => typeof m.slug === 'string' && m.visibility === 'list')
      .map((m) => ({ id: m.slug as string, label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string) }));
  } catch {
    return [];
  }
}

export interface CodexRun {
  prompt: string;
  /** Codex thread to continue (null starts a new one). */
  resume: string | null;
  /** "" = the model from the user's config.toml, or Codex's default. */
  model: string;
  effort: string;
  /** Written to AGENTS.md in the run folder, which Codex reads as project instructions. */
  systemPrompt: string;
  signal: AbortSignal;
}

/** A TOML string for a `-c key=value` override. */
const toml = (value: string) => JSON.stringify(value);

/** Run one turn of headless Codex and yield its JSON events until it exits. */
export async function* runCodex(host: CliHost, run: CodexRun): AsyncGenerator<CodexEvent> {
  const exe = host.command ?? defaultCommand();
  if (!exe) throw new Error(NOT_INSTALLED);
  await writeFileAtomic(join(host.dir, 'AGENTS.md'), run.systemPrompt);
  const model = run.model || (await codexConfiguredModel());
  const args = [
    'exec',
    ...(run.resume ? ['resume'] : []),
    '--json',
    '--skip-git-repo-check',
    // Not the user's config.toml: its plugins and MCP servers would add tools beyond the design tools.
    '--ignore-user-config',
    // No shell, nothing writes files, and nothing waits on an approval.
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '-c', `sandbox_mode=${toml('read-only')}`,
    '-c', `approval_policy=${toml('never')}`,
    '-c', `mcp_servers.openpaper.url=${toml(host.mcpUrl)}`,
    // Codex asks before tools that change things, and nobody is there to answer: the design tools are the point.
    '-c', `mcp_servers.openpaper.default_tools_approval_mode=${toml('approve')}`,
    '-c', `model_reasoning_effort=${toml(run.effort)}`,
    ...(model ? ['-m', model] : []),
    ...(run.resume ? [run.resume] : []),
    '-', // The prompt comes on stdin.
  ];
  yield* runJsonLines({
    command: exe,
    args,
    cwd: host.dir,
    input: run.prompt,
    signal: run.signal,
    name: 'Codex',
    notInstalled: NOT_INSTALLED,
    isFinal: (m) => m.type === 'turn.completed' || m.type === 'turn.failed',
  }) as AsyncGenerator<CodexEvent>;
}
