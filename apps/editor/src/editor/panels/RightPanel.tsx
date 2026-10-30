import { useEffect, useState } from 'react';
import { Check, Copy, CheckCircle2, RotateCcw, Bot, Plug, Undo2, GitBranch } from 'lucide-react';
import { displayName } from '@openpaper/core';
import { useEditor, setState, getState, toast } from '../../state/store.ts';
import { client, command } from '../../sync/session.ts';
import { copySelectionAsHtml } from '../clipboard.ts';
import { Inspector } from './Inspector.tsx';
import { VersionPanel } from './VersionPanel.tsx';

function CodePanel() {
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const version = useEditor((s) => s.version);
  const previewing = useEditor((s) => !!s.preview);
  const [format, setFormat] = useState<'tailwind' | 'inline-styles'>('tailwind');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const id = selection[0];

  useEffect(() => {
    if (!doc || !id || previewing) {
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
  }, [doc?.id, id, format, version, previewing]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server writes code for the current version, not an older one on screen.
  if (previewing) return <div className="op-empty">Code is shown for the current version. Go back to it to see a layer’s code.</div>;
  if (!id) return <div className="op-empty">Select a layer to see its code.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, minHeight: 0, flex: 1 }}>
      <div className="op-row" style={{ gap: 4 }}>
        <div className="op-toolbar op-segmented">
          <button className={`op-tab${format === 'tailwind' ? ' active' : ''}`} onClick={() => setFormat('tailwind')}>
            <span className="op-tab-label">Tailwind</span>
          </button>
          <button className={`op-tab${format === 'inline-styles' ? ' active' : ''}`} onClick={() => setFormat('inline-styles')}>
            <span className="op-tab-label">Inline</span>
          </button>
        </div>
        <button
          className="op-btn outline compact"
          style={{ marginLeft: 'auto' }}
          title="Copy JSX"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} JSX
        </button>
        <button
          className="op-btn outline compact"
          title="Copy as HTML (paste into any AI chat or back into OpenPaper)"
          onClick={() => {
            const html = copySelectionAsHtml();
            if (html) void navigator.clipboard.writeText(html).then(() => toast('HTML copied'));
          }}
        >
          <Copy size={12} /> HTML
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
      <p className="op-label" style={{ margin: '0 2px 8px', lineHeight: 1.5 }}>
        Press C and click the canvas to comment. Agents can read and resolve threads.
      </p>
      <label className="op-row" style={{ marginBottom: 10, cursor: 'pointer', width: 'fit-content' }}>
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {composer && (
        <div className="op-card focused" style={{ marginBottom: 10 }}>
          <div className="op-label op-truncate" style={{ marginBottom: 6 }}>
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
          <div className="op-row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="op-btn" onClick={() => setComposer(null)}>
              Cancel
            </button>
            <button className="op-btn primary" disabled={!text.trim()} onClick={() => void submit()}>
              Comment
            </button>
          </div>
        </div>
      )}
      {!threads.length && !composer && <div className="op-empty">No comments yet.</div>}
      {threads.map((t) => {
        const msgs = t.messages.filter((m) => !m.deletedAt);
        const node = doc.nodes[t.nodeId];
        const where = node && node.component !== 'PageRoot' ? displayName(node) : doc.pages[t.pageId]?.name;
        return (
          <div
            key={t.id}
            className={`op-card interactive${focused === t.id ? ' focused' : ''}`}
            onClick={() => {
              setState({ focusedThreadId: t.id, ...(t.pageId !== pageId ? { pageId: t.pageId } : {}) });
              if (node && node.component !== 'PageRoot') setState({ selection: [node.id] });
            }}
            style={{ opacity: t.status === 'resolved' ? 0.6 : 1 }}
          >
            <div className="op-card-head" style={{ marginBottom: 4 }}>
              <span className="op-label op-truncate" style={{ flex: 1 }} title={where}>
                {where}
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
                <div className="op-row" style={{ gap: 6, alignItems: 'baseline' }}>
                  <b className="op-truncate" style={{ fontSize: 11.5 }}>
                    {userName(m.userId)}
                  </b>
                  <span className="op-label" style={{ flexShrink: 0 }}>
                    {timeAgo(m.createdAt)}
                  </span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{m.text}</div>
              </div>
            ))}
            {focused === t.id && (
              <div className="op-row" style={{ marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
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
    <div className="op-scroll" style={{ flex: 1, padding: '10px 12px' }}>
      <div className="op-section-title">Connected agents</div>
      {!agents.length && (
        <div className="op-card dashed" style={{ padding: 12, marginBottom: 12, lineHeight: 1.5 }}>
          <div className="op-row" style={{ marginBottom: 6 }}>
            <Bot size={16} style={{ flexShrink: 0 }} /> <b>No agent is working on this file</b>
          </div>
          <div className="op-label" style={{ marginBottom: 10 }}>
            Connect Claude Code, Cursor, Codex or any MCP client, then ask it to design something in OpenPaper.
          </div>
          <button className="op-btn primary" onClick={() => setState({ showConnect: true })}>
            <Plug size={13} /> Connect an agent
          </button>
        </div>
      )}
      {agents.map((a) => {
        const status = a.workingOn.length
          ? `Working on ${a.workingOn.map((id) => (doc.nodes[id] ? displayName(doc.nodes[id]!) : id)).join(', ')}`
          : 'Reading the file';
        return (
          <div key={a.sessionId} className="op-agent-row">
            <span className="op-agent-dot" style={{ background: a.color, color: a.color }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="op-truncate" style={{ fontWeight: 600 }}>
                {a.name}
              </div>
              <div className="op-label op-truncate" title={status}>
                {status}
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
        );
      })}
      <div className="op-section-title" style={{ marginTop: 14, marginBottom: 2 }}>
        Activity
      </div>
      {!activity.length && <div className="op-label">Tool calls from agents appear here as they happen.</div>}
      {[...activity].reverse().map((e) => {
        const meta = `${e.actor.name} · ${e.tool} · ${e.durationMs}ms`;
        return (
          <div key={e.id} className="op-activity">
            <time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            <div style={{ minWidth: 0 }}>
              <div className="summary op-clamp-2" style={{ color: e.isError ? 'var(--op-danger)' : undefined }} title={e.summary}>
                {e.summary}
              </div>
              <div className="op-label op-truncate" title={meta}>
                {meta}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RightPanel() {
  const tab = useEditor((s) => s.rightTab);
  const agents = useEditor((s) => s.agents.length);
  const changes = useEditor((s) => (s.vcs?.tracked ? (s.vcs.changes?.length ?? 0) : 0));
  // Version control is an icon: five words don't fit the panel's width (its name is its tooltip and the panel's title).
  const tabs: Array<{ id: typeof tab; label: string; icon?: typeof GitBranch }> = [
    { id: 'design', label: 'Design' },
    { id: 'code', label: 'Code' },
    { id: 'comments', label: 'Comments' },
    { id: 'agents', label: 'Agents' },
    { id: 'version', label: 'Version control', icon: GitBranch },
  ];
  const tabTitle = (id: typeof tab) =>
    id === 'agents' && agents > 0
      ? `${agents} agent${agents === 1 ? '' : 's'} connected`
      : id === 'version'
        ? changes > 0
          ? `Version control: ${changes} change${changes === 1 ? '' : 's'} not committed`
          : 'Version control: keep versions of this design with Git'
        : undefined;
  return (
    <div className="op-panel right">
      <div className="op-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`op-tab${tab === t.id ? ' active' : ''}${t.icon ? ' op-tab-icon' : ''}`}
            title={tabTitle(t.id)}
            aria-label={t.icon ? t.label : undefined}
            onClick={() => setState({ rightTab: t.id })}
          >
            {t.icon ? <t.icon size={14} /> : <span className="op-tab-label">{t.label}</span>}
            {t.id === 'agents' && agents > 0 && <span className="op-count">{agents}</span>}
            {t.id === 'version' && changes > 0 && <span className="op-tab-dot" />}
          </button>
        ))}
      </div>
      <div key={tab} className="op-scroll op-tab-panel">
        {tab === 'design' && <Inspector />}
        {tab === 'code' && <CodePanel />}
        {tab === 'comments' && <CommentsPanel />}
        {tab === 'agents' && <AgentsPanel />}
        {tab === 'version' && <VersionPanel />}
      </div>
    </div>
  );
}
