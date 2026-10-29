// Package OpenPaper for Windows (x64): the payload zip the installer downloads, its manifest, and the installer.
//
//   node apps/desktop/scripts/package.mjs [--base-url <url>] [--manifest-url <url>] [--node <version>] [--skip-editor]
//
// Writes apps/desktop/release/:
//   OpenPaper-<version>-windows-x64.zip   OpenPaper.exe, node\node.exe, server\ (bundled CLI, editor, production node_modules)
//   OpenPaper-windows-x64.json            { version, url, size, sha256, installedSize } — what the installer reads
//   OpenPaper-Setup.exe                   the small installer, with --manifest-url baked in
//
// Publish all three as assets of a GitHub release tagged v<version>. The installer reads the manifest through
// releases/latest/download/, and the manifest points at that release's zip (--base-url; an empty one keeps the
// zip URL relative to the manifest, for testing from a local folder).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..', '..');
const require = createRequire(join(repo, 'packages', 'core', 'package.json'));
const { Zip, ZipDeflate, unzipSync } = require('fflate');

const REPO_URL = 'https://github.com/arshit09/OpenPaper';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};

const serverPkg = JSON.parse(await readFile(join(repo, 'packages', 'server', 'package.json'), 'utf8'));
const version = serverPkg.version;
const cargoVersion = (await readFile(join(desktop, 'Cargo.toml'), 'utf8')).match(/^version = "([^"]+)"/m)?.[1];
if (cargoVersion !== version) {
  fail(`apps/desktop/Cargo.toml is at ${cargoVersion} but packages/server is at ${version}; make them match.`);
}
const nodeVersion = option('--node', process.version).replace(/^v/, '');
const baseUrl = option('--base-url', `${REPO_URL}/releases/download/v${version}/`);
const manifestUrl = option('--manifest-url', `${REPO_URL}/releases/latest/download/OpenPaper-windows-x64.json`);

const out = join(desktop, 'release');
const cache = join(out, 'cache');
const stage = join(out, 'stage', 'OpenPaper');
const zipName = `OpenPaper-${version}-windows-x64.zip`;

