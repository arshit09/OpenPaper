import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolvePaths } from '../src/paths.ts';
import { startServer, type RunningServer } from '../src/server.ts';

let server: RunningServer;
let client: Client;
let home: string;

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

/** Body of a file-scoped result (after the {file, contentHash} header). */
function body(r: Result): any {
  const texts = r.content.filter((c) => c.type === 'text').map((c) => c.text!);
  const last = texts[texts.length - 1]!;
  try {
    return JSON.parse(last);
  } catch {
    return last;
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-test-'));
  const port = 31000 + Math.floor(Math.random() * 2000);
  server = await startServer({ paths: { ...resolvePaths(home), exports: join(home, 'exports') }, port });
  client = new Client({ name: 'vitest', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await server?.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

describe('OpenPaper MCP server', () => {
  let fileId = '';
  let artboardId = '';

  it('lists Paper-compatible tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(38);
    const names = tools.map((t) => t.name);
    for (const n of ['write_html', 'create_artboard', 'get_screenshot', 'get_jsx', 'finish_working_on_nodes', 'find_nodes', 'set_tokens']) {
      expect(names).toContain(n);
    }
    const write = tools.find((t) => t.name === 'write_html')!;
    expect(write.inputSchema.required).toEqual(['html', 'targetNodeId', 'mode', 'fileId']);
    expect(client.getInstructions()).toContain('paper-mcp-instructions');
  });

  it('creates and opens a file', async () => {
    const created = body(await call('create_file', { name: 'Test file' }));
    expect(created.fileId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    fileId = created.fileId;
    const info = body(await call('open_file', { fileId }));
    expect(info.fileName).toBe('Test file');
    expect(info.pageId).toBe('p-1-0');
    expect(info.rootNodeId).toBe('root_node_p-1-0');
    expect(info.artboards).toEqual([]);
  });

  it('returns the file header on file-scoped tools', async () => {
    const r = await call('get_basic_info', { fileId });
    const head = JSON.parse(r.content[0]!.text!);
    expect(head.file).toEqual({ id: fileId, name: 'Test file' });
    expect(head.contentHash.tokens).toMatch(/^[0-9a-f]{8}$/);
  });

  it('creates an artboard and writes HTML into it', async () => {
    const board = body(await call('create_artboard', { fileId, name: 'Desktop', styles: { width: '1440px', height: '900px', backgroundColor: '#ffffff' } }));
    expect(board.id).toBe('1-0');
    expect(board).toMatchObject({ name: 'Desktop', worldX: 0, worldY: 0, width: 1440, height: 900 });
    artboardId = board.id;

    const written = body(
      await call('write_html', {
        fileId,
        targetNodeId: artboardId,
        mode: 'insert-children',
        html: '<div layer-name="Hero" style="display:flex; flex-direction:column; gap:12px; padding:64px"><h1 style="font-size:56px; font-weight:700; color:#111; font-family: Inter">Design with agents</h1><p style="font-size:18px; color:#555">Everything is HTML and CSS.</p></div>',
      })
    );
    expect(written.createdNodes.map((n: { component: string }) => n.component)).toEqual(['Frame', 'Text', 'Text']);
    expect(written.createdNodes[0].name).toBe('Hero');
    expect(written.createdNodes[1].name).toBe('Design with agents');
  });

  it('summarizes the tree', async () => {
    const tree = body(await call('get_tree_summary', { fileId, nodeId: artboardId }));
    expect(tree.summary.split('\n')[0]).toMatch(/^Frame "Desktop" \(1-0\) 1440×900$/);
    expect(tree.summary).toContain('Text "Design with agents"');
    expect(tree.depth).toBe(3);
  });

  it('updates styles and reports inert ones', async () => {
    const r = body(await call('update_styles', { fileId, updates: [{ nodeIds: ['2-0'], styles: { gap: '24px', flexGrow: 1 } }, { nodeIds: ['nope'], styles: { color: 'red' } }] }));
    expect(r.updates[0]).toEqual({ nodeId: '2-0' });
    expect(r.errors[0]).toEqual({ nodeId: 'nope', error: 'Node not found: nope' });
    const styles = body(await call('get_computed_styles', { fileId, nodeIds: ['2-0', 'missing'] }));
    expect(styles.styles['2-0'].gap).toBe('24px');
    expect(styles.styles.missing).toBeNull();
  });

  it('finds nodes by color equivalence and text', async () => {
    const byColor = body(await call('find_nodes', { fileId, filters: [{ styleName: 'color', styleValue: 'rgb(17, 17, 17)' }] }));
    expect(byColor.nodes.map((n: { id: string }) => n.id)).toEqual(['3-0']);
    const byText = body(await call('find_nodes', { fileId, textValue: '*html and css*' }));
    expect(byText.count).toBe(1);
  });

  it('generates JSX in both formats', async () => {
    const inline = body(await call('get_jsx', { fileId, nodeId: '2-0', format: 'inline-styles', includeNodeIds: false }));
    expect(inline).toContain("fontSize: '56px'");
    expect(inline).toContain('Design with agents');
    const tw = body(await call('get_jsx', { fileId, nodeId: '2-0' }));
    expect(tw).toContain('id="2-0"');
    expect(tw).toContain('flex');
  });

  it('manages design tokens', async () => {
    const created = body(
      await call('create_tokens', {
        fileId,
        tokens: [
          { type: 'color', name: '--color-primary', value: '#3b82f6' },
          { type: 'spacing', name: '--spacing-4', value: 16 },
          { type: 'color', name: '--color-accent', value: 'var(--color-primary)' },
          { type: 'color', name: '--color-bad', value: 'not-a-color' },
        ],
      })
    );
    expect(created.tokens.slice(0, 3).map((t: { result: string }) => t.result)).toEqual(['created', 'created', 'created']);
    expect(created.tokens[3]).toEqual({ result: 'error', message: 'Invalid value "not-a-color" for token type "color".' });
    const css = body(await call('get_tokens', { fileId, format: 'css' }));
    expect(css).toBe(':root {\n  --color-primary: #3b82f6;\n  --color-accent: var(--color-primary);\n  --spacing-4: 16px;\n}\n');
    await call('update_styles', { fileId, updates: [{ nodeIds: ['3-0'], styles: { color: 'var(--color-primary)' } }] });
    const renamed = body(await call('set_tokens', { fileId, tokens: [{ name: '--color-primary', newName: '--color-brand' }] }));
    expect(renamed.tokens[0]).toEqual({ name: '--color-brand', result: 'updated' });
    const styles = body(await call('get_computed_styles', { fileId, nodeIds: ['3-0'] }));
    expect(styles.styles['3-0'].color).toBe('var(--color-brand)');
  });

  it('duplicates, moves, renames and deletes nodes', async () => {
    const dup = body(await call('duplicate_nodes', { fileId, nodes: [{ id: artboardId }] }));
    const copy = dup.duplicatedNodes[0];
    expect(copy.sourceId).toBe(artboardId);
    expect(copy.worldX).toBe(1520);
    expect(Object.keys(copy.descendantIdMap)).toHaveLength(3);

    const moved = body(await call('move_nodes', { fileId, moves: [{ nodeId: '4-0', before: '3-0' }] }));
    expect(moved.moves[0]).toMatchObject({ nodeId: '4-0', parentId: '2-0', index: 0 });

    const renamed = body(await call('rename_nodes', { fileId, updates: [{ nodeId: '4-0', name: 'Subtitle' }] }));
    expect(renamed.updates[0]).toEqual({ nodeId: '4-0', name: 'Subtitle' });

    const text = body(await call('set_text_content', { fileId, updates: [{ nodeId: '4-0', textContent: 'Real HTML. Real CSS.' }, { nodeId: '2-0', textContent: 'x' }] }));
    expect(text.errors[0].error).toBe('Node "Hero" is a Frame, not a Text node');

    const del = body(await call('delete_nodes', { fileId, nodeIds: [copy.newId] }));
    expect(del.deletedNodeIds).toEqual([copy.newId]);
    const missing = await call('get_node_info', { fileId, nodeId: copy.newId });
    expect(missing.isError).toBe(true);
  });

  it('manages pages', async () => {
    const page = body(await call('create_page', { fileId, name: 'Mobile', icon: 'design' }));
    expect(page).toEqual({ pageId: 'p-2-0', name: 'Mobile', icon: 'design' });
    const arranged = body(await call('arrange_pages', { fileId, order: ['p-2-0', { type: 'divider' }, 'p-1-0'] }));
    expect(arranged.pages.map((p: { type: string }) => p.type)).toEqual(['page', 'divider', 'page']);
    const bad = await call('arrange_pages', { fileId, order: ['p-2-0'] });
    expect(bad.isError).toBe(true);
    expect(body(bad)).toContain('Nothing was changed:');
  });

  it('validates arguments like Paper', async () => {
    const r = await call('get_node_info', { fileId });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^Invalid arguments for tool get_node_info:/);
    const bad = await call('get_basic_info', { fileId: 'not a file id' });
    expect(bad.content[0]!.text).toBe('Invalid fileId "not a file id". Expected an OpenPaper file id, /file/<id> route, or file URL.');
  });

  it('serves guides', async () => {
    const guide = await call('get_guide', { topic: 'paper-mcp-instructions' });
    expect(guide.content[0]!.text).toContain('Review checkpoints');
    const unknown = await call('get_guide', { topic: 'nope' });
    expect(unknown.content[0]!.text).toContain('Unknown guide topic: "nope"');
  });

  it('takes screenshots with a headless browser', async () => {
    if (!server.env.render.canRender) return;
    const shot = await call('get_screenshot', { fileId, nodeId: artboardId });
    expect(shot.isError).toBeFalsy();
    const image = shot.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.data!.length).toBeGreaterThan(1000);
    const info = body(await call('get_node_info', { fileId, nodeId: '3-0' }));
    expect(info.width).toBeGreaterThan(100);
    expect(info.worldX).toBe(64);
  });

  it('finishes working', async () => {
    const r = body(await call('finish_working_on_nodes', { fileId }));
    expect(r).toBe('OK');
  });
});
