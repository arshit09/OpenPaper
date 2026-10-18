import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source of the shader runtime script served to static renders. The production build ships it as
 * dist/shader-runtime.js next to cli.js; in development it is bundled from source on first use.
 */
export function createShaderRuntimeLoader(): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    cached ??= load().catch((error) => {
      cached = null;
      throw error;
    });
    return cached;
  };
}

async function load(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    return await readFile(join(here, 'shader-runtime.js'), 'utf8');
  } catch {
    // Development (tsx): bundle src/render/shader-runtime.ts.
  }
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [join(here, 'shader-runtime.ts')],
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

