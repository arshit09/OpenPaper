import { useEffect, useState, useSyncExternalStore } from 'react';
import { camera, getState, useEditor } from '../../state/store.ts';
import { unionRects, worldRectOf, worldToScreen, type Rect } from './geometry.ts';
import { gestureKind, getModes, getToolView, subscribeModes } from './interactions.ts';
import { measureBoxes, type Segment } from './canvas-math.ts';

const RED = '#F24822';

interface Snapshot {
  /** Screen px, relative to the canvas. */
  target: Rect;
  source: Rect | null;
  lines: Array<Segment & { value: number; axis: 'x' | 'y' }>;
  guides: Segment[];
}

function rectOf(ids: string[]): Rect | null {
  return unionRects(ids.map((id) => worldRectOf(id)).filter((r): r is Rect => !!r));
}

function toScreen(r: Rect): Rect {
  const a = worldToScreen({ x: r.x, y: r.y });
  const zoom = camera().zoom;
  return { x: a.x, y: a.y, width: r.width * zoom, height: r.height * zoom };
}

/** What Alt is measuring right now: selection → hovered layer, or original → copy while Alt-dragging. */
function measure(): Snapshot | null {
  const s = getState();
  const doc = s.doc;
  if (!doc || !s.selection.length) return null;
  const clone = getToolView().clone;
  let source: Rect | null;
  let target: Rect | null;
  let both = false;
  if (clone) {
    if (clone.flow) return null;
    source = rectOf(clone.ids);
    target = source && { ...source, x: source.x + clone.dx, y: source.y + clone.dy };
    both = true;
  } else {
    if (gestureKind()) return null;
    // Hovering the selection itself measures to its container.
    let id = s.hoverId;
    while (id && s.selection.includes(id)) {
      const parentId = doc.nodes[id]?.parentId;
      id = parentId && doc.nodes[parentId]?.component !== 'PageRoot' ? parentId : null;
    }
    if (!id) return null;
    source = rectOf(s.selection);
    target = worldRectOf(id);
  }
  if (!source || !target) return null;
  const zoom = camera().zoom;
  const m = measureBoxes(source, target, Math.max(0.05, 0.5 / zoom));
  const seg = (l: Segment) => {
    const a = worldToScreen({ x: l.x1, y: l.y1 });
    const b = worldToScreen({ x: l.x2, y: l.y2 });
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };
  return {
    target: toScreen(target),
    source: both ? toScreen(source) : null,
    lines: m.distances.map((d) => ({ ...seg(d), value: d.value, axis: d.axis })),
    guides: m.guides.map(seg),
  };
}

const crisp = (n: number) => Math.round(n) + 0.5;
const label = (v: number) => String(Math.round(v * 10) / 10);

/** Hold Alt with a selection and hover another layer to see the distances (red, Figma style). */
export function MeasureOverlay() {
  const modes = useSyncExternalStore(subscribeModes, getModes);
  const tool = useEditor((s) => s.tool);
  const editing = useEditor((s) => !!s.editingTextId);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const active = modes.alt && !modes.zoom && !modes.space && tool === 'select' && !editing && hasSelection;
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!active) {
      setSnap(null);
      return;
    }
    let frame = 0;
    let last = '';
    const tick = () => {
      const next = measure();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSnap(next);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active || !snap) return null;
  const outline = (r: Rect, key: string) => (
    <rect key={key} x={crisp(r.x)} y={crisp(r.y)} width={Math.max(0, Math.round(r.width) - 1)} height={Math.max(0, Math.round(r.height) - 1)} fill="none" stroke={RED} />
  );
  return (
    <div data-op-measure style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }} shapeRendering="crispEdges">
        {outline(snap.target, 'target')}
        {snap.source && outline(snap.source, 'source')}
        {snap.guides.map((g, i) => (
          <line key={`g${i}`} x1={crisp(g.x1)} y1={crisp(g.y1)} x2={crisp(g.x2)} y2={crisp(g.y2)} stroke={RED} strokeDasharray="4 3" />
        ))}
        {snap.lines.map((l, i) => (
          <line key={`l${i}`} x1={crisp(l.x1)} y1={crisp(l.y1)} x2={crisp(l.x2)} y2={crisp(l.y2)} stroke={RED} />
        ))}
      </svg>
      {snap.lines.map((l, i) => (
        <div
          key={`v${i}`}
          style={{
            position: 'absolute',
            left: (l.x1 + l.x2) / 2,
            top: (l.y1 + l.y2) / 2,
            transform: l.axis === 'x' ? 'translate(-50%, 5px)' : 'translate(5px, -50%)',
            padding: '1px 4px',
            borderRadius: 3,
            background: RED,
            color: '#fff',
            fontSize: 10.5,
            fontWeight: 600,
            lineHeight: '15px',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {label(l.value)}
        </div>
      ))}
    </div>
  );
}
