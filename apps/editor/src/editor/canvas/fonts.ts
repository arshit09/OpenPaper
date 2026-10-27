import { useEffect } from 'react';
import { useEditor } from '../../state/store.ts';
import { client } from '../../sync/session.ts';

const loaded = new Set<string>();

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
    for (const href of urls) {
      if (document.querySelector(`link[data-op-font="${CSS.escape(href)}"]`)) continue;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.dataset.opFont = href;
      document.head.appendChild(link);
    }
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
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadMissingFonts();
      }, 150);
    };
    if (useEditor.getState().doc) schedule();
    const unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.doc && (s.doc.nodes !== prev.doc?.nodes || s.doc.tokens !== prev.doc?.tokens)) schedule();
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
