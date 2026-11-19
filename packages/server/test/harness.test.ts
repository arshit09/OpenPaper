import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessStatus, installHarness, uninstallHarness } from '../src/harness.ts';

const launch = { command: '/usr/bin/node', args: ['/opt/openpaper/cli.js', 'mcp'] };

let home: string;
const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'op-harness-'));
  // Claude Desktop and VS Code live under the app-data folder: keep them in the temp home too.
  process.env.APPDATA = join(home, 'AppData');
  process.env.XDG_CONFIG_HOME = join(home, 'config');
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const connected = async () => (await harnessStatus(launch, home)).filter((h) => h.connected).map((h) => h.id);

describe('connecting and disconnecting agents', () => {
  it('reports nothing connected in a fresh home, then each agent once it is installed', async () => {
    expect(await connected()).toEqual([]);
    await installHarness('cursor', launch, home);
    await installHarness('codex', launch, home);
    expect(await connected()).toEqual(['cursor', 'codex']);
    const cursor = (await harnessStatus(launch, home)).find((h) => h.id === 'cursor')!;
    expect(cursor.path).toBe(join(home, '.cursor', 'mcp.json'));
  });

  it('takes only OpenPaper out of a JSON config, keeping comments and other servers', async () => {
    const path = join(home, '.cursor', 'mcp.json');
    await put(path, '{\n  // my servers\n  "mcpServers": {\n    "other": { "command": "x" },\n    "openpaper": { "command": "node" }\n  }\n}\n');
    expect(await connected()).toEqual(['cursor']);

    const result = await uninstallHarness('cursor', launch, home);
    expect(result).toMatchObject({ ok: true, changed: true });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('openpaper');
    expect(text).toContain('// my servers');
    expect(text).toContain('"other": { "command": "x" }');
    expect(await connected()).toEqual([]);

    // Again: nothing to take out.
    expect(await uninstallHarness('cursor', launch, home)).toMatchObject({ ok: true, changed: false });
  });

  it('counts an OpenPaper entry written by another install as connected', async () => {
    await put(join(home, '.claude.json'), JSON.stringify({ mcpServers: { openpaper: { type: 'http', url: 'http://127.0.0.1:29880/mcp' } } }));
    expect(await connected()).toEqual(['claude-code']);
  });

  it('removes the TOML table as text, so the rest of a Codex config keeps its comments', async () => {
    const path = join(home, '.codex', 'config.toml');
    const before = '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.node_repl]\ncommand = "node" # keep me\n';
    await put(path, before);
    await installHarness('codex', launch, home);
    // A subtable of ours goes with it.
    await writeFile(path, `${await readFile(path, 'utf8')}\n[mcp_servers.openpaper.env]\nFOO = "1"\n\n[profiles.fast]\nmodel = "o4"\n`);
    expect(await connected()).toEqual(['codex']);

    await uninstallHarness('codex', launch, home);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# my codex');
    expect(text).toContain('command = "node" # keep me');
    expect(text).not.toContain('openpaper');
    expect(parseToml(text)).toEqual({ model: 'gpt-5', mcp_servers: { node_repl: { command: 'node' } }, profiles: { fast: { model: 'o4' } } });
  });

  it('leaves a Codex config alone when it already has the same entry', async () => {
    const path = join(home, '.codex', 'config.toml');
    await put(path, '# mine\n');
    expect(await installHarness('codex', launch, home)).toMatchObject({ changed: true });
    const once = await readFile(path, 'utf8');
    expect(await installHarness('codex', launch, home)).toMatchObject({ changed: false });
    expect(await readFile(path, 'utf8')).toBe(once);
  });

  it('re-serializes a Codex config whose entry is inline', async () => {
    const path = join(home, '.codex', 'config.toml');
    await put(path, 'mcp_servers = { openpaper = { command = "node" }, other = { command = "x" } }\n');
    expect(await connected()).toEqual(['codex']);
    await uninstallHarness('codex', launch, home);
    expect(parseToml(await readFile(path, 'utf8'))).toEqual({ mcp_servers: { other: { command: 'x' } } });
  });

  it('finds OpenPaper in an alternate config file and removes it there', async () => {
    const alternate = join(home, '.gemini', 'config', 'mcp_config.json');
    await put(alternate, JSON.stringify({ mcpServers: { openpaper: { command: 'node' } } }));
    expect(await connected()).toEqual(['antigravity']);
    await uninstallHarness('antigravity', launch, home);
    expect(JSON.parse(await readFile(alternate, 'utf8'))).toEqual({ mcpServers: {} });
  });

  it('leaves a config it cannot read alone, and says so', async () => {
    const path = join(home, '.cursor', 'mcp.json');
    await put(path, '{ not json');
    const status = (await harnessStatus(launch, home)).find((h) => h.id === 'cursor')!;
    expect(status).toMatchObject({ connected: false });
    expect(status.error).toMatch(/Not valid JSON/);
    expect(await uninstallHarness('cursor', launch, home)).toMatchObject({ ok: false });
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });

  it('refuses an unknown agent', async () => {
    expect(await uninstallHarness('nope', launch, home)).toMatchObject({ ok: false });
  });
});
