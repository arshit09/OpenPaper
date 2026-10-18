import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useEditor, getState, setState } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import { elementFor, worldRectOf } from './geometry.ts';

const COPIED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'color',
  'textAlign',
  'textTransform',
  'textDecoration',
  'textShadow',
  'wordSpacing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFeatureSettings',
  'fontVariant',
] as const;

/** In-place text editing over a Text node (same typography, scales with the canvas). */
export function TextEditor() {
  const id = useEditor((s) => s.editingTextId);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const original = useRef('');

  useLayoutEffect(() => {
    if (!id) {
      setStyle(null);
      return;
    }
    const el = elementFor(id) as HTMLElement | null;
    const rect = worldRectOf(id);
    const node = getState().doc?.nodes[id];
    if (!el || !rect || !node) {
      setState({ editingTextId: null });
      return;
    }
    const cs = getComputedStyle(el);
    const s: Record<string, string | number> = {
      position: 'absolute',
      left: rect.x,
      top: rect.y,
      minWidth: Math.max(4, rect.width),
      minHeight: rect.height,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      outline: 'none',
      background: 'transparent',
      zIndex: 10,
      cursor: 'text',
      userSelect: 'text',
    };
    if (node.styles.width && node.styles.width !== 'fit-content' && node.styles.width !== 'max-content') s.width = rect.width;
    for (const k of COPIED) s[k] = (cs as unknown as Record<string, string>)[k]!;
    setStyle(s as CSSProperties);
    original.current = node.textValue ?? '';
  }, [id]);

  useEffect(() => {
    const el = ref.current;
    if (!id || !el || !style) return;
    el.textContent = original.current;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [id, style]);

  if (!id || !style) return null;

  const commit = () => {
    const el = ref.current;
    const editing = getState().editingTextId;
    if (!el || !editing) return;
    const text = (el.innerText ?? '').replace(/\n$/, '');
    setState({ editingTextId: null });
    if (!text.trim() && !original.current) {
      void command({ type: 'delete', nodeIds: [editing] });
      return;
    }
    if (text !== original.current) void command({ type: 'setText', nodeId: editing, text });
  };

  return (
    <div
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      data-op-overlay-ui
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
    />
  );
}
