import { useState } from 'react';
import { X } from 'lucide-react';
import { setState, toast, useEditor } from '../../state/store.ts';
import { client } from '../../sync/session.ts';
import { useEscape } from '../../ui/useEscape.ts';
import type { FigmaTokenChoice } from './figmaPaste.ts';

/** Shown when pasted Figma layers have image fills and no Figma token is configured. */
export function FigmaTokenDialog() {
  const prompt = useEditor((s) => s.figmaPrompt);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const done = (choice: FigmaTokenChoice) => {
    prompt?.resolve(choice);
    setState({ figmaPrompt: null });
    setToken('');
  };
  // Escape cancels the paste (it is waiting on this answer).
  useEscape(() => done('cancel'), !!prompt);
  if (!prompt) return null;
  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done('cancel')}>
      <div className="op-dialog" role="dialog" aria-modal="true" aria-label="Bring over Figma images" style={{ width: 440 }}>
        <header>
          <span>Bring over Figma images</span>
          <button className="op-icon-btn" title="Cancel paste" aria-label="Cancel paste" onClick={() => done('cancel')}>
            <X size={16} />
          </button>
        </header>
        <form
          className="body"
          style={{ display: 'flex', flexDirection: 'column', gap: 12, lineHeight: 1.5 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!token.trim()) return;
            setBusy(true);
            try {
              await client.request('figma.config.set', { token: token.trim() });
              done('with-images');
            } catch (error) {
              toast(error instanceof Error ? error.message : 'Could not save the token');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            This selection has {prompt.images} image{prompt.images === 1 ? '' : 's'}. Figma only puts references to images on the clipboard, so
            OpenPaper downloads them from Figma with your personal access token.
          </div>
          <div className="op-label">
            Create one in Figma → Settings → Security → Personal access tokens, with read-only access to file content. It's stored only on this
            computer (~/.openpaper/config.json). You can also set FIGMA_TOKEN.
          </div>
          <label className="op-field">
            <span className="op-label">Personal access token</span>
            <input className="op-input" type="password" placeholder="figd_…" value={token} autoFocus onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </label>
          <div className="footer" style={{ marginTop: 4 }}>
            <button type="button" className="op-btn outline" onClick={() => done('without-images')}>
              Paste without images
            </button>
            <button type="submit" className="op-btn primary" disabled={busy || !token.trim()}>
              Save & paste
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
