import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { SHADER_HOST_STYLE, shaderDef, shaderRenderProps, type NodeRecord, type ShaderProps, type TokenRecord } from '@openpaper/core';
import { useEditor } from '../../state/store.ts';
import { renderContext } from '../canvas/render-context.ts';
import { registerLayer } from '../canvas/geometry.ts';
import { useShaderLibrary } from './library.ts';

/** Canvas pixels must stay readable for screenshots, exports and colour picking. */
export const SHADER_GL_ATTRS = { preserveDrawingBuffer: true };

/** Fewest pixels a zoomed-out shader still renders. */
const MIN_PIXELS = 128 * 128;
/** Remounts after a lost WebGL context, per layer. */
const MAX_REMOUNTS = 2;

// While held (a capture in the editor), shaders render at full resolution whatever the zoom.
let fullResolution = 0;
const fullResolutionListeners = new Set<() => void>();
const subscribeFullResolution = (l: () => void) => {
  fullResolutionListeners.add(l);
  return () => fullResolutionListeners.delete(l);
};
const setFullResolution = (delta: number) => {
  fullResolution += delta;
  for (const l of fullResolutionListeners) l();
};

/** Render shader layers at full resolution until the returned release is called. */
export function holdFullShaderResolution(): () => void {
  setFullResolution(1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setFullResolution(-1);
  };
}

/** Zoom rounded up to a power of two (1 at 100% and above), so zooming crosses few steps. */
const zoomStep = (zoom: number | undefined) => (!zoom || zoom >= 1 ? 1 : Math.max(1 / 64, 2 ** Math.ceil(Math.log2(zoom))));

/**
 * The library sizes its canvas from the layer's layout box, which ignores the canvas zoom: a
 * zoomed-out shader would still shade every pixel of its full size each frame. This is the zoom
 * step it should render for, settled for a moment so a zoom gesture doesn't resize it each frame.
 */
function useRenderZoom(): number {
  const step = useEditor((s) => zoomStep(s.pageId ? s.cameras[s.pageId]?.zoom : undefined));
  const full = useSyncExternalStore(subscribeFullResolution, () => fullResolution > 0);
  const [settled, setSettled] = useState(step);
  useEffect(() => {
    if (step === settled) return;
    const timer = setTimeout(() => setSettled(step), 150);
    return () => clearTimeout(timer);
  }, [step, settled]);
  return full ? 1 : settled;
}

const ShaderCanvas = memo(function ShaderCanvas({
  component,
  props,
  tokens,
  maxPixelCount,
  paused,
}: {
  component: string;
  props: ShaderProps | undefined;
  tokens: readonly TokenRecord[] | undefined;
  maxPixelCount: number | undefined;
  /** Animations paused (Alt+P): the effect holds its frame. */
  paused: boolean;
}) {
  const def = shaderDef(component);
  const library = useShaderLibrary();
  // A lost WebGL context (the browser caps how many live at once) leaves the canvas blank: remount,
  // a couple of times at most — with more shader layers than the cap, remounts would evict each other.
  const [generation, setGeneration] = useState(0);
  const host = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const lost = (e: Event) => {
      if ((e.target as Element).tagName === 'CANVAS') setGeneration((g) => (g < MAX_REMOUNTS ? g + 1 : g));
    };
    el.addEventListener('webglcontextlost', lost, true);
    return () => el.removeEventListener('webglcontextlost', lost, true);
  }, [library, generation]);
  const renderProps = useMemo(() => {
    if (!def) return null;
    const out = shaderRenderProps(def, props, { tokens: tokens ?? [], resolveUrl: renderContext.resolveUrl });
    return paused && def.animated ? { ...out, speed: 0 } : out;
  }, [def, props, tokens, paused]);
  const Comp = def && library ? library[def.name] : undefined;
  if (!Comp || !renderProps) return null;
  return (
    <Comp
      key={generation}
      ref={(el: HTMLElement | null) => void (host.current = el)}
      {...renderProps}
      style={SHADER_HOST_STYLE}
      webGlContextAttributes={SHADER_GL_ATTRS}
      maxPixelCount={maxPixelCount}
    />
  );
});

/** A shader layer on the canvas: the layer box (fill, radius, borders) with the effect's canvas inside. */
export function ShaderNode({ node, style }: { node: NodeRecord; style: CSSProperties }) {
  const tokens = useEditor((s) => s.doc?.tokens);
  const preview = useEditor((s) => s.shaderPreview[node.id]);
  const paused = useEditor((s) => s.animationsPaused);
  const zoom = useRenderZoom();
  // Layer area in CSS px², rounded up to a power of two so resizing rarely changes the cap.
  const [area, setArea] = useState(0);
  const id = node.id;
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      const unregister = registerLayer(id, el);
      if (!el) return unregister;
      const observer = new ResizeObserver(([entry]) => {
        const box = entry?.borderBoxSize[0];
        const a = box ? box.inlineSize * box.blockSize : 0;
        setArea(a > 0 ? 2 ** Math.ceil(Math.log2(a)) : 0);
      });
      observer.observe(el);
      return () => {
        observer.disconnect();
        unregister?.();
      };
    },
    [id]
  );
  // The library renders at max(devicePixelRatio, 2)× the layout size; zoomed out, a fraction of that.
  const ratio = Math.max(window.devicePixelRatio || 1, 2) * zoom;
  const maxPixelCount = zoom < 1 && area ? Math.max(MIN_PIXELS, Math.round(area * ratio * ratio)) : undefined;
  return (
    <div ref={ref} data-op-id={node.id} style={style}>
      <ShaderCanvas component={node.component} props={preview ?? node.props} tokens={tokens} maxPixelCount={maxPixelCount} paused={paused} />
    </div>
  );
}

/** Animation time (ms) a mounted shader layer is showing right now. */
export function currentShaderFrame(nodeId: string): number | null {
  const host = document.querySelector(`[data-op-id="${CSS.escape(nodeId)}"] [data-paper-shader]`) as
    | (HTMLElement & { paperShaderMount?: { getCurrentFrame(): number } })
    | null;
  const frame = host?.paperShaderMount?.getCurrentFrame();
  return typeof frame === 'number' && Number.isFinite(frame) ? frame : null;
}
