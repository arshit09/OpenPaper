import { useState } from 'react';
import { ExternalLink, Globe, History, RotateCcw } from 'lucide-react';
import { toast, useEditor } from '../state/store.ts';
import { client } from '../sync/session.ts';
import { timeAgo } from './panels/VersionPanel.tsx';

/** Over the canvas while an older version is shown: what it is, and the way back. */
export function VersionBanner() {
  const preview = useEditor((s) => s.preview);
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const { commit } = preview;
  const fileId = preview.live.doc.id;
  const back = () => (location.hash = `#/file/${fileId}`);

  async function restore() {
    setBusy(true);
    try {
      await client.request('vcs.restore', { fileId, commit: commit.hash });
      back();
      toast(`Restored “${commit.subject}”. Undo to go back.`, 4000);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 5000);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="op-banner op-version-banner" role="status">
      <History size={14} className="op-version-banner-icon" />
      <span title={`${commit.subject}\n${commit.author}, ${new Date(commit.date).toLocaleString()} · ${commit.short}\nRead-only: restore it to make it the current version.`}>
        <b>{commit.subject}</b>
        <span className="op-label">
          {' '}
          · {commit.author}, {timeAgo(commit.date)} · read-only
        </span>
      </span>
      <button type="button" className="op-btn primary" disabled={busy} onClick={() => void restore()} title="Make this the current version (undo brings back what's there now)">
        <RotateCcw size={13} /> Restore
      </button>
      <a className="op-icon-btn" href={`#/file/${fileId}/version/${commit.hash}`} target="_blank" rel="noopener" title="Open this version in a new tab">
        <ExternalLink size={14} />
      </a>
      {commit.url && (
        <a className="op-icon-btn" href={commit.url} target="_blank" rel="noreferrer" title="See this commit on GitHub">
          <Globe size={14} />
        </a>
      )}
      <button type="button" className="op-btn" onClick={back}>
        Back to current
      </button>
    </div>
  );
}
