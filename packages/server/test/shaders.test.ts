import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolvePaths } from '../src/paths.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import type { HeadlessRenderer } from '../src/render/headless.ts';

let server: RunningServer;
let client: Client;
let home: string;

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

function body(r: Result): any {
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text!);
  const last = texts[texts.length - 1]!;
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

/** Distinct (4-bit quantised) colours in an image, counted in the headless browser. */
async function distinctColors(dataUrl: string): Promise<number> {
  const headless = (server.env.render as unknown as { headless: HeadlessRenderer }).headless;
  return headless.withDocument('<!doctype html><html><body></body></html>', { width: 10, height: 10 }, (page) =>
    page.evaluate(async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 7) seen.add(((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4));
      return seen.size;
    }, dataUrl)
  );
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-shaders-'));
  const port = 35000 + Math.floor(Math.random() * 2000);
  server = await startServer({ paths: { ...resolvePaths(home), exports: join(home, 'exports') }, port });
  client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await server?.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('shader layers over MCP', () => {
  let fileId = '';
  let shaderId = '';

  it('creates a shader with write_html', async () => {
    fileId = body(await call('create_file', { name: 'Shaders' })).fileId;
    await call('open_file', { fileId });
    const board = body(await call('create_artboard', { fileId, name: 'Hero', styles: { width: '600px', height: '400px', display: 'flex' } }));
    const r = body(
      await call('write_html', {
        fileId,
        targetNodeId: board.id,
        mode: 'insert-children',
        html: '<x-shader type="mesh-gradient" layer-name="Glow" colors="#ff5f6d #ffc371 #2b5876" swirl="0.6" style="width: 600px; height: 400px"></x-shader>',
      })
    );
    shaderId = r.createdNodes[0].id;
    expect(shaderId).toBeTruthy();
    const info = body(await call('get_node_info', { fileId, nodeId: shaderId }));
    expect(info.component).toBe('ShaderMeshGradient');
    expect(info.name).toBe('Glow');
    expect(info.shader).toEqual({ type: 'MeshGradient', props: expect.objectContaining({ swirl: 0.6, colors: ['#ff5f6d', '#ffc371', '#2b5876'] }) });
  });

  it('exports shader JSX with the library import', async () => {
    const jsx = body(await call('get_jsx', { fileId, nodeId: shaderId, format: 'inline-styles' }));
    expect(String(jsx)).toContain("import { MeshGradient } from '@paper-design/shaders-react';");
    expect(String(jsx)).toContain('<MeshGradient');
  });

  it('renders the effect in headless screenshots', async () => {
    const shot = await call('get_screenshot', { fileId, nodeId: shaderId });
    expect(shot.isError).toBeFalsy();
    const image = shot.content.find((c) => c.type === 'image')!;
    const colors = await distinctColors(`data:${image.mimeType};base64,${image.data}`);
    // A flat (unrendered) layer has a single colour; the gradient has many.
    expect(colors).toBeGreaterThan(30);
  });

  it('edits params and presets with update_shader', async () => {
    const r = body(
      await call('update_shader', {
        fileId,
        updates: [
          { nodeId: shaderId, preset: 'Beach', params: { speed: 0.25, grainMixer: 0.3 } },
          { nodeId: shaderId, params: { wobble: 1 } },
        ],
      })
    );
    expect(r.updates[0].props).toMatchObject({ speed: 0.25, grainMixer: 0.3, colors: ['#bcecf6', '#00aaff', '#00f7ff', '#ffd447'] });
    expect(r.errors[0].error).toMatch(/no parameter "wobble"/);
    const info = body(await call('get_node_info', { fileId, nodeId: shaderId }));
    expect(info.shader.props.speed).toBe(0.25);
    const notShader = body(await call('update_shader', { fileId, updates: [{ nodeId: info.parentId, params: { speed: 1 } }] }));
    expect(notShader.errors[0].error).toMatch(/not a shader layer/);
  });

  it('documents every effect in the shaders guide', async () => {
    const guide = body(await call('get_guide', { topic: 'shaders' }));
    expect(String(guide)).toContain('<x-shader type="MeshGradient"');
    expect(String(guide)).toContain('#### GodRays — God Rays');
  });

  it('refuses SVG export of shader layers', async () => {
    const r = await call('export', { fileId, nodes: { [shaderId]: [{ format: 'svg', scale: '1x' }] } });
    expect(JSON.stringify(r.content)).toContain('SVG export is not supported for this node, try a raster format instead.');
  });
});
