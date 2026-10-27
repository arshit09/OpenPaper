import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Monitor, MousePointerClick, RotateCw, Settings2, Smartphone, Tablet } from 'lucide-react';
import type { SiteElementInfo, SiteInfo } from '@openpaper/core';
import { toast, useEditor } from '../state/store.ts';
import { client, openChat, sendToAgent } from '../sync/session.ts';
import { AgentDock } from '../editor/AgentDock.tsx';
import { Logo } from '../ui/Logo.tsx';
import { PointPrompt, type PromptRect } from '../ui/PointPrompt.tsx';
import { isTyping } from '../editor/canvas/Canvas.tsx';
import { elementLabel, isInspectorMessage, rebase, sameSiteProxyUrl, type InspectorRect, type ToInspector } from './inspector.ts';
import { SiteDialog } from './SiteDialog.tsx';

const DEVICES = [
  { id: 'desktop', label: 'Desktop', width: null, Icon: Monitor },
  { id: 'tablet', label: 'Tablet (834)', width: 834, Icon: Tablet },
  { id: 'phone', label: 'Phone (390)', width: 390, Icon: Smartphone },
] as const;
type Device = (typeof DEVICES)[number]['id'];

const short = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${path.includes('\\') ? '\\' : '/'}${parts.slice(-2).join(path.includes('\\') ? '\\' : '/')}` : path;
};

/** The user's own running site, framed through OpenPaper's proxy so they can point at elements and ask the agent. */
export function SiteView({ siteId }: { siteId: string }) {
  const connection = useEditor((s) => s.connection);
  const running = useEditor((s) => s.agentChat.running);
  const [site, setSite] = useState<SiteInfo | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  /** The iframe's current page, as a site URL. */
  const [page, setPage] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [inspect, setInspect] = useState(true);
  const [device, setDevice] = useState<Device>('desktop');
  const [elements, setElements] = useState<SiteElementInfo[]>([]);
  const [rects, setRects] = useState<InspectorRect[]>([]);
  const [promptOpen, setPromptOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [bounds, setBounds] = useState({ width: 0, height: 0, frameX: 0, frameY: 0 });
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const hasDraft = useRef(false);
  /** The frame has loaded a page from the proxy (before that its window is still ours, so messages would misfire). */
  const loaded = useRef(false);
  /** Selectors of the current pick, to tell a new pick from the same one re-sent. */
  const pickKey = useRef('');

  const proxyOrigin = proxyUrl ? new URL(proxyUrl).origin : null;
  const post = useCallback(
    (message: ToInspector) => {
      if (proxyOrigin && loaded.current) frame.current?.contentWindow?.postMessage({ source: 'openpaper', ...message }, proxyOrigin);
    },
    [proxyOrigin]
  );

  // Open the site (starts its proxy) and its agent chat; again after a reconnect.
  useEffect(() => {
    let live = true;
    const open = () =>
      client
        .request<{ site: SiteInfo; proxyUrl: string }>('sites.open', { id: siteId })
        .then((r) => {
          if (!live) return;
          setSite(r.site);
          setProxyUrl((prev) => prev ?? sameSiteProxyUrl(r.proxyUrl, location.hostname));
          document.title = `${r.site.name} — OpenPaper`;
        })
        .catch((error) => {
          toast(error instanceof Error ? error.message : String(error));
          location.hash = '#/';
        });
    if (connection === 'open') void open();
    openChat(`site:${siteId}`);
    return () => {
      live = false;
    };
  }, [siteId, connection]);

  useEffect(
    () => () => {
      client.notify('sites.close', { id: siteId });
      openChat(null);
      document.title = 'OpenPaper';
    },
    [siteId]
  );

  useEffect(() => {
    if (!proxyOrigin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== proxyOrigin || e.source !== frame.current?.contentWindow || !isInspectorMessage(e.data)) return;
      const m = e.data;
      switch (m.type) {
        case 'ready':
          // A new document: it starts with no mode and no selection (a reload's selection is sent back after hello).
          loaded.current = true;
          post({ type: 'hello' });
          post({ type: 'mode', inspect });
          setElements([]);
          setRects([]);
          setPage(rebase(m.url, proxyOrigin, site?.url ?? m.url));
          break;
        case 'location':
          setPage(rebase(m.url, proxyOrigin, site?.url ?? m.url));
          break;
        case 'unreachable':
          setPage(m.url);
          setElements([]);
          setRects([]);
          break;
        case 'selection': {
          setElements(m.elements);
          // The same elements re-sent (HMR, agent done) only refresh their info; a new pick opens the prompt.
          const key = m.elements.map((el) => el.selector).join('|');
          if (key === pickKey.current) break;
          pickKey.current = key;
          if (!m.elements.length) setRects([]);
          else if (inspect) setPromptOpen(true);
          else if (!hasDraft.current) setPromptOpen(false);
          break;
        }
        case 'rects':
          setRects(m.rects);
          break;
        case 'mode':
          setInspect(m.inspect);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [proxyOrigin, post, inspect, site?.url]);

  useEffect(() => post({ type: 'mode', inspect }), [inspect, post]);
  // The clicked element shimmers while the agent works on it.
  useEffect(() => post({ type: 'working', active: running && elements.length > 0 }), [running, elements.length, post]);

  useEffect(() => {
    if (page) setAddress(page);
  }, [page]);

  // Escape (outside text fields) clears the pick, then leaves Select mode. Focus usually stays out here, not in the frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog on top (editing the site) takes the Escape itself.
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e) || document.querySelector('.op-dialog-backdrop')) return;
      if (elements.length) post({ type: 'clear' });
      else if (inspect) setInspect(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [elements.length, inspect, post]);

  // Where the frame sits inside the stage (the prompt is positioned in stage coordinates).
  useLayoutEffect(() => {
    const measure = () => {
      const s = stage.current?.getBoundingClientRect();
      const f = frame.current?.getBoundingClientRect();
      if (s && f) setBounds({ width: s.width, height: s.height, frameX: f.left - s.left, frameY: f.top - s.top });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (stage.current) ro.observe(stage.current);
    if (frame.current) ro.observe(frame.current);
    return () => ro.disconnect();
  }, [device, proxyUrl]);

  const navigate = (target: string) => {
    if (!site || !proxyUrl || !frame.current) return;
    let url = target.trim();
    if (!url) return;
    if (url.startsWith('/')) url = new URL(url, site.url).href;
    else if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    const proxied = rebase(url, site.url, proxyUrl);
    if (proxied === url && new URL(url).origin !== new URL(site.url).origin) {
      toast(`Only pages of ${new URL(site.url).host} open here.`);
      return;
    }
    frame.current.src = proxied;
  };

  const reload = () => {
    if (!frame.current || !proxyUrl) return;
    frame.current.src = page && site ? rebase(page, site.url, proxyUrl) : proxyUrl;
  };

  const union = rects.length
    ? rects.reduce<PromptRect>(
        (u, r) => {
          const x = Math.min(u.x, r.x);
          const y = Math.min(u.y, r.y);
          return { x, y, width: Math.max(u.x + u.width, r.x + r.width) - x, height: Math.max(u.y + u.height, r.y + r.height) - y };
        },
        { ...rects[0]! }
      )
    : null;
  const label = elements.length ? elementLabel(elements) : '';
  const target = elements.length ? { label, elements } : undefined;
  const width = DEVICES.find((d) => d.id === device)!.width;

  return (
    <div className="op-site">
      <header className="op-site-bar">
        <a href="#/" className="op-icon-btn" title="All files" aria-label="All files" style={{ color: 'var(--op-text)' }}>
          <Logo size={18} withText={false} />
        </a>
        <div className="op-site-name">
          <b className="op-truncate" title={site?.name}>
            {site?.name ?? 'Opening…'}
          </b>
          {site && (
            <button className="op-btn op-site-folder" title={`Project folder: ${site.folder} (click to change)`} onClick={() => setEditing(true)}>
              <FolderOpen size={12} /> <span className="op-truncate">{short(site.folder)}</span>
            </button>
          )}
        </div>
        <form
          className="op-site-address"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(address);
          }}
        >
          <button type="button" className="op-icon-btn small" title="Reload" onClick={reload}>
            <RotateCw size={13} />
          </button>
          <input className="op-input" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} aria-label="Page address" />
        </form>
        <div className="op-row" style={{ gap: 4, marginLeft: 'auto' }}>
          <button
            className={`op-btn${inspect ? ' op-site-select' : ''}`}
            aria-pressed={inspect}
            title={inspect ? 'Click elements to select them. Turn off to use the site normally.' : 'Select elements to change them'}
            onClick={() => setInspect(!inspect)}
          >
            <MousePointerClick size={14} /> Select
          </button>
          <div className="op-device-toggle" role="group" aria-label="Device width">
            {DEVICES.map(({ id, label: name, Icon }) => (
              <button key={id} className={`op-icon-btn${device === id ? ' pressed' : ''}`} title={name} aria-pressed={device === id} onClick={() => setDevice(id)}>
                <Icon size={14} />
              </button>
            ))}
          </div>
          {site && (
            <a className="op-icon-btn" href={page ?? site.url} target="_blank" rel="noreferrer" title="Open in a new tab">
              <ExternalLink size={14} />
            </a>
          )}
          <button className="op-icon-btn" title="Site settings" onClick={() => setEditing(true)}>
            <Settings2 size={14} />
          </button>
        </div>
      </header>
      <div ref={stage} className="op-site-stage">
        <div className={`op-site-frame${width ? ' device' : ''}`} style={width ? { width } : undefined}>
          {proxyUrl && (
            <iframe
              ref={frame}
              src={proxyUrl}
              title={site?.name ?? 'Site'}
              // Not the mic, camera, location or clipboard reads: the editor's own grants (voice input, paste)
              // would carry over to whatever the proxied page loads, without a prompt.
              allow="clipboard-write; fullscreen"
              onLoad={() => {
                loaded.current = true;
                post({ type: 'hello' });
                post({ type: 'mode', inspect });
              }}
            />
          )}
        </div>
        {union && target && (
          <PointPrompt
            rect={{ ...union, x: union.x + bounds.frameX, y: union.y + bounds.frameY }}
            bounds={bounds}
            label={label}
            open={promptOpen}
            focusKey={pickKey.current}
            onOpenChange={(v) => {
              setPromptOpen(v);
              if (v) return;
              pickKey.current = ''; // Clicking the same element again reopens it.
              frame.current?.focus();
            }}
            onDraftChange={(v) => (hasDraft.current = v)}
            onSend={(text) => sendToAgent(text, { target, page: page ?? undefined })}
          />
        )}
        <AgentDock
          claudeCodeOnly
          placeholder="Ask AI to change your site…"
          emptyHint={
            <>
              Turn on <b>Select</b>, click anything on your site, and say what should change, like <i>“make this button rounder”</i> or{' '}
              <i>“use our brand blue here”</i>. Claude Code edits the code in your project folder and your dev server reloads the page.
            </>
          }
          extra={() => ({ page: page ?? undefined, target })}
        />
      </div>
      {editing && site && (
        <SiteDialog
          site={site}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            const urlChanged = saved.url !== site.url;
            setSite(saved);
            if (urlChanged) {
              // A new address means a new proxy target: reopen it.
              void client.request<{ site: SiteInfo; proxyUrl: string }>('sites.open', { id: saved.id }).then((r) => {
                const next = sameSiteProxyUrl(r.proxyUrl, location.hostname);
                loaded.current = false;
                setProxyUrl(next);
                if (frame.current) frame.current.src = next;
              });
            }
          }}
        />
      )}
    </div>
  );
}
