import { useEffect } from 'react';
import { nodesToHtml, readerOf, FREEFORM_DISPLAY } from '@openpaper/core';
import { getState, setState, toast } from '../state/store.ts';
import { command } from '../sync/session.ts';
import { clientToWorld, elementFor, unionRects, viewportRect, worldRectOf, type Rect } from './canvas/geometry.ts';
import { isTyping } from './canvas/Canvas.tsx';

const MARKER = '<!--openpaper-->';
/** Figma puts its layers on the clipboard as a base64 payload between (figma) markers. */
const FIGMA_PAYLOAD = /\(figma\)[A-Za-z0-9+/=\s]+\(\/figma\)/;
const LOOKS_LIKE_HTML = /^\s*<[a-z!][\s\S]*>\s*$/i;

type Placement = { parentId: string; index?: number; at?: { x: number; y: number } };

/** Paste on top: into the selection's parent, right above it and at its position. */
function onTopPlacement(): Placement | null {
  const s = getState();
  const doc = s.doc;
  if (!doc) return null;
  const nodes = s.selection.map((id) => doc.nodes[id]).filter((n) => !!n?.parentId);
  if (!nodes.length) return null;
  const parentId = nodes[0]!.parentId!;
  const parent = doc.nodes[parentId]!;
  const siblings = nodes.filter((n) => n!.parentId === parentId);
  const index = Math.max(...siblings.map((n) => parent.children.indexOf(n!.id))) + 1;
  const positioned = parent.component === 'PageRoot' || parent.styles.display === FREEFORM_DISPLAY || siblings.every((n) => n!.styles.position === 'absolute');
  if (!positioned) return { parentId, index };
  const r = unionRects(nodes.map((n) => worldRectOf(n!.id)).filter((x): x is Rect => !!x));
  if (!r) return { parentId, index };
  let origin = { x: 0, y: 0 };
  if (parent.component !== 'PageRoot') {
    const pr = worldRectOf(parentId);
    const el = elementFor(parentId) as HTMLElement | null;
    if (pr) origin = { x: pr.x + (el?.clientLeft ?? 0), y: pr.y + (el?.clientTop ?? 0) };
  }
  return { parentId, index, at: { x: Math.round(r.x - origin.x), y: Math.round(r.y - origin.y) } };
}

let pasteOnTopArmed = 0;

/** Ctrl+Shift+V: the browser's paste event that follows goes on top of the selection. */
export function armPasteOnTop() {
  const armedAt = Date.now();
  pasteOnTopArmed = armedAt;
  // Some browsers send no paste event for Ctrl+Shift+V: read the clipboard instead.
  setTimeout(() => {
    if (pasteOnTopArmed !== armedAt) return;
    pasteOnTopArmed = 0;
    void readClipboardMarkup().then((html) => {
      if (html) void pasteHtml(html, onTopPlacement());
    });
  }, 250);
}

async function readClipboardMarkup(): Promise<string | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes('text/html')) {
        const html = await (await item.getType('text/html')).text();
        if (html) return html;
      }
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        if (LOOKS_LIKE_HTML.test(text)) return text;
      }
    }
  } catch {
    const text = await navigator.clipboard.readText().catch(() => '');
    if (LOOKS_LIKE_HTML.test(text)) return text;
  }
  return null;
}

/** Ctrl+Shift+R: each selected layer is replaced by the copied layers, in its place. */
export async function pasteToReplace() {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const ids = s.selection.filter((id) => doc.nodes[id]?.parentId);
  if (!ids.length) return;
  const html = await readClipboardMarkup();
  if (!html || FIGMA_PAYLOAD.test(html)) {
    toast('Copy layers first, then paste to replace');
    return;
  }
  const result = await command<{ ids: string[] }>({ type: 'insertHtml', parentId: doc.nodes[ids[0]!]!.parentId!, html: html.replace(MARKER, ''), replaceIds: ids });
  if (result.ids?.length) setState({ selection: result.ids });
}

/** Where pasted/dropped content goes: the selected frame, the selection's parent, or the page. */
function pasteTarget(): string | null {
  const s = getState();
  const doc = s.doc;
  if (!doc || !s.pageId) return null;
  const page = doc.pages[s.pageId];
  if (!page) return null;
  const first = s.selection.length === 1 ? doc.nodes[s.selection[0]!] : undefined;
  if (first?.component === 'Frame') return first.id;
  if (first?.parentId) return first.parentId;
  return page.rootId;
}

export function copySelectionAsHtml(): string | null {
  const s = getState();
  if (!s.doc || !s.selection.length) return null;
  return nodesToHtml(readerOf(s.doc), s.selection, { resolveUrl: (u) => (u.startsWith('/') ? `${location.origin}${u}` : u) });
}

async function uploadImage(file: Blob): Promise<{ url: string; width?: number; height?: number }> {
  const res = await fetch('/api/upload', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return (await res.json()) as { url: string; width?: number; height?: number };
}

/** File picker filter for everything insertImageFiles places. */
export const PLACEABLE_FILES = 'image/*,video/mp4,video/webm,.json,.lottie';

/** What a file becomes on the canvas: an image fill, a Video layer or a Lottie layer. */
function placeableKind(file: Blob): 'image' | 'video' | 'lottie' | null {
  const name = (file as File).name?.toLowerCase() ?? '';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'video/mp4' || file.type === 'video/webm' || /\.(mp4|webm)$/.test(name)) return 'video';
  if (file.type === 'application/json' || /\.(json|lottie)$/.test(name)) return 'lottie';
  return null;
}

/** Files the canvas can place (images, MP4/WebM video, Lottie JSON or .lottie). */
export function placeableFiles(files: Iterable<File>): File[] {
  return [...files].filter((f) => placeableKind(f) !== null);
}

