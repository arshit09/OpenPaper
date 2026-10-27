import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { setState, useEditor } from '../state/store.ts';
import { MAC, SHORTCUTS, SHORTCUT_GROUPS, type Shortcut } from './shortcuts.ts';
import { bindingLabel, formatBinding, matchBinding } from './hotkeys.ts';
import { isTyping } from './canvas/Canvas.tsx';
import '../styles/shortcuts.css';

const GESTURE = /drag|click|scroll|pinch|draw|canvas|handle/i;

/** Key combos to show for a shortcut, platform-formatted and without duplicates (Mod = Ctrl off macOS). */
function combos(sc: Shortcut): string[][] {
  const seen = new Set<string>();
  return [...(sc.show ?? sc.keys ?? []), ...(sc.gestures ?? [])]
    .filter((k) => {
      const label = bindingLabel(k, MAC);
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    })
    .map((k) => formatBinding(k, MAC));
}

function matches(sc: Shortcut, q: string): boolean {
  return !q || sc.label.toLowerCase().includes(q) || combos(sc).some((c) => c.join(' ').toLowerCase().includes(q));
}

/** Keyboard shortcuts help (Ctrl+Shift+? or Ctrl+/), generated from the shortcut registry. */
export function ShortcutsDialog() {
  const open = useEditor((s) => s.showShortcuts);
  return open ? <Dialog /> : null;
}

function Dialog() {
  const [query, setQuery] = useState('');
  const close = () => setState({ showShortcuts: false });

  useEffect(() => {
    const help = SHORTCUTS.find((sc) => sc.id === 'help')!;
    const onKey = (e: KeyboardEvent) => {
      // The search field has focus, so the regular key handler stays out of the way.
      if (e.key !== 'Escape' && !(isTyping(e) && help.keys!.some((k) => matchBinding(k, e, MAC)))) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const q = query.trim().toLowerCase();
  const groups = SHORTCUT_GROUPS.map((group) => ({ group, items: SHORTCUTS.filter((sc) => sc.group === group && matches(sc, q)) })).filter((g) => g.items.length);

  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="op-dialog op-shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <header>
          <span>Keyboard shortcuts</span>
          <label className="op-shortcuts-search">
            <Search size={13} />
            <input className="op-input" autoFocus placeholder="Search shortcuts" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="op-icon-btn" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <div className="body">
          <div className="op-shortcuts-cols">
            {groups.map(({ group, items }) => (
              <section key={group} className="op-shortcuts-group">
                <h3>{group}</h3>
                {items.map((sc) => (
                  <div key={sc.id} className="op-shortcuts-row">
                    <span className="label">{sc.label}</span>
                    <span className="keys">
                      {sc.hold && <span className="hold">Hold</span>}
                      {combos(sc).map((caps, i) => (
                        <span key={i} className="combo">
                          {caps.map((cap, j) =>
                            GESTURE.test(cap) ? (
                              <span key={j} className="gesture">
                                {cap}
                              </span>
                            ) : (
                              <kbd key={j}>{cap}</kbd>
                            )
                          )}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
          </div>
          {!groups.length && <div className="op-empty">No shortcut matches “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}
