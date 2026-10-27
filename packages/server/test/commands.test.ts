import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDocument, createSubtree, readerOf, Transaction, type EditorCommand } from '@openpaper/core';
import { AssetResolver } from '../src/assets.ts';
import { executeCommand } from '../src/commands.ts';
import { LiveDocument, type ActorRef } from '../src/hub.ts';
import { MediaStore } from '../src/media.ts';

const user: ActorRef = { kind: 'user', id: 'u', name: 'User' };
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'op-commands-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A page with an artboard holding a freeform child `box` and a flex column with `a`, `b`. */
function setup() {
  const doc = createDocument({ name: 'Commands' });
  const rootId = doc.pages[doc.pageList[0]!.id]!.rootId;
  const tx = new Transaction(doc);
  const board = createSubtree(tx, rootId, {
    component: 'Frame',
    label: 'Board',
    styles: { left: '0px', top: '0px', width: '800px', height: '600px', display: '*' },
    children: [
      { component: 'Rectangle', label: 'box', styles: { left: '10px', top: '20px', width: '100px', height: '50px' } },
      {
        component: 'Frame',
        label: 'list',
        styles: { left: '300px', top: '0px', display: 'flex', flexDirection: 'column' },
        children: [
          { component: 'Rectangle', label: 'a', styles: { width: '40px', height: '40px' } },
          { component: 'Rectangle', label: 'b', styles: { width: '40px', height: '40px' } },
        ],
      },
    ],
  });
  // Agent-made artboards are often flex columns holding absolutely positioned layers.
  createSubtree(tx, rootId, {
    component: 'Frame',
    label: 'Flow board',
    styles: { left: '1000px', top: '0px', width: '400px', height: '400px', display: 'flex', flexDirection: 'column' },
    children: [
      { component: 'Rectangle', label: 'p', styles: { position: 'absolute', left: '20px', top: '30px', width: '50px', height: '50px' } },
      { component: 'Rectangle', label: 'q', styles: { position: 'absolute', left: '120px', top: '30px', width: '50px', height: '50px' } },
    ],
  });
  const live = new LiveDocument(tx.commit().doc, { save: async () => {} } as never, () => {});
  const find = (label: string) => Object.values(live.doc.nodes).find((n) => n.label === label)!.id;
  const run = <T>(cmd: EditorCommand) => executeCommand(live, user, cmd, { assets: new AssetResolver(new MediaStore(dir)), userName: 'User' }) as Promise<T>;
  return { live, rootId, boardId: board.id, find, run };
}

describe('duplicate with placement (Alt-drag)', () => {
  it('drops copies where they were released, as one undo step', async () => {
    const { live, boardId, find, run } = setup();
    const box = find('box');
    const r = await run<{ ids: string[] }>({ type: 'duplicate', nodeIds: [box, boardId], place: { [box]: { styles: { left: '210px', top: '220px' } }, [boardId]: { styles: { left: '900px', top: '0px' } } } });
    const nodes = readerOf(live.doc);
    expect(r.ids).toHaveLength(2);
    expect(nodes.getNode(r.ids[0]!)!.styles).toMatchObject({ left: '210px', top: '220px' });
    expect(nodes.getNode(r.ids[1]!)!.styles).toMatchObject({ left: '900px', top: '0px' });
    expect(nodes.getNode(box)!.styles).toMatchObject({ left: '10px', top: '20px' });
    expect(live.undo(user)).toBe('Duplicate');
    expect(r.ids.every((id) => !live.doc.nodes[id])).toBe(true);
    expect(live.canUndo(user)).toBe(false);
  });

  it('inserts a flex child copy at the dropped index', async () => {
    const { live, find, run } = setup();
    const list = find('list');
    const r = await run<{ ids: string[] }>({ type: 'duplicate', nodeIds: [find('b')], place: { [find('b')]: { index: 0 } } });
    expect(live.doc.nodes[list]!.children).toEqual([r.ids[0], find('a'), find('b')]);
  });
});

