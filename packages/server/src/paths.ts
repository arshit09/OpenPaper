import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 29_880;
export const MCP_PATH = '/mcp';

export interface OpenPaperPaths {
  home: string;
  files: string;
  assets: string;
  exports: string;
  cache: string;
  index: string;
  serverInfo: string;
  config: string;
  logs: string;
}

/** Root data directory. Override with OPENPAPER_HOME. */
export function openPaperHome(): string {
  return process.env.OPENPAPER_HOME || join(homedir(), '.openpaper');
}

/** Where exports land: OPENPAPER_EXPORT_DIR, else ~/Downloads/OpenPaper, else <home>/exports. */
function exportsDir(home: string): string {
  if (process.env.OPENPAPER_EXPORT_DIR) return process.env.OPENPAPER_EXPORT_DIR;
  const downloads = join(homedir(), 'Downloads');
  return existsSync(downloads) ? join(downloads, 'OpenPaper') : join(home, 'exports');
}

export function resolvePaths(home = openPaperHome()): OpenPaperPaths {
  return {
    home,
    files: join(home, 'files'),
    assets: join(home, 'assets'),
    exports: exportsDir(home),
    cache: join(home, 'cache'),
    index: join(home, 'index.json'),
    serverInfo: join(home, 'server.json'),
    config: join(home, 'config.json'),
    logs: join(home, 'logs'),
  };
}
