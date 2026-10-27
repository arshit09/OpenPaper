import { useEffect, useState } from 'react';
import { Check, Copy, X, Plug } from 'lucide-react';
import { setState, toast } from '../state/store.ts';
import { client } from '../sync/session.ts';

interface McpInfo {
  url: string;
  launch: { command: string; args: string[] };
  harnesses: Array<{ id: string; label: string }>;
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <pre className="op-code" style={{ margin: 0, paddingRight: 36, minHeight: 34 }}>
        {text}
      </pre>
      <button
        className="op-icon-btn small"
        style={{ position: 'absolute', top: 6, right: 6 }}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

export function ConnectDialog() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    client.request<McpInfo>('mcp.info').then(setInfo).catch(() => {});
  }, []);

  const close = () => setState({ showConnect: false });

  async function install(id: string, label: string) {
    setStatus((s) => ({ ...s, [id]: 'Installing…' }));
    try {
      const result = await client.request<{ ok: boolean; changed?: boolean; path?: string; reason?: string }>('harness.install', {
        harness: id,
      });
      if (result.ok) {
        setStatus((s) => ({ ...s, [id]: result.changed ? 'Added — restart the agent' : 'Already set up' }));
        toast(`${label}: OpenPaper MCP ${result.changed ? 'added' : 'already configured'}`);
      } else setStatus((s) => ({ ...s, [id]: result.reason ?? 'Failed' }));
    } catch (error) {
      setStatus((s) => ({ ...s, [id]: error instanceof Error ? error.message : 'Failed' }));
    }
  }

  const quote = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
  const commandLine = info ? [info.launch.command, ...info.launch.args].map(quote).join(' ') : '';
  const jsonConfig = info
    ? JSON.stringify({ mcpServers: { openpaper: { command: info.launch.command, args: info.launch.args } } }, null, 2)
    : '';

  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="op-dialog" role="dialog" aria-label="Connect an agent">
        <header>
          <span>
            <Plug size={16} /> Connect your agent
          </span>
          <button className="op-icon-btn" title="Close" onClick={close} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <p style={{ margin: 0, color: 'var(--op-text-2)', lineHeight: 1.55 }}>
            OpenPaper speaks the same MCP tools as Paper. Add it to your agent once, then ask things like{' '}
            <em>“Design a pricing page in OpenPaper”</em>. The agent's work appears on the canvas live.
          </p>

          <section>
            <div className="op-section-title">One-click setup</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
              {(info?.harnesses ?? []).map((h) => (
                <button
                  key={h.id}
                  className="op-btn outline"
                  style={{ justifyContent: 'space-between', height: 34, minWidth: 0, padding: '0 10px' }}
                  title={status[h.id] ? `${h.label}: ${status[h.id]}` : `Add OpenPaper to ${h.label}`}
                  onClick={() => void install(h.id, h.label)}
                >
                  <span className="op-truncate">{h.label}</span>
                  <span className="op-label op-truncate">{status[h.id] ?? 'Add'}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="op-section-title">Claude Code (terminal)</div>
            <CopyBlock text={`claude mcp add openpaper --scope user -- ${commandLine}`} />
          </section>

          <section>
            <div className="op-section-title">Any MCP client (stdio)</div>
            <CopyBlock text={jsonConfig} />
          </section>

          <section>
            <div className="op-section-title">Streamable HTTP</div>
            <CopyBlock text={info?.url ?? ''} />
            <p className="op-label" style={{ margin: '6px 0 0' }}>
              Works while OpenPaper is running. The stdio command above starts it automatically.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
