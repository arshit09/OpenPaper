import { useEffect, useRef } from 'react';
import { displayName } from '@openpaper/core';
import { getState, setState, useEditor } from '../../state/store.ts';
import { sendToAgent } from '../../sync/session.ts';
import { PointPrompt } from '../../ui/PointPrompt.tsx';
import { bindingLabel, isMacPlatform } from '../hotkeys.ts';

const SHORTCUT = bindingLabel('Mod+K', isMacPlatform());
import { unionRects, viewportRect, type Rect } from './geometry.ts';

/** The agent button beside the canvas selection, opening a prompt aimed at exactly those layers. */
export function SelectionPrompt({ rects }: { rects: Record<string, Rect | null> }) {
  const selection = useEditor((s) => s.selection);
  const open = useEditor((s) => s.selectionPrompt);
  const doc = useEditor((s) => s.doc);
  const chatKey = useEditor((s) => s.agentChat.key);
  const busy = useEditor((s) => s.tool !== 'select' || !!s.editingTextId || Object.keys(s.transient).length > 0 || s.uiHidden);
  const hasDraft = useRef(false);
  const prev = useRef(selection);

  // A new selection closes an empty prompt; one with a draft follows the selection.
  useEffect(() => {
    if (prev.current === selection) return;
    prev.current = selection;
    if (getState().selectionPrompt && (!selection.length || !hasDraft.current)) setState({ selectionPrompt: false });
  }, [selection]);

  const targets = doc ? selection.filter((id) => doc.nodes[id] && doc.nodes[id]!.component !== 'PageRoot') : [];
  const rect = unionRects(targets.map((id) => rects[id]).filter((r): r is Rect => !!r));
  if (!doc || !chatKey || !rect || !targets.length) return null;

  const label = targets.length === 1 ? displayName(doc.nodes[targets[0]!]!) : `${targets.length} layers`;
  const vr = viewportRect();
  return (
    <PointPrompt
      rect={rect}
      bounds={{ width: vr.width, height: vr.height }}
      label={label}
      shortcut={SHORTCUT}
      open={open}
      hidden={busy}
      picker
      onOpenChange={(v) => setState({ selectionPrompt: v })}
      onDraftChange={(v) => (hasDraft.current = v)}
      onSend={(text) => sendToAgent(text, { target: { label, nodeIds: targets } })}
    />
  );
}
