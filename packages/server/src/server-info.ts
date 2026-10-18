import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-utils.ts';
import { DEFAULT_PORT, type OpenPaperPaths } from './paths.ts';

export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: string;
}

export async function readServerInfo(paths: OpenPaperPaths): Promise<ServerInfo | null> {
  try {
    return JSON.parse(await readFile(paths.serverInfo, 'utf8')) as ServerInfo;
  } catch {
    return null;
  }
}

export async function writeServerInfo(paths: OpenPaperPaths, info: ServerInfo): Promise<void> {
  await writeFileAtomic(paths.serverInfo, JSON.stringify(info, null, 2));
}

export async function removeServerInfo(paths: OpenPaperPaths, pid = process.pid): Promise<void> {
  const current = await readServerInfo(paths);
  if (current && current.pid !== pid) return;
  await rm(paths.serverInfo, { force: true });
}

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  pid: number;
}

export async function probeHealth(port: number, timeoutMs = 1500): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health;
    return body?.name === 'openpaper' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Find a running OpenPaper server. With an explicit port only that port is checked;
 * otherwise server.json's port, then the default port.
 */
export async function findRunningServer(paths: OpenPaperPaths, port?: number): Promise<{ port: number; health: Health } | null> {
  const candidates = port ? [port] : [(await readServerInfo(paths))?.port, DEFAULT_PORT];
  for (const p of [...new Set(candidates.filter((x): x is number => typeof x === 'number'))]) {
    const health = await probeHealth(p);
    if (health) return { port: p, health };
  }
  return null;
}

/**
 * Make sure a server is running, starting `openpaper serve` as a detached background
 * process when needed. Resolves with the server's port.
 */
export async function ensureServer(paths: OpenPaperPaths, opts: { port?: number; timeoutMs?: number } = {}): Promise<number> {
  const running = await findRunningServer(paths, opts.port);
  if (running) return running.port;

  await mkdir(paths.logs, { recursive: true });
  const log = openSync(join(paths.logs, 'server.log'), 'a');
  const script = process.argv[1]!;
  const args = [...process.execArgv, script, 'serve', '--no-open'];
  if (opts.port) args.push('--port', String(opts.port));
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, OPENPAPER_BACKGROUND: '1' },
  });
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const found = await findRunningServer(paths, opts.port);
    if (found) return found.port;
  }
  throw new Error(`OpenPaper server did not start. See ${join(paths.logs, 'server.log')}`);
}
