import { useEffect } from 'react';
import { nodesToHtml, readerOf, FREEFORM_DISPLAY } from '@openpaper/core';
import { getState, setState, toast } from '../state/store.ts';
import { command } from '../sync/session.ts';
import { clientToWorld, viewportRect, worldRectOf } from './canvas/geometry.ts';
import { isTyping } from './canvas/Canvas.tsx';

const MARKER = '<!--openpaper-->';
/** Figma puts its layers on the clipboard as a base64 payload between (figma) markers. */
const FIGMA_PAYLOAD = /\(figma\)[A-Za-z0-9+/=\s]+\(\/figma\)/;

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

/** Upload images and place them as image-filled rectangles. */
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
    if (!file.type.startsWith('image/')) continue;
    try {
      const up = await uploadImage(file);
      let w = up.width ?? 400;
      let h = up.height ?? 300;
      const max = 800;
      if (w > max || h > max) {
        const k = max / Math.max(w, h);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const styles: Record<string, string> = {
        width: `${w}px`,
        height: `${h}px`,
        backgroundImage: `url("${up.url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      };
      if (freeform) Object.assign(styles, { left: `${Math.round(world.x - w / 2)}px`, top: `${Math.round(world.y - h / 2)}px` });
      const name = (file as File).name?.replace(/\.[^.]+$/, '') || 'Image';
      const result = await command<{ ids: string[] }>({
        type: 'createNodes',
        parentId: target,
        nodes: [{ component: 'Rectangle', label: name, styles }],
      });
      ids.push(...result.ids);
      world = { x: world.x + 24, y: world.y + 24 };
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Image upload failed');
    }
  }
  if (ids.length) setState({ selection: ids, tool: 'select' });
}

async function pasteHtml(html: string) {
  const target = pasteTarget();
  if (!target) return;
  const result = await command<{ ids: string[] }>({ type: 'insertHtml', parentId: target, html: html.replace(MARKER, '') });
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
      const files = [...data.files].filter((f) => f.type.startsWith('image/'));
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
        void pasteHtml(html);
        return;
      }
      if (text && /^\s*<[a-z!][\s\S]*>\s*$/i.test(text)) {
        e.preventDefault();
        void pasteHtml(text);
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
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
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
  return isTyping(e as unknown as KeyboardEvent);
}
