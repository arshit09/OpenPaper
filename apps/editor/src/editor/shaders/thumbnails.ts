import { createElement, useEffect, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { SHADER_LIBRARY_VERSION, shaderPresetProps, shaderRenderProps, type ShaderDef } from '@openpaper/core';
import { SHADER_GL_ATTRS } from './ShaderLayer.tsx';
import { loadShaderLibrary } from './library.ts';

/**
 * Picker previews, rendered once in the browser from each effect's default preset (one WebGL
 * context at a time) and cached in localStorage.
 */
const W = 176;
const H = 132;
const STORAGE_KEY = `op-shader-thumbs:${SHADER_LIBRARY_VERSION}:1`;

const cache = new Map<string, string>();
const listeners = new Set<() => void>();
const queue: ShaderDef[] = [];
const queued = new Set<string>();
let running = false;

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, string>;
  for (const [k, v] of Object.entries(saved)) cache.set(k, v);
} catch {
  // Storage unavailable: previews are regenerated per session.
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Quota or privacy mode: keep the in-memory cache.
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function renderThumbnail(def: ShaderDef): Promise<string | null> {
  const Comp = (await loadShaderLibrary())[def.name];
  if (!Comp) return null;
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${W}px;height:${H}px;pointer-events:none;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const { props, background } = shaderPresetProps(def);
    const renderProps = shaderRenderProps(def, { ...props, frame: def.animated ? 2600 : 0 });
    root.render(
      createElement(Comp, {
        ...renderProps,
        speed: 0,
        minPixelRatio: 2,
        style: { position: 'absolute', inset: 0 },
        webGlContextAttributes: SHADER_GL_ATTRS,
      })
    );
    const deadline = performance.now() + 5000;
    let mount: Element | null = null;
    while (performance.now() < deadline) {
      mount = host.querySelector('[data-paper-shader]');
      if (mount && 'paperShaderMount' in mount) break;
      await nextFrame();
    }
    // Logo effects process their image asynchronously after mounting.
    if (def.category === 'logo') await new Promise((r) => setTimeout(r, 700));
    await nextFrame();
    await nextFrame();
    const canvas = host.querySelector('canvas');
    if (!canvas || !canvas.width) return null;
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = background ?? '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    return out.toDataURL('image/webp', 0.85);
  } catch {
    return null;
  } finally {
    const canvas = host.querySelector('canvas');
    root.unmount();
    host.remove();
    // Free the context now: the browser caps live WebGL contexts and, once over, drops the oldest —
    // the shader layers on the canvas. Garbage collection would get to these much later.
    canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const def = queue.shift()!;
    const url = await renderThumbnail(def);
    if (url) {
      cache.set(def.name, url);
      persist();
      for (const l of listeners) l();
    }
  }
  running = false;
}

function request(def: ShaderDef) {
  if (cache.has(def.name) || queued.has(def.name)) return;
  queued.add(def.name);
  queue.push(def);
  void pump();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShaderThumbnail(def: ShaderDef): string | undefined {
  const url = useSyncExternalStore(subscribe, () => cache.get(def.name));
  useEffect(() => request(def), [def]);
  return url;
}
