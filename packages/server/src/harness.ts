import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { decodeText, writeFileAtomic } from './fs-utils.ts';

/** Name of OpenPaper's entry in every harness's MCP server map. */
export const SERVER_NAME = 'openpaper';

export interface StdioLaunch {
  command: string;
  args: string[];
}

type Json = Record<string, unknown>;

interface Target {
  label: string;
  format: 'json' | 'toml';
  path: string;
  /** Checked before `path`; the first existing one is edited instead. */
  alternates?: string[];
  serversKey: string;
  entry: Json;
}

function appData(home: string): string {
  if (process.platform === 'win32') return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(home, '.config');
}

export const HARNESSES = {
  'claude-code': (home: string, s: StdioLaunch): Target => ({
    label: 'Claude Code',
    format: 'json',
    path: join(home, '.claude.json'),
    serversKey: 'mcpServers',
    entry: { type: 'stdio', command: s.command, args: s.args },
  }),
  'claude-desktop': (home: string, s: StdioLaunch): Target => ({
    label: 'Claude Desktop',
    format: 'json',
    path: join(appData(home), 'Claude', 'claude_desktop_config.json'),
    serversKey: 'mcpServers',
    entry: { command: s.command, args: s.args },
  }),
  cursor: (home: string, s: StdioLaunch): Target => ({
    label: 'Cursor',
    format: 'json',
    path: join(home, '.cursor', 'mcp.json'),
    serversKey: 'mcpServers',
    entry: { command: s.command, args: s.args },
  }),
  vscode: (home: string, s: StdioLaunch): Target => ({
    label: 'VS Code',
    format: 'json',
    path: join(appData(home), 'Code', 'User', 'mcp.json'),
    serversKey: 'servers',
    entry: { type: 'stdio', command: s.command, args: s.args },
  }),
  codex: (home: string, s: StdioLaunch): Target => ({
    label: 'Codex',
    format: 'toml',
    path: join(home, '.codex', 'config.toml'),
    serversKey: 'mcp_servers',
    entry: { command: s.command, args: s.args },
  }),
  windsurf: (home: string, s: StdioLaunch): Target => ({
    label: 'Windsurf',
    format: 'json',
    path: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    serversKey: 'mcpServers',
    entry: { command: s.command, args: s.args },
  }),
  'gemini-cli': (home: string, s: StdioLaunch): Target => ({
    label: 'Gemini CLI',
    format: 'json',
    path: join(home, '.gemini', 'settings.json'),
    serversKey: 'mcpServers',
    entry: { command: s.command, args: s.args },
  }),
  antigravity: (home: string, s: StdioLaunch): Target => ({
    label: 'Antigravity',
    format: 'json',
    path: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    alternates: [join(home, '.gemini', 'config', 'mcp_config.json')],
    serversKey: 'mcpServers',
    entry: { type: 'stdio', command: s.command, args: s.args },
  }),
  opencode: (home: string, s: StdioLaunch): Target => ({
    label: 'OpenCode',
    format: 'json',
    path: join(home, '.config', 'opencode', 'opencode.json'),
    alternates: [join(home, '.config', 'opencode', 'opencode.jsonc')],
    serversKey: 'mcp',
    entry: { type: 'local', command: [s.command, ...s.args], enabled: true },
  }),
  'copilot-cli': (home: string, s: StdioLaunch): Target => ({
    label: 'GitHub Copilot CLI',
    format: 'json',
    path: join(home, '.copilot', 'mcp-config.json'),
    serversKey: 'mcpServers',
    entry: { type: 'local', command: s.command, args: s.args, tools: ['*'] },
  }),
} as const;

export type HarnessId = keyof typeof HARNESSES;

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && Object.hasOwn(HARNESSES, value);
}

export type InstallResult =
  | { ok: true; harness: HarnessId; label: string; path: string; changed: boolean }
  | { ok: false; harness: string; reason: string; path?: string };

const unknownHarness = (harness: string) => ({
  ok: false as const,
  harness,
  reason: `Unknown harness. Choose one of: ${Object.keys(HARNESSES).join(', ')}`,
});

