import { useSyncExternalStore } from 'react';
import { getToolView, subscribeToolView } from './interactions.ts';

/** The zoom tool's area brush (hold Z and drag). */
export function ZoomOverlay() {
  const rect = useSyncExternalStore(subscribeToolView, () => getToolView().zoomRect);
  if (!rect) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        background: 'rgba(13, 153, 255, 0.08)',
        outline: '1px solid var(--op-selection)',
        pointerEvents: 'none',
      }}
    />
  );
}
