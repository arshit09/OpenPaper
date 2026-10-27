import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { displayName, type AgentPresence } from '@openpaper/core';
import { useEditor, getState, setState } from '../../state/store.ts';
import { screenRectOf, worldToScreen, type Rect } from './geometry.ts';
import { getGestureView, pressNode, startResize, subscribeGesture, type ResizeHandle } from './interactions.ts';
import { LiveCursors, LiveLayer } from './LiveLayer.tsx';
import { SelectionPrompt } from './SelectionPrompt.tsx';
import { command } from '../../sync/session.ts';

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** Track on-screen rects of nodes every animation frame (layout can change without React knowing). */
function useScreenRects(ids: string[]): Record<string, Rect | null> {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const rects = useRef<Record<string, Rect | null>>({});
  const idsKey = ids.join('|');
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      let changed = false;
      const next: Record<string, Rect | null> = {};
      for (const id of ids) {
        const r = screenRectOf(id);
        next[id] = r;
        if (!sameRect(r, rects.current[id])) changed = true;
      }
      if (Object.keys(rects.current).length !== ids.length) changed = true;
      if (changed) {
        rects.current = next;
        force();
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return rects.current;
}

/** "Agent is working here": shares the artboard's label row and shrinks to its dots before the name does. */
function AgentChip({ agent, first }: { agent: AgentPresence; first: boolean }) {
  return (
    <div className="op-live-chip" style={{ marginLeft: first ? 'auto' : 0, ['--c' as string]: agent.color } as React.CSSProperties}>
      <span className="op-live-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="op-live-chip-name">{agent.name}</span>
    </div>
  );
}

function AgentRing({ agent, rect, inset }: { agent: AgentPresence; rect: Rect; inset: number }) {
  return (
    <div
      className="op-live-ring"
      style={
        {
          left: rect.x - inset,
          top: rect.y - inset,
          width: rect.width + inset * 2,
          height: rect.height + inset * 2,
          ['--c' as string]: agent.color,
        } as React.CSSProperties
      }
    />
  );
}

export function Overlay() {
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const agents = useEditor((s) => s.agents);
  const tool = useEditor((s) => s.tool);
  const editingTextId = useEditor((s) => s.editingTextId);
  const zoom = useEditor((s) => (s.pageId && s.cameras[s.pageId]?.zoom) || 1);
  const topLevel = useEditor((s) => {
    const page = s.doc && s.pageId ? s.doc.pages[s.pageId] : undefined;
    return page ? s.doc!.nodes[page.rootId]?.children ?? [] : [];
  });
  const doc = useEditor((s) => s.doc);
  const pageId = useEditor((s) => s.pageId);
  const commentsHidden = useEditor((s) => s.commentsHidden);
  const gesture = useSyncExternalStore(subscribeGesture, getGestureView);

  const agentBoards = agents.flatMap((a) => a.workingOn.map((id) => ({ a, id })));
  const boardAgents = new Map<string, AgentPresence[]>();
  for (const { a, id } of agentBoards) boardAgents.set(id, [...(boardAgents.get(id) ?? []), a]);
  const tracked = [...new Set([...selection, ...(hoverId ? [hoverId] : []), ...topLevel, ...agentBoards.map((x) => x.id)])];
  const rects = useScreenRects(tracked);
  if (!doc) return null;

  const single = selection.length === 1 ? doc.nodes[selection[0]!] : undefined;
  const singleRect = single ? rects[single.id] : null;
  const showHandles = !!single && !!singleRect && !single.isLocked && tool === 'select' && !editingTextId && single.component !== 'PageRoot';
  const threads = commentsHidden ? [] : Object.values(doc.comments).filter((t) => !t.deletedAt && t.pageId === pageId && t.status === 'open');

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* Agent edits playing back: build outlines, fading deletions */}
      <LiveLayer />

      {/* Artboard labels, with the chip of any agent working on the artboard at the right end */}
      {topLevel.map((id) => {
        const node = doc.nodes[id];
        const r = rects[id];
        if (!node || !r || node.component !== 'Frame' || r.width < 24) return null;
        const selected = selection.includes(id);
        const working = r.width >= 48 ? boardAgents.get(id) : undefined;
        return (
          <div
            key={`label-${id}`}
            style={{ position: 'absolute', left: r.x, top: r.y - 20, width: Math.max(40, r.width), height: 18, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <div
              data-op-overlay-ui
              title={displayName(node)}
              onPointerDown={(e) => {
                if (e.button !== 0 || tool !== 'select') return;
                e.stopPropagation();
                pressNode(e.nativeEvent, id);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                const name = prompt('Rename artboard', displayName(node));
                if (name) void command({ type: 'rename', nodeId: id, name });
              }}
              style={{
                flex: '0 1 auto',
                minWidth: 0,
                height: 18,
                lineHeight: '18px',
                fontSize: 11,
                color: selected ? 'var(--op-selection)' : 'var(--op-text-2)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                pointerEvents: 'auto',
                cursor: 'default',
                userSelect: 'none',
              }}
            >
              {displayName(node)}
            </div>
            {working?.map((a, i) => <AgentChip key={a.sessionId} agent={a} first={i === 0} />)}
          </div>
        );
      })}

      {/* Agent working indicators */}
      {agentBoards.map(({ a, id }) => {
        const r = rects[id];
        const inset = 3 + (boardAgents.get(id)?.indexOf(a) ?? 0) * 4;
        return r ? <AgentRing key={`agent-${a.sessionId}-${id}`} agent={a} rect={r} inset={inset} /> : null;
      })}

      {/* Hover */}
      {hoverId && !selection.includes(hoverId) && rects[hoverId] && (
        <div
          style={{
            position: 'absolute',
            left: rects[hoverId]!.x,
            top: rects[hoverId]!.y,
            width: rects[hoverId]!.width,
            height: rects[hoverId]!.height,
            outline: '1px solid var(--op-selection)',
          }}
        />
      )}

      {/* Selection */}
      {selection.map((id) => {
        const r = rects[id];
        if (!r) return null;
        return (
          <div
            key={`sel-${id}`}
            style={{ position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height, outline: '1.5px solid var(--op-selection)' }}
          />
        );
      })}

      {showHandles &&
        HANDLES.map((h) => {
          const r = singleRect!;
          const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2;
          const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2;
          if ((h === 'n' || h === 's') && r.width < 24) return null;
          if ((h === 'e' || h === 'w') && r.height < 24) return null;
          return (
            <div
              key={h}
              data-op-overlay-ui
              onPointerDown={(e) => {
                e.stopPropagation();
                startResize(e.nativeEvent, single!.id, h);
              }}
              style={{
                position: 'absolute',
                left: x - 4,
                top: y - 4,
                width: 8,
                height: 8,
                background: '#fff',
                border: '1.5px solid var(--op-selection)',
                borderRadius: 2,
                pointerEvents: 'auto',
                cursor: HANDLE_CURSOR[h],
              }}
            />
          );
        })}

      {singleRect && single && (
        <div
          style={{
            position: 'absolute',
            left: singleRect.x + singleRect.width / 2,
            top: singleRect.y + singleRect.height + 8,
            transform: 'translateX(-50%)',
            padding: '1px 6px',
            borderRadius: 4,
            background: 'var(--op-selection)',
            color: '#fff',
            fontSize: 10.5,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {Math.round(singleRect.width / zoom)} × {Math.round(singleRect.height / zoom)}
        </div>
      )}

      {/* Gesture visuals */}
      {gesture.marquee && <ScreenRect world={gesture.marquee} style={{ background: 'rgba(13,153,255,0.08)', outline: '1px solid var(--op-selection)' }} />}
      {gesture.draw && <ScreenRect world={gesture.draw} style={{ outline: '1.5px dashed var(--op-selection)' }} />}
      {gesture.dropLine && <DropLine line={gesture.dropLine} />}
      {gesture.pencil && <PencilPreview points={gesture.pencil} zoom={zoom} />}

      {/* Comment pins */}
      {threads.map((t) => {
        const anchor = doc.nodes[t.nodeId];
        const base = anchor && anchor.component !== 'PageRoot' ? rects[t.nodeId] ?? screenRectOf(t.nodeId) : null;
        const pos = base
          ? { x: base.x + t.xOffset * zoom, y: base.y + t.yOffset * zoom }
          : worldToScreen({ x: t.xOffset, y: t.yOffset });
        return (
          <button
            key={t.id}
            data-op-overlay-ui
            title={t.messages[0]?.text}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setState({ rightTab: 'comments', focusedThreadId: t.id })}
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y - 28,
              width: 28,
              height: 28,
              borderRadius: '14px 14px 14px 2px',
              border: '2px solid #fff',
              background: getState().focusedThreadId === t.id ? 'var(--op-accent)' : '#1a1a1a',
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              pointerEvents: 'auto',
              cursor: 'pointer',
              boxShadow: 'var(--op-shadow)',
            }}
          >
            {t.messages.filter((m) => !m.deletedAt).length}
          </button>
        );
      })}

      <LiveCursors />

      {/* Ask the agent about the selection (on top of pins and cursors) */}
      {!gesture.marquee && <SelectionPrompt rects={rects} />}
    </div>
  );
}

