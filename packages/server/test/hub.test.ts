import { describe, expect, it } from 'vitest';
import { createDocument, createSubtree, Transaction } from '@openpaper/core';
import { LiveDocument, type ActorRef } from '../src/hub.ts';

const user: ActorRef = { kind: 'user', id: 'u', name: 'User' };
const other: ActorRef = { kind: 'user', id: 'u2', name: 'Other' };
const agent: ActorRef = { kind: 'agent', id: 's1', name: 'Claude Code' };
const agent2: ActorRef = { kind: 'agent', id: 's2', name: 'OpenPaper Agent' };
const system: ActorRef = { kind: 'system', id: 'system', name: 'OpenPaper' };

/** A board holding rectangles `a` and `b`. */
function setup() {
  const doc = createDocument({ name: 'History' });
  const rootId = doc.pages[doc.pageList[0]!.id]!.rootId;
  const tx = new Transaction(doc);
  createSubtree(tx, rootId, {
    component: 'Frame',
    label: 'Board',
    styles: { left: '0px', top: '0px', width: '400px', height: '400px' },
    children: [
      { component: 'Rectangle', label: 'a', styles: { width: '10px', height: '10px' } },
      { component: 'Rectangle', label: 'b', styles: { width: '10px', height: '10px' } },
    ],
  });
  const live = new LiveDocument(tx.commit().doc, { save: async () => {} } as never, () => {});
  const find = (label: string) => Object.values(live.doc.nodes).find((n) => n.label === label)!.id;
  const width = (label: string) => live.doc.nodes[find(label)]!.styles.width;
  const resize = (actor: ActorRef, label: string, w: string) =>
    live.transact(actor, `resize ${label}`, (tx) => tx.updateNode(find(label), (n) => void (n.styles.width = w)));
  const insert = (actor: ActorRef, label: string) =>
    live.transact(actor, `insert ${label}`, (tx) => createSubtree(tx, find('Board'), { component: 'Rectangle', label, styles: { width: '5px', height: '5px' } }));
  return { live, find, width, resize, insert };
}

