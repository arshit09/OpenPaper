import { useEffect, useState } from 'react';
import { ArrowDownToLine, X } from 'lucide-react';

/**
 * What the Windows desktop app hands the editor: its version, and a newer one when GitHub has it. The app sets
 * `window.__openpaperDesktop` on every editor load and fires `openpaper-desktop` when it changes; navigating to
 * /desktop/update asks it to update (it cancels that navigation). In a browser there's no app and no notice.
 */
type DesktopInfo = {
  version: string;
  update: null | {
    version: string;
    /** The release notes on GitHub. */
    notes: string;
    /** `starting`: the app is downloading Setup, which then takes over. */
    state: 'available' | 'starting' | 'failed';
    error?: string;
  };
};

declare global {
  interface Window {
    __openpaperDesktop?: DesktopInfo;
  }
}

/** "Not now" lasts until OpenPaper restarts (the window's session), then the notice comes back. */
const DISMISSED = 'op-update-dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISSED);
  } catch {
    return null;
  }
}

export function UpdateNotice() {
  const [info, setInfo] = useState(() => window.__openpaperDesktop);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    const onInfo = () => setInfo(window.__openpaperDesktop);
    window.addEventListener('openpaper-desktop', onInfo);
    onInfo();
    return () => window.removeEventListener('openpaper-desktop', onInfo);
  }, []);

  if (!info?.update) return null;
  const { update, version } = info;
  if (update.state === 'available' && dismissed === update.version) return null;
  const starting = update.state === 'starting';
  const failed = update.state === 'failed';

  function dismiss() {
    setDismissed(update.version);
    try {
      sessionStorage.setItem(DISMISSED, update.version);
    } catch {}
  }

  return (
    <div className="op-update" role="status" aria-live="polite">
      <div className="op-update-head">
        <ArrowDownToLine size={14} className="op-update-icon" />
        <span className="op-update-title">OpenPaper {update.version} is available</span>
        {!starting && (
          <button type="button" className="op-icon-btn" onClick={dismiss} title="Not now" aria-label="Not now">
            <X size={14} />
          </button>
        )}
      </div>
      <p className={failed ? 'op-update-text op-update-error' : 'op-update-text'}>
        {starting
          ? 'Downloading the update. Setup opens in a moment.'
          : failed
            ? (update.error ?? 'The update couldn’t start.')
            : `You have ${version}. Updating takes about a minute, then OpenPaper opens again.`}
      </p>
      <div className="op-update-actions">
        <a className="op-btn outline" href={update.notes} target="_blank" rel="noreferrer">
          What’s new
        </a>
        <button type="button" className="op-btn primary" disabled={starting} onClick={() => location.assign('/desktop/update')}>
          {starting ? 'Updating…' : failed ? 'Try again' : 'Update'}
        </button>
      </div>
    </div>
  );
}
