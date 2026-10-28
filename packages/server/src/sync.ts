import type { FigmaSettings } from './figma.ts';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { userInfo } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  generateJsx,
  OpError,
  PROTOCOL_VERSION,
  readerOf,
  type ClientMessage,
  type EditorCommand,
  type OpenFileResult,
  type ResourceInfo,
  type SiteInfo,
  type SpeechStatus,
  type ViewState,
  type AgentTarget,
} from '@openpaper/core';
import type { AgentService } from './agent/agent.ts';
import type { SpeechService } from './speech/service.ts';
import type { ThumbnailService } from './thumbnails.ts';
import { detectFolderForUrl, inspectFolder, pickFolder } from './sites/folders.ts';
import type { SiteProxies } from './sites/proxy.ts';
import { normalizeSiteUrl, type SiteRecord, type SiteStore } from './sites/store.ts';
import type { AgentSettings, Effort, Runner } from './agent/settings.ts';
import { executeCommand } from './commands.ts';
import { HARNESSES, installHarness } from './harness.ts';
import type { ActorRef } from './hub.ts';
import { MCP_PATH } from './paths.ts';
import type { OriginPolicy } from './security.ts';
import type { ToolEnv } from './tools/context.ts';
import type { EditorConnection } from './views.ts';
import { VERSION } from './version.ts';

export interface SyncOptions {
  env: ToolEnv;
  policy: OriginPolicy;
  mcpLaunch: () => { command: string; args: string[] };
  agents: AgentService;
  agentSettings: AgentSettings;
  figmaSettings?: FigmaSettings;
  /** Local speech-to-text behind the mic buttons (unset: voice input unavailable). */
  speech?: SpeechService;
  /** The user's own running sites, framed through per-site proxies (unset: no live sites). */
  sites?: { store: SiteStore; proxies: SiteProxies };
  /** Canvas previews on the home screen's file cards (unset: cards show an icon). */
  thumbnails?: ThumbnailService;
}

/** A site as the editor sees it (the proxy port is server bookkeeping). */
function siteInfo({ proxyPort: _port, ...site }: SiteRecord): SiteInfo {
  return site;
}

/** Whether anything answers at a URL (any HTTP status counts). */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

const NO_SPEECH: SpeechStatus = { engine: 'Voice input', state: 'unavailable', sizeBytes: 0, downloadedBytes: 0, error: 'Voice input is not set up on this server.' };

/** 16-bit little-endian PCM (base64) → samples in [-1, 1]. */
function decodePcm16(base64: string): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  const samples = new Float32Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  return samples;
}

function localUserName(): string {
  try {
    const name = userInfo().username;
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'You';
  } catch {
    return 'You';
  }
}

