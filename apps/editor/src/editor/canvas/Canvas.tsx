import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { BASE_CSS, tokenVars } from '@openpaper/core';
import { camera, getState, setCamera, useEditor } from '../../state/store.ts';
import { pushView } from '../../sync/session.ts';
import { NodeView } from './NodeView.tsx';
import { Overlay } from './Overlay.tsx';
import { TextEditor } from './TextEditor.tsx';
import { setViewportElement, unionRects, worldRectOf, viewportRect } from './geometry.ts';
import { onDoubleClick, onPointerDown, onPointerMove, onPointerUp, onWheel, setSpaceHeld, spaceHeld } from './interactions.ts';
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
  const zoom = Math.min(4, Math.max(0.02, Math.min((vr.width - padding * 2) / rect.width, (vr.height - padding * 2) / rect.height)));
  setCamera({
    zoom,
    x: vr.width / 2 - (rect.x + rect.width / 2) * zoom,
    y: vr.height / 2 - (rect.y + rect.height / 2) * zoom,
  });
}

export function zoomBy(factor: number) {
  const vr = viewportRect();
  const cam = camera();
  const z = Math.min(256, Math.max(0.02, cam.zoom * factor));
  const wx = (vr.width / 2 - cam.x) / cam.zoom;
  const wy = (vr.height / 2 - cam.y) / cam.zoom;
  setCamera({ zoom: z, x: vr.width / 2 - wx * z, y: vr.height / 2 - wy * z });
}

export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const pageId = useEditor((s) => s.pageId);
  const cam = useEditor((s) => (s.pageId && s.cameras[s.pageId]) || null);
  const tool = useEditor((s) => s.tool);
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
    if (!el) return;
    const wheel = (e: WheelEvent) => onWheel(e);
    el.addEventListener('wheel', wheel, { passive: false });
    const move = (e: PointerEvent) => onPointerMove(e);
    const up = (e: PointerEvent) => onPointerUp(e);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    const keyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        if (!spaceHeld) {
          setSpaceHeld(true);
          el.style.cursor = 'grab';
        }
        e.preventDefault();
      }
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpaceHeld(false);
        el.style.cursor = '';
      }
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    return () => {
      setViewportElement(null);
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
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

  useEffect(() => {
    pushView();
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

  return (
    <div
      ref={ref}
      className="op-canvas"
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: canvasColor || 'var(--op-canvas)',
        cursor: CURSORS[tool] ?? 'default',
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
      <div data-op-world style={worldStyle}>
        {rootChildren?.map((id) => <NodeView key={id} id={id} />)}
        <TextEditor />
      </div>
      <Overlay />
    </div>
  );
}

export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}
