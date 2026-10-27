import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ResourceInfo, ServerMessage } from '@openpaper/core';
import { resolvePaths } from '../src/paths.ts';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer;
let agent: Client;
let editor: WebSocket;
let home: string;
const messages: ServerMessage[] = [];
let reqId = 1;

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await agent.callTool({ name, arguments: args })) as Result;
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text!);
  return JSON.parse(texts[texts.length - 1]!);
}

function request<T>(method: string, params?: unknown): Promise<T> {
  const id = reqId++;
  return new Promise((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      const msg = JSON.parse(String(raw));
      if (msg.t !== 'res' || msg.id !== id) return;
      editor.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result as T);
    };
    editor.on('message', onMessage);
    editor.send(JSON.stringify({ t: 'req', id, method, params }));
  });
}

/** The next file-list broadcast where `fileId` matches `test`. */
function nextResources(fileId: string, test: (r: ResourceInfo | undefined) => boolean, timeoutMs = 20_000): Promise<ResourceInfo | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (editor.off('message', onMessage), reject(new Error('No matching file list'))), timeoutMs);
    const onMessage = (raw: Buffer) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      if (msg.t !== 'resources') return;
      const r = msg.resources.find((x) => x.id === fileId);
      if (!test(r)) return;
      clearTimeout(timer);
      editor.off('message', onMessage);
      resolve(r);
    };
    editor.on('message', onMessage);
  });
}

/** Width and height of a VP8X (extended, with alpha) WebP. */
function webpSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 16)).toBe('WEBPVP8X');
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-thumbs-'));
  const port = 33000 + Math.floor(Math.random() * 2000);
  server = await startServer({ paths: { ...resolvePaths(home), exports: join(home, 'exports') }, port });
  agent = new Client({ name: 'vitest', version: '1.0.0' });
  await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  editor = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: server.url } });
  editor.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((r) => editor.once('open', r));
  editor.send(JSON.stringify({ t: 'hello', protocol: 1 }));
});

afterAll(async () => {
  editor?.close();
  await agent?.close().catch(() => {});
  await server?.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('file thumbnails', () => {
  let fileId = '';
  let url = '';

  it('renders a file an agent changed once it goes quiet', async () => {
    if (!server.env.render.canRender) return;
    fileId = (await call('create_file', { name: 'Thumbs' })).fileId;
    const ready = nextResources(fileId, (r) => !!r?.thumbnail);
    await call('create_artboard', { fileId, name: 'Desktop', styles: { width: '1440px', height: '900px', backgroundColor: '#ff3366' } });
    const r = await ready;
    expect(r!.thumbnail!.background).toBeNull();
    url = r!.thumbnail!.url;
    const res = await fetch(`${server.url}${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(webpSize(Buffer.from(await res.arrayBuffer()))).toEqual({ width: 560, height: 260 });
  });

  it('catches up as soon as the editor leaves the file', async () => {
    if (!server.env.render.canRender) return;
    await request('file.open', { fileId });
    await request('view.update', { fileId, pageId: 'p-1-0', selection: [], focused: true });
    await call('update_styles', { fileId, updates: [{ nodeIds: ['1-0'], styles: { backgroundColor: '#3366ff' } }] });
    // While the file is open the quiet period is long; leaving it doesn't wait for that.
    const started = Date.now();
    const updated = nextResources(fileId, (r) => !!r?.thumbnail && r.thumbnail.url !== url);
    await request('view.update', { fileId: null, pageId: null, selection: [], focused: true });
    const r = await updated;
    expect(Date.now() - started).toBeLessThan(10_000);
    url = r!.thumbnail!.url;
  });

  it('catches up when the user switches away from the window', async () => {
    if (!server.env.render.canRender) return;
    await request('view.update', { fileId, pageId: 'p-1-0', selection: [], focused: true });
    await call('update_styles', { fileId, updates: [{ nodeIds: ['1-0'], styles: { backgroundColor: '#33cc66' } }] });
    const updated = nextResources(fileId, (r) => !!r?.thumbnail && r.thumbnail.url !== url);
    await request('view.update', { fileId, pageId: 'p-1-0', selection: [], focused: false });
    url = (await updated)!.thumbnail!.url;
    await request('view.update', { fileId: null, pageId: null, selection: [], focused: true });
  });

  it('keeps the page canvas colour beside the image', async () => {
    if (!server.env.render.canRender) return;
    await request('file.command', { fileId, command: { type: 'updatePage', pageId: 'p-1-0', canvasColor: '#123456' } });
    const updated = nextResources(fileId, (r) => r?.thumbnail?.background === '#123456');
    await request('view.update', { fileId, pageId: 'p-1-0', selection: [], focused: true });
    await request('view.update', { fileId: null, pageId: null, selection: [], focused: true });
    url = (await updated)!.thumbnail!.url;
  });

  it('shows the page the user was last on', async () => {
    if (!server.env.render.canRender) return;
    // Each page has its own canvas colour, so `background` tells which one the preview shows.
    const { pageId } = await call('create_page', { fileId, name: 'Second' });
    await call('create_artboard', { fileId, pageId, name: 'Mobile', styles: { width: '390px', height: '844px', backgroundColor: '#ffffff' } });
    await request('file.command', { fileId, command: { type: 'updatePage', pageId, canvasColor: '#654321' } });
    const second = nextResources(fileId, (r) => r?.thumbnail?.background === '#654321');
    await request('view.update', { fileId, pageId, selection: [], focused: true });
    await request('view.update', { fileId: null, pageId: null, selection: [], focused: true });
    url = (await second)!.thumbnail!.url;
    // Back on the first page and out again, without an edit: the card follows, under a new URL.
    const first = nextResources(fileId, (r) => r?.thumbnail?.background === '#123456');
    await request('view.update', { fileId, pageId: 'p-1-0', selection: [], focused: true });
    await request('view.update', { fileId: null, pageId: null, selection: [], focused: true });
    const r = await first;
    expect(r!.thumbnail!.url).not.toBe(url);
    url = r!.thumbnail!.url;
  });

  it('leaves empty files on the icon, and fills in files that never had one', async () => {
    if (!server.env.render.canRender) return;
    const empty = (await request<{ fileId: string }>('file.create', {})).fileId;
    await request('resources.list');
    // An empty file needs no browser, so this is plenty for it to be looked at.
    await new Promise((r) => setTimeout(r, 500));
    const list = await request<ResourceInfo[]>('resources.list');
    expect(list.find((r) => r.id === empty)!.thumbnail).toBeUndefined();
    expect(list.find((r) => r.id === fileId)!.thumbnail!.url).toBe(url);
  });

  it('deletes the image with the file', async () => {
    if (!server.env.render.canRender) return;
    await request('resource.delete', { resourceId: fileId });
    expect((await fetch(`${server.url}${url}`)).status).toBe(404);
  });

  it('refuses names that are not thumbnails', async () => {
    for (const name of ['..%2Findex.json', 'index.json', `${'A'.repeat(26)}.png`]) {
      expect((await fetch(`${server.url}/api/thumbnails/${name}`)).status).toBe(404);
    }
  });
});
