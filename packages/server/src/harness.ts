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

export async function installHarness(
  harness: string,
  launch: StdioLaunch,
  home = homedir()
): Promise<InstallResult> {
  if (!isHarnessId(harness)) {
    return { ok: false, harness, reason: `Unknown harness. Choose one of: ${Object.keys(HARNESSES).join(', ')}` };
  }
  const target = HARNESSES[harness](home, launch);
  let path = target.path;
  let existing: string | null = null;
  for (const candidate of [...(target.alternates ?? []), target.path]) {
    try {
      existing = decodeText(await readFile(candidate));
      path = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const edit = target.format === 'json' ? editJson(existing, target) : editToml(existing, target);
  if (edit.status === 'invalid') return { ok: false, harness, reason: edit.message, path };
  if (edit.status === 'changed') await writeFileAtomic(path, edit.text, 0o600);
  return { ok: true, harness, label: target.label, path, changed: edit.status === 'changed' };
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
  if (isDeepStrictEqual(servers[SERVER_NAME], target.entry)) return { status: 'unchanged' };
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