describe('undo history', () => {
  it("lets a person's undo take back an agent's change, and redo it", () => {
    const { live, width, resize } = setup();
    resize(agent, 'a', '50px');
    expect(live.canUndo(user)).toBe(true);
    expect(live.undo(user)).toBe('resize a');
    expect(width('a')).toBe('10px');
    expect(live.undo(user)).toBeNull();
    expect(live.redo(user)).toBe('resize a');
    expect(width('a')).toBe('50px');
    // Redone, it is still the agent's change: the Agents panel can undo it.
    expect(live.undo(agent)).toBe('resize a');
    expect(width('a')).toBe('10px');
  });

  it('steps back through people and agents newest first', () => {
    const { live, width, resize } = setup();
    resize(user, 'a', '20px');
    resize(agent, 'a', '30px');
    resize(agent2, 'b', '40px');
    resize(user, 'b', '50px');
    expect(live.undo(user)).toBe('resize b');
    expect(width('b')).toBe('40px');
    expect(live.undo(user)).toBe('resize b');
    expect(width('b')).toBe('10px');
    expect(live.undo(user)).toBe('resize a');
    expect(width('a')).toBe('20px');
    expect(live.undo(user)).toBe('resize a');
    expect(width('a')).toBe('10px');
    expect(live.canUndo(user)).toBe(false);
    for (let i = 0; i < 4; i++) live.redo(user);
    expect([width('a'), width('b')]).toEqual(['30px', '50px']);
  });

  it("keeps people's own changes apart, and an agent's undo to that agent", () => {
    const { live, width, resize } = setup();
    resize(other, 'a', '20px');
    resize(agent, 'b', '30px');
    resize(user, 'b', '40px');
    expect(live.undo(agent2)).toBeNull();
    // The agent's change to `b` was edited by the user since, so the panel leaves it alone.
    expect(live.undo(agent)).toBeNull();
    expect(width('b')).toBe('40px');
    expect(live.undo(user)).toBe('resize b');
    expect(live.undo(user)).toBeNull();
    expect(width('a')).toBe('20px');
    expect(live.undo(other)).toBe('resize a');
  });

  it('skips changes someone else has overwritten', () => {
    const { live, width, resize } = setup();
    resize(user, 'a', '20px');
    resize(agent, 'b', '30px');
    resize(other, 'b', '40px');
    expect(live.undo(user)).toBe('resize a');
    expect([width('a'), width('b')]).toEqual(['10px', '40px']);
  });

  it("ends a person's redo chain when an agent changes something", () => {
    const { live, width, resize } = setup();
    resize(user, 'a', '20px');
    live.undo(user);
    expect(live.canRedo(user)).toBe(true);
    resize(agent, 'b', '30px');
    expect(live.canRedo(user)).toBe(false);
    expect(live.redo(user)).toBeNull();
    expect(width('a')).toBe('10px');
  });

  it('does not record changes marked not undoable', () => {
    const { live } = setup();
    live.transact(agent, 'progress', (tx) => tx.setName('Renamed'), { undoable: false });
    expect(live.canUndo(user)).toBe(false);
    expect(live.undo(user)).toBeNull();
  });

  it('folds progress on a change (an image finishing) into it, so undo and redo still work', () => {
    const { live, find, insert } = setup();
    insert(agent, 'X');
    live.transact(system, 'Image generated', (tx) => tx.updateNode(find('X'), (n) => void (n.styles.backgroundImage = 'url(done.png)')), {
      undoable: false,
    });
    expect(live.undo(user)).toBe('insert X');
    expect(Object.values(live.doc.nodes).some((n) => n.label === 'X')).toBe(false);
    expectConsistent(live);
    expect(live.redo(user)).toBe('insert X');
    expect(live.doc.nodes[find('X')]!.styles.backgroundImage).toBe('url(done.png)');
    expectConsistent(live);
  });

  it('keeps an insert and its parent together, so a partial undo never orphans a layer', () => {
    const { live, find, insert } = setup();
    insert(agent, 'X');
    // Someone else restyles the board the layer went into: the insert can't be taken back cleanly.
    live.transact(other, 'fill', (tx) => tx.updateNode(find('Board'), (n) => void (n.styles.backgroundColor = 'red')));
    expect(live.undo(user)).toBeNull();
    expect(live.doc.nodes[find('Board')]!.children).toContain(find('X'));
    expectConsistent(live);
  });

  it('redoes only what the undo took back', () => {
    const { live, width, find } = setup();
    live.transact(agent, 'resize both', (tx) => {
      tx.updateNode(find('a'), (n) => void (n.styles.width = '50px'));
      tx.updateNode(find('b'), (n) => void (n.styles.width = '50px'));
    });
    live.transact(other, 'resize b', (tx) => tx.updateNode(find('b'), (n) => void (n.styles.width = '70px')));
    expect(live.undo(user)).toBe('resize both');
    expect([width('a'), width('b')]).toEqual(['10px', '70px']);
    expect(live.redo(user)).toBe('resize both');
    expect([width('a'), width('b')]).toEqual(['50px', '70px']);
  });

  it("gives each author a budget, so one busy author can't push another's steps off the end", () => {
    const { live, resize } = setup();
    resize(agent2, 'a', '20px');
    for (let i = 0; i < 300; i++) resize(agent, 'b', `${i}px`);
    expect(live.undo(agent2)).toBe('resize a');
  });

  it('refuses changes once the file is closed for deletion', () => {
    const { live, resize } = setup();
    resize(agent, 'a', '50px');
    live.closed = true;
    expect(() => resize(agent, 'a', '60px')).toThrow(/deleted/);
    expect(live.undo(user)).toBeNull();
  });
});

/** Every node's parent lists it, and every listed child exists and points back. */
function expectConsistent(live: LiveDocument) {
  for (const n of Object.values(live.doc.nodes)) {
    if (n.parentId) expect(live.doc.nodes[n.parentId]?.children).toContain(n.id);
    for (const c of n.children) expect(live.doc.nodes[c]?.parentId).toBe(n.id);
  }
}
