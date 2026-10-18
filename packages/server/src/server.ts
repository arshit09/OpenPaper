import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LayoutMap } from '@openpaper/core';
import { AgentService } from './agent/agent.ts';
import { AgentSettings } from './agent/settings.ts';
import { createApp } from './app.ts';
import { AssetResolver } from './assets.ts';
import { FontService } from './fonts/fonts.ts';
import { DocumentHub } from './hub.ts';
import { ImageGenService } from './images.ts';
import { createMcpHttpHandler } from './mcp/http.ts';
import { MediaStore } from './media.ts';
import { DEFAULT_PORT, MCP_PATH, type OpenPaperPaths } from './paths.ts';
import { PresenceService } from './presence.ts';
import { HeadlessRenderer } from './render/headless.ts';
import { createShaderRuntimeLoader } from './render/shader-runtime-loader.ts';
import { FigmaSettings } from './figma.ts';
import { RenderService, type EncodedImage } from './render/service.ts';
import { OriginPolicy } from './security.ts';
import { probeHealth, removeServerInfo, writeServerInfo } from './server-info.ts';
import { FileStore } from './storage.ts';
import { createSyncServer } from './sync.ts';
import { TailwindService } from './tailwind.ts';
import type { ToolEnv } from './tools/context.ts';
import { mcpToolList } from './tools/definitions.ts';
import { SERVER_INSTRUCTIONS } from './tools/guides.ts';
import { ToolRuntime } from './tools/runtime.ts';
import { VERSION } from './version.ts';
import { ViewRegistry } from './views.ts';

export interface StartOptions {
  paths: OpenPaperPaths;
  port?: number;
  /** Development: the editor is served by Vite on :5173. */
  dev?: boolean;
}

export interface RunningServer {
  url: string;
  editorUrl: string;
  port: number;
  env: ToolEnv;
  close(): Promise<void>;
}

function findEditorDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'editor'), resolve(here, '../../../apps/editor/dist'), resolve(here, '../../apps/editor/dist')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** `openpaper mcp` launch command for agent harness configs (absolute paths, no shell). */
export function mcpLaunchCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, 'mcp'] };
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const port = opts.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}`;
  const { paths } = opts;

  const existing = await probeHealth(port, 800);
  if (existing) throw new Error(`OpenPaper is already running on port ${port} (pid ${existing.pid}).`);

  const store = new FileStore(paths);
  await store.init();
  const hub = new DocumentHub(store);
  const media = new MediaStore(paths.assets);
  const figmaSettings = new FigmaSettings(paths.config);
  const assets = new AssetResolver(media, () => figmaSettings.token());
  const fonts = new FontService(paths.cache);
  void fonts.refresh();
  const headless = new HeadlessRenderer(() => url);
  const render = new RenderService(headless, fonts, () => url);
  fonts.setLocalFontLoader(() => render.localFonts());
  const views = new ViewRegistry();
  const tailwind = new TailwindService();
  const images = new ImageGenService(hub, media);
  const policy = new OriginPolicy(port, opts.dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []);

  // eslint-disable-next-line prefer-const
  let sync: ReturnType<typeof createSyncServer>;
  const presence = new PresenceService(
    (fileId) => hub.peek(fileId)?.doc,
    (fileId, agents) => views.broadcast(fileId, { t: 'presence', fileId, agents }),
    (fileId, entry) => views.broadcast(fileId, { t: 'activity', fileId, entry })
  );

  const env: ToolEnv = {
    hub,
    store,
    views,
    presence,
    render,
    fonts,
    assets,
    media,
    tailwind,
    images,
    paths,
    baseUrl: () => url,
    agentOpenedFile(fileId, pageId, agentName) {
      views.broadcast(null, { t: 'agent-opened', fileId, pageId, agentName });
    },
    resourcesChanged() {
      sync?.broadcastResources();
    },
  };

  // Editors can measure/capture when no headless browser is installed (or to reuse live layout).
  render.editorFallback = {
    async measure(fileId, pageId, version): Promise<LayoutMap | null> {
      const conn = views.editorShowing(fileId, pageId);
      if (!conn) return null;
      return views.rpc<LayoutMap>(conn, 'measure', { fileId, pageId, version }, 4000);
    },
    async screenshot(fileId, nodeId, scale): Promise<EncodedImage | null> {
      const conn = views.editorShowing(fileId);
      if (!conn) return null;
      const shot = await views.rpc<{ data: string; mimeType: string; width: number; height: number }>(
        conn,
        'screenshot',
        { fileId, nodeId, scale, format: 'jpeg' },
        15_000
      );
      return { ...shot, resized: false };
    },
  };

  const runtime = new ToolRuntime(env);
  const mcp = createMcpHttpHandler(runtime);
  const agentSettings = new AgentSettings(paths.config);
  const agents = new AgentService({
    runtime,
    settings: agentSettings,
    getDoc: (fileId) => hub.peek(fileId)?.doc,
    viewFor: (fileId) => views.viewFor(fileId),
    emit: (fileId, event) => views.broadcast(fileId, { t: 'agent', fileId, event }),
  });
  sync = createSyncServer({ env, policy, mcpLaunch: mcpLaunchCommand, agents, agentSettings, figmaSettings });
  tailwind.warmup();

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      agents.stopAll();
      mcp.close();
      sync.close();
      presence.close();
      tailwind.close();
      await hub.flushAll();
      await headless.close();
      await new Promise<void>((r) => server.close(() => r()));
      await removeServerInfo(paths);
    })();
    return closing;
  };

  const editorDir = opts.dev ? null : findEditorDir();
  const server = createApp({
    version: VERSION,
    policy,
    media,
    editorDir,
    devEditorUrl: opts.dev ? 'http://127.0.0.1:5173' : null,
    mcp: (req, res) => mcp.handle(req, res),
    mcpConfig: () => ({ tools: mcpToolList(), instructions: SERVER_INSTRUCTIONS }),
    upgrade: (req, socket, head) => sync.handleUpgrade(req, socket, head),
    renderDocument: (token) => headless.documentFor(token),
    shaderRuntime: createShaderRuntimeLoader(),
    shutdown: () => {
      void close().then(() => process.exit(0));
    },
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use. Pass --port to use another one.`));
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolveListen());
  });

  await writeServerInfo(paths, { pid: process.pid, port, url, version: VERSION, startedAt: new Date().toISOString() });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  }

  if (!editorDir && !opts.dev) console.warn('[openpaper] Editor build not found — run `npm run build` (or use --dev with `npm run dev:editor`).');
  if (!headless.available) console.warn('[openpaper] No Chromium-based browser found: screenshots and exports will use an open editor tab.');

  return { url, editorUrl: opts.dev ? 'http://127.0.0.1:5173' : url, port, env, close };
}

export { DEFAULT_PORT, MCP_PATH };
