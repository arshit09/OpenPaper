import { useEffect, useState } from 'react';
import { Check, Copy, CheckCircle2, RotateCcw, Bot, Plug, Undo2 } from 'lucide-react';
import { displayName } from '@openpaper/core';
import { useEditor, setState, getState, toast } from '../../state/store.ts';
import { client, command } from '../../sync/session.ts';
import { copySelectionAsHtml } from '../clipboard.ts';
import { Inspector } from './Inspector.tsx';

function CodePanel() {
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const version = useEditor((s) => s.version);
  const [format, setFormat] = useState<'tailwind' | 'inline-styles'>('tailwind');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const id = selection[0];

  useEffect(() => {
    if (!doc || !id) {
      setCode('');
      return;
    }
    const timer = setTimeout(() => {
      client
        .request<string>('jsx', { fileId: doc.id, nodeId: id, format, includeNodeIds: false })
        .then(setCode)
        .catch((e: Error) => setCode(`// ${e.message}`));
    }, 120);
    return () => clearTimeout(timer);
  }, [doc?.id, id, format, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!id) return <div className="op-empty">Select a layer to see its code.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, minHeight: 0, flex: 1 }}>
      <div className="op-row">
        <div className="op-toolbar" style={{ padding: 2 }}>
          <button className={`op-tab${format === 'tailwind' ? ' active' : ''}`} onClick={() => setFormat('tailwind')}>
            Tailwind
          </button>
          <button className={`op-tab${format === 'inline-styles' ? ' active' : ''}`} onClick={() => setFormat('inline-styles')}>
            Inline
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          className="op-btn outline"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} JSX
        </button>
        <button
          className="op-btn outline"
          title="Copy as HTML (paste into any AI chat or back into OpenPaper)"
          onClick={() => {
            const html = copySelectionAsHtml();
            if (html) void navigator.clipboard.writeText(html).then(() => toast('HTML copied'));
          }}
        >
          <Copy size={13} /> HTML
        </button>
      </div>
      <pre className="op-code" style={{ flex: 1, margin: 0, whiteSpace: 'pre', fontSize: 11 }}>
        {code}
      </pre>
    </div>
  );
}

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString();
}