function ScreenRect({ world, style }: { world: Rect; style: React.CSSProperties }) {
  const tl = worldToScreen({ x: world.x, y: world.y });
  const br = worldToScreen({ x: world.x + world.width, y: world.y + world.height });
  return <div style={{ position: 'absolute', left: tl.x, top: tl.y, width: br.x - tl.x, height: br.y - tl.y, ...style }} />;
}

function DropLine({ line }: { line: { x1: number; y1: number; x2: number; y2: number } }) {
  const a = worldToScreen({ x: line.x1, y: line.y1 });
  const b = worldToScreen({ x: line.x2, y: line.y2 });
  return (
    <div
      style={{
        position: 'absolute',
        left: Math.min(a.x, b.x) - 1,
        top: Math.min(a.y, b.y) - 1,
        width: Math.max(2, Math.abs(b.x - a.x)),
        height: Math.max(2, Math.abs(b.y - a.y)),
        background: 'var(--op-selection)',
      }}
    />
  );
}

function PencilPreview({ points, zoom }: { points: Array<{ x: number; y: number }>; zoom: number }) {
  const d = points.map((p, i) => {
    const s = worldToScreen(p);
    return `${i ? 'L' : 'M'}${s.x} ${s.y}`;
  });
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
      <path d={d.join(' ')} fill="none" stroke="#111" strokeWidth={3 * zoom} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
