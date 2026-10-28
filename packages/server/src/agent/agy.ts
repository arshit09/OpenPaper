import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../fs-utils.ts';
import { capture, findProgram, runJsonLines, type CliHost } from './cli.ts';

/**
 * Runs the built-in agent on the user's own Antigravity CLI (`agy`), so it uses their Google sign-in. It is
 * launched unmodified in print mode from a workspace OpenPaper sets up: a plugin there connects it to
 * OpenPaper's MCP endpoint, and the plugin's hook lets only the design tools, agy's image subagent and
 * reading the tools' own docs through. Headless agy refuses MCP tools it has no allow rule for, so the user
 * grants OpenPaper's once (`allowAgyDesignTools`), which adds one rule to agy's settings.
 */

export interface AgyStatus {
  version: string;
  /** agy's settings allow OpenPaper's design tools. */
  allowed: boolean;
}

export interface AgyHost extends CliHost {
  /** agy's settings file (default ~/.gemini/antigravity-cli/settings.json). Override for tests. */
  settingsPath?: string;
}

/** One line from `agy --output-format stream-json` (only the fields we read are typed). */
export interface AgyEvent {
  event: string;
  [key: string]: any;
}

const PLUGIN = 'openpaper';
/** How agy names a plugin's MCP server: `<plugin>_<server>`. */
export const AGY_SERVER = `${PLUGIN}_openpaper`;
/** The allow rule for OpenPaper's design tools. It only matches inside OpenPaper's workspace, where the plugin is. */
export const AGY_RULE = `mcp(${AGY_SERVER}/*)`;

export function agySettingsPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

/** The installed `agy` executable: PATH first, then the Windows installer's location. */
export function findAgy(): string | null {
  const local = process.env.LOCALAPPDATA;
  return findProgram({ win32: ['agy.exe', 'agy.cmd'], other: ['agy'] }, local ? [join(local, 'agy', 'bin')] : []);
}

function defaultCommand(): string[] | null {
  const path = findAgy();
  return path ? [path] : null;
}

const NOT_INSTALLED = 'The Antigravity CLI (agy) is not installed. Install it from https://antigravity.google, sign in, then try again.';
export const AGY_NOT_ALLOWED = "Antigravity hasn't allowed OpenPaper's design tools yet. Allow them once in the agent settings, then try again.";

/** Whether agy's settings already allow OpenPaper's design tools. */
export async function agyAllowed(path = agySettingsPath()): Promise<boolean> {
  try {
    const allow = (JSON.parse(await readFile(path, 'utf8')) as { permissions?: { allow?: unknown } })?.permissions?.allow;
    return Array.isArray(allow) && allow.includes(AGY_RULE);
  } catch {
    return false;
  }
}

/** Add OpenPaper's allow rule to agy's settings, keeping everything else in the file. */
export async function allowAgyDesignTools(path = agySettingsPath()): Promise<void> {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let parsed: unknown = {};
  try {
    if (text.trim()) parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  // Never overwrite a file we can't read: it's the user's own agy configuration.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Couldn't read ${path}. Add "${AGY_RULE}" to permissions.allow in it yourself.`);
  }
  const settings = parsed as Record<string, any>;
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const allow: unknown[] = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(AGY_RULE)) return;
  settings.permissions = { ...permissions, allow: [...allow, AGY_RULE] };
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Whether agy is installed and allows OpenPaper's design tools. */
export async function agyStatus(command = defaultCommand(), settingsPath = agySettingsPath()): Promise<AgyStatus | null> {
  if (!command) return null;
  try {
    const version = /\d+\.\d+[\w.-]*/.exec((await capture(command, ['--version'])).stdout)?.[0];
    if (!version) return null;
    return { version, allowed: await agyAllowed(settingsPath) };
  } catch {
    return null;
  }
}

/** Models agy offers (`agy models`: one "id<TAB>label" per line). Their ids include the effort level. */
export async function agyModels(command = defaultCommand()): Promise<Array<{ id: string; label: string }>> {
  if (!command) return [];
  try {
    const { stdout } = await capture(command, ['models'], 20_000);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.split('\t'))
      .filter((cols): cols is [string, string] => cols.length >= 2 && /^[\w.:-]+$/.test(cols[0]!.trim()))
      .map(([id, label]) => ({ id: id.trim(), label: label.trim() || id.trim() }));
  } catch {
    return [];
  }
}

/** The image subagent: agy's main agent can't generate images itself, it asks this one. */
const IMAGE_SUBAGENT = 'image-generator';

/**
 * The plugin hook, for two events. Before each tool call (PreToolUse) it allows or denies: only OpenPaper's
 * design tools, the image subagent (and what it needs) and reading those tools' docs or the images generated
 * here get through. agy's own permission checks still apply after it. When the agent would stop (Stop) while
 * the image subagent is still working in the background, it keeps the turn going so the image gets placed.
 */
