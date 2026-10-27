import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Mic, Square, X } from 'lucide-react';
import type { SpeechStatus } from '@openpaper/core';
import { getState, toast, useEditor } from '../state/store.ts';
import { hasSpeech, installSpeech, preloadSpeech, refreshSpeechStatus, startRecording, transcribe, type Recording } from './voice.ts';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface VoiceHandle {
  /**
   * Stop recording (if it is) and hand back the transcript instead of passing it to `onText`, so a
   * send can go out without waiting for a second click. Null when there's nothing to take.
   */
  take(): Promise<string | null>;
}

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

/** Stop the recording and transcribe it; '' (after telling the user why) when there's no text. */
async function transcribeRecording(r: Recording): Promise<string> {
  try {
    const samples = await r.stop();
    if (!hasSpeech(samples)) {
      toast("Didn't hear anything. Check your microphone.");
      return '';
    }
    const text = await transcribe(samples);
    if (!text) toast("Didn't catch that. Try again a little closer to the mic.");
    return text;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 4500);
    return '';
  }
}

/**
 * Mic button: speech is transcribed locally by the server and handed to `onText`.
 * Click to start and click again to stop, or hold it down while talking. Escape cancels.
 */
export function VoiceButton({
  onText,
  onPhase,
  disabled,
  ref,
}: {
  onText: (text: string) => void;
  onPhase?: (phase: VoicePhase) => void;
  disabled?: boolean;
  ref?: Ref<VoiceHandle>;
}) {
  const speech = useEditor((s) => s.speech);
  const [phase, setPhaseState] = useState<VoicePhase>('idle');
  const [panel, setPanel] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const recording = useRef<Recording | null>(null);
  /** The transcription in flight; `taken` once a caller claimed its text, so `onText` doesn't get it too. */
  const pending = useRef<{ text: Promise<string>; taken: boolean } | null>(null);
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

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (!getState().speech) void refreshSpeechStatus().catch(() => {});
    // Unmounted mid-recording (the prompt closed): drop the audio and tell the owner the mic is off.
    return () => {
      mounted.current = false;
      recording.current?.cancel();
      recording.current = null;
      onPhaseRef.current?.('idle');
    };
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
      const r = await startRecording(finish);
      // Gone while the browser asked for the mic: don't leave it recording.
      if (!mounted.current) return r.cancel();
      recording.current = r;
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

  function finish() {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    setPhase('transcribing');
    const job = { text: transcribeRecording(r), taken: false };
    pending.current = job;
    void job.text
      .then((text) => {
        if (text && !job.taken) onTextRef.current(text);
      })
      .finally(() => {
        pending.current = null;
        setPhase('idle');
      });
  }

  useImperativeHandle(ref, () => ({
    async take() {
      finish();
      const job = pending.current;
      if (!job || job.taken) return null;
      job.taken = true;
      return (await job.text) || null;
    },
  }));

  async function toggle() {
    if (phase === 'recording') return finish();
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
            finish();
          } else if (phase === 'idle' && ready) {
            // Start on press so holding the button works as push-to-talk.
            e.preventDefault();
            handled.current = true;
            pressedAt.current = Date.now();
            void start();
          }
        }}
        onPointerUp={() => {
          if (pressedAt.current && Date.now() - pressedAt.current >= HOLD_MS && recording.current) finish();
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
