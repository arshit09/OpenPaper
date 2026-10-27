import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { connect, isIP, type AddressInfo, type LookupFunction, type Socket } from 'node:net';
import { pipeline, Transform, type Duplex } from 'node:stream';
import * as zlib from 'node:zlib';
import { INSPECTOR_PATH, INSPECTOR_TAG, inspectorScript } from './inspector.ts';
import type { SiteRecord, SiteStore } from './store.ts';

/**
 * Serves one live site through its own loopback origin (`http://127.0.0.1:<port>/*` → `<site origin>/*`),
 * so the editor can frame it and the injected inspector can talk to the editor. The proxy only ever
 * connects to the site's own origin, and its origin is not one OpenPaper trusts, so the proxied page
 * gets no access to OpenPaper's WebSocket or MCP endpoint.
 */

const INTERNAL_PREFIX = '/__openpaper/';
const STATUS_PATH = '/__openpaper/status';
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
/** Would stop the editor from framing the site or the inspector from running. */
const FRAMING_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security'];
/** Look this far into an HTML response for <head> before injecting anyway. */
const HEAD_SCAN_LIMIT = 256 * 1024;
const PORT_UNAVAILABLE = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '::' || /^127\./.test(host);
}

function effectivePort(url: URL): number {
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

/** Drop hop-by-hop headers (and any the Connection header names). */
function endToEnd(headers: IncomingMessage['headers'], extra: string[] = []): OutgoingHttpHeaders {
  const drop = new Set([...HOP_BY_HOP, ...extra]);
  for (const name of String(headers.connection ?? '').split(',')) drop.add(name.trim().toLowerCase());
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !drop.has(name)) out[name] = value;
  return out;
}

/** Navigations (top-level or framed) get the inspector; fetches of HTML fragments don't. */
function isDocumentRequest(req: IncomingMessage): boolean {
  const dest = req.headers['sec-fetch-dest'];
  if (typeof dest === 'string') return dest === 'document' || dest === 'iframe' || dest === 'frame';
  return /\btext\/html\b/i.test(String(req.headers.accept ?? ''));
}

function decoderFor(encoding: string): Transform | null | undefined {
  const lenient = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (encoding) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(lenient);
    case 'deflate':
      return zlib.createInflate(lenient);
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return undefined; // unknown (zstd, stacked encodings): pass through without the inspector
  }
}

function tagEnd(html: string, from: number): number {
  let quote = '';
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

/**
 * Where the inspector tag goes in the start of an HTML document (as latin1, so indexes are byte offsets):
 * just inside `<head>`, else before the first node after the doctype/comments/`<html>` (never before the
 * doctype, which would switch the page to quirks mode). -1 means "need more bytes" unless `final`.
 */
export function insertionPoint(html: string, final: boolean): number {
  let i = html.startsWith('\xEF\xBB\xBF') ? 3 : 0;
  for (;;) {
    while (i < html.length && ' \t\n\r\f'.includes(html[i]!)) i++;
    if (i >= html.length) return final ? i : -1;
    if (html[i] !== '<') return i;
    if (i + 1 >= html.length) return final ? i : -1;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return final ? i : -1;
      i = end + 3;
      continue;
    }
    if (html[i + 1] === '!' || html[i + 1] === '?') {
      const end = html.indexOf('>', i);
      if (end < 0) return final ? i : -1;
      i = end + 1;
      continue;
    }
    const m = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(i, i + 32));
    if (!m) return i;
    if (!final && i + m[0].length >= html.length) return -1; // the tag name may continue in the next chunk
    const name = m[1]!.toLowerCase();
    if (name !== 'html' && name !== 'head') return i;
    const end = tagEnd(html, i + m[0].length);
    if (end < 0) return final ? i : -1;
    if (name === 'head') return end;
    i = end;
  }
}

/** Streams HTML through, holding back only the start of the document until the injection point is known. */
function injector(tag: Buffer): Transform {
  let pending: Buffer | null = Buffer.alloc(0);
  const release = (stream: Transform, final: boolean) => {
    const at = insertionPoint(pending!.toString('latin1'), final || pending!.length >= HEAD_SCAN_LIMIT);
    if (at < 0) return;
    stream.push(Buffer.concat([pending!.subarray(0, at), tag, pending!.subarray(at)]));
    pending = null;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!pending) return done(null, chunk);
      pending = Buffer.concat([pending, chunk]);
      release(this, false);
      done();
    },
    flush(done) {
      if (pending) release(this, true);
      done();
    },
  });
}

