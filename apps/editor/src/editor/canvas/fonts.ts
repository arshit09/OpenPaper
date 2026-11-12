import { useEffect } from 'react';
import { useEditor } from '../../state/store.ts';
import { client } from '../../sync/session.ts';

const loaded = new Set<string>();

/** The font load in progress (scheduled or running), for {@link fontsSettled}. */
let pending: { promise: Promise<void>; resolve: () => void } | null = null;

/**
 * Resolves once the open document's font stylesheets have loaded and the faces they declare are
 * ready (a failed or offline load resolves too). The file loader waits on it before showing frames.
 */
export async function fontsSettled(): Promise<void> {
  if (pending) await pending.promise;
  await document.fonts.ready;
}

/** Families referenced by node styles and font tokens. */
function familiesInDoc(): string[] {
  const doc = useEditor.getState().doc;
  if (!doc) return [];
  const out = new Set<string>();
  const add = (value: string) => {
    for (const part of value.split(',')) {
      const fam = part.trim().replace(/^["']|["']$/g, '');
      if (fam && !fam.startsWith('var(')) out.add(fam);
    }
  };
  for (const n of Object.values(doc.nodes)) if (n.styles.fontFamily) add(n.styles.fontFamily);
  for (const t of doc.tokens) if (t.type === 'fontFamily') add(t.value);
  return [...out];
}

async function loadMissingFonts() {
  const families = familiesInDoc().filter((f) => !loaded.has(f));
  if (!families.length) return;
  for (const f of families) loaded.add(f);
  try {
    const urls = await client.request<string[]>('fonts.css', { families });
    const sheets: Promise<void>[] = [];
    for (const href of urls) {
      if (document.querySelector(`link[data-op-font="${CSS.escape(href)}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.opFont = href;
      sheets.push(new Promise((resolve) => (link.onload = link.onerror = () => resolve())));
      document.head.appendChild(link);
    }
    await Promise.all(sheets);
  } catch {
    for (const f of families) loaded.delete(f);
  }
}

/**
 * Load Google Fonts used by the open document (same stylesheets as headless renders). Watches the
 * store directly: as a selector, the document would re-render the whole canvas on every patch.
 */
export function useDocumentFonts() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Edits are batched; a newly opened file's fonts are asked for at once (the file loader waits on them).
    const schedule = (delay = 150) => {
      if (timer) clearTimeout(timer);
      if (!pending) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        pending = { promise, resolve };
      }
      timer = setTimeout(() => {
        timer = null;
        const settling = pending;
        void loadMissingFonts().finally(() => {
          // A newer change scheduled another load meanwhile: that one settles it.
          if (pending === settling && !timer) pending = null;
          if (!timer) settling?.resolve();
        });
      }, delay);
    };
    if (useEditor.getState().doc) schedule(0);
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.doc && (s.doc.nodes !== prev.doc?.nodes || s.doc.tokens !== prev.doc?.tokens)) schedule(s.doc.id !== prev.doc?.id ? 0 : 150);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      pending?.resolve();
      pending = null;
    };
  }, []);
}
