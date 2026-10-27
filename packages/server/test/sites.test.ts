import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { detectFolderForUrl, inspectFolder } from '../src/sites/folders.ts';
import { INSPECTOR_PATH, INSPECTOR_TAG, inspectorScript } from '../src/sites/inspector.ts';
import { insertionPoint, SiteProxies, SiteProxy } from '../src/sites/proxy.ts';
import { normalizeSiteUrl, SiteStore } from '../src/sites/store.ts';

const EDITOR = ['http://127.0.0.1:29999', 'http://localhost:29999'];
const PAGE = '<!doctype html><html lang="en"><head><title>Hi</title></head><body><h1>Hello</h1></body></html>';
const JS = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 251));

interface Seen {
  url: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upPort: number;
let wss: WebSocketServer;
let proxy: SiteProxy;
let home: string;
const seen: Seen[] = [];
const wsHeaders: IncomingHttpHeaders[] = [];

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => done((server.address() as AddressInfo).port));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  firstChunkMs: number;
}

/** Raw HTTP (no automatic decompression, any Host header). */
function http(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const started = Date.now();
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      let firstChunkMs = -1;
      res.on('data', (chunk: Buffer) => {
        if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
        chunks.push(chunk);
      });
      res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), firstChunkMs }));
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(options.body);
  });
}

const doc = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', accept: 'text/html' };

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-sites-test-'));
  upstream = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (d: string) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url!, method: req.method!, headers: req.headers, body });
      const path = req.url!.split('?')[0];
      if (path === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'",
          'x-frame-options': 'DENY',
          'content-length': Buffer.byteLength(PAGE),
        });
        return res.end(PAGE);
      }
      if (path === '/gz' || path === '/br') {
        const packed = path === '/gz' ? gzipSync(PAGE) : brotliCompressSync(PAGE);
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': path === '/gz' ? 'gzip' : 'br', 'content-length': packed.length });
        return res.end(packed);
      }
      if (path === '/no-head') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!DOCTYPE html>\n<!-- hi --><p>bare</p>');
      }
      if (path === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': JS.length });
        return res.end(JS);
      }
      if (path === '/fragment') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<li>item</li>');
      }
      if (path === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${upPort}/login?x=1` });
        return res.end();
      }
      if (path === '/redirect-away') {
        res.writeHead(302, { location: 'https://example.com/login' });
        return res.end();
      }
      if (path === '/cookie') {
        res.writeHead(200, { 'set-cookie': ['a=1; Domain=localhost; Path=/', 'b=2; Path=/; HttpOnly'], 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (path === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ method: req.method, body, host: req.headers.host, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null }));
      }
      if (path === '/stream') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<!doctype html><html><head><title>s</title></head><body><p>early</p>');
        setTimeout(() => res.end('<p>late</p></body></html>'), 400);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
  });
  wss = new WebSocketServer({ server: upstream, handleProtocols: (protocols) => (protocols.has('vite-hmr') ? 'vite-hmr' : false) });
  wss.on('connection', (socket, req) => {
    wsHeaders.push(req.headers);
    socket.on('message', (data) => socket.send(`echo:${data}`));
  });
  upPort = await listen(upstream);
  proxy = new SiteProxy({ target: `http://localhost:${upPort}`, editorOrigins: EDITOR });
  await proxy.listen();
});

