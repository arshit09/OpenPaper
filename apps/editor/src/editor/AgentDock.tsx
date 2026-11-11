import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ArrowUp, Square, ChevronDown, ChevronUp, Settings2, RotateCcw, Check, X, Loader2, Wrench, Crosshair, Info, Plus } from 'lucide-react';
import { displayName, type AgentChatItem, type AgentConfigInfo, type AgentTarget, type PaperDocument } from '@openpaper/core';
import { useEditor, setState } from '../state/store.ts';
import { allowAgy, client, loadAgentConfig, sendToAgent, setAgentConfig } from '../sync/session.ts';
import { MarkdownView } from '../ui/MarkdownView.tsx';
import { AgentMark } from '../ui/Logo.tsx';
import { AGY_NOTE, RunnerPicker, runnerReady } from '../ui/RunnerPicker.tsx';
import { VoiceButton, type VoiceHandle, type VoicePhase } from '../ui/VoiceButton.tsx';
import { bindingLabel } from './hotkeys.ts';
import { MAC } from './shortcuts.ts';

/** Layers the message is about: the ones still in the file, named like the selection's own prompt names them. */
function layersTarget(doc: PaperDocument | null, ids: readonly string[]): AgentTarget | null {
  const nodeIds = doc ? ids.filter((id) => doc.nodes[id] && doc.nodes[id]!.component !== 'PageRoot') : [];
  if (!doc || !nodeIds.length) return null;
  return { label: nodeIds.length === 1 ? displayName(doc.nodes[nodeIds[0]!]!) : `${nodeIds.length} layers`, nodeIds };
}

const KEY_SOURCES: Record<NonNullable<AgentConfigInfo['keySource']>, string> = {
  settings: 'API key saved on this computer',
  environment: 'ANTHROPIC_API_KEY from the environment',
  profile: '`ant auth login` profile',
};

/** What the selected runner is, or what it still needs. */
function runnerLabel(config: AgentConfigInfo): string {
  switch (config.runner) {
    case 'claude-code': {
      const cc = config.claudeCode;
      if (!cc) return 'Claude Code not found';
      if (!cc.loggedIn) return 'Claude Code is not signed in';
      return `Claude Code ${cc.version}${cc.plan ? ` · ${cc.plan} plan` : ''}`;
    }
    case 'codex': {
      const cx = config.codex;
      if (!cx) return 'Codex not found';
      if (!cx.loggedIn) return 'Codex is not signed in';
      return `Codex ${cx.version}${cx.plan ? ` · ${cx.plan}` : ''}`;
    }
    case 'agy':
      return !config.agy ? 'Antigravity CLI not found' : `Antigravity ${config.agy.version}${config.agy.allowed ? '' : ' · needs permission'}`;
    case 'api':
      return config.keySource ? KEY_SOURCES[config.keySource] : 'No API key';
  }
}

/** Why agy needs a permission, on hover or focus. */
const AgyInfo = () => (
  <span className="op-runner-info" tabIndex={0} title={AGY_NOTE} aria-label={AGY_NOTE}>
    <Info size={12} />
  </span>
);

