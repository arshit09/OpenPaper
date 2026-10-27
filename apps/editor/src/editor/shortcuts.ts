import { useEffect } from 'react';
import { getState, setState, type EditorState, type Tool } from '../state/store.ts';
import { redo, undo } from '../sync/session.ts';
import { isTyping, zoomStep, zoomTo, zoomToFit } from './canvas/Canvas.tsx';
import { cancelGesture, endZoomMode, gestureKind, refreshGesture, resetModes, setModes, setSpaceHeld, startKeyPan } from './canvas/interactions.ts';
import { isMacPlatform, matchBinding, type Modifier } from './hotkeys.ts';
import * as act from './actions.ts';
import { armPasteOnTop, pasteToReplace } from './clipboard.ts';

export const MAC = isMacPlatform();

export const SHORTCUT_GROUPS = ['Tools', 'View', 'Selection', 'Edit', 'Arrange', 'Text'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/**
 * One keyboard shortcut. The key handler and the help dialog both read this registry.
 * Bindings use `hotkeys.ts` notation; `Mod` is Ctrl (⌘ on macOS).
 */
export interface Shortcut {
  id: string;
  label: string;
  group: ShortcutGroup;
  keys?: string[];
  /** Shown in the help instead of `keys` (when the full list is noisy). */
  show?: string[];
  /** Mouse gestures, shown in the help only; the canvas handles them. */
  gestures?: string[];
  /** Spring-loaded: active while the key is held. */
  hold?: boolean;
  /** Modifiers that may be held or not. */
  tolerate?: Modifier[];
  /** Keeps firing while the key auto-repeats. */
  repeat?: boolean;
  /** Leave the browser's default action alone (the paste event). */
  native?: boolean;
  /** Also works while a dialog is open. */
  global?: boolean;
  when?: (s: EditorState) => boolean;
  /** Return false to let the key fall through; a function runs when the key is released. */
  run?: (e: KeyboardEvent, s: EditorState) => void | false | (() => void);
}

const hasSelection = (s: EditorState) => s.selection.length > 0;
const tool = (t: Tool) => () => setState({ tool: t });
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const arrow = (e: KeyboardEvent, step: number) => ({
  dx: e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
  dy: e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0,
});
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const up = (e: KeyboardEvent) => (e.code === 'Period' ? 1 : -1);

/** Codes of keys currently down (arrow panning reads them). */
const pressed = new Set<string>();

export const SHORTCUTS: Shortcut[] = [
  // ---- Tools ----
  { id: 'tool-move', group: 'Tools', label: 'Move', keys: ['V'], run: tool('select') },
  { id: 'tool-hand', group: 'Tools', label: 'Hand', keys: ['H'], run: tool('hand') },
  { id: 'tool-frame', group: 'Tools', label: 'Frame', keys: ['F', 'A'], run: tool('frame') },
  { id: 'tool-rectangle', group: 'Tools', label: 'Rectangle', keys: ['R'], run: tool('rectangle') },
  { id: 'tool-ellipse', group: 'Tools', label: 'Ellipse', keys: ['O'], run: tool('ellipse') },
  {
    id: 'tool-text',
    group: 'Tools',
    label: 'Text (edits a selected text layer)',
    keys: ['T'],
    run: (_e, s) => {
      const node = s.selection.length === 1 ? s.doc?.nodes[s.selection[0]!] : undefined;
      if (node?.component === 'Text' && !node.isLocked) setState({ editingTextId: node.id });
      else setState({ tool: 'text' });
    },
  },
  { id: 'tool-pencil', group: 'Tools', label: 'Pencil', keys: ['P'], run: tool('pencil') },
  { id: 'tool-comment', group: 'Tools', label: 'Comment', keys: ['C', 'Y'], run: tool('comment') },
  { id: 'shaders', group: 'Tools', label: 'Shaders', keys: ['S'], run: (_e, s) => setState({ showShaders: !s.showShaders }) },
  { id: 'eyedropper', group: 'Tools', label: 'Pick color (fills the selection, or copies it)', keys: ['I'], run: () => void act.eyedropper() },
  { id: 'place-image', group: 'Tools', label: 'Place image', keys: ['Mod+Shift+K'], run: act.placeImage },
  {
    id: 'pan',
    group: 'Tools',
    label: 'Pan (hold and drag)',
    keys: ['Space'],
    hold: true,
    gestures: ['Middle-drag'],
    tolerate: ['Alt', 'Shift'],
    run: () => {
      setSpaceHeld(true);
      return () => setSpaceHeld(false);
    },
  },
  {
    id: 'zoom-tool',
    group: 'Tools',
    label: 'Zoom tool: click to zoom in, Alt+click out, drag an area',
    keys: MAC ? ['Z'] : ['Z', 'Ctrl+Space'],
    hold: true,
    tolerate: ['Alt'],
    run: () => {
      setModes({ zoom: true });
      return endZoomMode;
    },
  },
  {
    id: 'escape',
    group: 'Tools',
    label: 'Back to Move, then select parent',
    keys: ['Escape'],
    tolerate: ['Ctrl'],
    run: (e, s) => {
      if (gestureKind()) cancelGesture();
      else if (s.showShaders) setState({ showShaders: false });
      else if (s.tool !== 'select') setState({ tool: 'select' });
      else if (e.ctrlKey) setState({ selection: [] });
      else act.selectParent();
    },
  },

  // ---- View ----
  { id: 'zoom-in', group: 'View', label: 'Zoom in', keys: ['=', '+', 'Mod+=', 'Mod++'], show: ['+', 'Mod++'], repeat: true, run: () => zoomStep(1) },
  { id: 'zoom-out', group: 'View', label: 'Zoom out', keys: ['-', 'Mod+-', 'Mod+Shift+-'], show: ['-', 'Mod+-'], repeat: true, run: () => zoomStep(-1) },
  { id: 'zoom-100', group: 'View', label: 'Zoom to 100%', keys: ['Shift+0', 'Mod+0'], run: () => zoomTo(1) },
  { id: 'zoom-fit', group: 'View', label: 'Zoom to fit', keys: ['Shift+1'], run: () => zoomToFit() },
  {
    id: 'zoom-selection',
    group: 'View',
    label: 'Zoom to selection',
    keys: ['Shift+2'],
    run: (_e, s) => zoomToFit(s.selection.length ? s.selection : undefined),
  },
  { id: 'zoom-wheel', group: 'View', label: 'Zoom at the pointer', gestures: ['Mod+Scroll', 'Pinch'] },
  { id: 'scroll-pan', group: 'View', label: 'Scroll / scroll sideways', gestures: ['Scroll', 'Shift+Scroll'] },
  {
    id: 'pan-arrows',
    group: 'View',
    label: 'Pan (nothing selected; Shift = faster)',
    keys: ARROWS,
    show: ['Arrows'],
    tolerate: ['Shift'],
    repeat: true,
    when: (s) => !hasSelection(s),
    run: () =>
      startKeyPan(() => {
        const l = pressed.has('ArrowLeft');
        const r = pressed.has('ArrowRight');
        const u = pressed.has('ArrowUp');
        const d = pressed.has('ArrowDown');
        if (!l && !r && !u && !d) return null;
        return { x: (l ? 1 : 0) - (r ? 1 : 0), y: (u ? 1 : 0) - (d ? 1 : 0), fast: pressed.has('ShiftLeft') || pressed.has('ShiftRight') };
      }),
  },
  { id: 'artboard-next', group: 'View', label: 'Next / previous artboard', keys: ['N', 'Shift+N'], repeat: true, run: (e) => act.goToArtboard(e.shiftKey ? -1 : 1) },
  { id: 'page-next', group: 'View', label: 'Next / previous page', keys: ['PageDown', 'PageUp'], repeat: true, run: (e) => act.goToPage(e.key === 'PageUp' ? -1 : 1) },
  {
    id: 'measure',
    group: 'View',
    label: 'Measure distances (hover another layer)',
    keys: ['Alt'],
    hold: true,
    tolerate: ['Mod', 'Ctrl', 'Shift'],
    run: () => {
      setModes({ alt: true });
      return () => setModes({ alt: false });
    },
  },
  {
    id: 'toggle-ui',
    group: 'View',
    label: 'Show / hide UI',
    keys: ['.', 'Mod+.', 'Mod+\\'],
    show: ['.', 'Mod+\\'],
    run: (_e, s) => {
      setState({ uiHidden: !s.uiHidden });
      if (!s.uiHidden) act.notify('ui', `UI hidden. Press . or ${MAC ? '⌘\\' : 'Ctrl+\\'} to bring it back`, 2400);
    },
  },
  {
    id: 'collapse-panels',
    group: 'View',
    label: 'Collapse / expand panels',
    keys: ['Shift+\\', 'Shift+.', 'Mod+Shift+\\'],
    run: (_e, s) => setState(s.uiHidden ? { uiHidden: false, panelsCollapsed: false } : { panelsCollapsed: !s.panelsCollapsed }),
  },
  { id: 'panel-layers', group: 'View', label: 'Layers panel', keys: ['Alt+1'], run: () => setState({ uiHidden: false, panelsCollapsed: false, leftTab: 'layers' }) },
  { id: 'panel-tokens', group: 'View', label: 'Tokens panel', keys: ['Alt+2'], run: () => setState({ uiHidden: false, panelsCollapsed: false, leftTab: 'tokens' }) },
  {
    id: 'toggle-comments',
    group: 'View',
    label: 'Show / hide comments',
    keys: ['Shift+C'],
    run: (_e, s) => {
      setState({ commentsHidden: !s.commentsHidden });
      act.notify('comments', s.commentsHidden ? 'Comments visible' : 'Comments hidden');
    },
  },
  {
    id: 'help',
    group: 'View',
    label: 'Keyboard shortcuts',
    keys: ['Ctrl+Shift+/', 'Mod+Shift+/', 'Mod+/'],
    show: MAC ? ['Ctrl+Shift+?', 'Mod+/'] : ['Ctrl+Shift+?', 'Ctrl+/'],
    global: true,
    run: (_e, s) => setState({ showShortcuts: !s.showShortcuts }),
  },

  // ---- Selection ----
  { id: 'select-all', group: 'Selection', label: 'Select all', keys: ['Mod+A'], run: act.selectAll },
  { id: 'select-others', group: 'Selection', label: 'Select others', keys: ['Mod+Shift+A'], run: act.selectOthers },
  { id: 'select-next', group: 'Selection', label: 'Select next / previous', keys: ['Tab', 'Shift+Tab'], repeat: true, run: (e) => act.selectSibling(e.shiftKey ? -1 : 1) },
  { id: 'select-children', group: 'Selection', label: 'Select children / edit text', keys: ['Enter'], repeat: true, run: act.selectChildren },
  { id: 'select-parent', group: 'Selection', label: 'Select parent', keys: ['Shift+Enter', '\\'], repeat: true, run: act.selectParent },
  { id: 'select-add', group: 'Selection', label: 'Add to / remove from selection', gestures: ['Shift+Click'] },
  { id: 'select-deep', group: 'Selection', label: 'Select inside frames', gestures: ['Mod+Click'] },
  { id: 'select-drill', group: 'Selection', label: 'Select one level deeper / edit text', gestures: ['Double-click'] },
  { id: 'select-area', group: 'Selection', label: 'Select an area', gestures: ['Drag on empty canvas'] },

  // ---- Edit ----
  { id: 'undo', group: 'Edit', label: 'Undo', keys: ['Mod+Z'], repeat: true, run: () => void undo() },
  { id: 'redo', group: 'Edit', label: 'Redo', keys: ['Mod+Shift+Z', 'Mod+Y'], repeat: true, run: () => void redo() },
  {
    id: 'ask-agent',
    group: 'Edit',
    label: 'Ask the agent (about the selection)',
    keys: ['Mod+K'],
    run: (_e, s) => {
      if (s.selection.length) setState({ selectionPrompt: true });
      else document.querySelector<HTMLTextAreaElement>('.op-dock-composer textarea')?.focus();
    },
  },
  { id: 'cut', group: 'Edit', label: 'Cut', show: ['Mod+X'] },
  { id: 'copy', group: 'Edit', label: 'Copy (as HTML)', show: ['Mod+C'] },
  { id: 'paste', group: 'Edit', label: 'Paste (into a selected frame)', show: ['Mod+V'] },
  { id: 'paste-on-top', group: 'Edit', label: 'Paste on top of the selection', keys: ['Mod+Shift+V'], native: true, run: armPasteOnTop },
  { id: 'paste-replace', group: 'Edit', label: 'Paste to replace the selection', keys: ['Mod+Shift+R'], when: hasSelection, run: () => void pasteToReplace() },
  { id: 'copy-styles', group: 'Edit', label: 'Copy styles', keys: ['Mod+Alt+C'], when: hasSelection, run: act.copyStyles },
  { id: 'paste-styles', group: 'Edit', label: 'Paste styles', keys: ['Mod+Alt+V'], when: hasSelection, run: act.pasteStyles },
  { id: 'duplicate', group: 'Edit', label: 'Duplicate', keys: ['Mod+D'], repeat: true, run: act.duplicateSelection },
  { id: 'duplicate-drag', group: 'Edit', label: 'Duplicate by dragging', gestures: ['Alt+Drag'] },
  { id: 'delete', group: 'Edit', label: 'Delete', keys: ['Delete', 'Backspace'], run: act.deleteSelection },
  { id: 'rename', group: 'Edit', label: 'Rename', keys: ['Mod+R', 'F2'], when: hasSelection, run: act.rename },
  { id: 'opacity', group: 'Edit', label: 'Opacity (1 = 10%, 0 = 100%, two digits quickly)', keys: DIGITS, show: ['0…9'], repeat: true, when: hasSelection, run: (e) => act.opacityKey(Number(e.code.slice(-1))) },
  { id: 'hide', group: 'Edit', label: 'Show / hide', keys: ['Mod+Shift+H'], run: act.toggleVisibility },
  { id: 'lock', group: 'Edit', label: 'Lock / unlock', keys: ['Mod+Shift+L'], run: act.toggleLock },
  { id: 'unlock-all', group: 'Edit', label: 'Unlock all', keys: ['Mod+Shift+Alt+L'], run: act.unlockAll },
  { id: 'copy-png', group: 'Edit', label: 'Copy as PNG', keys: ['Mod+Shift+C'], when: hasSelection, run: act.copyAsPng },
  { id: 'copy-tailwind', group: 'Edit', label: 'Copy as Tailwind', keys: ['Alt+T'], when: hasSelection, run: () => void act.copyAsCode('tailwind') },
  { id: 'copy-react', group: 'Edit', label: 'Copy as React (inline styles)', keys: ['Alt+R'], when: hasSelection, run: () => void act.copyAsCode('inline-styles') },
  { id: 'copy-link', group: 'Edit', label: 'Copy link to the selection', keys: ['Mod+L'], run: act.copyLink },
  { id: 'export', group: 'Edit', label: 'Export', keys: ['Mod+Shift+E'], run: () => setState({ showExport: true }) },
  { id: 'save', group: 'Edit', label: 'Save (automatic)', keys: ['Mod+S'], run: () => act.notify('save', 'OpenPaper saves your changes automatically') },
  {
    id: 'home',
    group: 'Edit',
    label: 'Back to all files',
    keys: ['Mod+Shift+D'],
    run: () => {
      location.hash = '#/';
    },
  },

  // ---- Arrange ----
  {
    id: 'nudge',
    group: 'Arrange',
    label: 'Nudge (Shift = 10px); flex children change places',
    keys: ARROWS,
    show: ['Arrows', 'Shift+Arrows'],
    tolerate: ['Shift', 'Alt'],
    repeat: true,
    when: hasSelection,
    run: (e) => {
      const { dx, dy } = arrow(e, e.shiftKey ? 10 : 1);
      act.nudge(dx, dy);
    },
  },
  {
    id: 'resize-keys',
    group: 'Arrange',
    label: 'Resize (Shift = 10px)',
    keys: ARROWS.map((k) => `Mod+${k}`),
    show: ['Mod+Arrows'],
    tolerate: ['Shift'],
    repeat: true,
    when: hasSelection,
    run: (e) => {
      const { dx, dy } = arrow(e, e.shiftKey ? 10 : 1);
      act.resizeBy(dx, dy);
    },
  },
  { id: 'move-axis', group: 'Arrange', label: 'Move along one axis', gestures: ['Shift+Drag'] },
  { id: 'resize-center', group: 'Arrange', label: 'Resize from the center / keep proportions', gestures: ['Alt+Drag handle', 'Shift+Drag handle'] },
  { id: 'draw-center', group: 'Arrange', label: 'Draw from the center / as a square', gestures: ['Alt+Draw', 'Shift+Draw'] },
  { id: 'forward', group: 'Arrange', label: 'Bring forward', keys: ['Mod+]', 'Mod+Alt+ArrowDown'], repeat: true, run: () => act.reorder(1) },
  { id: 'backward', group: 'Arrange', label: 'Send backward', keys: ['Mod+[', 'Mod+Alt+ArrowUp'], repeat: true, run: () => act.reorder(-1) },
  { id: 'front', group: 'Arrange', label: 'Bring to front', keys: MAC ? [']', 'Mod+Alt+]'] : [']', 'Mod+Shift+]', 'Mod+Alt+]'], run: () => act.reorder('front') },
  { id: 'back', group: 'Arrange', label: 'Send to back', keys: MAC ? ['[', 'Mod+Alt+['] : ['[', 'Mod+Shift+[', 'Mod+Alt+['], run: () => act.reorder('back') },
  { id: 'group', group: 'Arrange', label: 'Group', keys: ['Mod+G'], when: hasSelection, run: () => void act.wrap('Group') },
  { id: 'wrap-frame', group: 'Arrange', label: 'Wrap in frame', keys: ['Mod+Alt+G', 'Shift+F'], when: hasSelection, run: () => void act.wrap('Frame') },
  { id: 'ungroup', group: 'Arrange', label: 'Ungroup', keys: ['Mod+Shift+G', 'Mod+Backspace'], when: hasSelection, run: () => void act.ungroup() },
  { id: 'add-flex', group: 'Arrange', label: 'Add flex layout (wraps when already flex)', keys: ['Shift+A'], when: hasSelection, run: () => void act.addFlex() },
  { id: 'remove-flex', group: 'Arrange', label: 'Remove flex layout', keys: ['Alt+Shift+A'], when: hasSelection, run: act.removeFlex },
  { id: 'align-left', group: 'Arrange', label: 'Align left', keys: ['Alt+A'], when: hasSelection, run: () => act.align('left') },
  { id: 'align-right', group: 'Arrange', label: 'Align right', keys: ['Alt+D'], when: hasSelection, run: () => act.align('right') },
  { id: 'align-top', group: 'Arrange', label: 'Align top', keys: ['Alt+W'], when: hasSelection, run: () => act.align('top') },
  { id: 'align-bottom', group: 'Arrange', label: 'Align bottom', keys: ['Alt+S'], when: hasSelection, run: () => act.align('bottom') },
  { id: 'align-center-x', group: 'Arrange', label: 'Align horizontal centers', keys: ['Alt+H', 'Alt+Shift+S'], when: hasSelection, run: () => act.align('centerX') },
  { id: 'align-center-y', group: 'Arrange', label: 'Align vertical centers', keys: ['Alt+V', 'Alt+Shift+W'], when: hasSelection, run: () => act.align('centerY') },
  { id: 'distribute-x', group: 'Arrange', label: 'Distribute horizontally', keys: [MAC ? 'Ctrl+Alt+H' : 'Alt+Shift+H'], when: hasSelection, run: () => act.distribute('x') },
  { id: 'distribute-y', group: 'Arrange', label: 'Distribute vertically', keys: [MAC ? 'Ctrl+Alt+V' : 'Alt+Shift+V'], when: hasSelection, run: () => act.distribute('y') },
  { id: 'flip-x', group: 'Arrange', label: 'Flip horizontal', keys: ['Shift+H'], when: hasSelection, run: () => act.flip('x') },
  { id: 'flip-y', group: 'Arrange', label: 'Flip vertical', keys: ['Shift+V'], when: hasSelection, run: () => act.flip('y') },
  { id: 'resize-fit', group: 'Arrange', label: 'Resize to fit content', keys: ['Mod+Alt+Shift+R'], when: hasSelection, run: act.resizeToFit },
  { id: 'resize-fill', group: 'Arrange', label: 'Resize to fill the parent', keys: ['Mod+Alt+Shift+F'], when: hasSelection, run: act.resizeToFill },
  { id: 'clip', group: 'Arrange', label: 'Clip content', keys: ['Alt+C'], when: hasSelection, run: act.toggleClip },
  { id: 'swap-fill', group: 'Arrange', label: 'Swap fill and border', keys: ['Shift+X'], when: hasSelection, run: act.swapFillAndStroke },

  // ---- Text ----
  { id: 'bold', group: 'Text', label: 'Bold', keys: ['Mod+B'], when: hasSelection, run: act.toggleBold },
  { id: 'italic', group: 'Text', label: 'Italic', keys: ['Mod+I'], when: hasSelection, run: act.toggleItalic },
  { id: 'underline', group: 'Text', label: 'Underline', keys: ['Mod+U'], when: hasSelection, run: () => act.toggleDecoration('underline') },
  { id: 'strikethrough', group: 'Text', label: 'Strikethrough', keys: ['Mod+Shift+X'], when: hasSelection, run: () => act.toggleDecoration('line-through') },
  { id: 'text-left', group: 'Text', label: 'Align text left', keys: ['Mod+Alt+L'], when: hasSelection, run: () => act.alignText('left') },
  { id: 'text-center', group: 'Text', label: 'Align text center', keys: ['Mod+Alt+T'], when: hasSelection, run: () => act.alignText('center') },
  { id: 'text-right', group: 'Text', label: 'Align text right', keys: ['Mod+Alt+R'], when: hasSelection, run: () => act.alignText('right') },
  { id: 'text-justify', group: 'Text', label: 'Justify text', keys: ['Mod+Alt+J'], when: hasSelection, run: () => act.alignText('justify') },
  { id: 'font-size', group: 'Text', label: 'Font size − / +', keys: ['Mod+Shift+,', 'Mod+Shift+.'], repeat: true, when: hasSelection, run: (e) => act.textStep('fontSize', up(e)) },
  { id: 'font-weight', group: 'Text', label: 'Font weight − / +', keys: ['Mod+Alt+,', 'Mod+Alt+.'], repeat: true, when: hasSelection, run: (e) => act.textStep('fontWeight', up(e)) },
  { id: 'line-height', group: 'Text', label: 'Line height − / +', keys: ['Alt+Shift+,', 'Alt+Shift+.'], repeat: true, when: hasSelection, run: (e) => act.textStep('lineHeight', up(e)) },
  { id: 'letter-spacing', group: 'Text', label: 'Letter spacing − / +', keys: ['Alt+,', 'Alt+.'], repeat: true, when: hasSelection, run: (e) => act.textStep('letterSpacing', up(e)) },
];

/** A modal dialog is up (ours, or any other `.op-dialog-backdrop` / aria-modal dialog). */
function dialogOpen(s: EditorState): boolean {
  return s.showExport || s.showConnect || !!s.figmaPrompt || s.showShortcuts || !!document.querySelector('.op-dialog-backdrop, [aria-modal="true"]');
}

/** Spring-loaded shortcuts waiting for their key to come up (keyed by e.code). */
const releases = new Map<string, () => void>();

function releaseAll() {
  for (const release of releases.values()) release();
  releases.clear();
  pressed.clear();
}

export function useShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      pressed.add(e.code);
      if (e.isComposing) return;
      // Shift / Alt reshape a drag in progress (axis lock, duplicate, resize from the center).
      if (e.key === 'Shift' || e.key === 'Alt') refreshGesture({ shiftKey: e.shiftKey, altKey: e.altKey });
      if (isTyping(e)) return;
      const s = getState();
      if (!s.doc || s.editingTextId) return;
      if (e.key === 'Alt') e.preventDefault(); // a lone Alt focuses the browser menu on Windows
      const dialog = dialogOpen(s);
      for (const sc of SHORTCUTS) {
        if (!sc.run || !sc.keys || (dialog && !sc.global)) continue;
        if (!sc.keys.some((k) => matchBinding(k, e, MAC, sc.tolerate))) continue;
        if (sc.when && !sc.when(s)) continue;
        if (e.repeat && !sc.repeat) {
          if (!sc.native) e.preventDefault();
          return;
        }
        const result = sc.run(e, s);
        if (result === false) continue;
        if (!sc.native) e.preventDefault();
        if (typeof result === 'function') {
          releases.get(e.code)?.();
          releases.set(e.code, result);
        }
        // Keys must not also activate a focused button or checkbox.
        const focused = document.activeElement as HTMLElement | null;
        if (focused && focused !== document.body && !focused.closest('.op-dialog-backdrop')) focused.blur?.();
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      pressed.delete(e.code);
      if (e.key === 'Shift' || e.key === 'Alt') refreshGesture({ shiftKey: e.shiftKey, altKey: e.altKey });
      const release = releases.get(e.code);
      if (release) {
        releases.delete(e.code);
        release();
      }
      if (e.key === 'Alt') {
        setModes({ alt: false });
        if (!isTyping(e)) e.preventDefault();
      }
    };
    // Keys released while the window is in the background never send keyup.
    const onBlur = () => {
      releaseAll();
      cancelGesture();
      resetModes();
    };
    const onVisibility = () => document.visibilityState === 'hidden' && onBlur();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      onBlur();
    };
  }, []);
}
