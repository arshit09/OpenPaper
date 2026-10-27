import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Folder, FileText, Bot, Trash2, Pencil, AppWindow } from 'lucide-react';
import type { ResourceInfo, SiteInfo } from '@openpaper/core';
import { useEditor, setState, toast } from '../state/store.ts';
import { client, refreshResources } from '../sync/session.ts';
import { AgentMark, Logo } from '../ui/Logo.tsx';
import { SiteDialog } from '../site/SiteDialog.tsx';

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
  const [sites, setSites] = useState<SiteInfo[]>([]);
  /** The live-site dialog: adding one (site null) or editing one. */
  const [siteDialog, setSiteDialog] = useState<{ site: SiteInfo | null } | null>(null);

  useEffect(() => {
    if (connection !== 'open') return;
    void refreshResources();
    client.request<SiteInfo[]>('sites.list').then(setSites).catch(() => {});
  }, [connection]);

  const items = useMemo(
    () =>
      resources
        .filter((r) => r.parentId === folderId)
        .sort((a, b) => (a.type === b.type ? b.updatedAt.localeCompare(a.updatedAt) : a.type === 'folder' ? -1 : 1)),
    [resources, folderId]
  );
  const folder = folderId ? resources.find((r) => r.id === folderId) : null;

  /** Server errors (it went away, a name clash) show up as a toast instead of only in the console. */
  const report = (error: unknown) => toast(error instanceof Error ? error.message : String(error));

  async function createFile() {
    try {
      const { fileId } = await client.request<{ fileId: string }>('file.create', { parentId: folderId });
      location.hash = `#/file/${fileId}`;
    } catch (error) {
      report(error);
    }
  }

  async function createFolder() {
    const name = prompt('Folder name', 'New folder');
    if (!name) return;
    await client.request('folder.create', { name, parentId: folderId }).catch(report);
  }

  async function rename(r: ResourceInfo) {
    const name = prompt(`Rename ${r.type}`, r.name);
    if (!name || name === r.name) return;
    await client.request('resource.rename', { resourceId: r.id, name }).catch(report);
  }

  async function removeSite(site: SiteInfo) {
    if (!confirm(`Remove "${site.name}" from OpenPaper? Your project folder and its files stay as they are.`)) return;
    try {
      await client.request('sites.delete', { id: site.id });
      setSites((list) => list.filter((s) => s.id !== site.id));
    } catch (error) {
      report(error);
    }
  }

  async function remove(r: ResourceInfo) {
    if (!confirm(`Delete "${r.name}"? This cannot be undone.`)) return;
    try {
      await client.request('resource.delete', { resourceId: r.id });
      toast(`Deleted ${r.name}`);
    } catch (error) {
      report(error);
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--op-panel-2)' }}>
      <header className="op-home-header">
        <Logo />
        <div style={{ flex: 1 }} />
        <span className="op-badge" title="Server connection" style={{ marginRight: 4 }}>
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
        <button className="op-btn outline" title="Open the site you're building and edit it with the agent" onClick={() => setSiteDialog({ site: null })}>
          <AppWindow size={15} /> Open live site
        </button>
        <button className="op-btn primary" onClick={createFile}>
          <FilePlus2 size={15} /> New file
        </button>
      </header>

      <main className="op-scroll" style={{ flex: 1, padding: '28px 32px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          {!folder && sites.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <div className="op-row" style={{ marginBottom: 18, gap: 10 }}>
                <h1 style={{ flex: 1, fontSize: 20, margin: 0, fontWeight: 650, lineHeight: '28px' }}>Live sites</h1>
                <button className="op-btn" onClick={() => setSiteDialog({ site: null })}>
                  <AppWindow size={14} /> Add site
                </button>
              </div>
              <div className="op-file-grid">
                {sites.map((site) => {
                  const openSite = () => (location.hash = `#/site/${site.id}`);
                  return (
                    <div
                      key={site.id}
                      className="op-file-card"
                      role="button"
                      tabIndex={0}
                      aria-label={`Open site ${site.name}`}
                      onClick={openSite}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                        e.preventDefault();
                        openSite();
                      }}
                    >
                      <div className="op-file-thumb op-site-thumb">
                        <AppWindow size={28} />
                        <span className="op-truncate">{site.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
                      </div>
                      <div className="op-file-meta">
                        <div>
                          <div className="op-truncate" style={{ fontWeight: 550 }} title={site.name}>
                            {site.name}
                          </div>
                          <div className="op-label op-truncate" title={site.folder}>
                            {site.folder}
                          </div>
                        </div>
                        <button className="op-icon-btn small" title="Edit" onClick={(e) => (e.stopPropagation(), setSiteDialog({ site }))}>
                          <Pencil size={13} />
                        </button>
                        <button className="op-icon-btn small" title="Remove" onClick={(e) => (e.stopPropagation(), void removeSite(site))}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          <div className="op-row" style={{ marginBottom: 18, gap: 10 }}>
            <h1 className="op-truncate" style={{ flex: 1, fontSize: 20, margin: 0, fontWeight: 650, lineHeight: '28px' }} title={folder?.name}>
              {folder ? (
                <>
                  <a href="#/" className="op-crumb" onClick={(e) => (e.preventDefault(), setFolderId(null))}>
                    Files
                  </a>{' '}
                  <span style={{ color: 'var(--op-text-3)' }}>/</span> {folder.name}
                </>
              ) : (
                'Files'
              )}
            </h1>
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
              <AgentMark size={26} />
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
                <button className="op-btn outline" onClick={() => setSiteDialog({ site: null })}>
                  <AppWindow size={15} /> Open live site
                </button>
              </div>
            </div>
          ) : (
            <div className="op-file-grid">
              {items.map((r) => {
                const openItem = () => (r.type === 'folder' ? setFolderId(r.id) : (location.hash = `#/file/${r.id}`));
                return (
                  <div
                    key={r.id}
                    className={`op-file-card${r.type === 'folder' ? ' folder' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${r.type} ${r.name}`}
                    onClick={openItem}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                      e.preventDefault();
                      openItem();
                    }}
                  >
                    <div className="op-file-thumb" style={r.thumbnail?.background ? { background: r.thumbnail.background } : undefined}>
                      {r.type === 'folder' ? (
                        <Folder size={34} />
                      ) : r.thumbnail ? (
                        // A new version swaps in place: the browser keeps the old image until the new one is decoded.
                        <img src={r.thumbnail.url} alt="" draggable={false} decoding="async" />
                      ) : (
                        <FileText size={30} />
                      )}
                    </div>
                    <div className="op-file-meta">
                      <div>
                        <div className="op-truncate" style={{ fontWeight: 550 }} title={r.name}>
                          {r.name}
                        </div>
                        <div className="op-label op-truncate">{r.type === 'folder' ? 'Folder' : `Edited ${timeAgo(r.updatedAt)}`}</div>
                      </div>
                      <button className="op-icon-btn small" title="Rename" onClick={(e) => (e.stopPropagation(), void rename(r))}>
                        <Pencil size={13} />
                      </button>
                      <button className="op-icon-btn small" title="Delete" onClick={(e) => (e.stopPropagation(), void remove(r))}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {agents.length > 0 && <p className="op-label" style={{ marginTop: 16 }}>{agents.length} agent(s) connected</p>}
        </div>
      </main>
      {siteDialog && (
        <SiteDialog
          site={siteDialog.site ?? undefined}
          onClose={() => setSiteDialog(null)}
          onSaved={(saved) => {
            setSiteDialog(null);
            if (siteDialog.site) setSites((list) => list.map((s) => (s.id === saved.id ? saved : s)));
            else location.hash = `#/site/${saved.id}`;
          }}
        />
      )}
    </div>
  );
}
