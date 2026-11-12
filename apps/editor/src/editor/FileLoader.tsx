import { useEffect, useRef, useState } from 'react';
import { getState, setState, useEditor } from '../state/store.ts';
import { LoadingMark } from '../ui/Logo.tsx';
import { fontsSettled } from './canvas/fonts.ts';
import { getViewportElement } from './canvas/geometry.ts';

/** Longest wait for fonts and images: the frames are shown then even if some are still loading. */
const MEDIA_WAIT_MS = 3000;
/** The mark fades in this long after the loader appears (`.op-loader-body`), so quick opens never show it… */
const MARK_DELAY_MS = 200;
/** …and once it has, it stays at least this long rather than flashing. */
const MARK_MIN_MS = 300;
/** The bar's last stretch, then the loader's fade (`.op-loader.leaving`). */
const FINISH_MS = 160;
const FADE_MS = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function loaded(el: HTMLElement, events: string[]): Promise<void> {
  return new Promise((resolve) => {
    for (const type of events) el.addEventListener(type, () => resolve(), { once: true });
  });
}

/** The page's images, background images and videos that haven't loaded yet. */
function pendingMedia(): Promise<void>[] {
  const root = getViewportElement();
  if (!root) return [];
  const waits: Promise<void>[] = [];
  for (const img of root.querySelectorAll('img')) if (!img.complete) waits.push(loaded(img, ['load', 'error']));
  for (const video of root.querySelectorAll('video')) if (video.src && video.readyState < 2) waits.push(loaded(video, ['loadeddata', 'error']));
  const urls = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>('[style*="url("]')) {
    for (const [, , url] of el.style.backgroundImage.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) if (url && !url.startsWith('data:')) urls.add(url);
  }
  for (const url of urls) {
    // The same request as the background's, from the cache when it has already arrived.
    const img = new Image();
    img.src = url;
    waits.push(img.decode().catch(() => {}));
  }
  return waits;
}

/**
 * Covers the editor while a file opens: the peeling mark and a progress bar, until the file's frames
 * are on screen with their fonts and images. The bar follows real steps: it creeps while the server
 * reads the file (that request has no progress of its own), steps when the document arrives and when
 * the canvas has painted it, and fills as fonts and images finish.
 */
function LoaderOverlay({ fileId }: { fileId: string | null }) {
  const name = useEditor((s) => (fileId ? s.resources.find((r) => r.id === fileId)?.name : undefined));
  const fill = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const shownAt = useRef(performance.now());
  const [leaving, setLeaving] = useState<boolean | 'quick'>(false);

  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    const cleanups: (() => void)[] = [];
    setLeaving(false);

    const progress = (to: number, ms: number, ease = 'cubic-bezier(0.2, 0, 0, 1)') => {
      const el = fill.current;
      if (!el) return;
      el.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none';
      el.style.transform = `scaleX(${to})`;
      bar.current?.setAttribute('aria-valuenow', String(Math.round(to * 100)));
    };
    const documentShown = () =>
      new Promise<void>((resolve) => {
        if (getState().doc?.id === fileId) return resolve();
        const unsubscribe = useEditor.subscribe((s) => {
          if (s.doc?.id === fileId) {
            unsubscribe();
            resolve();
          }
        });
        cleanups.push(unsubscribe);
      });

    void (async () => {
      progress(0, 0);
      void fill.current?.offsetWidth; // start the creep from empty
      // Quick at first, then ever slower, so even a long read never looks stuck (~20% at 1 s, ~38% at 4 s).
      progress(0.45, 12000, 'cubic-bezier(0.08, 0.7, 0.2, 1)');
      await documentShown();
      if (cancelled) return;
      progress(0.5, 250);
      // The canvas lays the page out and paints it (its camera is set before that first paint).
      await nextFrame();
      await nextFrame();
      if (cancelled) return;
      progress(0.6, 250);
      const waits = [fontsSettled(), ...pendingMedia()];
      let done = 0;
      const step = () => {
        if (!cancelled) progress(0.6 + (0.35 * ++done) / waits.length, 250);
      };
      await Promise.race([Promise.all(waits.map((w) => w.then(step, step))), sleep(MEDIA_WAIT_MS)]);
      if (cancelled) return;
      const shown = performance.now() - shownAt.current;
      if (shown < MARK_DELAY_MS) {
        // Ready before the mark appeared: just uncover the editor.
        setLeaving('quick');
      } else {
        if (shown < MARK_DELAY_MS + MARK_MIN_MS) await sleep(MARK_DELAY_MS + MARK_MIN_MS - shown);
        if (cancelled) return;
        progress(1, FINISH_MS);
        await sleep(FINISH_MS);
        if (cancelled) return;
        setLeaving(true);
      }
      await sleep(FADE_MS);
      if (!cancelled && getState().opening?.fileId === fileId) setState({ opening: null });
    })();

    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [fileId]);

  return (
    <div className={`op-loader${leaving ? ' leaving' : ''}${leaving === 'quick' ? ' quick' : ''}`} role="status" aria-label={name ? `Opening ${name}` : 'Opening file'}>
      <div className="op-loader-body">
        <LoadingMark size={48} />
        <div ref={bar} className="op-loader-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
          <div ref={fill} className="op-loader-fill" />
        </div>
      </div>
    </div>
  );
}

/** The loader, while a file is opening or none is on screen yet. Keep it at one place in the tree: remounting restarts the mark. */
export function FileLoader() {
  const fileId = useEditor((s) => s.opening?.fileId ?? null);
  const hasDoc = useEditor((s) => !!s.doc);
  if (!fileId && hasDoc) return null;
  return <LoaderOverlay fileId={fileId} />;
}
