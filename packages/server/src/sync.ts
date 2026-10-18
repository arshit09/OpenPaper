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
  type ViewState,
} from '@openpaper/core';
import type { AgentService } from './agent/agent.ts';
import type { AgentSettings, Effort } from './agent/settings.ts';
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
export function createSyncServer({ env, policy, mcpLaunch, agents, agentSettings, figmaSettings }: SyncOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const userName = localUserName();

  const resources = (): ResourceInfo[] => {
    const open = new Set(env.views.openFileIds());
    const active = env.views.activeFileId();
    return env.store.list().map((r) => ({ ...r, open: open.has(r.id), active: r.id === active }));
  };

  env.hub.on('commit', (e) => {
    env.views.broadcast(e.fileId, { t: 'patch', fileId: e.fileId, version: e.version, patch: e.patch, actor: e.actor, label: e.label });
    if (e.patch.meta?.name !== undefined) env.resourcesChanged();
  });

  const userActor = (conn: EditorConnection): ActorRef => ({ kind: 'user', id: conn.clientId, name: userName });

  async function handleRequest(conn: EditorConnection, method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'resources.list':
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
        conn.view = { ...view, selection: Array.isArray(view.selection) ? view.selection.slice(0, 1000) : [] };
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
          ...(params?.apiKey !== undefined ? { apiKey: params.apiKey as string | null } : {}),
          ...(params?.model ? { model: String(params.model) } : {}),
          ...(params?.effort ? { effort: String(params.effort) as Effort } : {}),
        });
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
        const fileId = String(params.fileId);
        await env.hub.get(fileId);
        const chat = agents.chat(fileId);
        if (chat.running) throw new Error('The agent is already working on this file.');
        void chat.send(String(params.text ?? '').slice(0, 20_000));
        return null;
      }
      case 'agent.stop':
        agents.chat(String(params.fileId)).stop();
        return null;
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
      if (conn) env.views.remove(conn.clientId);
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
