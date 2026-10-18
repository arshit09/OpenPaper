import { useEffect } from 'react';
import { FREEFORM_DISPLAY, parentKindOf, pxValue } from '@openpaper/core';
import { getState, setState, type Tool } from '../state/store.ts';
import { command, redo, undo } from '../sync/session.ts';
import { isTyping, zoomBy, zoomToFit } from './canvas/Canvas.tsx';
import { cancelGesture } from './canvas/interactions.ts';
import { setCamera } from '../state/store.ts';
import { viewportRect } from './canvas/geometry.ts';

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  f: 'frame',
  a: 'frame',
  r: 'rectangle',
  o: 'ellipse',
  t: 'text',
  p: 'pencil',
  c: 'comment',
};

function selected() {
  const s = getState();
  return s.doc ? s.selection.map((id) => s.doc!.nodes[id]).filter((n) => !!n) : [];
}

function nudge(dx: number, dy: number) {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const updates = selected()
    .filter((n) => {
      const parent = n!.parentId ? doc.nodes[n!.parentId] : undefined;
      const kind = parentKindOf(parent);
      return !n!.isLocked && (kind === 'root' || kind === 'freeform' || n!.styles.position === 'absolute');
    })
    .map((n) => ({
      nodeIds: [n!.id],
      styles: { left: `${(pxValue(n!.styles.left) ?? 0) + dx}px`, top: `${(pxValue(n!.styles.top) ?? 0) + dy}px` },
    }));
  if (updates.length) void command({ type: 'updateStyles', updates });
}

function reorder(delta: number | 'front' | 'back') {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const moves = selected().map((n) => {
    const parent = doc.nodes[n!.parentId!]!;
    const idx = parent.children.indexOf(n!.id);
    const max = parent.children.length - 1;
    const index = delta === 'front' ? max : delta === 'back' ? 0 : Math.max(0, Math.min(max, idx + delta));
    return { nodeId: n!.id, parentId: parent.id, index };
  });
  if (moves.length) void command({ type: 'move', moves });
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = getState();
      if (!s.doc) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        void redo();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        if (s.selection.length) {
          void command<{ ids: string[] }>({ type: 'duplicate', nodeIds: s.selection, offset: { x: 16, y: 16 } }).then((r) => r.ids?.length && setState({ selection: r.ids }));
        }
        return;
      }
      if (mod && key === 'g') {
        e.preventDefault();
        if (!s.selection.length) return;
        if (e.shiftKey) void command<{ ids: string[] }>({ type: 'ungroup', nodeIds: s.selection }).then((r) => setState({ selection: r.ids ?? [] }));
        else void command<{ ids: string[] }>({ type: 'group', nodeIds: s.selection }).then((r) => setState({ selection: r.ids ?? [] }));
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        const doc = s.doc;
        const first = s.selection[0] ? doc.nodes[s.selection[0]] : undefined;
        const parentId = first?.parentId ?? (s.pageId ? doc.pages[s.pageId]?.rootId : undefined);
        if (parentId) setState({ selection: [...(doc.nodes[parentId]?.children ?? [])] });
        return;
      }
      if (mod && (key === ']' || key === '[')) {
        e.preventDefault();
        reorder(key === ']' ? (e.altKey ? 'front' : 1) : e.altKey ? 'back' : -1);
        return;
      }
      if (mod && e.shiftKey && key === 'h') {
        e.preventDefault();
        const nodes = selected();
        if (nodes.length) void command({ type: 'setFlags', nodeIds: s.selection, isVisible: !nodes.every((n) => n!.isVisible) });
        return;
      }
      if (mod && e.shiftKey && key === 'l') {
        e.preventDefault();
        const nodes = selected();
        if (nodes.length) void command({ type: 'setFlags', nodeIds: s.selection, isLocked: !nodes.every((n) => n!.isLocked) });
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        zoomBy(0.8);
        return;
      }
      if (mod) return;

      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        zoomToFit();
        return;
      }
      if (e.shiftKey && e.code === 'Digit2') {
        e.preventDefault();
        if (s.selection.length) zoomToFit(s.selection);
        return;
      }
      if (e.shiftKey && e.code === 'Digit0') {
        e.preventDefault();
        const vr = viewportRect();
        const cam = s.pageId ? s.cameras[s.pageId] : undefined;
        if (cam) {
          const wx = (vr.width / 2 - cam.x) / cam.zoom;
          const wy = (vr.height / 2 - cam.y) / cam.zoom;
          setCamera({ zoom: 1, x: vr.width / 2 - wx, y: vr.height / 2 - wy });
        }
        return;
      }
      if (e.shiftKey && key === 'a') {
        // Toggle flex layout on the selection (like auto layout).
        e.preventDefault();
        const nodes = selected().filter((n) => n!.component === 'Frame');
        if (!nodes.length) return;
        const on = nodes.some((n) => !String(n!.styles.display ?? '').includes('flex'));
        void command({
          type: 'updateStyles',
          updates: nodes.map((n) => ({
            nodeIds: [n!.id],
            styles: on ? { display: 'flex', flexDirection: 'column', gap: n!.styles.gap ?? '8px' } : { display: FREEFORM_DISPLAY, flexDirection: null, gap: null },
          })),
        });
        return;
      }

      switch (e.key) {
        case 'Escape': {
          cancelGesture();
          if (s.tool !== 'select') setState({ tool: 'select' });
          else if (s.selection.length) {
            const parentId = s.doc.nodes[s.selection[0]!]?.parentId;
            const parent = parentId ? s.doc.nodes[parentId] : undefined;
            setState({ selection: parent && parent.component !== 'PageRoot' ? [parent.id] : [] });
          }
          return;
        }
        case 'Enter': {
          e.preventDefault();
          const node = s.selection.length === 1 ? s.doc.nodes[s.selection[0]!] : undefined;
          if (!node) return;
          if (e.shiftKey) {
            const parent = node.parentId ? s.doc.nodes[node.parentId] : undefined;
            if (parent && parent.component !== 'PageRoot') setState({ selection: [parent.id] });
          } else if (node.component === 'Text') setState({ editingTextId: node.id });
          else if (node.children.length) setState({ selection: [...node.children] });
          return;
        }
        case 'Delete':
        case 'Backspace':
          if (s.selection.length) {
            e.preventDefault();
            void command({ type: 'delete', nodeIds: s.selection });
          }
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!s.selection.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          nudge(dx, dy);
          return;
        }
        case 'F2': {
          const node = s.selection.length === 1 ? s.doc.nodes[s.selection[0]!] : undefined;
          if (!node) return;
          const name = prompt('Rename layer', node.label);
          if (name) void command({ type: 'rename', nodeId: node.id, name });
          return;
        }
      }
      if (!e.altKey && !e.shiftKey && TOOL_KEYS[key]) {
        setState({ tool: TOOL_KEYS[key] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