function stripCookieDomain(cookie: string): string {
  return cookie.replace(/;\s*domain=[^;]*/gi, '');
}

/** Status line + headers for writing a response straight onto a socket (WebSocket upgrades). */
function rawHead(res: IncomingMessage, bodyLength?: number): string {
  let head = `HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}\r\n`;
  const skip = bodyLength === undefined ? new Set<string>() : new Set(['content-length', 'transfer-encoding', 'connection']);
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    if (!skip.has(res.rawHeaders[i]!.toLowerCase())) head += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
  }
  if (bodyLength !== undefined) head += `Content-Length: ${bodyLength}\r\nConnection: close\r\n`;
  return `${head}\r\n`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** `siteUrl` is what the heading names; `pageUrl` (the page that failed) goes to the editor. */
function downPage(siteUrl: string, pageUrl: string, detail: string, editorOrigins: string[]): string {
  const host = (() => {
    try {
      return new URL(siteUrl).host;
    } catch {
      return siteUrl;
    }
  })();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Can't reach ${escapeHtml(host)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1f1f1f; --muted: #6b6b6b; --bg: #fafafa; --code: rgba(0,0,0,.06); }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #9a9a9a; --bg: #161616; --code: rgba(255,255,255,.08); } }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 440px; padding: 24px; text-align: center; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; overflow-wrap: anywhere; }
  p { margin: 0 0 6px; color: var(--muted); }
  code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
  .retry { margin-top: 14px; font-size: 12px; }
  .retry::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
</style>
</head>
<body>
<main>
  <h1>Can't reach ${escapeHtml(siteUrl)}</h1>
  <p>Is your dev server running? Start it (for example with <code>npm run dev</code>) and this page reloads by itself.</p>
  <p class="retry">Retrying every 2 seconds${detail ? ` · ${escapeHtml(detail)}` : ''}</p>
</main>
<script>
(function () {
  var origins = ${scriptJson(editorOrigins)};
  var parent = location.ancestorOrigins && location.ancestorOrigins[0];
  if (parent) origins = origins.indexOf(parent) >= 0 ? [parent] : [];
  if (window.parent !== window) {
    var msg = { source: 'openpaper-inspector', type: 'unreachable', url: ${scriptJson(pageUrl)}, proxyUrl: location.href };
    for (var i = 0; i < origins.length; i++) try { window.parent.postMessage(msg, origins[i]); } catch (e) {}
  }
  function check() {
    fetch(${scriptJson(STATUS_PATH)}, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) { if (s && s.up) location.reload(); else setTimeout(check, 2000); }, function () { setTimeout(check, 2000); });
  }
  setTimeout(check, 2000);
})();
</script>
</body>
</html>
`;
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Whether something already answers on 127.0.0.1:port (on Windows a specific-address bind can shadow a wildcard listener). */
function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (answer: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), 300);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface SiteProxyOptions {
  /** The site's URL. Only its origin is proxied; its path is where `url` starts. */
  target: string;
  /** Editor origins that may frame the site and talk to the inspector. A function is read on every request. */
  editorOrigins: string[] | (() => string[]);
  /** Port to try first (the site's previous one), so its origin and storage stay the same. */
  port?: number;
}

type Address = { address: string; family: 4 | 6 };

export class SiteProxy {
  /** The site's origin (no path). */
  readonly target: URL;
  private readonly startPath: string;
  private readonly targetPort: number;
  private readonly loopback: boolean;
  private readonly targetOrigins: string[];
  /** Loopback targets resolve to both 127.0.0.1 and ::1 (whichever the dev server bound), last success first. */
  private addresses: Address[] = [];
  private readonly agent: HttpAgent;
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly options: SiteProxyOptions) {
    const url = new URL(options.target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported site URL: ${options.target}`);
    this.target = new URL(url.origin);
    this.startPath = url.pathname + url.search;
    this.targetPort = effectivePort(url);
    this.loopback = isLoopbackHostname(url.hostname);
    this.targetOrigins = [url.origin];
    if (this.loopback) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const v4: Address = { address: '127.0.0.1', family: 4 };
      const v6: Address = { address: '::1', family: 6 };
      this.addresses = host === '::1' ? [v6, v4] : isIP(host) === 4 && host !== '127.0.0.1' && host !== '0.0.0.0' ? [{ address: host, family: 4 }] : [v4, v6];
      for (const alias of ['localhost', '127.0.0.1', '[::1]']) {
        const origin = `${url.protocol}//${alias}${url.port ? `:${url.port}` : ''}`;
        if (!this.targetOrigins.includes(origin)) this.targetOrigins.push(origin);
      }
    }
    this.agent = url.protocol === 'https:' ? new HttpsAgent({ keepAlive: true, maxSockets: 64 }) : new HttpAgent({ keepAlive: true, maxSockets: 64 });
    this.server = createServer({ noDelay: true }, (req, res) => this.onRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.server.on('clientError', (_error, socket) => socket.destroy());
  }

  get port(): number {
    const address = this.server.address() as AddressInfo | null;
    return address?.port ?? 0;
  }

  /** The proxy's own origin, e.g. http://127.0.0.1:51234. */
  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** What the editor loads in its iframe: the site's start path on the proxy origin. */
  get url(): string {
    return this.origin + this.startPath;
  }

  /** The proxy URL for any URL on the site's origin (other URLs come back unchanged). */
  urlFor(siteUrl: string): string {
    try {
      const url = new URL(siteUrl);
      if (this.isTargetUrl(url)) return this.origin + url.pathname + url.search + url.hash;
    } catch {
      // fall through
    }
    return siteUrl;
  }

  /** Listen on 127.0.0.1: the preferred port if it's free, else one the OS picks. */
  async listen(): Promise<number> {
    const preferred = this.options.port;
    const own = this.loopback && preferred === this.targetPort;
    if (preferred && !own && !(await portAnswers(preferred))) {
      try {
        await listenOn(this.server, preferred);
        return this.port;
      } catch (error) {
        if (!PORT_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    await listenOn(this.server, 0);
    return this.port;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    for (const socket of this.sockets) socket.destroy();
    this.agent.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** Whether the dev server accepts connections right now. */
  reachable(timeoutMs = 2500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.connectHost, port: this.targetPort, lookup: this.lookup });
      const done = (up: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(up);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.once('connect', () => {
        this.prefer(socket.remoteAddress);
        done(true);
      });
      socket.once('error', () => done(false));
    });
  }

  private editorOrigins(): string[] {
    const origins = this.options.editorOrigins;
    return typeof origins === 'function' ? origins() : origins;
  }

  // --- Addressing -------------------------------------------------------

  /** Loopback targets connect through a name so `lookup` (and Node's happy eyeballs) can try both families. */
  private get connectHost(): string {
    return this.loopback ? 'localhost' : this.target.hostname.replace(/^\[|\]$/g, '');
  }

  private readonly lookup: LookupFunction | undefined = ((_hostname: string, options: { all?: boolean; family?: number | string }, callback: (...args: any[]) => void) => {
    if (options.all) return callback(null, this.addresses);
    const family = Number(String(options.family ?? '').replace('IPv', '')) || 0;
    const match = this.addresses.find((a) => !family || a.family === family) ?? this.addresses[0]!;
    callback(null, match.address, match.family);
  }) as LookupFunction;

  private prefer(address: string | undefined) {
    const at = this.addresses.findIndex((a) => a.address === address);
    if (at > 0) this.addresses = [this.addresses[at]!, ...this.addresses.filter((_, i) => i !== at)];
  }

  private isProxyOrigin(origin: string): boolean {
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  /** Same scheme and port as the site, and the same host (any loopback alias for a loopback site). */
  private isTargetUrl(url: URL): boolean {
    if (url.protocol !== this.target.protocol || effectivePort(url) !== this.targetPort) return false;
    return url.hostname === this.target.hostname || (this.loopback && isLoopbackHostname(url.hostname));
  }

  /** DNS rebinding guard: only requests addressed to the proxy itself. */
  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  // --- Requests ---------------------------------------------------------

  private upstream(method: string, path: string, headers: OutgoingHttpHeaders, agent: HttpAgent | false): ClientRequest {
    const options: RequestOptions & { rejectUnauthorized?: boolean } = {
      protocol: this.target.protocol,
      hostname: this.connectHost,
      port: this.targetPort,
      method,
      path,
      headers,
      agent,
    };
    if (this.loopback) options.lookup = this.lookup;
    // Local dev servers on https almost always use a self-signed certificate.
    if (this.target.protocol === 'https:') options.rejectUnauthorized = !this.loopback;
    const req = (this.target.protocol === 'https:' ? httpsRequest : httpRequest)(options);
    if (this.loopback) {
      req.once('socket', (socket: Socket) => {
        if (socket.connecting) socket.once('connect', () => this.prefer(socket.remoteAddress));
      });
    }
    return req;
  }

  /** Make the dev server see a same-origin request to itself (Vite allowedHosts / WS origin, Next allowedDevOrigins). */
  private forwardHeaders(req: IncomingMessage): OutgoingHttpHeaders {
    const headers = endToEnd(req.headers);
    headers.host = this.target.host;
    // Only our own origin is rewritten: other pages calling the proxy keep their Origin, so the dev server's checks still apply to them.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && this.isProxyOrigin(origin)) headers.origin = this.target.origin;
    const referer = req.headers.referer;
    if (typeof referer === 'string') {
      try {
        const url = new URL(referer);
        if (this.isProxyOrigin(url.origin)) headers.referer = this.target.origin + url.pathname + url.search;
      } catch {
        delete headers.referer;
      }
    }
    return headers;
  }

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    if (!this.hostOk(req)) return this.sendText(res, 403, 'Forbidden');
    const path = req.url ?? '/';
    if (!path.startsWith('/')) return this.sendText(res, 400, 'Bad request');
    if (path.startsWith(INTERNAL_PREFIX)) return void this.internal(req, res, path);

    const document = isDocumentRequest(req);
    const headers = this.forwardHeaders(req);
    // We rewrite document bodies; plain bytes avoid a decompress/recompress round trip.
    if (document) headers['accept-encoding'] = 'identity';
    const upstream = this.upstream(req.method ?? 'GET', path, headers, this.agent);
    upstream.on('response', (upRes) => {
      try {
        this.respond(req, res, upRes, document);
      } catch (error) {
        upRes.resume();
        this.fail(res, path, error, document);
      }
    });
    upstream.on('error', (error) => this.fail(res, path, error, document));
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  private respond(req: IncomingMessage, res: ServerResponse, upRes: IncomingMessage, document: boolean) {
    const status = upRes.statusCode ?? 502;
    const proxyOrigin = `http://${req.headers.host}`;
    const type = String(upRes.headers['content-type'] ?? '');
    const html = /^\s*text\/html\b/i.test(type);
    const headers = endToEnd(upRes.headers, FRAMING_HEADERS);
    for (const name of ['location', 'content-location']) {
      const value = headers[name];
      if (typeof value === 'string') headers[name] = this.toProxy(value, proxyOrigin);
    }
    const cookies = upRes.headers['set-cookie'];
    if (cookies) headers['set-cookie'] = cookies.map(stripCookieDomain);
    if (html || !type) headers['content-security-policy'] = this.frameAncestors();

    const hasBody = req.method !== 'HEAD' && status >= 200 && status !== 204 && status !== 304;
    const decoder = decoderFor(String(upRes.headers['content-encoding'] ?? '').trim().toLowerCase());
    const inject = document && html && hasBody && decoder !== undefined && !/charset\s*=\s*"?utf-16/i.test(type);
    if (!inject) {
      res.writeHead(status, headers);
      return pipeline(upRes, res, () => {});
    }
    delete headers['content-length'];
    delete headers['content-encoding'];
    res.writeHead(status, headers);
    const steps: Array<NodeJS.ReadableStream | NodeJS.WritableStream> = [upRes];
    if (decoder) steps.push(decoder);
    steps.push(injector(Buffer.from(INSPECTOR_TAG)), res);
    pipeline(steps, () => {});
  }

  /** Absolute URLs on the site's origin → the same path on the proxy origin. */
  private toProxy(value: string, proxyOrigin: string): string {
    if (!/^([a-z][a-z\d+.-]*:)?\/\//i.test(value)) return value;
    try {
      const url = new URL(value, this.target);
      if (this.isTargetUrl(url)) return proxyOrigin + url.pathname + url.search + url.hash;
    } catch {
      // leave malformed values alone
    }
    return value;
  }

  private frameAncestors(): string {
    return `frame-ancestors 'self' ${this.editorOrigins().join(' ')}`.trim();
  }

  private fail(res: ServerResponse, path: string, error: unknown, document: boolean) {
    if (res.headersSent || res.destroyed) return void res.destroy();
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    const siteUrl = this.target.origin + (this.startPath === '/' ? '' : this.startPath);
    if (!document) return this.sendText(res, 502, `Can't reach ${siteUrl}${code ? ` (${code})` : ''}`);
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': this.frameAncestors() });
    res.end(downPage(siteUrl, this.target.origin + path, code, this.editorOrigins()));
  }

  private sendText(res: ServerResponse, status: number, text: string) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  /** Routes the proxy answers itself; never forwarded. */
  private async internal(req: IncomingMessage, res: ServerResponse, path: string) {
    const pathname = path.split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.sendText(res, 405, 'Method not allowed');
    if (pathname === INSPECTOR_PATH) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(req.method === 'HEAD' ? undefined : inspectorScript({ editorOrigins: this.editorOrigins(), targetOrigins: this.targetOrigins }));
    }
    if (pathname === STATUS_PATH) {
      const up = await this.reachable();
      const headers: OutgoingHttpHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      const origin = req.headers.origin;
      if (typeof origin === 'string' && this.editorOrigins().includes(origin)) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      res.writeHead(200, headers);
      return void res.end(JSON.stringify({ up }));
    }
    this.sendText(res, 404, 'Not found');
  }

  // --- WebSockets (HMR) -------------------------------------------------

  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const client = socket as Socket;
    client.on('error', () => client.destroy());
    const path = req.url ?? '/';
    if (!this.hostOk(req) || !path.startsWith('/') || path.startsWith(INTERNAL_PREFIX)) {
      return void client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    this.track(client);
    const headers = this.forwardHeaders(req);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';
    const upstream = this.upstream(req.method ?? 'GET', path, headers, false);

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      this.track(upSocket);
      client.setTimeout(0);
      client.setNoDelay(true);
      upSocket.setNoDelay(true);
      upSocket.on('error', () => client.destroy());
      client.on('error', () => upSocket.destroy());
      client.once('close', () => upSocket.destroy());
      upSocket.once('close', () => client.destroy());
      client.write(rawHead(upRes));
      if (upHead.length) client.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(client);
      client.pipe(upSocket);
    });
    // The dev server answered without upgrading (wrong path, rejected origin): relay its answer.
    upstream.on('response', (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        client.end(Buffer.concat([Buffer.from(rawHead(upRes, body.length)), body]));
      });
      upRes.on('error', () => client.destroy());
    });
    upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    upstream.end();
  }
}

