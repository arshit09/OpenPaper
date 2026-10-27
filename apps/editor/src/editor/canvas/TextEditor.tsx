import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { inlineRunStyles, normalizeRuns, parseInlineStyle, runsText, styleMapToCss, type StyleMap, type TextRun } from '@openpaper/core';
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

/** Fill the editor with the node's text: one span per styled run, tagged with its index. */
function fillEditor(el: HTMLElement, text: string, runs: readonly TextRun[] | undefined) {
  if (!runs?.length) {
    el.textContent = text;
    return;
  }
  el.replaceChildren(
    ...runs.map((run, i) => {
      if (!run.styles || !Object.keys(run.styles).length) return document.createTextNode(run.text);
      const span = document.createElement('span');
      span.style.cssText = styleMapToCss(run.styles);
      span.dataset.run = String(i);
      // As the browser wrote it: a span whose style changes while editing is read back from the DOM.
      span.dataset.css = span.style.cssText;
      span.textContent = run.text;
      return span;
    })
  );
}

/**
 * The edited content as runs. Spans we rendered keep their run's exact styles (tokens included),
 * even when the browser splits them; formatting added while editing (Ctrl+B, …) is read from the DOM.
 */
function readRuns(root: HTMLElement, source: readonly TextRun[] | undefined): TextRun[] {
  const out: TextRun[] = [];
  let endsWithBr = false;
  const walk = (node: Node, styles: StyleMap) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) {
        out.push({ text: node.textContent, styles });
        endsWithBr = false;
      }
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') {
      out.push({ text: '\n', styles });
      endsWithBr = true;
      return;
    }
    // Some browsers put new lines in blocks.
    if ((tag === 'div' || tag === 'p') && out.length && !runsText(out).endsWith('\n')) out.push({ text: '\n', styles });
    const run = node.dataset.run !== undefined ? source?.[Number(node.dataset.run)] : undefined;
    const next = run && node.style.cssText === node.dataset.css ? { ...styles, ...run.styles } : inlineRunStyles(tag, parseInlineStyle(node.getAttribute('style')), styles);
    node.childNodes.forEach((c) => walk(c, next));
  };
  root.childNodes.forEach((c) => walk(c, {}));
  // The browser adds a trailing <br> so an empty last line stays visible.
  if (endsWithBr) out.pop();
  return out;
}

/** In-place text editing over a Text node (same typography, scales with the canvas). */
export function TextEditor() {
  const id = useEditor((s) => s.editingTextId);
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const original = useRef<{ text: string; runs?: TextRun[]; styles: StyleMap }>({ text: '', styles: {} });

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
    original.current = { text: node.textValue ?? '', runs: node.textRuns, styles: node.styles };
  }, [id]);

  useEffect(() => {
    const el = ref.current;
    if (!id || !el || !style) return;
    fillEditor(el, original.current.text, original.current.runs);
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
    const before = original.current;
    const runs = readRuns(el, before.runs);
    const text = runsText(runs);
    setState({ editingTextId: null });
    if (!text.trim() && !before.text) {
      void command({ type: 'delete', nodeIds: [editing] });
      return;
    }
    const next = normalizeRuns(runs, before.styles);
    const rich = !!next.runs || Object.keys(next.hoist).length > 0;
    if (text === before.text && !Object.keys(next.hoist).length && JSON.stringify(next.runs ?? null) === JSON.stringify(before.runs ?? null)) return;
    void command(rich ? { type: 'setText', nodeId: editing, text, runs } : { type: 'setText', nodeId: editing, text });
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-op-overlay-ui
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onPaste={(e) => {
        // Pasted text takes the style where it lands; formatting from elsewhere is not kept.
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      }}
      onDrop={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        } else if (e.key === 'Enter') {
          // A line break inside the paragraph, never a new block.
          e.preventDefault();
          document.execCommand('insertLineBreak');
        }
      }}
    />
  );
}
