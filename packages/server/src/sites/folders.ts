import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

/**
 * Project folders for live sites: the OS folder picker, a quick look at what a folder holds,
 * and a best-effort guess at which folder a running dev server was started from.
 */

export interface FolderInfo {
  /** Absolute, normalized path. */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** package.json `name`, else the folder name. */
  name: string;
  /** e.g. "next", "vite", "astro" (from package.json dependencies or well-known files). */
  framework?: string;
  /** The folder is inside a git work tree. */
  hasGit: boolean;
}

const PICK_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a program to completion (or until the timeout kills it). Rejects only if it can't start (e.g. ENOENT). */
function run(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** PowerShell with a script passed as -EncodedCommand (no quoting issues). pwsh 7 first unless `legacyFirst`. */
async function powershell(script: string, timeoutMs: number, env?: NodeJS.ProcessEnv, legacyFirst = false): Promise<RunResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  const shells = legacyFirst ? ['powershell.exe', 'pwsh.exe'] : ['pwsh.exe', 'powershell.exe'];
  for (const shell of shells) {
    try {
      return await run(shell, args, timeoutMs, env);
    } catch (error) {
      if (!isMissing(error) || shell === shells[shells.length - 1]) throw error;
    }
  }
  throw new Error('PowerShell not found');
}

const fromBase64 = (text: string) => Buffer.from(text.trim(), 'base64').toString('utf8');

// --- Folder picker ---------------------------------------------------------

// A hidden TopMost owner keeps the dialog in front of the browser even though the server isn't the
// foreground app. pwsh 7 (.NET) shows the modern Explorer-style dialog; Windows PowerShell the old tree.
const WINDOWS_PICKER = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:OPENPAPER_PICK_TITLE
$dialog.ShowNewFolderButton = $true
if ($dialog | Get-Member -Name UseDescriptionForTitle) { $dialog.UseDescriptionForTitle = $true }
$initial = $env:OPENPAPER_PICK_INITIAL
if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
  if ($dialog | Get-Member -Name InitialDirectory) { $dialog.InitialDirectory = $initial } else { $dialog.SelectedPath = $initial }
}
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))
}
`;

let picking: Promise<string | null> | null = null;

/**
 * Open the OS folder dialog. Resolves the chosen absolute path, or null if the user cancelled.
 * Only one dialog at a time: a second call while one is open gets the same result.
 * Throws when no dialog is available (e.g. Linux without zenity/kdialog), so the UI can ask for a typed path.
 */
export function pickFolder(options: { title?: string; initial?: string } = {}): Promise<string | null> {
  picking ??= openPicker(options.title ?? 'Choose your project folder', options.initial).finally(() => (picking = null));
  return picking;
}

async function openPicker(title: string, initial: string | undefined): Promise<string | null> {
  const start = initial && isAbsolute(initial) ? initial : undefined;
  if (process.platform === 'win32') {
    const out = await powershell(WINDOWS_PICKER, PICK_TIMEOUT_MS, { OPENPAPER_PICK_TITLE: title, OPENPAPER_PICK_INITIAL: start ?? '' });
    if (out.stdout.trim()) return resolve(fromBase64(out.stdout));
    if (out.code !== 0) throw new Error(`The folder dialog failed: ${out.stderr.trim().split('\n')[0] || `exit ${out.code}`}`);
    return null;
  }
  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      'try',
      'if (count of argv) > 1 then',
      'return POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))',
      'end if',
      'return POSIX path of (choose folder with prompt (item 1 of argv))',
      'on error number -128',
      'return ""',
      'end try',
      'end run',
    ];
    const out = await run('osascript', [...script.flatMap((line) => ['-e', line]), title, ...(start ? [start] : [])], PICK_TIMEOUT_MS);
    const path = out.stdout.trim();
    if (path) return path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (out.code !== 0) throw new Error(`The folder dialog failed: ${out.stderr.trim() || `exit ${out.code}`}`);
    return null;
  }
  const dialogs: Array<[string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start.replace(/\/?$/, '/')}`] : [])]],
    ['kdialog', ['--getexistingdirectory', start ?? homedir(), '--title', title]],
  ];
  for (const [program, args] of dialogs) {
    let out: RunResult;
    try {
      out = await run(program, args, PICK_TIMEOUT_MS);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const path = out.stdout.trim();
    return out.code === 0 && path ? path : null;
  }
  throw new Error('No folder dialog is available (install zenity or kdialog). Type the folder path instead.');
}

