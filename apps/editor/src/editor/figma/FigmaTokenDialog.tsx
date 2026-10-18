import { useState } from 'react';
import { X } from 'lucide-react';
import { setState, toast, useEditor } from '../../state/store.ts';
import { client } from '../../sync/session.ts';
import type { FigmaTokenChoice } from './figmaPaste.ts';

/** Shown when pasted Figma layers have image fills and no Figma token is configured. */
export function FigmaTokenDialog() {
  const prompt = useEditor((s) => s.figmaPrompt);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  if (!prompt) return null;
  const done = (choice: FigmaTokenChoice) => {
    prompt.resolve(choice);
    setState({ figmaPrompt: null });
    setToken('');
  };
  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done('cancel')}>
      <div className="op-dialog" style={{ width: 440 }}>
        <header>
          <span>Bring over Figma images</span>
          <button className="op-icon-btn" onClick={() => done('cancel')}>
            <X size={16} />
          </button>
        </header>
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 12, lineHeight: 1.5 }}>
          <div>
            This selection has {prompt.images} image{prompt.images === 1 ? '' : 's'}. Figma only puts references to images on the clipboard, so
            OpenPaper downloads them from Figma with your personal access token.
          </div>
          <div className="op-label">
            Create one in Figma → Settings → Security → Personal access tokens, with read-only access to file content. It's stored only on this
            computer (~/.openpaper/config.json). You can also set FIGMA_TOKEN.
          </div>
          <form
            className="op-row"
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
            <input className="op-input" type="password" placeholder="figd_…" value={token} autoFocus onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button className="op-btn primary" disabled={busy || !token.trim()}>
              Save & paste
            </button>
          </form>
          <div className="op-row" style={{ justifyContent: 'flex-end' }}>
            <button className="op-btn" onClick={() => done('without-images')}>
              Paste without images
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