function CommentsPanel() {
  const doc = useEditor((s) => s.doc)!;
  const pageId = useEditor((s) => s.pageId);
  const focused = useEditor((s) => s.focusedThreadId);
  const [showResolved, setShowResolved] = useState(false);
  const composer = useEditor((s) => s.pendingComment);
  const setComposer = (value: null) => setState({ pendingComment: value });
  const [text, setText] = useState('');
  const [reply, setReply] = useState<Record<string, string>>({});

  const threads = Object.values(doc.comments)
    .filter((t) => !t.deletedAt && (showResolved || t.status === 'open'))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const userName = (id: string) => doc.users?.[id]?.displayName ?? (id === 'local-user' ? 'You' : id);

  const submit = async () => {
    if (!composer || !text.trim() || !pageId) return;
    const s = getState();
    let position = composer.world;
    if (composer.nodeId) {
      const el = document.querySelector(`[data-op-id="${CSS.escape(composer.nodeId)}"]`);
      const cam = s.cameras[pageId];
      if (el && cam) {
        const r = el.getBoundingClientRect();
        const vr = document.querySelector('.op-canvas')!.getBoundingClientRect();
        position = {
          x: Math.round(composer.world.x - (r.left - vr.left - cam.x) / cam.zoom),
          y: Math.round(composer.world.y - (r.top - vr.top - cam.y) / cam.zoom),
        };
      }
    }
    const r = await command<{ threadId?: string }>({ type: 'createComment', pageId, nodeId: composer.nodeId, position, text: text.trim() });
    setComposer(null);
    setText('');
    if (r.threadId) setState({ focusedThreadId: r.threadId });
  };

  return (
    <div className="op-scroll" style={{ flex: 1, padding: 10 }}>
      <div className="op-row" style={{ marginBottom: 8 }}>
        <span className="op-label" style={{ flex: 1 }}>
          Press C and click the canvas to comment. Agents can read and resolve threads.
        </span>
      </div>
      <label className="op-row" style={{ marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {composer && (
        <div style={{ border: '1px solid var(--op-accent)', borderRadius: 8, padding: 8, marginBottom: 10 }}>
          <div className="op-label" style={{ marginBottom: 6 }}>
            New comment{composer.nodeId && doc.nodes[composer.nodeId] ? ` on “${displayName(doc.nodes[composer.nodeId]!)}”` : ''}
          </div>
          <textarea
            className="op-input"
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void submit()}
            placeholder="What should change?"
          />
          <div className="op-row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="op-btn" onClick={() => setComposer(null)}>
              Cancel
            </button>
            <button className="op-btn primary" onClick={() => void submit()}>
              Comment
            </button>
          </div>
        </div>
      )}
      {!threads.length && !composer && <div className="op-empty">No comments yet.</div>}
      {threads.map((t) => {
        const msgs = t.messages.filter((m) => !m.deletedAt);
        const node = doc.nodes[t.nodeId];
        return (
          <div
            key={t.id}
            onClick={() => {
              setState({ focusedThreadId: t.id, ...(t.pageId !== pageId ? { pageId: t.pageId } : {}) });
              if (node && node.component !== 'PageRoot') setState({ selection: [node.id] });
            }}
            style={{
              border: `1px solid ${focused === t.id ? 'var(--op-accent)' : 'var(--op-border)'}`,
              borderRadius: 8,
              padding: 10,
              marginBottom: 8,
              opacity: t.status === 'resolved' ? 0.6 : 1,
              cursor: 'pointer',
            }}
          >
            <div className="op-row" style={{ marginBottom: 6 }}>
              <span className="op-label" style={{ flex: 1 }}>
                {node && node.component !== 'PageRoot' ? displayName(node) : doc.pages[t.pageId]?.name}
              </span>
              <button
                className="op-icon-btn small"
                title={t.status === 'open' ? 'Resolve' : 'Reopen'}
                onClick={(e) => {
                  e.stopPropagation();
                  void command({ type: 'setCommentStatus', threadId: t.id, status: t.status === 'open' ? 'resolved' : 'open' });
                }}
              >
                {t.status === 'open' ? <CheckCircle2 size={14} /> : <RotateCcw size={13} />}
              </button>
            </div>
            {msgs.map((m) => (
              <div key={m.id} style={{ marginBottom: 6 }}>
                <div className="op-row">
                  <b style={{ fontSize: 11.5 }}>{userName(m.userId)}</b>
                  <span className="op-label">{timeAgo(m.createdAt)}</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{m.text}</div>
              </div>
            ))}
            {focused === t.id && (
              <div className="op-row" onClick={(e) => e.stopPropagation()}>
                <input
                  className="op-input"
                  placeholder="Reply…"
                  value={reply[t.id] ?? ''}
                  onChange={(e) => setReply({ ...reply, [t.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && reply[t.id]?.trim()) {
                      void command({ type: 'replyComment', threadId: t.id, text: reply[t.id]!.trim() });
                      setReply({ ...reply, [t.id]: '' });
                    }
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AgentsPanel() {
  const agents = useEditor((s) => s.agents);
  const activity = useEditor((s) => s.activity);
  const doc = useEditor((s) => s.doc)!;
  return (
    <div className="op-scroll" style={{ flex: 1, padding: 10 }}>
      <div className="op-section-title">Connected agents</div>
      {!agents.length && (
        <div style={{ border: '1px dashed var(--op-border-strong)', borderRadius: 8, padding: 12, marginBottom: 12, lineHeight: 1.5 }}>
          <div className="op-row" style={{ marginBottom: 6 }}>
            <Bot size={16} /> <b>No agent is working on this file</b>
          </div>
          <div className="op-label" style={{ marginBottom: 8 }}>
            Connect Claude Code, Cursor, Codex or any MCP client, then ask it to design something in OpenPaper.
          </div>
          <button className="op-btn primary" onClick={() => setState({ showConnect: true })}>
            <Plug size={13} /> Connect an agent
          </button>
        </div>
      )}
      {agents.map((a) => (
        <div key={a.sessionId} className="op-row" style={{ padding: '6px 0', borderBottom: '1px solid var(--op-border)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: a.color, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{a.name}</div>
            <div className="op-label">
              {a.workingOn.length ? `Working on ${a.workingOn.map((id) => (doc.nodes[id] ? displayName(doc.nodes[id]!) : id)).join(', ')}` : 'Reading the file'}
            </div>
          </div>
          <button
            className="op-icon-btn small"
            title={`Undo ${a.name}'s last change`}
            onClick={async () => {
              const label = await client.request<string | null>('file.undoAgent', { fileId: doc.id, sessionId: a.sessionId });
              toast(label ? `Undid “${label}” by ${a.name}` : `Nothing to undo for ${a.name}`);
            }}
          >
            <Undo2 size={13} />
          </button>
        </div>
      ))}
      <div className="op-section-title" style={{ marginTop: 14 }}>
        Activity
      </div>
      {!activity.length && <div className="op-label">Tool calls from agents appear here as they happen.</div>}
      {[...activity].reverse().map((e) => (
        <div key={e.id} className="op-row" style={{ alignItems: 'flex-start', padding: '5px 0' }}>
          <span className="op-label" style={{ width: 36, flexShrink: 0 }}>
            {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: e.isError ? 'var(--op-danger)' : undefined, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.summary}</div>
            <div className="op-label">
              {e.actor.name} · {e.tool} · {e.durationMs}ms
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const agents = useEditor((s) => s.agents.length);
  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'design', label: 'Design' },
    { id: 'code', label: 'Code' },
    { id: 'comments', label: 'Comments' },
    { id: 'agents', label: 'Agents' },
  ];
  return (
    <div className="op-panel right">
      <div className="op-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`op-tab${tab === t.id ? ' active' : ''}`} onClick={() => setState({ rightTab: t.id })}>
            {t.label}
            {t.id === 'agents' && agents > 0 && (
              <span
                style={{
                  marginLeft: 5,
                  display: 'inline-grid',
                  placeItems: 'center',
                  minWidth: 15,
                  height: 15,
                  borderRadius: 8,
                  background: 'var(--op-agent)',
                  color: '#fff',
                  fontSize: 9.5,
                  fontWeight: 700,
                }}
              >
                {agents}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="op-scroll" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {tab === 'design' && <Inspector />}
        {tab === 'code' && <CodePanel />}
        {tab === 'comments' && <CommentsPanel />}
        {tab === 'agents' && <AgentsPanel />}
      </div>
    </div>
  );
}