await rm(join(out, 'stage'), { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(cache, { recursive: true });

// 1. Editor and server. The server builds straight into the stage, never into packages/server/dist.
if (!flag('--skip-editor')) run('npm', ['run', 'build', '--workspace', '@openpaper/editor'], repo);
const server = join(stage, 'server');
run('node', [join(repo, 'packages', 'server', 'scripts', 'build.mjs'), '--outdir', server], repo);
const runtimeDeps = { ...serverPkg.dependencies, ...serverPkg.optionalDependencies };
delete runtimeDeps['@openpaper/core']; // bundled into cli.js
await writeFile(
  join(server, 'package.json'),
  JSON.stringify({ name: 'openpaper-server', version, private: true, type: 'module', license: 'MIT' }, null, 2) + '\n',
);
await copyProductionModules(Object.keys(runtimeDeps), join(server, 'node_modules'));
const pruned = await prune(server);
log(`server: pruned ${mb(pruned)} of maps, type declarations, sources and docs`);

// 2. Node.js runtime.
const nodeDir = join(stage, 'node');
await mkdir(nodeDir, { recursive: true });
const nodeZip = await nodeArchive(nodeVersion);
const prefix = `node-v${nodeVersion}-win-x64/`;
const files = unzipSync(nodeZip, { filter: (f) => f.name === `${prefix}node.exe` || f.name === `${prefix}LICENSE` });
await writeFile(join(nodeDir, 'node.exe'), files[`${prefix}node.exe`]);
await writeFile(join(nodeDir, 'LICENSE'), files[`${prefix}LICENSE`]);
log(`node: v${nodeVersion}`);

// 3. The app and the installer.
run('cargo', ['build', '--release'], desktop, { OPENPAPER_MANIFEST_URL: manifestUrl });
await cp(join(desktop, 'target', 'release', 'openpaper.exe'), join(stage, 'OpenPaper.exe'));
await cp(join(desktop, 'target', 'release', 'openpaper-setup.exe'), join(out, 'OpenPaper-Setup.exe'));
await cp(join(repo, 'LICENSE'), join(stage, 'LICENSE.txt'));
await cp(join(repo, 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));

// 4. Zip and manifest.
const entries = await walk(stage);
const installedSize = (await Promise.all(entries.map((f) => stat(f).then((s) => s.size)))).reduce((a, b) => a + b, 0);
const zipPath = join(out, zipName);
await zipFolder(stage, entries, zipPath);
const zipSize = (await stat(zipPath)).size;
const sha256 = await hashFile(zipPath);
const setupSize = (await stat(join(out, 'OpenPaper-Setup.exe'))).size;
const manifest = {
  name: 'OpenPaper',
  version,
  url: `${baseUrl}${zipName}`,
  size: zipSize,
  sha256,
  installedSize: installedSize + setupSize,
};
await writeFile(join(out, 'OpenPaper-windows-x64.json'), JSON.stringify(manifest, null, 2) + '\n');

log('');
log(`release/${zipName}  ${mb(zipSize)} (${mb(installedSize)} installed)`);
log(`release/OpenPaper-windows-x64.json  → ${manifest.url}`);
log(`release/OpenPaper-Setup.exe  ${mb(setupSize)}, reads ${manifestUrl}`);

// ---------------------------------------------------------------------------

function run(command, argv, cwd, env = {}) {
  log(`> ${command} ${argv.join(' ')}`);
  // npm is a .cmd script on Windows, which only runs through a shell.
  const shell = command === 'npm' && process.platform === 'win32';
  execFileSync(command, argv, { cwd, stdio: 'inherit', shell, env: { ...process.env, ...env } });
}

function log(line) {
  console.log(line);
}

function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Find an installed package the way Node does: in node_modules of `from`, then of each parent folder. */
function locate(name, from) {
  for (let dir = from; dir !== dirname(repo) && dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * Copy the server's production dependency tree out of the repo's node_modules (the versions package-lock.json
 * pinned) into `target`, keeping each package at the same place in the tree so nested versions resolve as they
 * do here. Optional dependencies are taken when installed (sherpa-onnx's win-x64 binaries).
 */
async function copyProductionModules(names, target) {
  const serverDir = join(repo, 'packages', 'server');
  const placed = new Map(); // source folder → folder in the stage
  const queue = names.map((name) => ({ name, from: serverDir, optional: name in (serverPkg.optionalDependencies ?? {}) }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const source = locate(name, from);
    if (!source) {
      if (optional) continue;
      fail(`dependency ${name} is not installed (needed from ${relative(repo, from)}). Run npm ci first.`);
    }
    if (placed.has(source)) continue;
    // repo/node_modules/... and packages/server/node_modules/... both land in the stage's server/node_modules/...
    const rel = relative(source.startsWith(serverDir + sep) ? serverDir : repo, source);
    if (!rel.startsWith('node_modules' + sep)) fail(`unexpected location for ${name}: ${relative(repo, source)}`);
    const destination = join(dirname(target), rel);
    if ([...placed.values()].includes(destination)) fail(`two packages would land in ${relative(repo, destination)}`);
    placed.set(source, destination);
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: source, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: source, optional: true });
  }
  for (const [source, destination] of placed) {
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      // Nested node_modules are copied package by package, and only the ones in use.
      filter: (src) => !relative(source, src).split(sep).includes('node_modules'),
    });
  }
  log(`server: ${placed.size} production packages`);
}

/** Drop what Node never loads at run time. Returns bytes removed. */
async function prune(dir) {
  let removed = 0;
  const junkDirs = new Set(['test', 'tests', '__tests__', '.github', 'example', 'examples', 'docs']);
  const junkFile = /\.(map|d\.ts|d\.mts|d\.cts|ts|mts|cts|md|markdown)$|^(tsconfig.*\.json|\.npmignore|\.eslintrc.*|\.prettierrc.*)$/i;
  const keep = /^(license|licence|notice|copying)/i;
  async function visit(folder, inModules) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (inModules && junkDirs.has(entry.name)) {
          removed += await size(path);
          await rm(path, { recursive: true, force: true });
        } else {
          await visit(path, inModules || entry.name === 'node_modules');
        }
      } else if (junkFile.test(entry.name) && !keep.test(entry.name) && (inModules || entry.name.endsWith('.map'))) {
        removed += (await stat(path)).size;
        await rm(path, { force: true });
      }
    }
  }
  await visit(dir, false);
  return removed;
}

async function size(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await size(join(path, entry));
  return total;
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

/** The official Windows build of Node, checked against nodejs.org's SHASUMS256.txt and cached. */
async function nodeArchive(version) {
  const name = `node-v${version}-win-x64.zip`;
  const path = join(cache, name);
  const base = `https://nodejs.org/dist/v${version}/`;
  const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.trim().endsWith(` ${name}`))?.split(/\s+/)[0];
  if (!expected) fail(`nodejs.org has no ${name}`);
  if (!existsSync(path) || (await hashFile(path)) !== expected) {
    log(`downloading ${base}${name}`);
    const res = await fetch(`${base}${name}`);
    if (!res.ok) fail(`downloading ${name} failed: ${res.status}`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    if ((await hashFile(path)) !== expected) fail(`${name} doesn't match its published checksum`);
  }
  return new Uint8Array(await readFile(path));
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Stream a folder into a zip (deflate), one file at a time, so memory stays flat. */
async function zipFolder(root, files, to) {
  const output = createWriteStream(to);
  const done = new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) throw error;
    output.write(chunk);
    if (final) output.end();
  });
  for (const file of files) {
    const entry = new ZipDeflate(relative(root, file).split(sep).join('/'), { level: 9 });
    zip.add(entry);
    await new Promise((resolve, reject) => {
      createReadStream(file, { highWaterMark: 1 << 20 })
        .on('data', (chunk) => entry.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)))
        .on('end', () => {
          entry.push(new Uint8Array(0), true);
          resolve();
        })
        .on('error', reject);
    });
  }
  zip.end();
  await done;
}