/** Upload images, videos and Lottie files and place them: images as image-filled rectangles, the others as layers that play. */
export async function insertImageFiles(files: Blob[], clientPoint?: { x: number; y: number }) {
  const target = pasteTarget();
  const s = getState();
  if (!target || !s.doc) return;
  const parent = s.doc.nodes[target]!;
  const freeform = parent.component === 'PageRoot' || parent.styles.display === FREEFORM_DISPLAY;
  const vr = viewportRect();
  const at = clientPoint ?? { x: vr.left + vr.width / 2, y: vr.top + vr.height / 2 };
  let world = clientToWorld(at.x, at.y);
  if (parent.component !== 'PageRoot') {
    const pr = worldRectOf(parent.id);
    if (pr) world = { x: world.x - pr.x, y: world.y - pr.y };
  }
  const ids: string[] = [];
  for (const file of files) {
    const kind = placeableKind(file);
    if (!kind) continue;
    try {
      const up = await uploadImage(file);
      let w = up.width ?? (kind === 'video' ? 640 : kind === 'lottie' ? 300 : 400);
      let h = up.height ?? (kind === 'video' ? 360 : 300);
      const max = 800;
      if (w > max || h > max) {
        const k = max / Math.max(w, h);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const styles: Record<string, string> =
        kind === 'image'
          ? { width: `${w}px`, height: `${h}px`, backgroundImage: `url("${up.url}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }
          : { width: `${w}px`, height: `${h}px` };
      if (freeform) Object.assign(styles, { left: `${Math.round(world.x - w / 2)}px`, top: `${Math.round(world.y - h / 2)}px` });
      const name = (file as File).name?.replace(/\.[^.]+$/, '') || (kind === 'video' ? 'Video' : kind === 'lottie' ? 'Lottie' : 'Image');
      const result = await command<{ ids: string[] }>({
        type: 'createNodes',
        parentId: target,
        nodes: [kind === 'image' ? { component: 'Rectangle', label: name, styles } : { component: kind === 'video' ? 'Video' : 'Lottie', label: name, styles, src: up.url }],
      });
      ids.push(...result.ids);
      world = { x: world.x + 24, y: world.y + 24 };
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Upload failed');
    }
  }
  if (ids.length) setState({ selection: ids, tool: 'select' });
}

async function pasteHtml(html: string, placement: Placement | null = null) {
  const target = placement?.parentId ?? pasteTarget();
  if (!target) return;
  const result = await command<{ ids: string[] }>({
    type: 'insertHtml',
    parentId: target,
    html: html.replace(MARKER, ''),
    ...(placement ? { index: placement.index, at: placement.at } : {}),
  });
  if (result.ids?.length) setState({ selection: result.ids });
}

async function pasteText(text: string) {
  const target = pasteTarget();
  const s = getState();
  if (!target || !s.doc) return;
  const parent = s.doc.nodes[target]!;
  const freeform = parent.component === 'PageRoot' || parent.styles.display === FREEFORM_DISPLAY;
  const vr = viewportRect();
  let world = clientToWorld(vr.left + vr.width / 2, vr.top + vr.height / 2);
  if (parent.component !== 'PageRoot') {
    const pr = worldRectOf(parent.id);
    if (pr) world = { x: world.x - pr.x, y: world.y - pr.y };
  }
  const result = await command<{ ids: string[] }>({
    type: 'createNodes',
    parentId: target,
    nodes: [
      {
        component: 'Text',
        textValue: text,
        styles: {
          fontSize: '16px',
          lineHeight: '24px',
          color: '#000000',
          fontFamily: 'system-ui, sans-serif',
          ...(freeform ? { left: `${Math.round(world.x)}px`, top: `${Math.round(world.y)}px`, maxWidth: '480px' } : {}),
        },
      },
    ],
  });
  if (result.ids?.length) setState({ selection: result.ids });
}

/** Copy/cut/paste and drag-and-drop of images, HTML and text. */
export function useClipboard() {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isTypingTarget(e)) return;
      const html = copySelectionAsHtml();
      if (!html) return;
      e.preventDefault();
      e.clipboardData?.setData('text/html', `${MARKER}${html}`);
      e.clipboardData?.setData('text/plain', html);
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTypingTarget(e)) return;
      const ids = getState().selection;
      onCopy(e);
      if (ids.length) void command({ type: 'delete', nodeIds: ids });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e) || !getState().doc) return;
      const data = e.clipboardData;
      if (!data) return;
      const onTop = pasteOnTopArmed && Date.now() - pasteOnTopArmed < 1000 ? onTopPlacement() : null;
      pasteOnTopArmed = 0;
      const files = placeableFiles(data.files);
      if (files.length) {
        e.preventDefault();
        void insertImageFiles(files);
        return;
      }
      const html = data.getData('text/html');
      const text = data.getData('text/plain');
      if (html && FIGMA_PAYLOAD.test(html)) {
        e.preventDefault();
        const target = pasteTarget();
        // The decoder (kiwi + decompression) loads only when Figma layers are pasted.
        if (target) void import('./figma/figmaPaste.ts').then((m) => m.pasteFigma(html, target));
        return;
      }
      if (html && (html.includes(MARKER) || /<(div|section|svg|img|span|p|h[1-6]|button|a|x-shader)\b/i.test(html))) {
        e.preventDefault();
        void pasteHtml(html, onTop);
        return;
      }
      if (text && LOOKS_LIKE_HTML.test(text)) {
        e.preventDefault();
        void pasteHtml(text, onTop);
        return;
      }
      if (text) {
        e.preventDefault();
        void pasteText(text);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = placeableFiles(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void insertImageFiles(files, { x: e.clientX, y: e.clientY });
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
}

function isTypingTarget(e: Event): boolean {
  return isTyping(e);
}
