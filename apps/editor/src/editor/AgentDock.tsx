import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Sparkles, Send, Square, ChevronDown, ChevronUp, Settings2, RotateCcw, Check, X, Loader2, Wrench } from 'lucide-react';
import type { AgentChatItem, AgentConfigInfo } from '@openpaper/core';
import { useEditor, setState, getState, toast } from '../state/store.ts';
import { client } from '../sync/session.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const KEY_SOURCES: Record<NonNullable<AgentConfigInfo['keySource']>, string> = {
  settings: 'API key saved on this computer',
  environment: 'ANTHROPIC_API_KEY from the environment',
  profile: '`ant auth login` profile',
};

function KeySetup({ onSaved }: { onSaved: (info: AgentConfigInfo) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: '12px 12px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600 }}>Design with Claude, right here</div>
      <div className="op-label" style={{ lineHeight: 1.5 }}>
        Add an Anthropic API key to chat with the built-in design agent. It's stored only on this computer
        (~/.openpaper/config.json). ANTHROPIC_API_KEY and <code>ant auth login</code> also work. Prefer Claude Code,
        Cursor or another agent? Use <b>Connect agent</b> instead.
      </div>
      <form
        className="op-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!key.trim()) return;
          setBusy(true);
          try {
            onSaved(await client.request<AgentConfigInfo>('agent.config.set', { apiKey: key.trim() }));
          } finally {
            setBusy(false);
          }
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

function ItemView({ item }: { item: AgentChatItem }) {
  const [showThinking, setShowThinking] = useState(false);
  switch (item.kind) {
    case 'user':
      return (
        <div
          style={{
            alignSelf: 'flex-end',
            maxWidth: '85%',
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
            <div className="op-label" style={{ borderLeft: '2px solid var(--op-border-strong)', paddingLeft: 8, margin: '2px 0 6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {item.thinking}
            </div>
          )}
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</div>
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
}

/** The built-in design agent, docked at the bottom of the canvas. */
export function AgentDock() {
  const doc = useEditor((s) => s.doc);
  const chat = useEditor((s) => s.agentChat);
  const [text, setText] = useState('');
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

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items, open]);

  if (!doc) return null;
  const setOpen = (v: boolean) => setState((s) => ({ agentChat: { ...s.agentChat, open: v } }));
  const needsKey = config !== null && config.keySource === null;

  const send = async () => {
    const value = text.trim();
    if (!value || chat.running) return;
    setText('');
    setOpen(true);
    try {
      await client.request('agent.send', { fileId: getState().doc!.id, text: value });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };

  const usage = chat.usage;
  return (
    <div
      className="op-dock"
      data-op-overlay-ui
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className={`op-dock-body${open ? ' open' : ''}`}>
        <div inert={!open}>
          <div className="op-dock-row">
            <Sparkles size={14} style={{ color: 'var(--op-agent)', flexShrink: 0 }} />
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
            <button className="op-icon-btn small" title="New chat" onClick={() => void client.request('agent.reset', { fileId: doc.id })}>
              <RotateCcw size={13} />
            </button>
            <button className="op-icon-btn small" title="Collapse" onClick={() => setOpen(false)}>
              <ChevronDown size={14} />
            </button>
          </div>
          {showSettings && config && (
            <div className="op-dock-row" style={{ flexWrap: 'wrap', padding: '8px 12px' }}>
              <select
                className="op-input"
                style={{ width: 'auto' }}
                value={config.model}
                onChange={async (e) => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { model: e.target.value }))}
              >
                {config.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                className="op-input"
                style={{ width: 'auto' }}
                value={config.effort}
                onChange={async (e) => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { effort: e.target.value }))}
              >
                {EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    Effort: {e}
                  </option>
                ))}
              </select>
              <span className="op-label">{config.keySource ? KEY_SOURCES[config.keySource] : 'No API key'}</span>
              {config.keySource === 'settings' && (
                <button className="op-btn" style={{ marginLeft: 'auto' }} onClick={async () => setConfig(await client.request<AgentConfigInfo>('agent.config.set', { apiKey: null }))}>
                  Remove key
                </button>
              )}
            </div>
          )}
          {needsKey && <KeySetup onSaved={setConfig} />}
          {(!needsKey || chat.items.length > 0) && (
            <div ref={listRef} className="op-scroll" style={{ maxHeight: 'min(46vh, 420px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {!chat.items.length && (
                <div className="op-label" style={{ lineHeight: 1.6 }}>
                  Ask for a design and watch it appear on the canvas. Try: <i>“Design a sign-up screen for a meditation app”</i> or <i>“Make the selected card feel more premium.”</i>
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
        {!open && <Sparkles size={16} className="op-dock-spark" />}
        <textarea
          ref={inputRef}
          className="op-input"
          rows={1}
          placeholder={chat.running ? 'The agent is working…' : 'Ask AI to design…'}
          value={text}
          onFocus={() => !open && (chat.items.length > 0 || needsKey) && setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape') (e.currentTarget as HTMLTextAreaElement).blur();
          }}
        />
        {!open && chat.items.length > 0 && (
          <button className="op-icon-btn" title="Show conversation" onClick={() => setOpen(true)}>
            <ChevronUp size={15} />
          </button>
        )}
        {chat.running ? (
          <button className="op-icon-btn active" title="Stop" onClick={() => void client.request('agent.stop', { fileId: doc.id })}>
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
