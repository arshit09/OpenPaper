import { useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties } from 'react';
import { BASE_CSS, tokenVars } from '@openpaper/core';
import { camera, getState, setCamera, setState, useEditor } from '../../state/store.ts';
import { pushView } from '../../sync/session.ts';
import { NodeView } from './NodeView.tsx';
import { Overlay } from './Overlay.tsx';
import { TextEditor } from './TextEditor.tsx';
import { DragGhost } from './DragGhost.tsx';
import { MeasureOverlay } from './MeasureOverlay.tsx';
import { ZoomOverlay } from './ZoomOverlay.tsx';
import { setViewportElement, unionRects, watchLayout, worldRectOf, viewportRect } from './geometry.ts';
import {
  cancelGesture,
  fitRect,
  gestureKind,
  getModes,
  onDoubleClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  setModes,
  subscribeModes,
  zoomAt,
} from './interactions.ts';
import { nextZoomLevel } from './canvas-math.ts';
import { useDocumentFonts } from './fonts.ts';

const CURSORS: Record<string, string> = {
  select: 'default',
  hand: 'grab',
  frame: 'crosshair',
  rectangle: 'crosshair',
  ellipse: 'crosshair',
  text: 'text',
  pencil: 'crosshair',
  comment: 'crosshair',
};

/** Fit all top-level content (or the given ids) into the viewport. */
export function zoomToFit(ids?: string[], padding = 80) {
  const s = getState();
  const doc = s.doc;
  const page = doc && s.pageId ? doc.pages[s.pageId] : undefined;
  if (!doc || !page) return;
  const targets = ids ?? doc.nodes[page.rootId]?.children ?? [];
  const rect = unionRects(targets.map((id) => worldRectOf(id)).filter((r): r is NonNullable<typeof r> => !!r));
  const vr = viewportRect();
  if (!rect || rect.width === 0 || rect.height === 0) {
    setCamera({ x: vr.width / 2 - 360, y: 80, zoom: 1 });
    return;
  }
  fitRect(rect, padding);
}

export function zoomBy(factor: number) {
  const vr = viewportRect();
  zoomAt(camera().zoom * factor, vr.width / 2, vr.height / 2);
}

/** Zoom to an exact level around the viewport center. */
export function zoomTo(zoom: number) {
  const vr = viewportRect();
  zoomAt(zoom, vr.width / 2, vr.height / 2);
}

/** Zoom in/out to the next stop (… 50%, 100%, 200% …). */
export function zoomStep(direction: 1 | -1) {
  zoomTo(nextZoomLevel(camera().zoom, direction));
}

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const pageId = useEditor((s) => s.pageId);
  const cam = useEditor((s) => (s.pageId && s.cameras[s.pageId]) || null);
  const tool = useEditor((s) => s.tool);
  const modes = useSyncExternalStore(subscribeModes, getModes);
  const rootChildren = useEditor((s) => {
    const page = s.doc && s.pageId ? s.doc.pages[s.pageId] : undefined;
    return page ? s.doc!.nodes[page.rootId]?.children : undefined;
  });
  const canvasColor = useEditor((s) => (s.doc && s.pageId ? s.doc.pages[s.pageId]?.canvasColor : undefined));
  const tokens = useEditor((s) => s.doc?.tokens);
  const vars = useMemo(() => tokenVars(tokens ?? []), [tokens]);
  useDocumentFonts();

  useEffect(() => {
    const el = ref.current;
    setViewportElement(el);
    if (!el || !world.current) return;
    const unwatch = watchLayout(el, world.current);
    const wheel = (e: WheelEvent) => {
      if (scrollsItself(e)) {
        // The control scrolls; pinch / Ctrl+wheel must still never zoom the page.
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      onWheel(e);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const move = (e: PointerEvent) => {
      // Alt may go down while another window has focus; pointer events still report it.
      if (e.altKey !== getModes().alt) setModes({ alt: e.altKey });
      // Gestures follow the pointer anywhere; hover only hit-tests over the canvas itself, not over
      // panels or the dock (whose own hover would be undone) or controls drawn on the canvas.
      if (gestureKind()) return onPointerMove(e);
      const target = e.target as Element | null;
      if (target && el.contains(target) && !target.closest('[data-op-overlay-ui]')) onPointerMove(e);
      else if (target && el.contains(target) && getState().hoverId) setState({ hoverId: null });
    };
    const leave = () => {
      if (!gestureKind() && getState().hoverId) setState({ hoverId: null });
    };
    const up = (e: PointerEvent) => onPointerUp(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // A pen or touch press taken over by the system: drop the gesture instead of leaving it stuck.
    window.addEventListener('pointercancel', cancelGesture);
    el.addEventListener('pointerleave', leave);
    return () => {
      setViewportElement(null);
      unwatch();
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelGesture);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);

  // First visit to a page: fit its content once it has rendered.
  const hadContent = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (!pageId) return;
    const has = (rootChildren?.length ?? 0) > 0;
    const known = getState().cameras[pageId];
    if (!known || (has && !hadContent.current[pageId])) {
      requestAnimationFrame(() => requestAnimationFrame(() => zoomToFit()));
    }
    hadContent.current[pageId] = has;
  }, [pageId, (rootChildren?.length ?? 0) > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Panning reports the viewport a few times a second, not every frame.
  useEffect(() => {
    pushView(250);
  }, [cam]);

  const view = cam ?? { x: 0, y: 0, zoom: 1 };
  const worldStyle = {
    position: 'absolute',
    left: 0,
    top: 0,
    transformOrigin: '0 0',
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    ...vars,
  } as CSSProperties;
  const cursor = modes.panning
    ? 'grabbing'
    : modes.zoom
      ? modes.alt
        ? 'zoom-out'
        : 'zoom-in'
      : modes.space
        ? 'grab'
        : (CURSORS[tool] ?? 'default');

  return (
    <div
      ref={ref}
      className="op-canvas"
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: canvasColor || 'var(--op-canvas)',
        cursor,
        touchAction: 'none',
        userSelect: 'none',
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-op-overlay-ui]')) return;
        (document.activeElement as HTMLElement | null)?.blur?.();
        onPointerDown(e.nativeEvent);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-op-overlay-ui]')) return;
        onDoubleClick(e.nativeEvent);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{BASE_CSS}</style>
      <div ref={world} data-op-world style={worldStyle}>
        {rootChildren?.map((id) => <NodeView key={id} id={id} />)}
        <DragGhost />
        <TextEditor />
      </div>
      <Overlay />
      <MeasureOverlay />
      <ZoomOverlay />
    </div>
  );
}

/** Is a wheel over a control on the canvas (a long prompt) for that control to scroll, rather than the canvas? */
function scrollsItself(e: WheelEvent): boolean {
  const target = e.target as Element | null;
  const ui = target?.closest?.('[data-op-overlay-ui]');
  if (!ui) return false;
  for (let el: Element | null = target; el && el !== ui.parentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return true;
  }
  return false;
}

const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week|range)$/i;

/** Is the event aimed at something that takes typing (text fields, editable text, selects, sliders)? */
export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.tagName !== 'string') return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.getAttribute('role') === 'combobox') return true;
  return t.tagName === 'INPUT' && TEXT_INPUTS.test((t as HTMLInputElement).type || 'text');
}