export interface SiteProxiesOptions {
  /** Editor origins (e.g. http://127.0.0.1:<port> and http://localhost:<port>). */
  editorOrigins: string[];
  /** When given, each site's proxy port is saved so the next start reuses it. */
  store?: SiteStore;
}

/** One proxy per open site. */
export class SiteProxies {
  private readonly proxies = new Map<string, SiteProxy>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly editorOrigins: string[];

  constructor(private readonly options: SiteProxiesOptions) {
    this.editorOrigins = [...options.editorOrigins];
  }

  /** Allow another editor origin (e.g. the dev-mode editor), for running and future proxies alike. */
  allowEditorOrigin(origin: string): void {
    if (!this.editorOrigins.includes(origin)) this.editorOrigins.push(origin);
  }

  /** Start the site's proxy, or reuse the running one (restarted on the same port if the site's origin changed). */
  start(site: SiteRecord): Promise<{ proxyUrl: string; port: number; origin: string }> {
    return this.serial(site.id, async () => {
      let proxy = this.proxies.get(site.id);
      if (proxy && proxy.target.origin !== new URL(site.url).origin) {
        await proxy.close();
        this.proxies.delete(site.id);
        site = { ...site, proxyPort: proxy.port };
        proxy = undefined;
      }
      if (!proxy) {
        proxy = new SiteProxy({ target: site.url, editorOrigins: () => this.editorOrigins, port: site.proxyPort });
        await proxy.listen();
        this.proxies.set(site.id, proxy);
        const store = this.options.store;
        if (store?.get(site.id) && store.get(site.id)!.proxyPort !== proxy.port) await store.update(site.id, { proxyPort: proxy.port }).catch(() => {});
      }
      return { proxyUrl: proxy.urlFor(site.url), port: proxy.port, origin: proxy.origin };
    });
  }

  get(id: string): SiteProxy | undefined {
    return this.proxies.get(id);
  }

  stop(id: string): Promise<void> {
    return this.serial(id, async () => {
      const proxy = this.proxies.get(id);
      this.proxies.delete(id);
      await proxy?.close();
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.proxies.keys()].map((id) => this.stop(id)));
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    this.queues.set(id, settled);
    void settled.then(() => {
      if (this.queues.get(id) === settled) this.queues.delete(id);
    });
    return run;
  }
}
