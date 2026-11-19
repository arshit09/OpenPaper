// Package an OpenPaper release: the Windows app (the payload zip the installer downloads, its manifest, and the
// installer) and the cross-platform CLI (a bundle, its manifest, and the install scripts in apps/cli).
//
//   node apps/desktop/scripts/package.mjs [--base-url <url>] [--manifest-url <url>] [--node <version>] [--skip-editor] [--cli-only]
//
// Writes apps/desktop/release/:
//   OpenPaper-<version>-windows-x64.zip   OpenPaper.exe, node\node.exe, server\ (bundled CLI, editor, production node_modules)
//   OpenPaper-windows-x64.json            { version, url, size, sha256, installedSize, setup } — what the installer
//                                         reads, and the app to find updates (`setup`: this Setup's url, size, sha256)
//   OpenPaper-Setup.exe                   the small installer, with --manifest-url baked in
//   OpenPaper-<version>-cli.tar.gz        server/ without native binaries, the same on every platform
//   OpenPaper-cli.json                    { version, url, size, sha256, node, speech-<target>-url/-sha256 } — what the
//                                         install scripts read; they add Node.js and the voice engine for the machine
//   install.sh, install.ps1, install.cmd  the CLI install scripts
//
// Publish them all as assets of a GitHub release tagged v<version>. The installers read their manifests through
// releases/latest/download/, and each manifest points at that release's files (--base-url; an empty one keeps the
// URLs relative to the manifest, for testing from a local folder). --cli-only skips the Windows app (no Rust needed).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createGzip } from 'node:zlib';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(desktop, '..', '..');
const require = createRequire(join(repo, 'packages', 'core', 'package.json'));
const { Zip, ZipDeflate, unzipSync } = require('fflate');

const REPO_URL = 'https://github.com/arshit09/OpenPaper';
/** Platforms the CLI install scripts support, as Node.js and sherpa-onnx name them. */
const CLI_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64', 'win-arm64'];
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

// 2. The CLI: the same server, minus the voice engine's native binaries, which the install scripts fetch per platform.
await packageCli(server);
if (flag('--cli-only')) process.exit(0);

// 3. Node.js runtime.
const nodeDir = join(stage, 'node');
await mkdir(nodeDir, { recursive: true });
const nodeZip = await nodeArchive(nodeVersion);
const prefix = `node-v${nodeVersion}-win-x64/`;
const files = unzipSync(nodeZip, { filter: (f) => f.name === `${prefix}node.exe` || f.name === `${prefix}LICENSE` });
await writeFile(join(nodeDir, 'node.exe'), files[`${prefix}node.exe`]);
await writeFile(join(nodeDir, 'LICENSE'), files[`${prefix}LICENSE`]);
log(`node: v${nodeVersion}`);

// 4. The app and the installer.
run('cargo', ['build', '--release'], desktop, { OPENPAPER_MANIFEST_URL: manifestUrl });
const built = join(process.env.CARGO_TARGET_DIR || join(desktop, 'target'), 'release');
await cp(join(built, 'openpaper.exe'), join(stage, 'OpenPaper.exe'));
await cp(join(built, 'openpaper-setup.exe'), join(out, 'OpenPaper-Setup.exe'));
await cp(join(repo, 'LICENSE'), join(stage, 'LICENSE.txt'));
await cp(join(repo, 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));

// 5. Zip and manifest.
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
  // The app downloads this Setup and runs it with --update to update itself.
  setup: { url: `${baseUrl}OpenPaper-Setup.exe`, size: setupSize, sha256: await hashFile(join(out, 'OpenPaper-Setup.exe')) },
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

