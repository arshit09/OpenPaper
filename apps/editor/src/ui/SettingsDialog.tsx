import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy, Loader2, Settings, X } from 'lucide-react';
import type { AgentHarnessInfo } from '@openpaper/core';
import { setState, toast, useEditor } from '../state/store.ts';
import { client, connectAgent, loadHarnesses } from '../sync/session.ts';
import { AgentLogo } from './RunnerMark.tsx';
import { useEscape } from './useEscape.ts';

interface McpInfo {
  url: string;
  launch: { command: string; args: string[] };
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

/** What a connected agent's row says it can do, on hover. */
function agentHint(agent: AgentHarnessInfo): string {
  const where = agent.connected ? `OpenPaper is in ${agent.path}.` : `Connect adds OpenPaper to ${agent.path}.`;
  return agent.runner
    ? `${where} ${agent.label} can also answer right here: pick it in the agent menu beside a selection's prompt or the dock.`
    : `${where} Then ask ${agent.label} to design in OpenPaper, and its work appears on the canvas live.`;
}

function AgentRow({ agent }: { agent: AgentHarnessInfo }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const result = await connectAgent(agent.id, !agent.connected);
    setBusy(false);
    if (!result?.ok) return;
    if (agent.connected) toast(`${agent.label} disconnected. Restart it if it's open.`);
    else if (!result.changed) toast(`${agent.label} was already connected.`);
    else toast(agent.runner ? `${agent.label} connected. It can answer here now; restart it to design from there too.` : `${agent.label} connected. Restart it so it picks up OpenPaper.`, 4000);
  };
  return (
    <div className={`op-agent-item${agent.connected ? ' connected' : ''}`} title={agent.error ? undefined : agentHint(agent)}>
      <span className="op-agent-logo">
        <AgentLogo id={agent.id} size={18} />
      </span>
      <div className="op-agent-text">
        <div className="op-truncate op-agent-name">{agent.label}</div>
        {agent.error ? (
          <div className="op-agent-status error" title={`${agent.path}: ${agent.error}`}>
            Can't read its settings
          </div>
        ) : (
          <div className="op-agent-status">
            {agent.connected && <span className="op-agent-on" aria-hidden />}
            <span className="op-truncate">{agent.connected ? 'Connected' : 'Not connected'}</span>
          </div>
        )}
      </div>
      <button
        className={`op-btn compact ${agent.connected ? 'op-agent-disconnect' : 'outline'}`}
        disabled={busy || !!agent.error}
        aria-label={`${agent.connected ? 'Disconnect' : 'Connect'} ${agent.label}`}
        onClick={() => void toggle()}
      >
        {busy && <Loader2 size={12} className="op-spin" />}
        {agent.connected ? 'Disconnect' : 'Connect'}
      </button>
    </div>
  );
}

/**
 * Settings: connect the coding agents that design in OpenPaper (Claude Code, Cursor, Codex…) and disconnect
 * them again. Connecting adds OpenPaper's MCP server to the agent's own config file; disconnecting takes
 * just that entry back out. Opened from the gear on the home screen and the agent menus' Connect agent.
 */
export function SettingsDialog() {
  const harnesses = useEditor((s) => s.harnesses);
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    loadHarnesses().catch(() => {});
    client.request<McpInfo>('mcp.info').then(setInfo).catch(() => {});
  }, []);

  const close = () => setState({ showSettings: false });
  useEscape(close);

  const quote = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);
  const commandLine = info ? [info.launch.command, ...info.launch.args].map(quote).join(' ') : '';
  const jsonConfig = info
    ? JSON.stringify({ mcpServers: { openpaper: { command: info.launch.command, args: info.launch.args } } }, null, 2)
    : '';
  const connected = harnesses?.filter((h) => h.connected).length ?? 0;

  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="op-dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <header>
          <span>
            <Settings size={16} /> Settings
          </span>
          <button className="op-icon-btn" title="Close" onClick={close} aria-label="Close" autoFocus>
            <X size={16} />
          </button>
        </header>
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <section>
            <div className="op-section-title">
              <span>Agents</span>
              {connected > 0 && <span className="op-label">{connected} connected</span>}
            </div>
            <p style={{ margin: '0 0 12px', color: 'var(--op-text-2)', lineHeight: 1.55 }}>
              Connect an agent, then ask it things like <em>“Design a pricing page in OpenPaper”</em>. Its work appears on the canvas
              live. Claude Code, Codex and Antigravity can also answer right here, from the agent menu beside a selection or the dock.
            </p>
            {harnesses ? (
              <div className="op-agent-grid">
                {harnesses.map((h) => (
                  <AgentRow key={h.id} agent={h} />
                ))}
              </div>
            ) : (
              <div className="op-row op-label" style={{ minHeight: 56 }}>
                <Loader2 size={13} className="op-spin" /> Looking for your agents…
              </div>
            )}
          </section>

          <section>
            <button className="op-btn op-settings-disclosure" aria-expanded={manual} onClick={() => setManual(!manual)}>
              <ChevronRight size={14} className="op-settings-chevron" />
              Set up by hand
            </button>
            {manual && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
                <div>
                  <div className="op-section-title">Claude Code (terminal)</div>
                  <CopyBlock text={`claude mcp add openpaper --scope user -- ${commandLine}`} />
                </div>
                <div>
                  <div className="op-section-title">Any MCP client (stdio)</div>
                  <CopyBlock text={jsonConfig} />
                </div>
                <div>
                  <div className="op-section-title">Streamable HTTP</div>
                  <CopyBlock text={info?.url ?? ''} />
                  <p className="op-label" style={{ margin: '6px 0 0' }}>
                    Works while OpenPaper is running. The stdio command above starts it automatically.
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
