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

/** Load Google Fonts used by the open document (same stylesheets as headless renders). */
export function useDocumentFonts() {
  const doc = useEditor((s) => s.doc);
  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(async () => {
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
    }, 150);
    return () => clearTimeout(timer);
  }, [doc]);
}
