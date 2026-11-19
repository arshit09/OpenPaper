import { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { parentKindOf, renderSpec, scopeSvgIds, splitSvgMarkup, svgAttrToReact } from '@openpaper/core';
import { getState, subscribeLayer, useEditor } from '../../state/store.ts';
import { renderContext } from './render-context.ts';
import { registerLayer } from './geometry.ts';
import { ShaderNode } from '../shaders/ShaderLayer.tsx';
import { EmbedNode, LottieNode, useReplay } from './MotionLayers.tsx';

const SvgNode = memo(function SvgNode({ markup, style, id }: { markup: string; style: CSSProperties; id: string }) {
  // Ids are scoped per node: many SVGs share the canvas DOM (same rule as headless renders).
  const { attrs, inner } = useMemo(() => splitSvgMarkup(scopeSvgIds(markup, `_${id}_`)), [markup, id]);
  const el = useRef<SVGSVGElement | null>(null);
  const paused = useEditor((s) => s.animationsPaused);
  const animates = useMemo(() => /<(animate\w*|set)\b/i.test(inner), [inner]);
  // SMIL animations (<animate>, <animateTransform>, …) hold still with the rest of the design.
  useEffect(() => {
    if (!animates) return;
    if (paused) el.current?.pauseAnimations();
    else el.current?.unpauseAnimations();
  }, [paused, animates, inner]);
  // Per markup, not per render: a dragged SVG re-renders on every pointer move.
  const props = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' || k.toLowerCase().startsWith('on')) continue;
      out[svgAttrToReact(k)] = v;
    }
    if (!out.xmlns) out.xmlns = 'http://www.w3.org/2000/svg';
    return out;
  }, [attrs]);
  const html = useMemo(() => ({ __html: inner }), [inner]);
  return (
    <svg
      {...props}
      ref={(node) => {
        el.current = node;
        return registerLayer(id, node);
      }}
      style={style}
      data-op-id={id}
      dangerouslySetInnerHTML={html}
    />
  );
});

const VideoNode = memo(function VideoNode({ id, style, src, loop, speed }: { id: string; style: CSSProperties; src?: string; loop: boolean; speed: number }) {
  const el = useRef<HTMLVideoElement | null>(null);
  const paused = useEditor((s) => s.animationsPaused);
  useEffect(() => {
    if (el.current) el.current.playbackRate = speed;
  }, [speed, src]);
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    if (paused) v.pause();
    else void v.play().catch(() => {});
  }, [paused]);
  useReplay(() => {
    const v = el.current;
    if (!v) return;
    v.currentTime = 0;
    if (!getState().animationsPaused) void v.play().catch(() => {});
  });
  return (
    <video
      ref={(node) => {
        el.current = node;
        return registerLayer(id, node);
      }}
      data-op-id={id}
      style={style}
      src={src}
      muted
      loop={loop}
      autoPlay={!paused}
      playsInline
    />
  );
});

/** Renders one design node (and its subtree) as real DOM. */
export const NodeView = memo(function NodeView({ id }: { id: string }) {
  // Woken only by changes to this layer (see subscribeLayer), not by every store update.
  const subscribe = useCallback((listener: () => void) => subscribeLayer(id, listener), [id]);
  const node = useSyncExternalStore(subscribe, () => getState().doc?.nodes[id]);
  // Only the parent's layout kind matters; a primitive avoids re-rendering siblings.
  const parentKind = useSyncExternalStore(subscribe, () => {
    const s = getState();
    const parentId = s.doc?.nodes[id]?.parentId;
    return parentKindOf(parentId ? s.doc?.nodes[parentId] : undefined);
  });
  const transient = useSyncExternalStore(subscribe, () => getState().transient[id]);
  const editing = useSyncExternalStore(subscribe, () => getState().editingTextId === id);

  if (!node) return null;
  const spec = renderSpec(node, parentKind, renderContext);
  const ref = (el: Element | null) => registerLayer(node.id, el);
  const style = (transient ? { ...spec.style, ...transient } : spec.style) as CSSProperties;

  if (spec.kind === 'svg') return <SvgNode markup={spec.svg!} style={style} id={node.id} />;
  if (spec.kind === 'shader') return <ShaderNode node={node} style={style} />;
  if (spec.kind === 'lottie') {
    return <LottieNode id={node.id} style={style} src={spec.attrs.src} loop={spec.attrs.loop !== 'false'} speed={Number(spec.attrs.speed) || 1} />;
  }
  if (spec.kind === 'embed') return <EmbedNode node={node} style={style} />;

  if (spec.kind === 'text') {
    return (
      <div ref={ref} data-op-id={node.id} style={editing ? { ...style, visibility: 'hidden' } : style}>
        {spec.runs
          ? spec.runs.map((r, i) =>
              Object.keys(r.style).length ? (
                <span key={i} style={r.style as CSSProperties}>
                  {r.text}
                </span>
              ) : (
                r.text
              )
            )
          : spec.text}
      </div>
    );
  }

  if (spec.tag === 'img') {
    return <img ref={ref} data-op-id={node.id} style={style} src={spec.attrs.src} alt={spec.attrs.alt ?? ''} draggable={false} />;
  }
  if (spec.tag === 'video') {
    return <VideoNode id={node.id} style={style} src={spec.attrs.src} loop={spec.attrs.loop !== 'false'} speed={Number(spec.attrs.speed) || 1} />;
  }

  return (
    <div ref={ref} data-op-id={node.id} style={style}>
      {node.children.map((childId) => (
        <NodeView key={childId} id={childId} />
      ))}
    </div>
  );
});
