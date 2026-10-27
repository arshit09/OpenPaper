import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline, type Duplex } from 'node:stream';
import { assetUrlToPath, IMAGE_MIME, MEDIA_ROUTE, type MediaStore } from './media.ts';
import { SHADER_RUNTIME_PATH } from '@openpaper/core';
import { MCP_PATH } from './paths.ts';
import type { OriginPolicy } from './security.ts';

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface AppHandlers {
  version: string;
  policy: OriginPolicy;
  media: MediaStore;
  /** Built editor (index.html + assets). Null in dev mode (Vite serves the editor). */
  editorDir: string | null;
  devEditorUrl: string | null;
  mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  mcpConfig: () => unknown;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Internal render documents for the headless renderer: /__render/<token>. */
  renderDocument: (token: string) => string | null;
  /** Script that mounts shader layers in render documents (SHADER_RUNTIME_PATH). */
  shaderRuntime: () => Promise<string>;
  shutdown: () => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Images are served from the editor's own origin, so an SVG opened as a page (in a new tab) must not
 * run script there: as a document it gets no scripts and an opaque origin. `<img>` and CSS uses are unaffected.
 */
const MEDIA_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
  'x-content-type-options': 'nosniff',
};

/** Render documents carry user designs: only the shader runtime may run, and nothing can be framed or embedded. */
const RENDER_CSP = "script-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'";

/** The editor itself may not be framed by another site (clickjacking). */
const EDITOR_HEADERS = { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };

async function sendFile(res: ServerResponse, path: string, mime: string, cache = 'no-store', headers: Record<string, string> = {}) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': cache, ...headers });
  // A file that can't be opened after all (locked, deleted, offline) ends this response, not the server.
  pipeline(createReadStream(path), res, () => {});
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createApp(h: AppHandlers): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[openpaper] request failed', req.method, req.url, error);
      if (!res.headersSent) sendJson(res, (error as { status?: number }).status ?? 500, { status: 'error', message: String(error) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!h.policy.hostOk(req)) return sendJson(res, 403, { status: 'forbidden', message: 'Invalid host' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // --- MCP ------------------------------------------------------------
    if (path === MCP_PATH) {
      if (!h.policy.noBrowserOrigin(req)) return sendJson(res, 403, { status: 'forbidden', message: 'Browser requests are not allowed' });
      return h.mcp(req, res);
    }
    if (path === `${MCP_PATH}/config.json`) {
      if (!h.policy.noBrowserOrigin(req)) return sendJson(res, 403, { status: 'forbidden', message: 'Browser requests are not allowed' });
      return sendJson(res, 200, h.mcpConfig());
    }
    // Some harnesses probe OAuth discovery after any failure; answer plainly so they don't think we do OAuth.
    if (path.startsWith('/.well-known/')) return void res.writeHead(404).end();

    // --- API ------------------------------------------------------------
    if (path === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'openpaper', version: h.version, pid: process.pid });
    }
    if (path === '/api/upload' && req.method === 'POST') {
      if (!h.policy.sameOrigin(req)) return sendJson(res, 403, { status: 'forbidden', message: 'Cross-origin upload rejected' });
      const body = await readBody(req, 100 * 1024 * 1024);
      const stored = await h.media.put(body, String(req.headers['content-type'] ?? 'application/octet-stream'));
      return sendJson(res, 200, stored);
    }
    if (path === '/api/shutdown' && req.method === 'POST') {
      if (!h.policy.noBrowserOrigin(req)) return sendJson(res, 403, { status: 'forbidden' });
      sendJson(res, 200, { ok: true });
      setTimeout(() => h.shutdown(), 50);
      return;
    }

    // --- Media ----------------------------------------------------------
    if (path.startsWith(MEDIA_ROUTE)) {
      if (!h.policy.notCrossSite(req)) return sendText(res, 403, 'Forbidden');
      const file = h.media.pathFor(path);
      if (!file) return sendText(res, 404, 'Not found');
      return sendFile(res, file, IMAGE_MIME[extname(file)] ?? 'application/octet-stream', 'public, max-age=31536000, immutable', MEDIA_HEADERS);
    }
    if (path === '/local-asset') {
      // Equivalent of paper-asset://: only images, never to other sites.
      if (!h.policy.notCrossSite(req)) return sendText(res, 403, 'Forbidden');
      const target = assetUrlToPath(`paper-asset://${url.searchParams.get('path') ?? ''}`);
      const mime = target ? IMAGE_MIME[extname(target).toLowerCase()] : undefined;
      if (!target || !mime) return sendText(res, 404, 'Not found');
      return sendFile(res, target, mime, 'no-store', MEDIA_HEADERS);
    }

    // --- Internal render documents (headless renderer) -------------------
    if (path.startsWith('/__render/')) {
      const html = h.renderDocument(path.slice('/__render/'.length));
      if (html === null) return sendText(res, 404, 'Not found');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': RENDER_CSP });
      return void res.end(html);
    }

    if (path === SHADER_RUNTIME_PATH) {
      const js = await h.shaderRuntime();
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(js);
    }

    // --- Editor (static) ------------------------------------------------
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    if (!h.editorDir) {
      if (h.devEditorUrl) {
        res.writeHead(302, { location: `${h.devEditorUrl}${path}${url.search}` });
        return void res.end();
      }
      return sendText(res, 404, 'Editor build not found. Run `npm run build`.');
    }
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    const filePath = join(h.editorDir, rel);
    if (!filePath.startsWith(h.editorDir + sep) && filePath !== h.editorDir) return sendText(res, 403, 'Forbidden');
    const ext = extname(filePath);
    if (rel && existsSync(filePath) && STATIC_MIME[ext]) {
      const immutable = rel.startsWith('assets' + sep) || rel.startsWith('assets/');
      return sendFile(res, filePath, STATIC_MIME[ext]!, immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ext === '.html' ? EDITOR_HEADERS : {});
    }
    // SPA fallback
    return sendFile(res, join(h.editorDir, 'index.html'), STATIC_MIME['.html']!, 'no-cache', EDITOR_HEADERS);
  }

  server.on('upgrade', (req, socket, head) => {
    if (!h.policy.hostOk(req)) return socket.destroy();
    h.upgrade(req, socket, head);
  });

  return server;
}
