import { memo, useEffect, useRef } from 'react';
import { attachLiveCursors, attachLiveLayer } from './live.ts';
import '../../styles/live.css';

/** Below the selection UI: fading copies of deleted layers and the build outlines (one canvas). */
export const LiveLayer = memo(function LiveLayer() {
  const hud = useRef<HTMLCanvasElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  useEffect(() => attachLiveLayer(hud.current, ghosts.current), []);
  return (
    <>
      <div ref={ghosts} className="op-live-ghosts" aria-hidden="true" />
      <canvas ref={hud} className="op-live-hud" aria-hidden="true" />
    </>
  );
});

/** Above everything: where each agent is writing right now. */
export const LiveCursors = memo(function LiveCursors() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => attachLiveCursors(ref.current), []);
  return <div ref={ref} className="op-live-cursors" aria-hidden="true" />;
});