/** Runs a settings request with the buttons disabled meanwhile (failures are toasted by the request). */
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await request();
    } catch {
      // Already shown.
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

/** Codex or Antigravity picked but not ready: install, sign in, or (agy) allow OpenPaper's design tools. */
function CliSetup({ config }: { config: AgentConfigInfo }) {
  const [busy, run] = useBusy();
  const codex = config.runner === 'codex';
  const status = codex ? config.codex : config.agy;
  return (
    <div style={{ padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>{codex ? 'Design with Codex' : 'Design with Antigravity'}</div>
      <div className="op-label" style={{ lineHeight: 1.5 }}>
        Runs your own {codex ? 'Codex CLI with your ChatGPT sign-in' : 'Antigravity CLI (agy) with your Google sign-in'}. It works through OpenPaper's
        design tools on the canvas, and makes images with its own image generator.
      </div>
      <div className="op-row" style={{ gap: 8 }}>
        <div className="op-label" style={{ flex: 1, lineHeight: 1.5 }}>
          {!status ? (
            codex ? (
              <>
                Install the Codex CLI from <b>developers.openai.com/codex</b>, then run <code>codex login</code>.
              </>
            ) : (
              <>
                Install the Antigravity CLI from <b>antigravity.google</b> and sign in.
              </>
            )
          ) : codex ? (
            <>
              Codex is installed but not signed in. Run <code>codex login</code> in a terminal.
            </>
          ) : (
            <>
              agy needs a one-time permission: Allow adds <code>mcp(openpaper_openpaper/*)</code> to <code>~/.gemini/antigravity-cli/settings.json</code>.{' '}
              <AgyInfo />
            </>
          )}
        </div>
        {!codex && config.agy && !config.agy.allowed ? (
          <button className="op-btn primary" disabled={busy} onClick={() => void run(allowAgy)}>
            Allow
          </button>
        ) : (
          <button className="op-btn" disabled={busy} onClick={() => void run(loadAgentConfig)}>
            Check again
          </button>
        )}
      </div>
    </div>
  );
}

/** Choose what runs the agent. `claudeCodeOnly`: a live site, which edits code with Claude Code's file tools. */
function AgentSetup({ config, claudeCodeOnly }: { config: AgentConfigInfo; claudeCodeOnly?: boolean }) {
  const [key, setKey] = useState('');
  const [busy, run] = useBusy();
  const cc = config.claudeCode;
  return (
    <div style={{ padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>{claudeCodeOnly ? 'Edit your site with Claude Code' : 'Design with Claude, right here'}</div>
      <div className="op-label" style={{ lineHeight: 1.5 }}>
        {claudeCodeOnly ? (
          <>Live sites run on Claude Code with your own Claude sign-in: it edits the code in your project folder. An Anthropic API key can't do that.</>
        ) : (
          <>
            Run the built-in design agent on Claude Code with your own Claude sign-in, or with an Anthropic API key. Codex and Antigravity work too:
            pick them in the menu beside the send button. Prefer to chat from Claude Code, Cursor or another agent? Use <b>Connect agent</b> instead.
          </>
        )}
      </div>
      <div className="op-row" style={{ gap: 8 }}>
        <div className="op-label" style={{ flex: 1, lineHeight: 1.5 }}>
          {cc?.loggedIn ? (
            <>
              Claude Code {cc.version} is signed in{cc.plan ? ` with your ${cc.plan} plan` : ''}. Usage counts toward that account.
            </>
          ) : cc ? (
            <>
              Claude Code is installed but not signed in. Run <code>claude auth login</code> in a terminal.
            </>
          ) : (
            <>
              Install Claude Code from <b>claude.com/claude-code</b> and sign in to use your Claude plan.
            </>
          )}
        </div>
        {cc?.loggedIn ? (
          <button className="op-btn primary" disabled={busy} onClick={() => void run(() => setAgentConfig({ runner: 'claude-code' }))}>
            Use Claude Code
          </button>
        ) : (
          <button className="op-btn" disabled={busy} onClick={() => void run(loadAgentConfig)}>
            Check again
          </button>
        )}
      </div>
      {!claudeCodeOnly && (
        <>
          <div className="op-label" style={{ lineHeight: 1.5 }}>
            Or add an Anthropic API key. It's stored only on this computer (~/.openpaper/config.json).
            ANTHROPIC_API_KEY and <code>ant auth login</code> also work.
          </div>
          <form
            className="op-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!key.trim()) return;
              void run(() => setAgentConfig({ apiKey: key.trim(), runner: 'api' }));
            }}
          >
            <input className="op-input" type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <button className="op-btn primary" disabled={busy || !key.trim()}>
              Save
            </button>
          </form>
        </>
      )}
    </div>
  );
}

// Memoized so typing in the prompt doesn't re-render the whole conversation.
const ItemView = memo(function ItemView({ item }: { item: AgentChatItem }) {
  const [showThinking, setShowThinking] = useState(false);
  switch (item.kind) {
    case 'user':
      return (
        <div style={{ alignSelf: 'flex-end', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          {item.target && (
            <span className="op-chat-target" title={`Pointed at ${item.target}`}>
              <Crosshair size={11} style={{ flexShrink: 0 }} />
              <span className="op-truncate">{item.target}</span>
            </span>
          )}
          <div
            style={{
              padding: '8px 11px',
              borderRadius: '12px 12px 4px 12px',
              background: 'var(--op-accent)',
              color: 'var(--op-accent-text)',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              lineHeight: 1.45,
            }}
          >
            {item.text}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div style={{ maxWidth: '92%', lineHeight: 1.5 }}>
          {item.thinking && (
            <button className="op-btn op-thinking" aria-expanded={showThinking} onClick={() => setShowThinking(!showThinking)}>
              {showThinking ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Thinking
            </button>
          )}
          {showThinking && (
            <MarkdownView text={item.thinking ?? ''} className="op-label op-thinking-text" />
          )}
          <MarkdownView text={item.text} />
        </div>
      );
    case 'tool':
      return (
        <div className="op-row" style={{ color: item.status === 'error' ? 'var(--op-danger)' : 'var(--op-text-2)', fontSize: 11.5, minHeight: 20 }}>
          {item.status === 'running' ? (
            <Loader2 size={13} className="op-spin" style={{ flexShrink: 0 }} />
          ) : item.status === 'done' ? (
            <Check size={13} style={{ color: 'var(--op-success)', flexShrink: 0 }} />
          ) : (
            <X size={13} style={{ flexShrink: 0 }} />
          )}
          <Wrench size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
          <span className="op-truncate" title={item.summary || item.name}>
            {item.summary || item.name}
          </span>
        </div>
      );
    case 'notice':
      return (
        <div style={{ fontSize: 11.5, color: item.level === 'error' ? 'var(--op-danger)' : 'var(--op-text-3)', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          {item.text}
        </div>
      );
  }
});

/**
 * The built-in agent, docked at the bottom of the canvas or a live site. It talks to the open chat
 * (the file's, or the site's); `extra` adds per-message context such as the site page.
 */
export function AgentDock({
  placeholder = 'Ask AI to design…',
  emptyHint,
  extra,
  claudeCodeOnly,
}: {
  placeholder?: string;
  emptyHint?: ReactNode;
  extra?: () => { page?: string; target?: AgentTarget };
  /** Only Claude Code can run this chat (a live site); any other runner counts as not set up. */
  claudeCodeOnly?: boolean;
}) {
  const chat = useEditor((s) => s.agentChat);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<VoicePhase>('idle');
  const config = useEditor((s) => s.agentConfig);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<VoiceHandle>(null);
  /** A send is waiting for its transcript or the server; a second one would race it. */
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const open = chat.open;
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  /** Layers added with +: the next message is about them. */
  const [attached, setAttached] = useState<string[]>([]);

  useEffect(() => {
    loadAgentConfig().catch(() => {});
  }, []);

  // Another file's chat starts without them.
  useEffect(() => setAttached([]), [chat.key]);

  // Grow the prompt with its content (up to the CSS max-height, then scroll).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Before paint, so the conversation opens already scrolled to the latest message.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items, open]);

  const key = chat.key;
  if (!key) return null;
  const setOpen = (v: boolean) => setState((s) => ({ agentChat: { ...s.agentChat, open: v } }));
  const needsSetup = config !== null && (claudeCodeOnly ? config.runner !== 'claude-code' || !config.claudeCode?.loggedIn : !runnerReady(config));
  const cliRunner = config?.runner === 'codex' || config?.runner === 'agy';

  const listening = voice === 'recording' || voice === 'transcribing';
  /** This is the open file's chat (not a live site's), so canvas layers can be added to a message. */
  const onCanvas = !!doc && doc.id === key;
  const chip = onCanvas ? layersTarget(doc, attached) : null;
  const selected = onCanvas ? layersTarget(doc, selection) : null;

  // Sending while the mic is on stops it and sends what was said along with anything typed.
  const send = async () => {
    const typed = text.trim();
    if ((!typed && !listening) || chat.running || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setText('');
    const about = chip;
    setAttached([]);
    try {
      const spoken = listening ? await voiceRef.current?.take() : null;
      const value = [typed, spoken].filter(Boolean).join(' ');
      if (!value) {
        if (about?.nodeIds) setAttached(about.nodeIds);
        return;
      }
      setOpen(true);
      await sendToAgent(value, { ...extra?.(), ...(about ? { target: about } : {}) }).catch(() => {
        setText(value);
        if (about?.nodeIds) setAttached(about.nodeIds);
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  /** Pressing the composer's empty space (not one of its buttons) puts the cursor in the prompt, like a text field. */
  const focusPrompt = (e: PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    inputRef.current?.focus();
  };

  const usage = chat.usage;
  return (
    <div
      className="op-dock"
      data-op-overlay-ui
      data-voice-box
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={`op-dock-body${open ? ' open' : ''}`}>
        <div inert={!open}>
          <div className="op-dock-row">
            <AgentMark size={14} style={{ flexShrink: 0 }} />
            <b className="op-truncate" style={{ flex: 1 }}>
              Design agent
            </b>
            {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
              <span className="op-label op-truncate" style={{ fontVariantNumeric: 'tabular-nums' }} title="Tokens this chat (cache reads in parentheses)">
                {Math.round((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) / 1000)}k in ({Math.round(usage.cacheReadTokens / 1000)}k cached) · {Math.round(usage.outputTokens / 1000)}k out
              </span>
            )}
            <button className={`op-icon-btn small${showSettings ? ' pressed' : ''}`} title="Settings" aria-pressed={showSettings} onClick={() => setShowSettings(!showSettings)}>
              <Settings2 size={13} />
            </button>
            <button className="op-icon-btn small" title="New chat" onClick={() => void client.request('agent.reset', { fileId: key })}>
              <RotateCcw size={13} />
            </button>
            <button className="op-icon-btn small" title="Collapse" onClick={() => setOpen(false)}>
              <ChevronDown size={14} />
            </button>
          </div>
          {showSettings && config && (
            <div className="op-dock-row" style={{ flexWrap: 'wrap', padding: '8px 12px' }}>
              {/* Runner, model and effort are in the picker beside the send button. */}
              <span className="op-label">{runnerLabel(config)}</span>
              {config.runner === 'agy' && <AgyInfo />}
              {config.runner === 'agy' && config.agy && !config.agy.allowed && (
                <button className="op-btn" onClick={() => void allowAgy()}>
                  Allow
                </button>
              )}
              {config.keySource === 'settings' && (
                <button className="op-btn" style={{ marginLeft: 'auto' }} onClick={() => void setAgentConfig({ apiKey: null }).catch(() => {})}>
                  Remove key
                </button>
              )}
            </div>
          )}
          {needsSetup && config && (cliRunner && !claudeCodeOnly ? <CliSetup config={config} /> : <AgentSetup config={config} claudeCodeOnly={claudeCodeOnly} />)}
          {(!needsSetup || chat.items.length > 0) && (
            <div ref={listRef} className="op-scroll" style={{ maxHeight: 'min(46vh, 420px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!chat.items.length && (
                <div className="op-label" style={{ lineHeight: 1.6 }}>
                  {emptyHint ?? (
                    <>
                      Ask for a design and watch it appear on the canvas. Try: <i>“Design a sign-up screen for a meditation app”</i>. To change just one
                      part, select it and press <b>+</b>, or use the agent button beside it ({bindingLabel('Mod+K', MAC)}). The menu by the send button
                      picks who answers: Claude Code, Codex or Antigravity, which can also generate images.
                    </>
                  )}
                </div>
              )}
              {chat.items.map((item) => (
                <ItemView key={item.id} item={item} />
              ))}
              {chat.running && (
                <div className="op-row op-label">
                  <Loader2 size={13} className="op-spin" /> Working…
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="op-dock-composer" onPointerDown={focusPrompt}>
        <textarea
          ref={inputRef}
          className="op-input"
          rows={1}
          aria-label="Message the design agent"
          placeholder={
            voice === 'recording'
              ? 'Listening… click the mic to stop'
              : voice === 'transcribing'
                ? 'Transcribing…'
                : chat.running
                  ? 'The agent is working…'
                  : chip
                    ? 'Describe your edit…'
                    : placeholder
          }
          value={text}
          onFocus={() => !open && (chat.items.length > 0 || needsSetup) && setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter that confirms an IME composition isn't a send.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape') (e.currentTarget as HTMLTextAreaElement).blur();
            // Backspace in an empty prompt takes the layers back out, like a chip in a search field.
            if (e.key === 'Backspace' && !text && chip) setAttached([]);
          }}
        />
        <div className="op-dock-tools" onPointerDown={focusPrompt}>
          {onCanvas && (
            <button
              className="op-icon-btn"
              title={selected ? `Add ${selected.label} to your message` : 'Select layers on the canvas to add them to your message'}
              aria-label={selected ? `Add ${selected.label} to your message` : 'Add the selected layers to your message'}
              disabled={!selected}
              onClick={() => {
                if (!selected?.nodeIds) return;
                setAttached(selected.nodeIds);
                inputRef.current?.focus();
              }}
            >
              <Plus size={16} />
            </button>
          )}
          {chip && (
            <span className="op-dock-chip" title={`This message is about ${chip.label}`}>
              <Crosshair size={12} style={{ flexShrink: 0 }} />
              <span className="op-truncate">{chip.label}</span>
              <button
                type="button"
                title="Remove"
                aria-label={`Remove ${chip.label}`}
                onClick={() => {
                  setAttached([]);
                  inputRef.current?.focus();
                }}
              >
                <X size={12} />
              </button>
            </span>
          )}
          <div className="op-dock-spacer" />
          {config && <RunnerPicker variant="model" claudeCodeOnly={claudeCodeOnly} />}
          {chat.items.length > 0 && (
            <button className="op-icon-btn op-dock-fold" title="Show conversation" inert={open} onClick={() => setOpen(true)}>
              <ChevronUp size={15} />
            </button>
          )}
          <VoiceButton
            ref={voiceRef}
            onPhase={setVoice}
            onText={(t) => {
              setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t));
              inputRef.current?.focus();
            }}
          />
          {chat.running ? (
            <button className="op-icon-btn op-dock-send" title="Stop" onClick={() => void client.request('agent.stop', { fileId: key })}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button className="op-icon-btn op-dock-send" title="Send (Enter)" disabled={(!text.trim() && !listening) || sending} onClick={() => void send()}>
              {sending ? <Loader2 size={14} className="op-spin" /> : <ArrowUp size={16} strokeWidth={2.25} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