/** WebSocket endpoint for editors: commands in, patches/presence/activity out. */
export function createSyncServer({ env, policy, mcpLaunch, agents, agentSettings, figmaSettings, speech, sites, thumbnails }: SyncOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const userName = localUserName();

  const resources = (): ResourceInfo[] => {
    const open = new Set(env.views.openFileIds());
    const active = env.views.activeFileId();
    return env.store.list().map((r) => ({
      ...r,
      open: open.has(r.id),
      active: r.id === active,
      ...(r.type === 'file' ? { thumbnail: thumbnails?.thumbnailFor(r.id) } : {}),
    }));
  };

  env.hub.on('commit', (e) => {
    env.views.broadcast(e.fileId, { t: 'patch', fileId: e.fileId, version: e.version, patch: e.patch, actor: e.actor, label: e.label });
    if (e.patch.meta?.name !== undefined) env.resourcesChanged();
  });

  const userActor = (conn: EditorConnection): ActorRef => ({ kind: 'user', id: conn.clientId, name: userName });

  async function handleRequest(conn: EditorConnection, method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'resources.list':
        // Someone is looking at the file list: fill in missing or outdated previews in the background.
        thumbnails?.backfill();
        return resources();
      case 'file.create': {
        const doc = await env.store.create({ name: params?.name, parentId: params?.parentId ?? null });
        env.hub.adopt(doc);
        env.resourcesChanged();
        return { fileId: doc.id };
      }
      case 'file.open': {
        const live = await env.hub.get(String(params.fileId));
        conn.subscriptions.add(live.id);
        const result: OpenFileResult = {
          doc: live.doc,
          version: live.version,
          agents: env.presence.presenceFor(live.id),
          activity: env.presence.activityFor(live.id),
        };
        return result;
      }
      case 'file.close':
        conn.subscriptions.delete(String(params.fileId));
        return null;
      case 'file.command': {
        const live = await env.hub.get(String(params.fileId));
        try {
          return await executeCommand(live, userActor(conn), params.command as EditorCommand, { assets: env.assets, userName });
        } catch (error) {
          if (error instanceof OpError) throw new Error(error.message);
          throw error;
        }
      }
      case 'file.undo':
        return (await env.hub.get(String(params.fileId))).undo(userActor(conn));
      case 'file.redo':
        return (await env.hub.get(String(params.fileId))).redo(userActor(conn));
      case 'file.undoAgent': {
        // Undo the last change an agent made (by MCP session id).
        const live = await env.hub.get(String(params.fileId));
        return live.undo({ kind: 'agent', id: String(params.sessionId), name: 'agent' });
      }
      case 'view.update': {
        const view = params as ViewState;
        const before = conn.view;
        conn.view = { ...view, selection: Array.isArray(view.selection) ? view.selection.slice(0, 1000) : [] };
        if (typeof view.fileId === 'string' && typeof view.pageId === 'string') thumbnails?.viewing(view.fileId, view.pageId);
        // Leaving a file (for home, a site or another file) or switching away from the window
        // catches its preview up in the background.
        if (before.fileId && (before.fileId !== view.fileId || (before.focused && !view.focused))) thumbnails?.left(before.fileId);
        if (view.focused) conn.lastActiveAt = Date.now();
        return null;
      }
      case 'resource.rename': {
        const entry = env.store.get(String(params.resourceId));
        if (!entry) throw new Error('Not found');
        const name = String(params.name ?? '').trim().slice(0, 500);
        if (!name) return null;
        if (entry.type === 'file') {
          const live = await env.hub.get(entry.id);
          live.transact(userActor(conn), 'Rename file', (tx) => tx.setName(name));
          await live.flush();
        } else await env.store.renameFolder(entry.id, name);
        env.resourcesChanged();
        return null;
      }
      case 'resource.delete': {
        const id = String(params.resourceId);
        if (env.hub.isOpen(id)) await env.hub.close(id);
        await env.store.delete(id);
        await thumbnails?.removed(id);
        env.resourcesChanged();
        return null;
      }
      case 'folder.create': {
        const entry = await env.store.createFolder(String(params.name ?? 'New folder'), params.parentId ?? null);
        env.resourcesChanged();
        return entry;
      }
      case 'mcp.info':
        return {
          url: `${env.baseUrl()}${MCP_PATH}`,
          launch: mcpLaunch(),
          harnesses: Object.entries(HARNESSES).map(([id, fn]) => ({ id, label: fn('', mcpLaunch()).label })),
        };
      case 'harness.install':
        return installHarness(String(params.harness), mcpLaunch());
      case 'jsx': {
        const live = await env.hub.get(String(params.fileId));
        const format = params.format === 'inline-styles' ? 'inline-styles' : 'tailwind';
        return generateJsx(readerOf(live.doc), String(params.nodeId), {
          format,
          includeNodeIds: !!params.includeNodeIds,
          includeRootPositioning: false,
          canonicalize: format === 'tailwind' ? await env.tailwind.canonicalizerFor(live.doc.tokens) : undefined,
        });
      }
      case 'export.render': {
        const live = await env.hub.get(String(params.fileId));
        const nodeId = String(params.nodeId);
        const format = String(params.format) as 'png' | 'jpg' | 'webp' | 'pdf' | 'svg';
        if (format === 'pdf') return { mimeType: 'application/pdf', data: (await env.render.exportPdf(live.doc, nodeId)).toString('base64') };
        if (format === 'svg') {
          const node = live.doc.nodes[nodeId];
          if (node?.component !== 'SVG' || !node.svg) throw new Error('SVG export works for vector layers only. Try PNG.');
          return { mimeType: 'image/svg+xml', data: Buffer.from(node.svg).toString('base64') };
        }
        const data = await env.render.exportRaster(live.doc, nodeId, format, Number(params.scale) || 1);
        return { mimeType: format === 'jpg' ? 'image/jpeg' : `image/${format}`, data: data.toString('base64') };
      }
      case 'fonts.css':
        return env.fonts.cssUrls((params?.families as string[]) ?? []);
      case 'fonts.list':
        return env.fonts.googleFamilies();
      case 'images.models':
        return env.images.models();
      // ---- built-in design agent ----
      case 'agent.config.get':
        return agentSettings.info();
      case 'agent.config.set':
        await agentSettings.update({
          ...(params?.runner ? { runner: String(params.runner) as Runner } : {}),
          ...(params?.apiKey !== undefined ? { apiKey: params.apiKey as string | null } : {}),
          // "" picks the runner's own default model (Codex, agy).
          ...(typeof params?.model === 'string' ? { model: params.model } : {}),
          ...(params?.effort ? { effort: String(params.effort) as Effort } : {}),
        });
        return agentSettings.info();
      case 'agent.agy.allow':
        await agentSettings.allowAgy();
        return agentSettings.info();
      case 'figma.config.get':
        return figmaSettings?.info() ?? { tokenSource: null };
      case 'figma.config.set':
        await figmaSettings?.setToken(params?.token === null ? null : String(params?.token ?? ''));
        return figmaSettings?.info() ?? { tokenSource: null };
      case 'agent.history': {
        const chat = agents.chat(String(params.fileId));
        return { items: chat.items, running: chat.running, usage: chat.usage };
      }
      case 'agent.send': {
        // The chat key is a file id, or `site:<id>` for a live site.
        const key = String(params.fileId);
        if (key.startsWith('site:')) {
          if (!sites?.store.get(key.slice('site:'.length))) throw new Error('This site no longer exists.');
        } else await env.hub.get(key);
        const chat = agents.chat(key);
        if (chat.running) throw new Error('The agent is already working on this.');
        const target = params.target && typeof params.target === 'object' ? (params.target as AgentTarget) : undefined;
        const page = typeof params.page === 'string' ? params.page.slice(0, 2000) : undefined;
        void chat.send(String(params.text ?? '').slice(0, 20_000), { target, page });
        return null;
      }
      case 'agent.stop':
        agents.chat(String(params.fileId)).stop();
        return null;
      // ---- live sites (the user's own dev server, framed through a proxy) ----
      case 'sites.list':
        return sites ? sites.store.list().map(siteInfo) : [];
      case 'sites.create': {
        if (!sites) throw new Error('Live sites are not available on this server.');
        return siteInfo(await sites.store.create({ url: String(params.url ?? ''), folder: String(params.folder ?? '') }));
      }
      case 'sites.update': {
        if (!sites) throw new Error('Live sites are not available on this server.');
        const patch = {
          ...(typeof params.url === 'string' ? { url: params.url } : {}),
          ...(typeof params.folder === 'string' ? { folder: params.folder } : {}),
          ...(typeof params.name === 'string' ? { name: params.name } : {}),
        };
        return siteInfo(await sites.store.update(String(params.id), patch));
      }
      case 'sites.delete': {
        const id = String(params.id);
        await sites?.proxies.stop(id);
        agents.chat(`site:${id}`).reset();
        await sites?.store.delete(id);
        return null;
      }
      case 'sites.open': {
        const id = String(params.id);
        const site = sites?.store.get(id);
        if (!sites || !site) throw new Error('This site no longer exists.');
        const { proxyUrl } = await sites.proxies.start(site);
        conn.subscriptions.add(`site:${id}`);
        const opened = await sites.store.update(id, { lastOpenedAt: new Date().toISOString() });
        return { site: siteInfo(opened), proxyUrl };
      }
      case 'sites.close':
        conn.subscriptions.delete(`site:${String(params.id)}`);
        return null;
      case 'sites.pickFolder':
        return pickFolder({ initial: typeof params?.start === 'string' && params.start ? params.start : undefined });
      case 'sites.inspectFolder':
        return inspectFolder(String(params.path ?? ''));
      // Is the dev server up? / Which folder does it run from? (Separate: finding the folder can take seconds.)
      case 'sites.probe':
      case 'sites.detect': {
        let url: string;
        try {
          url = normalizeSiteUrl(String(params.url ?? ''));
        } catch {
          return method === 'sites.probe' ? { reachable: false } : { folder: null };
        }
        return method === 'sites.probe' ? { reachable: await reachable(url) } : { folder: await detectFolderForUrl(url).catch(() => null) };
      }
      // ---- voice input (transcribed on this machine) ----
      case 'speech.status':
        return speech?.status() ?? NO_SPEECH;
      case 'speech.install':
        if (!speech) throw new Error(NO_SPEECH.error);
        // Progress and failures arrive as `speech` pushes.
        void speech.install().catch(() => {});
        return speech.status();
      case 'speech.preload':
        void speech?.preload();
        return null;
      case 'speech.transcribe': {
        if (!speech) throw new Error(NO_SPEECH.error);
        const { text } = await speech.transcribe(decodePcm16(String(params.audio ?? '')), Number(params.sampleRate) || 16_000);
        return { text };
      }
      case 'agent.reset':
        agents.chat(String(params.fileId)).reset();
        return null;
      default:
        throw new Error(`Unknown method "${method}"`);
    }
  }

  function attach(ws: WebSocket) {
    let conn: EditorConnection | null = null;
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.t === 'hello') {
        const clientId = msg.clientId && /^[\w-]{8,64}$/.test(msg.clientId) && !env.views.conns.has(msg.clientId) ? msg.clientId : randomUUID();
        conn = {
          clientId,
          ws,
          view: { fileId: null, pageId: null, selection: [], focused: false },
          subscriptions: new Set(),
          lastActiveAt: Date.now(),
          pendingRpc: new Map(),
        };
        env.views.add(conn);
        env.views.send(conn, { t: 'welcome', clientId, serverVersion: VERSION, protocol: PROTOCOL_VERSION, mcpUrl: `${env.baseUrl()}${MCP_PATH}` });
        return;
      }
      if (!conn) return;
      if (msg.t === 'rpc-res') {
        env.views.resolveRpc(conn, msg.id, msg.result, msg.error);
        return;
      }
      if (msg.t === 'req') {
        const c = conn;
        handleRequest(c, msg.method, msg.params)
          .then((result) => env.views.send(c, { t: 'res', id: msg.id, result }))
          .catch((error: unknown) => env.views.send(c, { t: 'res', id: msg.id, error: error instanceof Error ? error.message : String(error) }));
      }
    });
    ws.on('close', () => {
      if (!conn) return;
      env.views.remove(conn.clientId);
      // A tab closed on a file counts as leaving it.
      if (conn.view.fileId) thumbnails?.left(conn.view.fileId);
    });
    ws.on('error', () => ws.close());
  }

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/ws' || !policy.sameOrigin(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
    },
    broadcastResources() {
      env.views.broadcast(null, { t: 'resources', resources: resources() });
    },
    close() {
      for (const client of wss.clients) client.close();
      wss.close();
    },
  };
}