// --- Folder info -----------------------------------------------------------

/** Normalize a path the user typed or pasted: strips quotes, expands `~`, resolves to absolute. */
export function normalizeFolderPath(input: string): string {
  let path = input.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(1));
  path = resolve(path);
  const root = parse(path).root;
  return path.length > root.length ? path.replace(/[\\/]+$/, '') : path;
}

interface PackageJson {
  name?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const text = (await readFile(join(dir, 'package.json'), 'utf8')).replace(/^﻿/, '');
    const pkg = JSON.parse(text) as PackageJson;
    return pkg && typeof pkg === 'object' ? pkg : null;
  } catch {
    return null;
  }
}

/** Most specific first: meta-frameworks before the bundler or UI library they build on. */
const FRAMEWORK_DEPS: Array<[string, string]> = [
  ['next', 'next'],
  ['nuxt', 'nuxt'],
  ['@sveltejs/kit', 'sveltekit'],
  ['astro', 'astro'],
  ['@remix-run/dev', 'remix'],
  ['@react-router/dev', 'react-router'],
  ['gatsby', 'gatsby'],
  ['@solidjs/start', 'solid-start'],
  ['@builder.io/qwik-city', 'qwik'],
  ['@docusaurus/core', 'docusaurus'],
  ['vitepress', 'vitepress'],
  ['@angular/core', 'angular'],
  ['react-scripts', 'create-react-app'],
  ['@11ty/eleventy', 'eleventy'],
  ['vite', 'vite'],
  ['parcel', 'parcel'],
  ['webpack', 'webpack'],
];

/** Non-JS projects, by a file only they have. */
const FRAMEWORK_FILES: Array<[string, string]> = [
  ['manage.py', 'django'],
  ['artisan', 'laravel'],
  ['config/routes.rb', 'rails'],
  ['hugo.toml', 'hugo'],
  ['hugo.yaml', 'hugo'],
  ['_config.yml', 'jekyll'],
];

function frameworkOf(dir: string, pkg: PackageJson | null): string | undefined {
  if (pkg) {
    const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    for (const [dep, name] of FRAMEWORK_DEPS) if (dep in deps) return name;
  }
  for (const [file, name] of FRAMEWORK_FILES) if (existsSync(join(dir, file))) return name;
  return undefined;
}

function insideGitRepo(dir: string): boolean {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true;
    if (dirname(current) === current) return false;
  }
}

export async function inspectFolder(input: string): Promise<FolderInfo> {
  const path = normalizeFolderPath(input);
  const info = await stat(path).catch(() => null);
  const isDirectory = !!info?.isDirectory();
  const pkg = isDirectory ? await readPackageJson(path) : null;
  const pkgName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const result: FolderInfo = {
    path,
    exists: !!info,
    isDirectory,
    name: pkgName || basename(path) || path,
    hasGit: isDirectory && insideGitRepo(path),
  };
  const framework = isDirectory ? frameworkOf(path, pkg) : undefined;
  if (framework) result.framework = framework;
  return result;
}

// --- Which folder is this dev server running from? -------------------------

/** A process in the listener's ancestry (nearest first). */
interface ProcessInfo {
  commandLine?: string;
  cwd?: string;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '::' || /^127\./.test(host);
}

/**
 * Best effort: find the process listening on a localhost URL's port and derive its project folder
 * (the path before `node_modules` in its command line, or its working directory). Null when unsure.
 */