describe('absolutely positioned layers in a flow frame', () => {
  it('group in place and ungroup back', async () => {
    const { live, find, run } = setup();
    const [p, q] = [find('p'), find('q')];
    const r = await run<{ ids: string[] }>({ type: 'group', nodeIds: [p, q] });
    const frame = live.doc.nodes[r.ids[0]!]!;
    expect(frame.styles).toMatchObject({ position: 'absolute', left: '20px', top: '30px', width: '150px', height: '50px', display: '*' });
    expect(live.doc.nodes[q]!.styles).toMatchObject({ left: '100px', top: '0px' });
    await run({ type: 'ungroup', nodeIds: [frame.id] });
    expect(live.doc.nodes[q]!.styles).toMatchObject({ position: 'absolute', left: '120px', top: '30px' });
  });

  it('a flex wrapper lays them out instead', async () => {
    const { live, find, run } = setup();
    const r = await run<{ ids: string[] }>({ type: 'group', nodeIds: [find('p'), find('q')], styles: { display: 'flex', flexDirection: 'row', gap: '50px', width: 'fit-content', height: 'fit-content' } });
    expect(live.doc.nodes[r.ids[0]!]!.styles).toMatchObject({ position: 'absolute', left: '20px', top: '30px', display: 'flex' });
    expect(live.doc.nodes[find('p')]!.styles).toEqual({ width: '50px', height: '50px' });
  });

  it('Ctrl+D offsets the copy', async () => {
    const { live, find, run } = setup();
    const r = await run<{ ids: string[] }>({ type: 'duplicate', nodeIds: [find('p')], offset: { x: 16, y: 16 } });
    expect(live.doc.nodes[r.ids[0]!]!.styles).toMatchObject({ position: 'absolute', left: '36px', top: '46px' });
  });

  it('paste on top and paste to replace keep the spot', async () => {
    const { live, find, run } = setup();
    const flow = find('Flow board');
    const html = '<div layer-name="Pasted" style="width: 30px; height: 30px"></div>';
    const top = await run<{ ids: string[] }>({ type: 'insertHtml', parentId: flow, html, index: 2, at: { x: 120, y: 30 } });
    expect(live.doc.nodes[top.ids[0]!]!.styles).toMatchObject({ position: 'absolute', left: '120px', top: '30px' });
    const rep = await run<{ ids: string[] }>({ type: 'insertHtml', parentId: flow, html, replaceIds: [find('p')] });
    expect(live.doc.nodes[rep.ids[0]!]!.styles).toMatchObject({ position: 'absolute', left: '20px', top: '30px' });
    expect(live.doc.nodes[flow]!.children.indexOf(rep.ids[0]!)).toBe(0);
  });
});

describe('group options', () => {
  it('wraps in a labelled flex frame keeping the given order', async () => {
    const { live, find, run } = setup();
    const [a, b] = [find('a'), find('b')];
    const r = await run<{ ids: string[] }>({ type: 'group', nodeIds: [b, a], label: 'Frame', ordered: true, styles: { display: 'flex', flexDirection: 'row', gap: '12px' } });
    const frame = live.doc.nodes[r.ids[0]!]!;
    expect(frame.label).toBe('Frame');
    expect(frame.children).toEqual([b, a]);
    expect(frame.styles).toMatchObject({ display: 'flex', flexDirection: 'row', gap: '12px' });
  });
});

describe('insertHtml placement', () => {
  const html = '<div layer-name="Pasted" style="width: 30px; height: 30px"></div>';

  it('pastes on top: at a position and index in the parent', async () => {
    const { live, boardId, rootId, find, run } = setup();
    const r = await run<{ ids: string[] }>({ type: 'insertHtml', parentId: boardId, html, index: 1, at: { x: 10, y: 20 } });
    expect(live.doc.nodes[boardId]!.children.indexOf(r.ids[0]!)).toBe(1);
    expect(live.doc.nodes[r.ids[0]!]!.styles).toMatchObject({ left: '10px', top: '20px' });
    expect(find('box')).toBeTruthy();
    const top = await run<{ ids: string[] }>({ type: 'insertHtml', parentId: rootId, html, at: { x: 0, y: 0 } });
    expect(live.doc.nodes[top.ids[0]!]!.styles).toMatchObject({ left: '0px', top: '0px' });
  });

  it('pastes to replace each selected layer in place', async () => {
    const { live, boardId, find, run } = setup();
    const box = find('box');
    const r = await run<{ ids: string[] }>({ type: 'insertHtml', parentId: boardId, html, replaceIds: [box, boardId] });
    expect(r.ids).toHaveLength(2);
    expect(live.doc.nodes[box]).toBeUndefined();
    expect(live.doc.nodes[boardId]).toBeUndefined();
    expect(live.doc.nodes[r.ids[1]!]!.styles).toMatchObject({ left: '0px', top: '0px' });
  });
});
