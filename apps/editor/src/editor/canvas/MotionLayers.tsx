import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { EMBED_FRAME_STYLE, embedFrameUrl, embedSandbox, type NodeRecord } from '@openpaper/core';
import type { AnimationItem } from 'lottie-web';
import { getState, useEditor } from '../../state/store.ts';
import { registerLayer } from './geometry.ts';

/** Runs `fn` when the animations are replayed (not on mount). */
export function useReplay(fn: () => void) {
  const epoch = useEditor((s) => s.animationEpoch);
  const seen = useRef(epoch);
  useEffect(() => {
    if (epoch === seen.current) return;
    seen.current = epoch;
    fn();
  }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** lottie-web's SVG player (the light build: no expressions, no eval), loaded with the first Lottie layer. */
let player: Promise<typeof import('lottie-web')['default']> | null = null;
const loadPlayer = () => (player ??= import('lottie-web/build/player/lottie_light').then((m) => m.default));

const HOST_STYLE: CSSProperties = { width: '100%', height: '100%' };

/** A Lottie layer: the layer box with the animation drawn as SVG inside it. */
export const LottieNode = memo(function LottieNode({ id, style, src, loop, speed }: { id: string; style: CSSProperties; src?: string; loop: boolean; speed: number }) {
  const host = useRef<HTMLDivElement | null>(null);
  const [anim, setAnim] = useState<AnimationItem | null>(null);
  const paused = useEditor((s) => s.animationsPaused);
  useEffect(() => {
    const el = host.current;
    if (!el || !src) return;
    let item: AnimationItem | null = null;
    let cancelled = false;
    void Promise.all([loadPlayer(), fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))])
      .then(([lottie, data]) => {
        if (cancelled) return;
        item = lottie.loadAnimation({
          container: el,
          renderer: 'svg',
          loop,
          autoplay: !getState().animationsPaused,
          animationData: data,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        });
        setAnim(item);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      item?.destroy();
      setAnim(null);
    };
  }, [src, loop]);
  useEffect(() => anim?.setSpeed(speed), [anim, speed]);
  useEffect(() => {
    if (!anim) return;
    if (paused) anim.pause();
    else anim.play();
  }, [anim, paused]);
  useReplay(() => {
    if (!anim) return;
    if (getState().animationsPaused) anim.goToAndStop(0, true);
    else anim.goToAndPlay(0, true);
  });
  return (
    <div ref={(el) => registerLayer(id, el)} data-op-id={id} style={style}>
      <div ref={host} style={HOST_STYLE} />
    </div>
  );
});

/**
 * An Embed layer: its HTML (or a web page) in a sandboxed frame filling the layer. The frame never
 * takes the pointer; the layer box is what the canvas selects. Pause and play reach the page as a
 * message (see the server's embed runtime); a replay reloads it.
 */
export const EmbedNode = memo(function EmbedNode({ node, style }: { node: NodeRecord; style: CSSProperties }) {
  const fileId = useEditor((s) => s.doc?.id ?? '');
  const paused = useEditor((s) => s.animationsPaused);
  const epoch = useEditor((s) => s.animationEpoch);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const url = embedFrameUrl(fileId, node);
  const send = () => frame.current?.contentWindow?.postMessage({ 'op-animations': getState().animationsPaused ? 'pause' : 'play' }, '*');
  useEffect(send, [paused]);
  return (
    <div ref={(el) => registerLayer(node.id, el)} data-op-id={node.id} style={style}>
      <iframe key={epoch} ref={frame} src={url} sandbox={embedSandbox(url, location.origin)} style={EMBED_FRAME_STYLE} title={node.label} onLoad={send} />
    </div>
  );
});
