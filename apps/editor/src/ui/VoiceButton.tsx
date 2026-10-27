import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mic, Square, X } from 'lucide-react';
import type { SpeechStatus } from '@openpaper/core';
import { getState, toast, useEditor } from '../state/store.ts';
import { hasSpeech, installSpeech, preloadSpeech, refreshSpeechStatus, startRecording, transcribe, type Recording } from './voice.ts';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing';

/** Held this long, the mic records until it's released (push-to-talk); a quick click toggles instead. */
const HOLD_MS = 400;

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

function SetupPanel({ status, anchor, onClose }: { status: SpeechStatus | null; anchor: HTMLElement; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  // Right-aligned to the mic, above the box holding it (prompt or dock); below when there's no room.
  useLayoutEffect(() => {
    const mic = anchor.getBoundingClientRect();
    const r = (anchor.closest('[data-voice-box]') ?? anchor).getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const right = Math.max(8, innerWidth - mic.right - 6);
    setPos(r.top - h - 8 > 8 ? { right, bottom: innerHeight - r.top + 8 } : { right, top: r.bottom + 8 });
  }, [anchor, status?.state]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [anchor, onClose]);

  const state = status?.state;
  const pct = status && status.sizeBytes ? Math.round((status.downloadedBytes / status.sizeBytes) * 100) : 0;
  return createPortal(
    <div ref={ref} className="op-voice-panel" role="dialog" aria-label="Voice input" style={pos} onPointerDown={(e) => e.stopPropagation()}>
      <div className="op-row" style={{ gap: 6 }}>
        <Mic size={14} style={{ flexShrink: 0 }} />
        <b style={{ flex: 1 }}>Talk to the agent</b>
        <button className="op-icon-btn small" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {!status ? (
        <div className="op-label">Checking voice input…</div>
      ) : state === 'unavailable' ? (
        <div className="op-label">Voice input isn't available on this computer{status.error ? `: ${status.error}` : '.'}</div>
      ) : state === 'downloading' ? (
        <>
          <div className="op-label">
            Downloading {status.engine}… {pct}% ({mb(status.downloadedBytes)} of {mb(status.sizeBytes)})
          </div>
          <div className="op-progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="op-label">You can keep working. The mic is ready when this finishes.</div>
        </>
      ) : state === 'ready' || state === 'loading' ? (
        <div className="op-label">Ready. Click the mic and speak, or hold it down while you talk.</div>
      ) : (
        <>
          <div className="op-label" style={{ lineHeight: 1.5 }}>
            Speak instead of typing. {status.engine} turns your voice into text on this computer, so your audio never leaves it.
            It needs a one-time {mb(status.sizeBytes)} download.
          </div>
          {state === 'error' && status.error && <div style={{ color: 'var(--op-danger)', fontSize: 11.5 }}>{status.error}</div>}
          <div className="op-row" style={{ justifyContent: 'flex-end' }}>
            <button className="op-btn" onClick={onClose}>
              Not now
            </button>
            <button className="op-btn primary" onClick={() => void installSpeech().catch((e) => toast(e instanceof Error ? e.message : String(e)))}>
              {state === 'error' ? 'Try again' : `Download (${mb(status.sizeBytes)})`}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

/**
 * Mic button: speech is transcribed locally by the server and handed to `onText`.
 * Click to start and click again to stop, or hold it down while talking. Escape cancels.
 */
export function VoiceButton({ onText, onPhase, disabled }: { onText: (text: string) => void; onPhase?: (phase: VoicePhase) => void; disabled?: boolean }) {
  const speech = useEditor((s) => s.speech);
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  const [panel, setPanel] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const recording = useRef<Recording | null>(null);
  const pressedAt = useRef(0);
  /** The pointer already handled this press; ignore the click that follows it. */
  const handled = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;

  const setPhase = (p: VoicePhase) => {
    setPhaseState(p);
    onPhaseRef.current?.(p);
  };

  useEffect(() => {
    if (!getState().speech) void refreshSpeechStatus().catch(() => {});
    return () => recording.current?.cancel();
  }, []);

  // Close the panel a moment after the download finishes.
  useEffect(() => {
    if (!panel || speech?.state !== 'ready') return;
    const t = setTimeout(() => setPanel(false), 2500);
    return () => clearTimeout(t);
  }, [panel, speech?.state]);

  useEffect(() => {
    if (phase !== 'recording') return;
    let frame = 0;
    const tick = () => {
      button.current?.style.setProperty('--level', (recording.current?.level() ?? 0).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    tick();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      recording.current?.cancel();
      recording.current = null;
      setPhase('idle');
    };
    window.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', key, true);
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = speech?.state === 'ready' || speech?.state === 'loading';

  async function start() {
    setPhase('starting');
    preloadSpeech();
    try {
      recording.current = await startRecording(() => void finish());
      setPhase('recording');
    } catch (error) {
      setPhase('idle');
      const name = (error as { name?: string })?.name;
      toast(
        name === 'NotAllowedError'
          ? 'Microphone access is blocked. Allow it for this page in the browser, then try again.'
          : name === 'NotFoundError'
            ? 'No microphone found.'
            : `Couldn't start the microphone: ${error instanceof Error ? error.message : String(error)}`,
        4500
      );
    }
  }

  async function finish() {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    setPhase('transcribing');
    try {
      const samples = await r.stop();
      if (!hasSpeech(samples)) return toast("Didn't hear anything. Check your microphone.");
      const text = await transcribe(samples);
      if (text) onTextRef.current(text);
      else toast("Didn't catch that. Try again a little closer to the mic.");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 4500);
    } finally {
      setPhase('idle');
    }
  }

  async function toggle() {
    if (phase === 'recording') return void finish();
    if (phase !== 'idle') return;
    const status = getState().speech ?? (await refreshSpeechStatus().catch(() => null));
    if (status?.state === 'ready' || status?.state === 'loading') void start();
    else setPanel(true);
  }

  const pct = speech?.state === 'downloading' && speech.sizeBytes ? speech.downloadedBytes / speech.sizeBytes : 0;
  const title =
    phase === 'recording'
      ? 'Stop and transcribe (Esc cancels)'
      : phase === 'transcribing'
        ? 'Transcribing…'
        : speech?.state === 'downloading'
          ? `Downloading voice input… ${Math.round(pct * 100)}%`
          : 'Speak (click, or hold while talking)';
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`op-icon-btn op-voice${phase === 'recording' ? ' recording' : ''}${speech?.state === 'downloading' ? ' downloading' : ''}`}
        style={{ ['--progress' as string]: pct } as CSSProperties}
        title={title}
        aria-label={title}
        aria-pressed={phase === 'recording'}
        disabled={disabled || phase === 'transcribing' || phase === 'starting'}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          handled.current = false;
          if (phase === 'recording') {
            handled.current = true;
            void finish();
          } else if (phase === 'idle' && ready) {
            // Start on press so holding the button works as push-to-talk.
            e.preventDefault();
            handled.current = true;
            pressedAt.current = Date.now();
            void start();
          }
        }}
        onPointerUp={() => {
          if (pressedAt.current && Date.now() - pressedAt.current >= HOLD_MS && recording.current) void finish();
          pressedAt.current = 0;
        }}
        onClick={() => {
          if (handled.current) {
            handled.current = false;
            return;
          }
          void toggle();
        }}
      >
        {phase === 'transcribing' || phase === 'starting' ? (
          <Loader2 size={14} className="op-spin" />
        ) : phase === 'recording' ? (
          <Square size={11} fill="currentColor" />
        ) : (
          <Mic size={15} />
        )}
      </button>
      {panel && button.current && <SetupPanel status={speech} anchor={button.current} onClose={() => setPanel(false)} />}
    </>
  );
}