function hookScript(schemaDir: string): string {
  return `// Written by OpenPaper; agy runs it in OpenPaper's workspace before each tool call and before stopping.
const path = require('node:path');
const SERVER = ${JSON.stringify(AGY_SERVER)};
const SCHEMAS = ${JSON.stringify(schemaDir)};
const SUBAGENT = ${JSON.stringify(IMAGE_SUBAGENT)};
// Tools of the image subagent and for waiting on it.
const IMAGE_TOOLS = ['generate_image', 'send_message', 'wait', 'wait_5_seconds', 'manage_subagents', 'finish'];
const norm = (p) => {
  const r = path.resolve(String(p));
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (p, dir) => !!p && !!dir && (norm(p) + path.sep).startsWith(norm(dir) + path.sep);
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {}
  if (!payload.toolCall) {
    const busy = payload.fullyIdle === false;
    process.stdout.write(JSON.stringify(busy ? { decision: 'continue', reason: 'The image generator is still working; its message with the saved file arrives on its own. Then place the file.' } : {}));
    return;
  }
  const call = payload.toolCall;
  const args = call.args || {};
  let ok = false;
  let reason = "Only OpenPaper's design tools and image generation are available here.";
  if (call.name === 'call_mcp_tool') ok = args.ServerName === SERVER;
  else if (IMAGE_TOOLS.includes(call.name)) ok = true;
  else if (call.name === 'invoke_subagent') {
    ok = args.TypeName === SUBAGENT;
    reason = 'Only the ' + SUBAGENT + ' subagent is available here.';
  } else if (call.name === 'read_file' || call.name === 'view_file') {
    const file = args.Path || args.AbsolutePath || '';
    ok = inside(file, SCHEMAS) || inside(file, payload.artifactDirectoryPath);
  }
  process.stdout.write(JSON.stringify(ok ? { decision: 'allow' } : { decision: 'deny', reason }));
});
`;
}

/** The workspace agy runs in: the design guide as AGENTS.md, and the plugin with OpenPaper's MCP server and gate. */
async function prepareWorkspace(host: AgyHost, systemPrompt: string) {
  const plugin = join(host.dir, '.agents', 'plugins', PLUGIN);
  // agy keeps each MCP tool's schema in <settings dir>/mcp/<server>/ and reads it before a call.
  const schemaDir = join(dirname(host.settingsPath ?? agySettingsPath()), 'mcp', AGY_SERVER);
  // The hook runs through `cmd /c` on Windows (`sh -c` elsewhere), from the plugin folder. cmd won't look for
  // programs in the current folder there, hence `.\`. If the hook can't run, agy refuses the tool call.
  const node = process.execPath;
  const command = process.platform === 'win32' ? '.\\hook.cmd' : `'${node.replace(/'/g, `'\\''`)}' hook.cjs`;
  const hook = { type: 'command', command, timeout: 10 };
  await writeFileAtomic(join(host.dir, 'AGENTS.md'), systemPrompt);
  await writeFileAtomic(join(plugin, 'plugin.json'), JSON.stringify({ name: PLUGIN }, null, 2));
  await writeFileAtomic(join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: { openpaper: { url: host.mcpUrl } } }, null, 2));
  await writeFileAtomic(join(plugin, 'hook.cjs'), hookScript(schemaDir));
  if (process.platform === 'win32') await writeFileAtomic(join(plugin, 'hook.cmd'), `@"${node}" "%~dp0hook.cjs"\r\n`);
  await writeFileAtomic(join(plugin, 'hooks.json'), JSON.stringify({ openpaper: { PreToolUse: [{ matcher: '*', hooks: [hook] }], Stop: [hook] } }, null, 2));
}

export interface AgyRun {
  prompt: string;
  /** agy conversation to continue (null starts a new one). */
  resume: string | null;
  /** "" = agy's own default. */
  model: string;
  /** Written to AGENTS.md in the workspace, which agy always applies there. */
  systemPrompt: string;
  signal: AbortSignal;
}

/** agy takes the prompt as an argument, and a Windows command line holds about 32k characters. */
const MAX_PROMPT = 30_000;

/** Run one turn of headless agy and yield its stream-json events until it exits. */
export async function* runAgy(host: AgyHost, run: AgyRun): AsyncGenerator<AgyEvent> {
  const exe = host.command ?? defaultCommand();
  if (!exe) throw new Error(NOT_INSTALLED);
  if (!(await agyAllowed(host.settingsPath))) throw new Error(AGY_NOT_ALLOWED);
  if (run.prompt.length > MAX_PROMPT) throw new Error('That message is too long for Antigravity. Shorten it and try again.');
  await prepareWorkspace(host, run.systemPrompt);
  const args = [
    '--output-format', 'stream-json',
    ...(run.model ? ['--model', run.model] : []),
    ...(run.resume ? ['--conversation', run.resume] : []),
    // The prompt starts with "<context>", so it can't be taken for a flag.
    '--print', run.prompt,
  ];
  yield* runJsonLines({
    command: exe,
    args,
    cwd: host.dir,
    signal: run.signal,
    name: 'Antigravity',
    notInstalled: NOT_INSTALLED,
    isFinal: (m) => m.event === 'result',
  }) as AsyncGenerator<AgyEvent>;
}
