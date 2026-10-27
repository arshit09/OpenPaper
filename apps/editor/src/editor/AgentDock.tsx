import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Send, Square, ChevronDown, ChevronUp, Settings2, RotateCcw, Check, X, Loader2, Wrench, Crosshair } from 'lucide-react';
import type { AgentChatItem, AgentConfigInfo, AgentTarget } from '@openpaper/core';
import { useEditor, setState } from '../state/store.ts';
import { client, sendToAgent } from '../sync/session.ts';
import { MarkdownView } from '../ui/MarkdownView.tsx';
import { AgentMark } from '../ui/Logo.tsx';
import { Select } from '../ui/Select.tsx';
import { VoiceButton, type VoicePhase } from '../ui/VoiceButton.tsx';

const RUNNERS = [
  { value: 'claude-code', label: 'Claude Code sign-in' },
  { value: 'api', label: 'Anthropic API key' },
] as const;
const EFFORTS = (['low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) => ({ value: e, label: `Effort: ${e}` }));

const KEY_SOURCES: Record<NonNullable<AgentConfigInfo['keySource']>, string> = {
  settings: 'API key saved on this computer',
  environment: 'ANTHROPIC_API_KEY from the environment',
  profile: '`ant auth login` profile',
};

function claudeCodeLabel(cc: AgentConfigInfo['claudeCode']): string {
  if (!cc) return 'Claude Code not found';
  if (!cc.loggedIn) return 'Claude Code is not signed in';
  return `Claude Code ${cc.version}${cc.plan ? ` · ${cc.plan} plan` : ''}`;
}

function AgentSetup({ config, onChange }: { config: AgentConfigInfo; onChange: (info: AgentConfigInfo) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (request: Promise<AgentConfigInfo>) => {
    setBusy(true);
    try {
      onChange(await request);
    } finally {
      setBusy(false);
    }
  };
  const cc = config.claudeCode;
  return (
    <div style={{ padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>Design with Claude, right here</div>
      <div className="op-label" style={{ lineHeight: 1.5 }}>
        Run the built-in design agent on Claude Code with your own Claude sign-in, or with an Anthropic API key.
        Prefer to chat from Claude Code, Cursor or another agent? Use <b>Connect agent</b> instead.
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
          <button className="op-btn primary" disabled={busy} onClick={() => void run(client.request<AgentConfigInfo>('agent.config.set', { runner: 'claude-code' }))}>
            Use Claude Code
          </button>
        ) : (
          <button className="op-btn" disabled={busy} onClick={() => void run(client.request<AgentConfigInfo>('agent.config.get'))}>
            Check again
          </button>
        )}
      </div>
      <div className="op-label" style={{ lineHeight: 1.5 }}>
        Or add an Anthropic API key. It's stored only on this computer (~/.openpaper/config.json).
        ANTHROPIC_API_KEY and <code>ant auth login</code> also work.
      </div>
      <form
        className="op-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          void run(client.request<AgentConfigInfo>('agent.config.set', { apiKey: key.trim(), runner: 'api' }));
        }}
      >
        <input className="op-input" type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        <button className="op-btn primary" disabled={busy || !key.trim()}>
          Save
        </button>
      </form>
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
            <span className="op-chat-target op-truncate" title={`Pointed at ${item.target}`}>
              <Crosshair size={11} style={{ flexShrink: 0 }} /> {item.target}
            </span>
          )}
          <div
            style={{
              padding: '8px 11px',
              borderRadius: '12px 12px 4px 12px',
              background: 'var(--op-accent)',
              color: '#fff',
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
}: {
  placeholder?: string;
  emptyHint?: ReactNode;
  extra?: () => { page?: string; target?: AgentTarget };
}) {
  const chat = useEditor((s) => s.agentChat);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<VoicePhase>('idle');
  const [config, setConfig] = useState<AgentConfigInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const open = chat.open;

  useEffect(() => {
    client.request<AgentConfigInfo>('agent.config.get').then(setConfig).catch(() => {});
  }, []);

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
  const needsSetup = config !== null && (config.runner === 'api' ? config.keySource === null : !config.claudeCode?.loggedIn);

  const send = async () => {
    const value = text.trim();
    if (!value || chat.running) return;
    setText('');
    setOpen(true);
    await sendToAgent(value, extra?.()).catch(() => setText(value));
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
              <Select
                style={{ width: 'auto' }}
                title="What runs the agent"
                value={config.runner}
                options={RUNNERS}
                onChange={async (runner) => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { runner }))}
              />
              <Select
                style={{ width: 'auto' }}
                title="Model"
                value={config.model}
                options={config.models.map((m) => ({ value: m.id, label: m.label }))}
                onChange={async (model) => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { model }))}
              />
              <Select
                style={{ width: 'auto' }}
                title="Effort"
                value={config.effort}
                options={EFFORTS}
                onChange={async (effort) => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { effort }))}
              />
              <span className="op-label">
                {config.runner === 'claude-code' ? claudeCodeLabel(config.claudeCode) : config.keySource ? KEY_SOURCES[config.keySource] : 'No API key'}
              </span>
              {config.keySource === 'settings' && (
                <button className="op-btn" style={{ marginLeft: 'auto' }} onClick={async () => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { apiKey: null }))}>
                  Remove key
                </button>
              )}
            </div>
          )}
          {needsSetup && config && <AgentSetup config={config} onChange={setConfig} />}
          {(!needsSetup || chat.items.length > 0) && (
            <div ref={listRef} className="op-scroll" style={{ maxHeight: 'min(46vh, 420px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!chat.items.length && (
                <div className="op-label" style={{ lineHeight: 1.6 }}>
                  {emptyHint ?? (
                    <>
                      Ask for a design and watch it appear on the canvas. Try: <i>“Design a sign-up screen for a meditation app”</i>, or select a
                      layer and use the agent button beside it (Ctrl+K) to change just that.
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
      <div className="op-dock-composer">
        <AgentMark size={16} className="op-dock-spark op-dock-fold" />
        <textarea
          ref={inputRef}
          className="op-input"
          rows={1}
          placeholder={
            voice === 'recording' ? 'Listening… click the mic to stop' : voice === 'transcribing' ? 'Transcribing…' : chat.running ? 'The agent is working…' : placeholder
          }
          value={text}
          onFocus={() => !open && (chat.items.length > 0 || needsSetup) && setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape') (e.currentTarget as HTMLTextAreaElement).blur();
          }}
        />
        {chat.items.length > 0 && (
          <button className="op-icon-btn op-dock-fold" title="Show conversation" inert={open} onClick={() => setOpen(true)}>
            <ChevronUp size={15} />
          </button>
        )}
        <VoiceButton
          onPhase={setVoice}
          onText={(t) => {
            setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t}` : t));
            inputRef.current?.focus();
          }}
        />
        {chat.running ? (
          <button className="op-icon-btn active" title="Stop" onClick={() => void client.request('agent.stop', { fileId: key })}>
            <Square size={13} />
          </button>
        ) : (
          <button className="op-icon-btn active" title="Send (Enter)" disabled={!text.trim()} onClick={() => void send()}>
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