/** The CLI bundle (`server/` from the stage, without native packages), its manifest, and the install scripts. */
async function packageCli(serverDir) {
  const cliName = `OpenPaper-${version}-cli.tar.gz`;
  const cliPath = join(out, cliName);
  // One platform's native package (sherpa-onnx-win-x64 and the like) stays out; sherpa-onnx-node, its JS side, stays in.
  const native = /^node_modules[\\/]sherpa-onnx-(?!node(?:[\\/]|$))[^\\/]+(?:[\\/]|$)/;
  const files = (await walk(serverDir)).filter((f) => !native.test(relative(serverDir, f)));
  await tarGz(serverDir, files, 'server', cliPath);
  const size = (await stat(cliPath)).size;

  // Node.js: the scripts download the version the Windows app bundles, from nodejs.org, checked against its SHASUMS.
  const sums = await (await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).text();
  for (const target of CLI_TARGETS) {
    const archives = target.startsWith('win-') ? ['zip'] : ['tar.gz', 'tar.xz'];
    for (const ext of archives) {
      if (!sums.includes(` node-v${nodeVersion}-${target}.${ext}\n`)) fail(`nodejs.org has no node-v${nodeVersion}-${target}.${ext}`);
    }
  }

  const manifest = { name: 'OpenPaper CLI', version, url: `${baseUrl}${cliName}`, size, sha256: await hashFile(cliPath), node: nodeVersion };

  // The voice engine: sherpa-onnx's package for each platform, at the version sherpa-onnx-node pins. The scripts fetch
  // it from npm and check it against the SHA-256 recorded here, after this checks it against npm's own integrity hash.
  const sherpa = JSON.parse(await readFile(join(serverDir, 'node_modules', 'sherpa-onnx-node', 'package.json'), 'utf8'));
  for (const target of CLI_TARGETS) {
    const name = `sherpa-onnx-${target}`;
    const wanted = sherpa.optionalDependencies?.[name];
    if (!wanted) fail(`sherpa-onnx-node ${sherpa.version} has no ${name}`);
    const res = await fetch(`https://registry.npmjs.org/${name}/${wanted}`);
    if (!res.ok) fail(`npm has no ${name}@${wanted}: ${res.status}`);
    const { dist } = await res.json();
    const file = join(cache, `${name}-${wanted}.tgz`);
    if (!existsSync(file) || !(await matchesIntegrity(file, dist.integrity))) {
      log(`downloading ${dist.tarball}`);
      const tgz = await fetch(dist.tarball);
      if (!tgz.ok) fail(`downloading ${name}@${wanted} failed: ${tgz.status}`);
      await writeFile(file, Buffer.from(await tgz.arrayBuffer()));
      if (!(await matchesIntegrity(file, dist.integrity))) fail(`${name}@${wanted} doesn't match npm's integrity hash`);
    }
    manifest[`speech-${target}-url`] = dist.tarball;
    manifest[`speech-${target}-sha256`] = await hashFile(file);
  }
  // Flat and one key per line: install.sh reads it with sed.
  await writeFile(join(out, 'OpenPaper-cli.json'), JSON.stringify(manifest, null, 2) + '\n');

  // The install scripts, with the line endings each shell needs, whatever git checked out.
  for (const [name, eol] of [
    ['install.sh', '\n'],
    ['install.ps1', '\r\n'],
    ['install.cmd', '\r\n'],
  ]) {
    const text = (await readFile(join(repo, 'apps', 'cli', name), 'utf8')).replace(/\r\n/g, '\n');
    await writeFile(join(out, name), eol === '\n' ? text : text.replace(/\n/g, '\r\n'));
  }

  log(`release/${cliName}  ${mb(size)} (${files.length} files) → ${manifest.url}`);
  log(`release/OpenPaper-cli.json  Node.js ${nodeVersion}, voice engine for ${CLI_TARGETS.length} platforms`);
  log('release/install.sh, install.ps1, install.cmd');
}

async function matchesIntegrity(file, integrity) {
  const [algorithm, expected] = integrity.split('-');
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) =>
    createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject),
  );
  return hash.digest('base64') === expected;
}

/** Stream files under `root` into a gzipped tar inside a `prefix/` folder: folders 0755, files 0644. */
async function tarGz(root, files, prefix, to) {
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(to);
  const done = new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
    gzip.on('error', reject);
  });
  gzip.pipe(output);
  const write = (chunk) => (gzip.write(chunk) ? Promise.resolve() : new Promise((resolve) => gzip.once('drain', resolve)));
  const mtime = Math.floor(Date.now() / 1000);
  const folders = new Set();
  const addFolder = async (folder) => {
    if (folders.has(folder)) return;
    if (folder.includes('/')) await addFolder(folder.slice(0, folder.lastIndexOf('/')));
    folders.add(folder);
    await write(tarHeader(`${folder}/`, 0, 0o755, '5', mtime));
  };
  for (const file of files) {
    const name = `${prefix}/${relative(root, file).split(sep).join('/')}`;
    await addFolder(name.slice(0, name.lastIndexOf('/')));
    const data = await readFile(file);
    await write(tarHeader(name, data.length, 0o644, '0', mtime));
    await write(data);
    if (data.length % 512) await write(Buffer.alloc(512 - (data.length % 512)));
  }
  await write(Buffer.alloc(1024));
  gzip.end();
  await done;
}

/** A POSIX ustar header. Paths over 100 bytes are split at a slash into prefix (up to 155) and name. */
function tarHeader(path, size, mode, type, mtime) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    let cut = path.indexOf('/');
    while (cut !== -1 && Buffer.byteLength(path.slice(cut + 1)) > 100) cut = path.indexOf('/', cut + 1);
    if (cut === -1 || cut === path.length - 1 || Buffer.byteLength(path.slice(0, cut)) > 155) {
      fail(`${path} is too long for a tar header`);
    }
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';
  header.write(name, 0, 100);
  header.write(octal(mode, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(size, 12), 124);
  header.write(octal(mtime, 12), 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
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
