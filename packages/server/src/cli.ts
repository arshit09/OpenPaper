#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { HARNESSES, installHarness, isHarnessId } from './harness.ts';
import { DEFAULT_PORT, MCP_PATH, resolvePaths } from './paths.ts';
import { findBrowserExecutable } from './render/browser-path.ts';
import { ensureServer, findRunningServer, readServerInfo } from './server-info.ts';
import { VERSION } from './version.ts';

const HELP = `OpenPaper ${VERSION} — open-source, AI-first design canvas with a Paper-compatible MCP server

Usage: openpaper <command> [options]

Commands:
  start                 Start the server in the background (if needed) and open the editor
  serve                 Run the server in the foreground
  mcp                   MCP stdio relay for agent harnesses (starts the server when needed)
  install <agent...>    Add OpenPaper to an agent's MCP config (or --all)
  status                Show whether the server is running
  stop                  Stop the running server
  doctor                Check your setup

Options:
  --port <n>            Server port (default ${DEFAULT_PORT})
  --no-open             Don't open the browser
  --dev                 Development mode (editor served by Vite on :5173)
  -v, --version         Print version
  -h, --help            Show help

Agents for install: ${Object.keys(HARNESSES).join(', ')}
`;

interface Args {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else if (arg.startsWith('--no-')) flags[arg.slice(5)] = false;
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (inline !== undefined) flags[key] = inline;
      else if (key === 'port' && argv[i + 1]) flags[key] = argv[++i]!;
      else flags[key] = true;
    } else positionals.push(arg);
  }
  return { command: positionals.shift(), positionals, flags };
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

/** How agent harnesses should launch `openpaper mcp` (absolute paths, no shell needed). */
function mcpLaunch() {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, 'mcp'] };
}

async function main() {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const paths = resolvePaths();
  const port = flags.port ? Number(flags.port) : undefined;

  if (flags.version) return console.log(VERSION);
  if (flags.help || !command || command === 'help') return console.log(HELP);

  switch (command) {
    case 'serve': {
      const { startServer } = await import('./server.ts');
      const server = await startServer({ paths, port: port ?? DEFAULT_PORT, dev: flags.dev === true });
      console.log(`OpenPaper ${VERSION} running at ${server.url}`);
      console.log(`MCP endpoint: ${server.url}${MCP_PATH}`);
      if (flags.open !== false && !process.env.OPENPAPER_BACKGROUND) openBrowser(server.editorUrl);
      return;
    }
    case 'start': {
      const p = await ensureServer(paths, { port });
      const url = `http://127.0.0.1:${p}`;
      console.log(`OpenPaper is running at ${url}`);
      if (flags.open !== false) openBrowser(url);
      return;
    }
    case 'mcp': {
      const { runStdioRelay } = await import('./mcp/stdio-relay.ts');
      await runStdioRelay({ ensureServer: () => ensureServer(paths, { port }) });
      return;
    }
    case 'install': {
      const targets = flags.all ? Object.keys(HARNESSES) : positionals;
      if (!targets.length) {
        console.error(`Name at least one agent: ${Object.keys(HARNESSES).join(', ')} (or --all)`);
        process.exitCode = 1;
        return;
      }
      const launch = mcpLaunch();
      for (const target of targets) {
        if (!isHarnessId(target)) {
          console.error(`✗ ${target}: unknown agent`);
          process.exitCode = 1;
          continue;
        }
        const result = await installHarness(target, launch);
        if (result.ok) console.log(`✓ ${result.label}: ${result.changed ? 'added to' : 'already in'} ${result.path}`);
        else {
          console.error(`✗ ${target}: ${result.reason}${result.path ? ` (${result.path})` : ''}`);
          process.exitCode = 1;
        }
      }
      console.log('\nRestart your agent so it picks up the new MCP server.');
      return;
    }
    case 'status': {
      const running = await findRunningServer(paths, port);
      if (!running) {
        console.log('OpenPaper is not running. Start it with `openpaper start`.');
        process.exitCode = 1;
        return;
      }
      const info = await readServerInfo(paths);
      console.log(`OpenPaper ${running.health.version} is running (pid ${running.health.pid})`);
      console.log(`Editor: http://127.0.0.1:${running.port}`);
      console.log(`MCP:    http://127.0.0.1:${running.port}${MCP_PATH}`);
      if (info) console.log(`Since:  ${info.startedAt}`);
      console.log(`Data:   ${paths.home}`);
      return;
    }
    case 'stop': {
      const running = await findRunningServer(paths, port);
      if (!running) return console.log('OpenPaper is not running.');
      await fetch(`http://127.0.0.1:${running.port}/api/shutdown`, { method: 'POST' }).catch(() => {});
      console.log('OpenPaper stopped.');
      return;
    }
    case 'doctor': {
      const browser = findBrowserExecutable();
      const running = await findRunningServer(paths, port);
      console.log(`OpenPaper ${VERSION}`);
      console.log(`Node:     ${process.version}`);
      console.log(`Data dir: ${paths.home}`);
      console.log(`Exports:  ${paths.exports}`);
      console.log(`Browser:  ${browser ?? 'not found — screenshots/exports need Chrome, Edge, Brave or Chromium (set OPENPAPER_BROWSER)'}`);
      console.log(`Server:   ${running ? `running on port ${running.port}` : 'not running'}`);
      console.log(`MCP:      ${JSON.stringify(mcpLaunch())}`);
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
