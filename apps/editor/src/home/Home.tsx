import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Folder, FileText, Bot, Trash2, Pencil, Sparkles } from 'lucide-react';
import type { ResourceInfo } from '@openpaper/core';
import { useEditor, setState, toast } from '../state/store.ts';
import { client, refreshResources } from '../sync/session.ts';
import { Logo } from '../ui/Logo.tsx';

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Home() {
  const resources = useEditor((s) => s.resources);
  const connection = useEditor((s) => s.connection);
  const agents = useEditor((s) => s.agents);
  const [folderId, setFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (connection === 'open') void refreshResources();
  }, [connection]);

  const items = useMemo(
    () =>
      resources
        .filter((r) => r.parentId === folderId)
        .sort((a, b) => (a.type === b.type ? b.updatedAt.localeCompare(a.updatedAt) : a.type === 'folder' ? -1 : 1)),
    [resources, folderId]
  );
  const folder = folderId ? resources.find((r) => r.id === folderId) : null;

  async function createFile() {
    const { fileId } = await client.request<{ fileId: string }>('file.create', { parentId: folderId });
    location.hash = `#/file/${fileId}`;
  }

  async function createFolder() {
    const name = prompt('Folder name', 'New folder');
    if (!name) return;
    await client.request('folder.create', { name, parentId: folderId });
  }

  async function rename(r: ResourceInfo) {
    const name = prompt(`Rename ${r.type}`, r.name);
    if (!name || name === r.name) return;
    await client.request('resource.rename', { resourceId: r.id, name });
  }

  async function remove(r: ResourceInfo) {
    if (!confirm(`Delete "${r.name}"? This cannot be undone.`)) return;
    await client.request('resource.delete', { resourceId: r.id });
    toast(`Deleted ${r.name}`);
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--op-panel-2)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 56,
          padding: '0 20px',
          background: 'var(--op-panel)',
          borderBottom: '1px solid var(--op-border)',
        }}
      >
        <Logo />
        <div style={{ flex: 1 }} />
        <span className="op-badge" title="Server connection">
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 99,
              background: connection === 'open' ? 'var(--op-success)' : 'var(--op-danger)',
            }}
          />
          {connection === 'open' ? 'Local server' : 'Connecting…'}
        </span>
        <button className="op-btn outline" onClick={() => setState({ showConnect: true })}>
          <Bot size={15} /> Connect an agent
        </button>
        <button className="op-btn primary" onClick={createFile}>
          <FilePlus2 size={15} /> New file
        </button>
      </header>

      <main className="op-scroll" style={{ flex: 1, padding: '28px 32px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <div className="op-row" style={{ marginBottom: 18, gap: 10 }}>
            <h1 style={{ fontSize: 20, margin: 0, fontWeight: 650 }}>
              {folder ? (
                <>
                  <a href="#/" onClick={(e) => (e.preventDefault(), setFolderId(null))} style={{ color: 'var(--op-text-3)' }}>
                    Files
                  </a>{' '}
                  / {folder.name}
                </>
              ) : (
                'Files'
              )}
            </h1>
            <div style={{ flex: 1 }} />
            <button className="op-btn" onClick={createFolder}>
              <Folder size={14} /> New folder
            </button>
          </div>

          {items.length === 0 ? (
            <div
              style={{
                border: '1px dashed var(--op-border-strong)',
                borderRadius: 12,
                padding: '48px 24px',
                textAlign: 'center',
                background: 'var(--op-panel)',
              }}
            >
              <Sparkles size={26} style={{ color: 'var(--op-agent)' }} />
              <h2 style={{ fontSize: 16, margin: '10px 0 6px' }}>Design with your AI agent</h2>
              <p style={{ color: 'var(--op-text-2)', maxWidth: 460, margin: '0 auto 16px', lineHeight: 1.55 }}>
                Create a file, connect Claude Code, Cursor, Codex or any MCP client, and watch it draw on the canvas in
                real time. Everything stays on your machine.
              </p>
              <div className="op-row" style={{ justifyContent: 'center' }}>
                <button className="op-btn primary" onClick={createFile}>
                  <FilePlus2 size={15} /> New file
                </button>
                <button className="op-btn outline" onClick={() => setState({ showConnect: true })}>
                  <Bot size={15} /> Connect an agent
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {items.map((r) => (
                <div
                  key={r.id}
                  onClick={() => (r.type === 'folder' ? setFolderId(r.id) : (location.hash = `#/file/${r.id}`))}
                  style={{
                    background: 'var(--op-panel)',
                    border: '1px solid var(--op-border)',
                    borderRadius: 10,
                    overflow: 'hidden',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      height: 120,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: r.type === 'folder' ? 'var(--op-panel-2)' : 'var(--op-canvas)',
                      color: 'var(--op-text-3)',
                    }}
                  >
                    {r.type === 'folder' ? <Folder size={34} /> : <FileText size={30} />}
                  </div>
                  <div className="op-row" style={{ padding: '10px 10px 10px 12px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name}
                      </div>
                      <div className="op-label">{r.type === 'folder' ? 'Folder' : `Edited ${timeAgo(r.updatedAt)}`}</div>
                    </div>
                    <button className="op-icon-btn small" title="Rename" onClick={(e) => (e.stopPropagation(), void rename(r))}>
                      <Pencil size={13} />
                    </button>
                    <button className="op-icon-btn small" title="Delete" onClick={(e) => (e.stopPropagation(), void remove(r))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {agents.length > 0 && <p className="op-label" style={{ marginTop: 16 }}>{agents.length} agent(s) connected</p>}
        </div>
      </main>
    </div>
  );
}
