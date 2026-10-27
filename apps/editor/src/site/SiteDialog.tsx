import { useEffect, useState } from 'react';
import { AppWindow, Check, FolderOpen, Loader2, X } from 'lucide-react';
import type { SiteInfo } from '@openpaper/core';
import { toast } from '../state/store.ts';
import { client } from '../sync/session.ts';
import { normalizeSiteUrl } from './inspector.ts';

interface FolderInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  name: string;
  framework?: string;
  hasGit: boolean;
}

const FOLDER_EXAMPLE = /Windows/.test(navigator.userAgent) ? 'C:\\Projects\\my-site' : '~/Projects/my-site';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Add a live site (its dev server URL + project folder), or edit one. */
export function SiteDialog({ site, onClose, onSaved }: { site?: SiteInfo; onClose: () => void; onSaved: (site: SiteInfo) => void }) {
  const [url, setUrl] = useState(site?.url ?? '');
  const [folder, setFolder] = useState(site?.folder ?? '');
  const [reach, setReach] = useState<'checking' | 'up' | 'down' | null>(null);
  const [detected, setDetected] = useState<string | null>(null);
  /** What `sites.inspectFolder` said about the folder as typed (`query`). */
  const [checked, setChecked] = useState<{ query: string; info: FolderInfo } | null>(null);
  const [busy, setBusy] = useState(false);
  const normalized = normalizeSiteUrl(url);
  const debouncedUrl = useDebounced(normalized, 400);
  const debouncedFolder = useDebounced(folder.trim(), 300);

  // Is the dev server up, and which folder is it serving from (when we can tell)?
  useEffect(() => {
    if (!debouncedUrl) return setReach(null);
    let live = true;
    setReach('checking');
    client
      .request<{ reachable: boolean }>('sites.probe', { url: debouncedUrl })
      .then((r) => live && setReach(r.reachable ? 'up' : 'down'))
      .catch(() => live && setReach(null));
    client
      .request<{ folder: string | null }>('sites.detect', { url: debouncedUrl })
      .then(({ folder: found }) => {
        if (!live) return;
        setDetected(found);
        if (found) setFolder((f) => f || found);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [debouncedUrl]);

  useEffect(() => {
    if (!debouncedFolder) return setChecked(null);
    let live = true;
    client
      .request<FolderInfo>('sites.inspectFolder', { path: debouncedFolder })
      .then((info) => live && setChecked({ query: debouncedFolder, info }))
      .catch(() => live && setChecked(null));
    return () => {
      live = false;
    };
  }, [debouncedFolder]);

  const info = checked && checked.query === folder.trim() ? checked.info : null;
  const folderOk = !!info && info.exists && info.isDirectory;
  const canSave = !!normalized && folderOk && !busy;

  async function browse() {
    try {
      const picked = await client.request<string | null>('sites.pickFolder', { start: folder.trim() || detected || undefined });
      if (picked) setFolder(picked);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const saved = site
        ? await client.request<SiteInfo>('sites.update', { id: site.id, url: normalized, folder: info!.path })
        : await client.request<SiteInfo>('sites.create', { url: normalized, folder: info!.path });
      onSaved(saved);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="op-dialog"
        role="dialog"
        aria-label={site ? 'Edit live site' : 'Open a live site'}
        style={{ width: 'min(520px, 100%)' }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header>
          <span>
            <AppWindow size={16} /> {site ? 'Edit live site' : 'Open your live site'}
          </span>
          <button type="button" className="op-icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, color: 'var(--op-text-2)', lineHeight: 1.55 }}>
            Open the site you're building, click any element on it, and tell the agent what to change, by typing or speaking.
            Claude Code edits the code in your project folder, and your dev server reloads the page.
          </p>
          <label className="op-field">
            <span className="op-label">Site address (your running dev server)</span>
            <input className="op-input" autoFocus placeholder="http://localhost:5173" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
            <span className="op-label op-site-hint">
              {!url.trim() ? (
                'Start your dev server first (npm run dev, or similar), then paste its address.'
              ) : !normalized ? (
                <span style={{ color: 'var(--op-danger)' }}>That isn't a web address.</span>
              ) : reach === 'checking' ? (
                <>
                  <Loader2 size={11} className="op-spin" /> Checking…
                </>
              ) : reach === 'up' ? (
                <>
                  <Check size={11} style={{ color: 'var(--op-success)' }} /> The site is up.
                </>
              ) : reach === 'down' ? (
                "Nothing answers there yet. You can still add it and start the server later."
              ) : null}
            </span>
          </label>
          <label className="op-field">
            <span className="op-label">Project folder (where the agent edits code)</span>
            <div className="op-row">
              <input className="op-input" placeholder={FOLDER_EXAMPLE} value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} />
              <button type="button" className="op-btn" onClick={() => void browse()}>
                <FolderOpen size={14} /> Browse…
              </button>
            </div>
            <span className="op-label op-site-hint">
              {!folder.trim() ? (
                'Pick the folder with your project, usually the one with package.json.'
              ) : !info ? null : !info.exists ? (
                <span style={{ color: 'var(--op-danger)' }}>That folder doesn't exist.</span>
              ) : !info.isDirectory ? (
                <span style={{ color: 'var(--op-danger)' }}>That's a file, not a folder.</span>
              ) : (
                <>
                  <Check size={11} style={{ color: 'var(--op-success)' }} /> {info.name}
                  {info.framework ? ` · ${info.framework}` : ''}
                  {detected && detected === info.path ? ' · the folder this dev server runs from' : ''}
                </>
              )}
            </span>
          </label>
          <div className="footer">
            <button type="button" className="op-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="op-btn primary" disabled={!canSave}>
              {busy ? <Loader2 size={14} className="op-spin" /> : null} {site ? 'Save' : 'Open site'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
