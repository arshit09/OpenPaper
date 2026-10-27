import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { elementFor, muteVideos, worldRectOf } from './geometry.ts';
import { getToolView, subscribeToolView } from './interactions.ts';

/** Text properties a layer may inherit from its parent; the copy sits elsewhere in the tree. */
const INHERITED = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'whiteSpace', 'wordSpacing', 'direction'] as const;

/**
 * Alt-drag preview, rendered inside the world layer: snapshots of the dragged layers follow the
 * pointer while the originals stay put, until the real copies have rendered.
 */
export function DragGhost() {
  const clone = useSyncExternalStore(subscribeToolView, () => getToolView().clone);
  const host = useRef<HTMLDivElement>(null);
  const key = clone?.ids.join('|') ?? '';

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    for (const id of key ? key.split('|') : []) {
      const src = elementFor(id) as HTMLElement | null;
      const r = worldRectOf(id);
      if (!src || !r) continue;
      // Layout size (not the transformed box), centered where the original renders.
      const w = src instanceof HTMLElement ? src.offsetWidth : r.width;
      const h = src instanceof HTMLElement ? src.offsetHeight : r.height;
      const copy = src.cloneNode(true) as HTMLElement;
      muteVideos(copy);
      copy.removeAttribute('data-op-id');
      for (const d of copy.querySelectorAll('[data-op-id]')) d.removeAttribute('data-op-id');
      const from = src.querySelectorAll('canvas');
      copy.querySelectorAll('canvas').forEach((c, i) => {
        try {
          c.getContext('2d')?.drawImage(from[i]!, 0, 0);
        } catch {
          // A GPU canvas may not be readable; the layer's own fill still shows.
        }
      });
      Object.assign(copy.style, {
        position: 'absolute',
        left: `${r.x + r.width / 2 - w / 2}px`,
        top: `${r.y + r.height / 2 - h / 2}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${w}px`,
        height: `${h}px`,
        margin: '0',
        flex: 'none',
        visibility: 'visible',
        pointerEvents: 'none',
      });
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      const parentStyle = src.parentElement ? getComputedStyle(src.parentElement) : null;
      if (parentStyle) for (const p of INHERITED) wrap.style[p] = parentStyle[p];
      wrap.appendChild(copy);
      el.appendChild(wrap);
    }
  }, [key]);

  return (
    <div
      ref={host}
      aria-hidden
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none',
        display: clone ? 'block' : 'none',
        opacity: clone?.flow ? 0.85 : 1,
        transform: clone ? `translate(${clone.dx}px, ${clone.dy}px)` : undefined,
      }}
    />
  );
}
