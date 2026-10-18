import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetResolver } from '../src/assets.ts';
import { FigmaSettings, parseFigmaImageUrl } from '../src/figma.ts';
import { MediaStore } from '../src/media.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openpaper-figma-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function stubFigma(calls: string[]) {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://api.figma.com/v1/files/KEY123/images') {
      expect((init?.headers as Record<string, string>)['X-Figma-Token']).toBe('figd_test');
      return new Response(JSON.stringify({ error: false, status: 200, meta: { images: { abcd: 'https://cdn.example/abcd.png' } } }), { status: 200 });
    }
    if (url === 'https://cdn.example/abcd.png') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404 });
  });
}

describe('Figma image fills', () => {
  it('parses figma-image URLs', () => {
    expect(parseFigmaImageUrl('figma-image://KEY123/ABCD')).toEqual({ fileKey: 'KEY123', hash: 'abcd' });
    expect(parseFigmaImageUrl('figma-image://bad key/abcd')).toBeNull();
    expect(parseFigmaImageUrl('https://example.com/x.png')).toBeNull();
  });

  it('downloads image fills with a token, one API call per file', async () => {
    const calls: string[] = [];
    stubFigma(calls);
    const assets = new AssetResolver(new MediaStore(dir), async () => 'figd_test');
    const out = await assets.resolveAll(['figma-image://KEY123/abcd', 'figma-image://KEY123/ffff']);
    expect(out.get('figma-image://KEY123/abcd')?.url).toMatch(/^\/media\/[0-9a-f]+\.png$/);
    expect(out.get('figma-image://KEY123/ffff')).toBeNull();
    expect(calls.filter((c) => c.includes('api.figma.com'))).toHaveLength(1);
  });

  it('drops image fills without a token (no network)', async () => {
    const calls: string[] = [];
    stubFigma(calls);
    const assets = new AssetResolver(new MediaStore(dir), async () => null);
    const out = await assets.resolveAll(['figma-image://KEY123/abcd']);
    expect(out.get('figma-image://KEY123/abcd')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('pastes several layers onto the canvas keeping their arrangement', async () => {
    const { createDocument, readerOf } = await import('@openpaper/core');
    const { LiveDocument } = await import('../src/hub.ts');
    const { executeCommand } = await import('../src/commands.ts');
    const doc = createDocument({ name: 'Paste' });
    const live = new LiveDocument(doc, { save: async () => {} } as never, () => {});
    const root = doc.pages[doc.pageList[0]!.id]!.rootId;
    const html =
      '<div layer-name="A" style="position: absolute; left: 0px; top: 0px; width: 100px; height: 50px"></div>' +
      '<div layer-name="B" style="position: absolute; left: 160px; top: 90px; width: 100px; height: 50px"></div>';
    const r = (await executeCommand(live, { kind: 'user', id: 'u', name: 'User' }, { type: 'insertHtml', parentId: root, html, keepLayout: true }, {
      assets: new AssetResolver(new MediaStore(dir)),
      userName: 'User',
    })) as { ids: string[] };
    const [a, b] = r.ids.map((id) => readerOf(live.doc).getNode(id)!);
    const dx = Number.parseFloat(b!.styles.left!) - Number.parseFloat(a!.styles.left!);
    const dy = Number.parseFloat(b!.styles.top!) - Number.parseFloat(a!.styles.top!);
    expect([dx, dy]).toEqual([160, 90]);
  });

  it('stores the token owner-only next to other settings', async () => {
    vi.stubEnv('FIGMA_TOKEN', '');
    vi.stubEnv('FIGMA_ACCESS_TOKEN', '');
    const path = join(dir, 'config.json');
    const settings = new FigmaSettings(path);
    expect(await settings.info()).toEqual({ tokenSource: null });
    await settings.setToken('figd_saved');
    expect(await settings.token()).toBe('figd_saved');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ figma: { token: 'figd_saved' } });
    await settings.setToken(null);
    expect(await settings.info()).toEqual({ tokenSource: null });
    vi.stubEnv('FIGMA_TOKEN', 'figd_env');
    expect(await settings.info()).toEqual({ tokenSource: 'environment' });
  });
});
