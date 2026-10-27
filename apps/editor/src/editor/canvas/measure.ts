import type { LayoutMap } from '@openpaper/core';
import { camera } from '../../state/store.ts';
import { elementFor, getViewportElement } from './geometry.ts';
import { suspendLive } from './live.ts';

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Layout of every rendered node on the current page, in world coordinates. Agent edits that are
 * still playing back don't matter: they only hide (visibility) or animate paint, never layout.
 */
export function measureRenderedPage(): LayoutMap {
  const viewport = getViewportElement();
  const world = viewport?.querySelector('[data-op-world]') as HTMLElement | null;
  if (!world) return {};
  const zoom = camera().zoom || 1;
  const wr = world.getBoundingClientRect();
  const out: LayoutMap = {};
  for (const el of Array.from(world.querySelectorAll('[data-op-id]'))) {
    const id = el.getAttribute('data-op-id')!;
    const r = el.getBoundingClientRect();
    const parent = el.parentElement?.closest('[data-op-id]') as HTMLElement | null;
    let x: number;
    let y: number;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      x = (r.left - pr.left) / zoom - (parent.clientLeft || 0);
      y = (r.top - pr.top) / zoom - (parent.clientTop || 0);
    } else {
      x = (r.left - wr.left) / zoom;
      y = (r.top - wr.top) / zoom;
    }
    out[id] = {
      worldX: round((r.left - wr.left) / zoom),
      worldY: round((r.top - wr.top) / zoom),
      x: round(x),
      y: round(y),
      width: round(r.width / zoom),
      height: round(r.height / zoom),
    };
  }
  return out;
}

/** Rasterize a rendered node in the browser (used when the server has no headless browser). */
export async function captureNode(nodeId: string, scale: number): Promise<{ data: string; mimeType: string; width: number; height: number }> {
  // The capture shows the final state: finish every reveal, and keep edits instant until it's taken.
  const release = suspendLive();
  try {
    const el = elementFor(nodeId) as HTMLElement | null;
    if (!el) throw new Error(`Node "${nodeId}" is not on the page the editor is showing.`);
    const { domToJpeg } = await import('modern-screenshot');
    const canvasColor = getComputedStyle(getViewportElement()!).backgroundColor || '#eeeeee';
    const dataUrl = await domToJpeg(el, { scale, quality: 0.92, backgroundColor: canvasColor });
    const img = new Image();
    img.src = dataUrl;
    await img.decode().catch(() => {});
    return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg', width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    release();
  }
}
