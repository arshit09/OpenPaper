// Bundle the OpenPaper server + CLI (with @openpaper/core inlined) and ship the built editor next to it.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(dist, 'cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // npm dependencies of this package stay external; workspace code (core) and its
  // small pure-JS dependencies are bundled in.
  external: [...Object.keys(pkg.dependencies).filter((d) => d !== '@openpaper/core'), 'esbuild'],
  // (src/cli.ts carries the #!/usr/bin/env node line; esbuild keeps it first.)
  banner: {
    js: "import { createRequire as __opCreateRequire } from 'node:module'; const require = __opCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Browser runtime that mounts shader layers in headless render documents.
await build({
  entryPoints: [join(root, 'src/render/shader-runtime.ts')],
  outfile: join(dist, 'shader-runtime.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

const editorDist = join(root, '../../apps/editor/dist');
try {
  await stat(join(editorDist, 'index.html'));
  await cp(editorDist, join(dist, 'editor'), { recursive: true });
  console.log('Copied editor build → dist/editor');
} catch {
  console.warn('Editor build not found (run `npm run build --workspace @openpaper/editor` first).');
}