export async function detectFolderForUrl(input: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input.trim()) ? input.trim() : `http://${input.trim()}`);
  } catch {
    return null;
  }
  if (!isLoopbackHost(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  try {
    const chain =
      process.platform === 'win32' ? await windowsListener(port) : process.platform === 'linux' ? await linuxListener(port) : await lsofListener(port);
    for (const proc of chain) {
      const root = await projectRoot(proc);
      if (root) return root;
    }
  } catch {
    // Unsure: let the user pick.
  }
  return null;
}

const WINDOWS_LISTENER = `
$ErrorActionPreference = 'SilentlyContinue'
$conn = Get-NetTCPConnection -LocalPort ([int]$env:OPENPAPER_PORT) -State Listen | Select-Object -First 1
if (-not $conn) { exit 0 }
$procId = [int]$conn.OwningProcess
$chain = @()
for ($i = 0; $i -lt 5 -and $procId -gt 4; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId"
  if (-not $p) { break }
  $chain += [pscustomobject]@{ commandLine = $p.CommandLine; executable = $p.ExecutablePath }
  $procId = [int]$p.ParentProcessId
}
$json = ConvertTo-Json -InputObject @($chain) -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
`;

async function windowsListener(port: number): Promise<ProcessInfo[]> {
  // Windows PowerShell starts faster and always has the NetTCPIP module.
  const out = await powershell(WINDOWS_LISTENER, PROBE_TIMEOUT_MS, { OPENPAPER_PORT: String(port) }, true);
  if (!out.stdout.trim()) return [];
  const list = JSON.parse(fromBase64(out.stdout)) as Array<{ commandLine?: string | null }>;
  return (Array.isArray(list) ? list : [list]).map((p) => ({ commandLine: p.commandLine ?? undefined }));
}

async function linuxListener(port: number): Promise<ProcessInfo[]> {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const inodes = new Set<string>();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '');
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols: sl, local_address, rem_address, st (0A = LISTEN), ..., inode (index 9)
      if (cols.length > 9 && cols[3] === '0A' && cols[1]!.endsWith(hex)) inodes.add(cols[9]!);
    }
  }
  if (!inodes.size) return lsofListener(port);
  const deadline = Date.now() + 5_000;
  let pid: number | null = null;
  outer: for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    if (Date.now() > deadline) break;
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const link = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => '');
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (inode && inodes.has(inode)) {
        pid = Number(entry);
        break outer;
      }
    }
  }
  const chain: ProcessInfo[] = [];
  for (let i = 0; pid && pid > 1 && i < 5; i++) {
    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
    chain.push({ commandLine: cmd.split('\0').filter(Boolean).map(quoteArg).join(' '), cwd });
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    pid = Number(statLine.slice(statLine.lastIndexOf(')') + 2).split(' ')[1]) || null;
  }
  return chain;
}

async function lsofListener(port: number): Promise<ProcessInfo[]> {
  const listing = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], PROBE_TIMEOUT_MS);
  let pid: number | null = Number(listing.stdout.trim().split('\n')[0]) || null;
  const chain: ProcessInfo[] = [];
  for (let i = 0; pid && pid > 1 && i < 5; i++) {
    const cwdOut = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], PROBE_TIMEOUT_MS);
    const cwd = cwdOut.stdout.split('\n').find((l) => l.startsWith('n'))?.slice(1);
    const ps = await run('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], PROBE_TIMEOUT_MS);
    const match = /^\s*(\d+)\s+(.*)$/.exec(ps.stdout.trim());
    chain.push({ commandLine: match?.[2], cwd });
    pid = Number(match?.[1]) || null;
  }
  return chain;
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** Split a command line into arguments (double quotes group; enough for paths). */
function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) args.push(m[1] ?? m[2]!);
  return args;
}

/** Install locations of global tools (npx cache, global npm, version managers): never a project. */
const GLOBAL_DIR = /npm-cache|[\\/]_npx[\\/]|[\\/]npm[\\/]node_modules|AppData[\\/]Roaming[\\/]npm|Program Files|[\\/]nodejs([\\/]|$)|[\\/]\.nvm[\\/]|[\\/]\.volta[\\/]|[\\/]\.fnm[\\/]|fnm_multishells|[\\/]\.bun[\\/]|[\\/]pnpm[\\/]global|[\\/]\.pnpm-store|^\/usr\/|^\/opt\/|[\\/]scoop[\\/]/i;

async function isProjectDir(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory() || GLOBAL_DIR.test(dir)) return false;
  const normalized = resolve(dir);
  return normalized !== resolve(homedir()) && normalized !== parse(normalized).root;
}

async function projectRoot(proc: ProcessInfo): Promise<string | null> {
  // The working directory is exact when we have it (npm/pnpm run scripts from the package folder).
  if (proc.cwd && existsSync(join(proc.cwd, 'package.json')) && (await isProjectDir(proc.cwd))) return resolve(proc.cwd);
  for (const arg of splitCommandLine(proc.commandLine ?? '')) {
    const at = arg.search(/[\\/]node_modules[\\/]/i);
    if (at <= 0) continue;
    const dir = arg.slice(0, at);
    if (isAbsolute(dir) && (await isProjectDir(dir))) return resolve(dir);
  }
  if (proc.cwd && (await isProjectDir(proc.cwd))) return resolve(proc.cwd);
  return null;
}