/** The harness's config files that exist, in the order they're edited (alternates first), with their text. */
async function existingConfigs(target: Target): Promise<Array<{ path: string; text: string }>> {
  const found: Array<{ path: string; text: string }> = [];
  for (const candidate of [...(target.alternates ?? []), target.path]) {
    try {
      found.push({ path: candidate, text: decodeText(await readFile(candidate)) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return found;
}

export async function installHarness(
  harness: string,
  launch: StdioLaunch,
  home = homedir()
): Promise<InstallResult> {
  if (!isHarnessId(harness)) return unknownHarness(harness);
  const target = HARNESSES[harness](home, launch);
  const first = (await existingConfigs(target))[0];
  const path = first?.path ?? target.path;
  const edit = target.format === 'json' ? editJson(first?.text ?? null, target) : editToml(first?.text ?? null, target);
  if (edit.status === 'invalid') return { ok: false, harness, reason: edit.message, path };
  if (edit.status === 'changed') await writeFileAtomic(path, edit.text, 0o600);
  return { ok: true, harness, label: target.label, path, changed: edit.status === 'changed' };
}

/**
 * Take OpenPaper back out of a harness's MCP config: only its `openpaper` entry goes, from every config
 * file the harness reads. The rest of each file (other servers, comments, formatting) stays as it was.
 */
export async function uninstallHarness(
  harness: string,
  launch: StdioLaunch,
  home = homedir()
): Promise<InstallResult> {
  if (!isHarnessId(harness)) return unknownHarness(harness);
  const target = HARNESSES[harness](home, launch);
  let changed = false;
  let path = target.path;
  for (const config of await existingConfigs(target)) {
    const edit = target.format === 'json' ? removeJson(config.text, target) : removeToml(config.text, target);
    if (edit.status === 'invalid') return { ok: false, harness, reason: edit.message, path: config.path };
    if (edit.status === 'changed') {
      await writeFileAtomic(config.path, edit.text, 0o600);
      changed = true;
      path = config.path;
    }
  }
  return { ok: true, harness, label: target.label, path, changed };
}

export interface HarnessStatus {
  id: HarnessId;
  label: string;
  /** OpenPaper is in its MCP config (whatever command that entry launches). */
  connected: boolean;
  /** The config file that has OpenPaper, or the one Connect would write. */
  path: string;
  /** Its config can't be read, so Connect and Disconnect would refuse to touch it. */
  error?: string;
}

/** Which harnesses have OpenPaper in their MCP config. Only reads. */
export async function harnessStatus(launch: StdioLaunch, home = homedir()): Promise<HarnessStatus[]> {
  return Promise.all(
    (Object.keys(HARNESSES) as HarnessId[]).map(async (id): Promise<HarnessStatus> => {
      const target = HARNESSES[id](home, launch);
      try {
        const configs = await existingConfigs(target);
        for (const config of configs) {
          const servers = readServers(config.text, target);
          if (typeof servers === 'string') return { id, label: target.label, connected: false, path: config.path, error: servers };
          if (servers[SERVER_NAME] !== undefined) return { id, label: target.label, connected: true, path: config.path };
        }
        return { id, label: target.label, connected: false, path: configs[0]?.path ?? target.path };
      } catch (error) {
        return { id, label: target.label, connected: false, path: target.path, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}

/** The harness's MCP server map, or why it can't be read. */
function readServers(text: string, target: Target): Json | string {
  let root: unknown = {};
  if (text.trim()) {
    if (target.format === 'json') {
      const errors: ParseError[] = [];
      root = parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length) return `Not valid JSON: ${printParseErrorCode(errors[0]!.error)}`;
    } else {
      try {
        root = parseToml(text);
      } catch (error) {
        return `Not valid TOML: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  if (!isPlainObject(root)) return 'Expected an object at the top level';
  const servers = root[target.serversKey] ?? {};
  return isPlainObject(servers) ? servers : `Expected "${target.serversKey}" to be an object`;
}

type Edit = { status: 'unchanged' } | { status: 'changed'; text: string } | { status: 'invalid'; message: string };

function isPlainObject(value: unknown): value is Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Patch `<serversKey>.openpaper` in place so comments and formatting elsewhere survive. */
function editJson(existingText: string | null, target: Target): Edit {
  const text = existingText && existingText.trim() ? existingText : '{}';
  const errors: ParseError[] = [];
  const root: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) return { status: 'invalid', message: `Not valid JSON: ${printParseErrorCode(errors[0]!.error)}` };
  if (!isPlainObject(root)) return { status: 'invalid', message: 'Expected a JSON object at the top level' };
  const servers = root[target.serversKey] ?? {};
  if (!isPlainObject(servers)) return { status: 'invalid', message: `Expected "${target.serversKey}" to be an object` };
  if (isDeepStrictEqual(servers[SERVER_NAME], target.entry)) return { status: 'unchanged' };
  const indentMatch = existingText?.match(/^([ \t]+)"/m);
  const indent = indentMatch?.[1] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edited = applyEdits(
    text,
    modify(text, [target.serversKey, SERVER_NAME], target.entry, {
      formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol },
    })
  );
  return { status: 'changed', text: edited.endsWith('\n') ? edited : edited + eol };
}

/** Remove `<serversKey>.openpaper`, leaving the rest of the file as it was. */
function removeJson(text: string, target: Target): Edit {
  const servers = readServers(text, target);
  if (typeof servers === 'string') return { status: 'invalid', message: servers };
  if (servers[SERVER_NAME] === undefined) return { status: 'unchanged' };
  // No formatting options: the edit cuts out the entry alone instead of reformatting the object around it.
  return { status: 'changed', text: applyEdits(text, modify(text, [target.serversKey, SERVER_NAME], undefined, {})) };
}

/** A parsed TOML value as plain JSON: smol-toml's tables have no prototype, which deep equality counts. */
const plain = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove `[<serversKey>.openpaper]` (and its subtables) as text, so comments elsewhere survive. When the
 * entry is written some other way (inline, dotted keys), the file is re-serialized instead, as install does.
 */
function removeToml(text: string, target: Target): Edit {
  const servers = readServers(text, target);
  if (typeof servers === 'string') return { status: 'invalid', message: servers };
  if (servers[SERVER_NAME] === undefined) return { status: 'unchanged' };
  const root = parseToml(text) as Json;
  const { [SERVER_NAME]: _removed, ...rest } = servers;
  const expected: Json = { ...root, [target.serversKey]: rest };

  const key = (k: string) => `(?:${escapeRegExp(k)}|"${escapeRegExp(k)}"|'${escapeRegExp(k)}')`;
  const ours = new RegExp(`^\\s*\\[\\s*${key(target.serversKey)}\\s*\\.\\s*${key(SERVER_NAME)}\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
  const header = /^\s*\[/;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (header.test(line)) skipping = ours.test(line);
    if (!skipping) kept.push(line);
  }
  const stripped = kept.join(eol).replace(/(\r?\n){3,}/g, eol + eol);
  try {
    const parsed = parseToml(stripped) as Json;
    // An emptied `[mcp_servers]` table may be gone from the parse; that's the same config.
    const normalize = (r: Json) => plain({ ...r, [target.serversKey]: (r[target.serversKey] as Json | undefined) ?? {} });
    if (isDeepStrictEqual(normalize(parsed), normalize(expected))) return { status: 'changed', text: stripped };
  } catch {
    // Fall through and re-serialize.
  }
  return { status: 'changed', text: stringifyToml(expected) };
}

function editToml(existingText: string | null, target: Target): Edit {
  let root: unknown = {};
  if (existingText && existingText.trim()) {
    try {
      root = parseToml(existingText);
    } catch (error) {
      return { status: 'invalid', message: `Not valid TOML: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!isPlainObject(root)) return { status: 'invalid', message: 'Expected a TOML table at the top level' };
  const servers = root[target.serversKey] ?? {};
  if (!isPlainObject(servers)) return { status: 'invalid', message: `Expected "${target.serversKey}" to be a table` };
  if (isDeepStrictEqual(plain(servers[SERVER_NAME]), target.entry)) return { status: 'unchanged' };
  if (servers[SERVER_NAME] === undefined && existingText) {
    // Append a new table so the rest of the file (comments included) is untouched.
    const table = stringifyToml({ [target.serversKey]: { [SERVER_NAME]: target.entry } });
    const appended = existingText + (existingText.endsWith('\n') ? '\n' : '\n\n') + table;
    try {
      parseToml(appended);
      return { status: 'changed', text: appended };
    } catch {
      // Inline servers table: fall through and re-serialize.
    }
  }
  root[target.serversKey] = { ...servers, [SERVER_NAME]: target.entry };
  return { status: 'changed', text: stringifyToml(root) };
}
