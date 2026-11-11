import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewState } from '@openpaper/core';
import { ViewMemory } from '../src/view-memory.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'op-views-'));
  path = join(dir, 'views.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const viewport = { x: -120, y: 40, zoom: 0.5, width: 1200, height: 800 };

function view(partial: Partial<ViewState>): ViewState {
  return { fileId: 'file1', pageId: 'pageA', selection: [], focused: true, ...partial };
}

describe('ViewMemory', () => {
  it('remembers the last page and each page’s camera and selection', () => {
    const memory = new ViewMemory(path);
    memory.record(view({ pageId: 'pageA', selection: ['n1'], viewport }));
    memory.record(view({ pageId: 'pageB', selection: ['n7', 'n8'], viewport: { ...viewport, zoom: 2 } }));
    expect(memory.get('file1')).toEqual({
      pageId: 'pageB',
      pages: {
        pageA: { viewport, selection: ['n1'] },
        pageB: { viewport: { ...viewport, zoom: 2 }, selection: ['n7', 'n8'] },
      },
    });
    expect(memory.get('other')).toBeUndefined();
  });

  it('keeps a page’s camera when a report has none', () => {
    const memory = new ViewMemory(path);
    memory.record(view({ viewport }));
    memory.record(view({ selection: ['n2'] }));
    expect(memory.get('file1')?.pages.pageA).toEqual({ viewport, selection: ['n2'] });
  });

  it('ignores older versions on screen, home and malformed reports', () => {
    const memory = new ViewMemory(path);
    memory.record(view({ viewport, selection: ['n1'] }));
    memory.record(view({ viewport: { ...viewport, zoom: 3 }, selection: [], previewing: true }));
    memory.record(view({ fileId: null, pageId: null }));
    memory.record(view({ pageId: 'pageB', viewport: { ...viewport, zoom: Number.NaN } as never, selection: [3, 'n4'] as never }));
    expect(memory.get('file1')).toEqual({
      pageId: 'pageB',
      pages: { pageA: { viewport, selection: ['n1'] }, pageB: { selection: ['n4'] } },
    });
  });

  it('forgets pages deleted from the file and deleted files', () => {
    const memory = new ViewMemory(path);
    memory.record(view({ pageId: 'pageA', viewport }));
    memory.record(view({ pageId: 'pageB', viewport }));
    memory.record(view({ pageId: 'pageC', viewport }), (id) => id !== 'pageA');
    expect(Object.keys(memory.get('file1')!.pages).sort()).toEqual(['pageB', 'pageC']);
    memory.forget('file1');
    expect(memory.get('file1')).toBeUndefined();
  });

  it('is kept across restarts, without files that are gone', async () => {
    const memory = new ViewMemory(path);
    memory.record(view({ fileId: 'file1', viewport, selection: ['n1'] }));
    memory.record(view({ fileId: 'file2', pageId: 'pageZ', viewport }));
    await memory.close();
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);

    const again = new ViewMemory(path);
    await again.init((id) => id !== 'file2');
    expect(again.get('file1')).toEqual({ pageId: 'pageA', pages: { pageA: { viewport, selection: ['n1'] } } });
    expect(again.get('file2')).toBeUndefined();
  });

  it('starts empty from a missing or damaged file', async () => {
    const missing = new ViewMemory(path);
    await missing.init();
    expect(missing.get('file1')).toBeUndefined();

    await writeFile(path, '{"version":1,"files":{"file1":{"pageId":"p","pages":{"p":{"viewport":"x","selection":"y"}}},"file2":null}}');
    const damaged = new ViewMemory(path);
    await damaged.init();
    expect(damaged.get('file1')).toEqual({ pageId: 'p', pages: { p: { selection: [] } } });
    expect(damaged.get('file2')).toBeUndefined();
  });

  it('forgets the files left longest ago past 500', () => {
    const memory = new ViewMemory(path);
    for (let i = 0; i < 502; i++) memory.record(view({ fileId: `f${i}` }));
    memory.record(view({ fileId: 'f0', selection: ['n1'] }));
    expect(memory.get('f0')).toBeDefined();
    expect(memory.get('f1')).toBeUndefined();
    expect(memory.get('f2')).toBeUndefined();
    expect(memory.get('f3')).toBeDefined();
    expect(memory.get('f501')).toBeDefined();
  });
});
