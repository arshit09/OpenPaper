import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source of a runtime script served to static renders (`shader-runtime` mounts shader layers,
 * `lottie-runtime` draws Lottie layers). The production build ships it as dist/<name>.js next to
 * cli.js; in development it is bundled from source on first use.
 */
export function createRuntimeLoader(name: 'shader-runtime' | 'lottie-runtime'): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    cached ??= load(name).catch((error) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

/** The shader runtime (SHADER_RUNTIME_PATH). */
export function createShaderRuntimeLoader(): () => Promise<string> {
  return createRuntimeLoader('shader-runtime');
}

async function load(name: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return await readFile(join(here, `${name}.js`), 'utf8');
  } catch {
    // Development (tsx): bundle src/render/<name>.ts.
  }
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [join(here, `${name}.ts`)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

