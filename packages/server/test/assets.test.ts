import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetResolver } from '../src/assets.ts';
import { MediaStore } from '../src/media.ts';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const png = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openpaper-assets-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** Route fetches by URL; records every URL requested. */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    return routes[url]?.() ?? new Response('not found', { status: 404 });
  });
  return calls;
}

describe('remote images', () => {
  it('follows redirects between public hosts', async () => {
    stubFetch({
      'http://93.184.216.34/a.png': () => new Response(null, { status: 302, headers: { location: 'http://93.184.216.35/b.png' } }),
      'http://93.184.216.35/b.png': png,
    });
    const out = await new AssetResolver(new MediaStore(dir)).resolveOne('http://93.184.216.34/a.png');
    expect(out?.url).toMatch(/^\/media\/[0-9a-f]+\.png$/);
  });

  it("won't let a public image redirect into the local network", async () => {
    const calls = stubFetch({
      'http://93.184.216.34/a.png': () => new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/camera.png' } }),
      'http://192.168.1.1/camera.png': png,
    });
    expect(await new AssetResolver(new MediaStore(dir)).resolveOne('http://93.184.216.34/a.png')).toBeNull();
    expect(calls).toEqual(['http://93.184.216.34/a.png']);
  });

  it('still loads images asked for on a local address', async () => {
    stubFetch({ 'http://127.0.0.1:5173/logo.png': png });
    const out = await new AssetResolver(new MediaStore(dir)).resolveOne('http://127.0.0.1:5173/logo.png');
    expect(out?.url).toMatch(/^\/media\//);
  });

  it('stops reading a body that grows past the limit, whatever its declared length', async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    stubFetch({
      'http://93.184.216.34/bomb.png': () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent++;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { 'content-type': 'image/png' } }
        ),
    });
    expect(await new AssetResolver(new MediaStore(dir)).resolveOne('http://93.184.216.34/bomb.png')).toBeNull();
    expect(sent).toBeLessThan(40);
  });

  it('retries a URL after a transient failure, but remembers a missing image', async () => {
    let status = 503;
    const calls = stubFetch({
      'http://93.184.216.34/flaky.png': () => (status === 200 ? png() : new Response('busy', { status })),
    });
    const assets = new AssetResolver(new MediaStore(dir));
    expect(await assets.resolveOne('http://93.184.216.34/flaky.png')).toBeNull();
    status = 200;
    expect((await assets.resolveOne('http://93.184.216.34/flaky.png'))?.url).toMatch(/^\/media\//);
    expect(await assets.resolveOne('http://93.184.216.34/gone.png')).toBeNull();
    expect(await assets.resolveOne('http://93.184.216.34/gone.png')).toBeNull();
    expect(calls.filter((c) => c.endsWith('gone.png'))).toHaveLength(1);
  });
});

describe('local images', () => {
  it('refuses file URLs that name a remote host (UNC paths)', async () => {
    const assets = new AssetResolver(new MediaStore(dir));
    expect(await assets.resolveOne('file://attacker.example/share/a.png')).toBeNull();
    await expect(new MediaStore(dir).putLocalFile('\\\\attacker.example\\share\\a.png')).rejects.toThrow(/Network paths/);
  });
});
