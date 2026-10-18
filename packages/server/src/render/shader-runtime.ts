/**
 * Browser script for static renders (headless screenshots, exports): mounts every shader layer
 * (`[data-op-shader]`) with @paper-design/shaders-react at its stored frame, then sets
 * `window.__opShadersReady`. Bundled to an IIFE and served at SHADER_RUNTIME_PATH.
 */
import { createElement, Suspense, useLayoutEffect, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import * as Shaders from '@paper-design/shaders-react';

interface ShaderWindow {
  __opShadersReady?: boolean;
  __opShaderErrors?: string[];
  __opFreezeShaders?: () => void;
}
const w = window as unknown as ShaderWindow;
const errors: string[] = (w.__opShaderErrors = []);
const HOST_STYLE = { position: 'absolute', inset: 0, borderRadius: 'inherit' } as const;
const LOGO_EFFECTS = new Set(['Heatmap', 'LiquidMetal', 'GemSmoke']);
const TIMEOUT_MS = 10_000;

window.addEventListener('unhandledrejection', (e) => errors.push(String((e as PromiseRejectionEvent).reason)));
window.addEventListener('error', (e) => errors.push(String((e as ErrorEvent).message)));

function Mounted({ onMount, children }: { onMount: () => void; children?: unknown }) {
  useLayoutEffect(onMount, []);
  return children as never;
}

const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function mountAll() {
  const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-op-shader]'));
  const committed: Promise<void>[] = [];
  for (const el of hosts) {
    const name = el.dataset.opShader ?? '';
    const Comp = (Shaders as unknown as Record<string, ComponentType<Record<string, unknown>>>)[name];
    if (!Comp) {
      errors.push(`Unknown shader ${name}`);
      continue;
    }
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(el.dataset.opShaderProps ?? '{}');
    } catch {
      errors.push(`Bad props for ${name}`);
    }
    const extra = LOGO_EFFECTS.has(name) ? { suspendWhenProcessingImage: true } : {};
    committed.push(
      new Promise<void>((resolve) => {
        createRoot(el).render(
          createElement(
            Suspense,
            { fallback: null },
            createElement(
              Mounted,
              { onMount: resolve },
              createElement(Comp, {
                ...props,
                ...extra,
                speed: 0,
                style: HOST_STYLE,
                webGlContextAttributes: { preserveDrawingBuffer: true },
              })
            )
          )
        );
      })
    );
  }
  const deadline = Date.now() + TIMEOUT_MS;
  await Promise.race([Promise.all(committed), new Promise((r) => setTimeout(r, TIMEOUT_MS))]);
  // The WebGL mount is created asynchronously (after image uniforms load).
  const mounted = () => hosts.every((el) => !el.firstElementChild || 'paperShaderMount' in el.firstElementChild);
  while (!mounted() && Date.now() < deadline && errors.length === 0) await frames();
  await frames();
}

/** Replace each shader canvas with a PNG <img> (PDF printing does not keep WebGL canvases reliably). */
w.__opFreezeShaders = () => {
  for (const canvas of Array.from(document.querySelectorAll<HTMLCanvasElement>('[data-op-shader] canvas'))) {
    try {
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.style.cssText = canvas.style.cssText || 'position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;z-index:-1';
      canvas.replaceWith(img);
    } catch (error) {
      errors.push(String(error));
    }
  }
};

void mountAll().finally(() => {
  w.__opShadersReady = true;
});