afterAll(async () => {
  await proxy?.close();
  wss?.close();
  if (upstream) await closeServer(upstream);
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

const last = () => seen[seen.length - 1]!;

describe('site proxy', () => {
  it('injects the inspector into documents and lets the editor frame them', async () => {
    const res = await http(`${proxy.origin}/`, { headers: doc });
    const html = res.body.toString();
    expect(res.status).toBe(200);
    expect(html).toBe(PAGE.replace('<head>', `<head>${INSPECTOR_TAG}`));
    expect(Number(res.headers['content-length'] ?? html.length)).toBe(Buffer.byteLength(html));
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(`frame-ancestors 'self' ${EDITOR.join(' ')}`);
    expect(last().headers.host).toBe(`localhost:${upPort}`);
    expect(last().headers['accept-encoding']).toBe('identity');
  });

  it('decodes gzip and brotli documents before injecting', async () => {
    for (const path of ['/gz', '/br']) {
      const res = await http(`${proxy.origin}${path}`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip, br' } });
      expect(res.headers['content-encoding']).toBeUndefined();
      expect(res.body.toString()).toBe(PAGE.replace('<head>', `<head>${INSPECTOR_TAG}`));
    }
  });

  it('injects after the doctype when there is no <head>', async () => {
    const res = await http(`${proxy.origin}/no-head`, { headers: doc });
    expect(res.body.toString()).toBe(`<!DOCTYPE html>\n<!-- hi -->${INSPECTOR_TAG}<p>bare</p>`);
  });

  it('streams other responses byte for byte', async () => {
    const res = await http(`${proxy.origin}/app.js`, { headers: { 'sec-fetch-dest': 'script', 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, JS)).toBe(0);
    expect(res.headers['content-length']).toBe(String(JS.length));
    const fragment = await http(`${proxy.origin}/fragment`, { headers: { 'sec-fetch-dest': 'empty', accept: 'text/html' } });
    expect(fragment.body.toString()).toBe('<li>item</li>');
  });

  it('keeps streaming SSR streaming', async () => {
    const res = await http(`${proxy.origin}/stream`, { headers: doc });
    expect(res.firstChunkMs).toBeLessThan(300);
    expect(res.body.toString()).toBe(
      `<!doctype html><html><head>${INSPECTOR_TAG}<title>s</title></head><body><p>early</p><p>late</p></body></html>`
    );
  });

  it('rewrites redirects to the site (any loopback alias) onto the proxy, and strips cookie domains', async () => {
    const res = await http(`${proxy.origin}/redirect`);
    expect(res.headers.location).toBe(`${proxy.origin}/login?x=1`);
    const viaLocalhost = await http(`http://127.0.0.1:${proxy.port}/redirect`, { headers: { host: `localhost:${proxy.port}` } });
    expect(viaLocalhost.headers.location).toBe(`http://localhost:${proxy.port}/login?x=1`);
    expect((await http(`${proxy.origin}/redirect-away`)).headers.location).toBe('https://example.com/login');
    const cookie = await http(`${proxy.origin}/cookie`);
    expect(cookie.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  });

  it('forwards bodies and makes its own requests look same-origin to the dev server', async () => {
    const res = await http(`${proxy.origin}/echo?q=1`, {
      method: 'POST',
      headers: { origin: proxy.origin, referer: `${proxy.origin}/page?a=b`, 'content-type': 'text/plain' },
      body: 'hello body',
    });
    expect(JSON.parse(res.body.toString())).toEqual({
      method: 'POST',
      body: 'hello body',
      host: `localhost:${upPort}`,
      origin: `http://localhost:${upPort}`,
      referer: `http://localhost:${upPort}/page?a=b`,
    });
    expect(last().url).toBe('/echo?q=1');
    // Other pages calling the proxy keep their Origin, so the dev server's own checks still see them.
    const foreign = await http(`${proxy.origin}/echo`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: 'x' });
    expect(JSON.parse(foreign.body.toString()).origin).toBe('http://evil.example');
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    const before = seen.length;
    const res = await http(`${proxy.origin}/`, { headers: { host: 'evil.example' } });
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  it('serves the inspector itself, with the editor origins', async () => {
    const before = seen.length;
    const res = await http(`${proxy.origin}${INSPECTOR_PATH}`);
    const js = res.body.toString();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(js).toContain(JSON.stringify(EDITOR));
    expect(js).toContain(`http://localhost:${upPort}`);
    expect(() => new Function(js)).not.toThrow();
    expect((await http(`${proxy.origin}/__openpaper/other`)).status).toBe(404);
    expect(seen.length).toBe(before);
  });

  it('relays WebSocket upgrades (HMR) with the origin rewritten', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/hmr?token=abc`, 'vite-hmr', { origin: proxy.origin });
    await new Promise<void>((done, fail) => {
      socket.once('open', () => done());
      socket.once('error', fail);
    });
    expect(socket.protocol).toBe('vite-hmr');
    const reply = new Promise<string>((done) => socket.once('message', (data) => done(String(data))));
    socket.send('ping');
    expect(await reply).toBe('echo:ping');
    const big = 'x'.repeat(200_000);
    const bigReply = new Promise<string>((done) => socket.once('message', (data) => done(String(data))));
    socket.send(big);
    expect(await bigReply).toBe(`echo:${big}`);
    socket.close();
    const headers = wsHeaders[wsHeaders.length - 1]!;
    expect(headers.origin).toBe(`http://localhost:${upPort}`);
    expect(headers.host).toBe(`localhost:${upPort}`);
  });

  it('falls back to the other loopback family (site on 127.0.0.1, URL says [::1])', async () => {
    const v6 = new SiteProxy({ target: `http://[::1]:${upPort}`, editorOrigins: EDITOR });
    await v6.listen();
    try {
      const res = await http(`${v6.origin}/app.js`);
      expect(Buffer.compare(res.body, JS)).toBe(0);
      expect(last().headers.host).toBe(`[::1]:${upPort}`);
    } finally {
      await v6.close();
    }
  });

  it('shows a self-retrying page while the dev server is down', async () => {
    const probe = createServer();
    const port = await listen(probe);
    await closeServer(probe);
    const down = new SiteProxy({ target: `http://localhost:${port}/app`, editorOrigins: EDITOR });
    await down.listen();
    try {
      expect(down.url).toBe(`${down.origin}/app`);
      const page = await http(`${down.origin}/app/settings?tab=1`, { headers: doc });
      const html = page.body.toString();
      expect(page.status).toBe(502);
      expect(html).toContain(`Can't reach http://localhost:${port}/app`);
      expect(html).toContain(`url: "http://localhost:${port}/app/settings?tab=1"`);
      expect(html).toContain('/__openpaper/status');
      expect(html).toContain("type: 'unreachable'");
      expect(page.headers['content-security-policy']).toContain('frame-ancestors');
      expect((await http(`${down.origin}/main.js`)).status).toBe(502);
      expect(JSON.parse((await http(`${down.origin}/__openpaper/status`)).body.toString())).toEqual({ up: false });

      const late = createServer((_req, res) => res.end('up'));
      await listen(late, port);
      try {
        const status = await http(`${down.origin}/__openpaper/status`, { headers: { origin: EDITOR[0]! } });
        expect(JSON.parse(status.body.toString())).toEqual({ up: true });
        expect(status.headers['access-control-allow-origin']).toBe(EDITOR[0]);
        expect((await http(`${down.origin}/app`)).body.toString()).toBe('up');
      } finally {
        await closeServer(late);
      }
    } finally {
      await down.close();
    }
  });
});

describe('insertionPoint', () => {
  it('finds the spot inside <head>, waiting for more bytes when needed', () => {
    expect(insertionPoint('<!doctype html><html><head><meta charset="utf-8">', false)).toBe(27);
    expect(insertionPoint('<html><head data-x="a>b">', false)).toBe(25);
    expect(insertionPoint('<!doctype html><ht', false)).toBe(-1);
    expect(insertionPoint('<!doctype html><html lang="en"', false)).toBe(-1);
    expect(insertionPoint('<!doctype html><header>', false)).toBe(15);
    expect(insertionPoint('\xEF\xBB\xBF<!DOCTYPE html>\n<title>x</title>', false)).toBe(19);
    expect(insertionPoint('plain text', false)).toBe(0);
    expect(insertionPoint('', true)).toBe(0);
  });
});

describe('inspector script', () => {
  it('embeds its config safely and parses', () => {
    const js = inspectorScript({ editorOrigins: ['http://127.0.0.1:1'], targetOrigins: ['http://x</script>'] });
    expect(js).not.toContain('</script>');
    expect(js).toContain('__openpaperInspector__');
    expect(() => new Function(js)).not.toThrow();
    // ES2019: no optional chaining or nullish coalescing.
    expect(js).not.toMatch(/\?\.[a-zA-Z_$(\[]|\?\?/);
  });
});

describe('site store', () => {
  it('normalizes URLs', () => {
    expect(normalizeSiteUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeSiteUrl(' 3000 ')).toBe('http://localhost:3000');
    expect(normalizeSiteUrl('http://0.0.0.0:4321/docs/#top')).toBe('http://localhost:4321/docs/');
    expect(normalizeSiteUrl('https://127.0.0.1:8443/?a=1')).toBe('https://127.0.0.1:8443?a=1');
    expect(() => normalizeSiteUrl('ftp://x')).toThrow();
    expect(() => normalizeSiteUrl('')).toThrow();
  });

  it('persists sites', async () => {
    const folder = join(home, 'my-app');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'my-app-pkg', devDependencies: { vite: '^7' } }));
    const path = join(home, 'sites.json');
    const store = new SiteStore(path);
    await store.init();
    const site = await store.create({ url: 'localhost:5173', folder: `${folder}${'/'}` });
    expect(site).toMatchObject({ name: 'my-app-pkg', url: 'http://localhost:5173', folder: resolve(folder) });
    expect(await store.create({ url: 'http://localhost:5173/', folder })).toEqual(site);
    await expect(store.create({ url: 'localhost:1', folder: join(home, 'missing') })).rejects.toThrow(/not found/i);

    const updated = await store.update(site.id, { name: ' Renamed ', proxyPort: 51234, lastOpenedAt: '2026-01-01T00:00:00.000Z' });
    expect(updated).toMatchObject({ name: 'Renamed', proxyPort: 51234 });

    const reloaded = new SiteStore(path);
    await reloaded.init();
    expect(reloaded.list()).toEqual([updated]);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);

    expect(await reloaded.delete(site.id)).toBe(true);
    expect(await reloaded.delete(site.id)).toBe(false);
    const again = new SiteStore(path);
    await again.init();
    expect(again.list()).toEqual([]);
  });

  it('reuses and persists proxy ports', async () => {
    const folder = join(home, 'ports');
    await mkdir(folder, { recursive: true });
    const store = new SiteStore(join(home, 'ports.json'));
    await store.init();
    let site = await store.create({ url: `http://localhost:${upPort}`, folder });
    const proxies = new SiteProxies({ editorOrigins: EDITOR, store });

    const first = await proxies.start(site);
    expect(first.proxyUrl).toBe(`http://127.0.0.1:${first.port}/`);
    expect(store.get(site.id)!.proxyPort).toBe(first.port);
    expect((await proxies.start(store.get(site.id)!)).port).toBe(first.port); // already running
    await proxies.stop(site.id);

    site = store.get(site.id)!;
    expect((await proxies.start(site)).port).toBe(first.port); // same origin after a restart
    await proxies.stop(site.id);

    const squatter = createServer();
    await listen(squatter, first.port);
    try {
      const moved = await proxies.start(store.get(site.id)!);
      expect(moved.port).not.toBe(first.port);
      expect(store.get(site.id)!.proxyPort).toBe(moved.port);
      expect((await http(`${moved.origin}/app.js`)).body.length).toBe(JS.length);
    } finally {
      await proxies.closeAll();
      await closeServer(squatter);
    }
  });
});

describe('folders', () => {
  it('inspects a project folder', async () => {
    const folder = join(home, 'next-site');
    await mkdir(join(folder, '.git'), { recursive: true });
    await writeFile(join(folder, 'package.json'), '﻿' + JSON.stringify({ dependencies: { next: '15', react: '19' }, devDependencies: { vite: '7' } }));
    expect(await inspectFolder(`"${folder}"`)).toEqual({ path: resolve(folder), exists: true, isDirectory: true, name: 'next-site', framework: 'next', hasGit: true });
    const missing = await inspectFolder(join(home, 'nope'));
    expect(missing).toMatchObject({ exists: false, isDirectory: false, name: 'nope', hasGit: false });
  });

  it.runIf(process.platform === 'win32' || process.platform === 'linux')('finds the folder a local server runs from', async () => {
    // The upstream server runs inside this test process, which was started from the repo's node_modules.
    const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    expect(await detectFolderForUrl(`http://localhost:${upPort}`)).toBe(repo);
    expect(await detectFolderForUrl('https://example.com')).toBeNull();
  });
});
