import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, MessageSquare, Square, X } from 'lucide-react';
import { setState, useEditor } from '../state/store.ts';
import { client } from '../sync/session.ts';
import { AgentMark } from './Logo.tsx';
import { VoiceButton, type VoicePhase } from './VoiceButton.tsx';

export interface PromptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WIDTH = 320;
const BUTTON = 28;
const GAP = 8;
const MARGIN = 8;

const HIDDEN = { visibility: 'hidden', pointerEvents: 'none' } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The reply as one short paragraph: markdown emphasis, code ticks and headings dropped. */
const plain = (md: string) =>
  md
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Beside the target's right edge; flipped to its left, then tucked inside it, when that runs off screen. */
function place(rect: PromptRect, bounds: { width: number; height: number }, w: number, h: number) {
  let left = rect.x + rect.width + GAP;
  if (left + w > bounds.width - MARGIN) left = rect.x - GAP - w;
  if (left < MARGIN) left = clamp(rect.x + rect.width - w - GAP, MARGIN, Math.max(MARGIN, bounds.width - w - MARGIN));
  const top = clamp(rect.y, MARGIN, Math.max(MARGIN, bounds.height - h - MARGIN));
  return { left, top };
}

/**
 * Ask the agent about exactly the thing the user pointed at: a button with the agent mark beside it that
 * opens a small prompt (type or speak). After sending it shows the agent's progress and reply in place.
 */
export function PointPrompt({
  rect,
  bounds,
  label,
  shortcut,
  open,
  focusKey,
  hidden,
  onOpenChange,
  onDraftChange,
  onSend,
}: {
  /** The pointed-at box, in the container's coordinates. */
  rect: PromptRect;
  /** The container's size, to keep the prompt on screen. */
  bounds: { width: number; height: number };
  /** Short name of the target ("Card", "button"). */
  label: string;
  /** Key that opens the prompt, for the button's tooltip. */
  shortcut?: string;
  open: boolean;
  /** Changing it puts the cursor back in the prompt (a new pick on a live site). */
  focusKey?: unknown;
  /** Hidden for now (mid-drag) but kept, with its draft and progress. */
  hidden?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether there's unsent text (the owner keeps the prompt open across target changes then). */
  onDraftChange?: (hasDraft: boolean) => void;
  onSend: (text: string) => Promise<void>;
}) {
  const chat = useEditor((s) => s.agentChat);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<VoicePhase>('idle');
  /** Index into the chat where this prompt's last message starts (its progress and reply follow it). */
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [height, setHeight] = useState(BUTTON);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open, focusKey]);

  const hasDraft = !!text.trim();
  useEffect(() => {
    onDraftChange?.(hasDraft);
  }, [hasDraft]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = input.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
    setHeight(root.current?.offsetHeight ?? BUTTON);
  });

  const mine = sentAt !== null ? chat.items.slice(sentAt) : [];
  const lastTool = [...mine].reverse().find((i) => i.kind === 'tool');
  const reply = [...mine].reverse().find((i) => i.kind === 'assistant' && i.text.trim());
  const failure = [...mine].reverse().find((i) => i.kind === 'notice' && i.level === 'error');
  const working = chat.running && sentAt !== null;

  const send = async () => {
    const value = text.trim();
    if (!value || chat.running) return;
    setText('');
    setSentAt(chat.items.length);
    try {
      await onSend(value);
    } catch {
      setText(value);
      setSentAt(null);
    }
  };

  const pos = place(rect, bounds, open ? WIDTH : BUTTON, open ? height : BUTTON);
  const shortLabel = label.length > 28 ? `${label.slice(0, 27)}…` : label;
  // Layer names get quotes; labels that quote their own text ("“Get started” link") don't.
  const named = /[“"<]/.test(shortLabel) ? shortLabel : `“${shortLabel}”`;

  if (!open) {
    return (
      <button
        data-op-overlay-ui
        className={`op-point-btn${working ? ' working' : ''}`}
        style={{ left: pos.left, top: pos.top, ...(hidden ? HIDDEN : {}) }}
        title={`Ask the agent to change ${label}${shortcut ? ` (${shortcut})` : ''}`}
        aria-label={`Ask the agent to change ${label}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onOpenChange(true)}
      >
        {working ? <Loader2 size={15} className="op-spin" /> : <AgentMark size={16} />}
      </button>
    );
  }

  const placeholder =
    voice === 'recording' ? 'Listening… click the mic to stop' : voice === 'transcribing' ? 'Transcribing…' : chat.running && !working ? 'The agent is busy…' : `Ask AI to change ${named}…`;
  return (
    <div
      ref={root}
      data-op-overlay-ui
      data-voice-box
      className="op-point-prompt"
      style={{ left: pos.left, top: pos.top, width: WIDTH, ...(hidden ? HIDDEN : {}) }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="op-point-row">
        <AgentMark size={16} className="op-point-mark" />
        <textarea
          ref={input}
          className="op-input"
          rows={1}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onOpenChange(false);
            }
          }}
        />
        <VoiceButton
          onPhase={setVoice}
          onText={(t) => {
            setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t));
            input.current?.focus();
          }}
        />
        {working ? (
          <button className="op-icon-btn active" title="Stop" onClick={() => chat.key && void client.request('agent.stop', { fileId: chat.key })}>
            <Square size={12} />
          </button>
        ) : (
          <button className="op-icon-btn active" title="Send (Enter)" disabled={!text.trim() || chat.running} onClick={() => void send()}>
            <ArrowUp size={15} />
          </button>
        )}
      </div>
      {sentAt !== null && (working || reply || failure) && (
        <div className="op-point-status">
          {working ? (
            <div className="op-row" style={{ gap: 6 }}>
              <Loader2 size={13} className="op-spin" style={{ flexShrink: 0 }} />
              <span className="op-truncate" style={{ flex: 1 }}>
                {lastTool?.kind === 'tool' ? lastTool.summary || lastTool.name : 'Working…'}
              </span>
            </div>
          ) : (
            <div className="op-clamp-3" style={failure && !reply ? { color: 'var(--op-danger)' } : undefined}>
              {failure?.kind === 'notice' && !reply ? failure.text : reply?.kind === 'assistant' ? plain(reply.text) : ''}
            </div>
          )}
          <div className="op-row" style={{ gap: 2, marginTop: 4 }}>
            <button
              className="op-btn op-point-link"
              onClick={() => setState((s) => ({ agentChat: { ...s.agentChat, open: true } }))}
            >
              <MessageSquare size={12} /> Show in chat
            </button>
            <div style={{ flex: 1 }} />
            {!working && (
              <button className="op-icon-btn small" title="Dismiss" onClick={() => setSentAt(null)}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
