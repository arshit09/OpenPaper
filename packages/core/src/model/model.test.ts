import { describe, expect, it } from 'vitest';
import { applyPatch, createDocument, formatNodeId, formatPageId, Transaction } from '../index.ts';
import { createSubtree, deleteSubtree, duplicateSubtree, moveNode, OpError, patchStyles, setTextValue } from './ops.ts';
import { artboardOf, isArtboard, pageIdOfNode, subtreeOf } from './tree.ts';

function newDoc() {
  const doc = createDocument({ name: 'Test' });
  const page = doc.pages[doc.pageList[0]!.id]!;
  return { doc, page, rootId: page.rootId };
}

describe('ids', () => {
  it('formats node and page ids like Paper', () => {
    expect(formatNodeId(1)).toBe('1-0');
    expect(formatNodeId(10)).toBe('A-0');
    expect(formatNodeId(87)).toBe('2F-0');
    expect(formatPageId(1)).toBe('p-1-0');
  });
});

describe('document', () => {
  it('starts with one page and a page root', () => {
    const { doc, page, rootId } = newDoc();
    expect(page.id).toBe('p-1-0');
    expect(rootId).toBe('root_node_p-1-0');
    expect(doc.nodes[rootId]?.component).toBe('PageRoot');
  });
});

describe('transaction', () => {
  it('creates nested nodes with sequential ids and produces invertible patches', () => {
    const { doc, rootId } = newDoc();
    const tx = new Transaction(doc);
    const card = createSubtree(tx, rootId, {
      component: 'Frame',
      label: 'Card',
      styles: { width: '320px', height: '200px' },
      children: [{ component: 'Text', textValue: 'Hello world' }],
    });
    expect(card.id).toBe('1-0');
    const { doc: next, patch, inverse } = tx.commit();
    expect(next.nodes['1-0']?.children).toEqual(['2-0']);
    expect(next.nodes['2-0']?.label).toBe('Hello world');
    expect(next.nodes[rootId]?.children).toEqual(['1-0']);
    expect(next.counters.nodes).toBe(2);

    // Untouched records are shared, touched ones are new objects.
    expect(next.nodes[rootId]).not.toBe(doc.nodes[rootId]);

    const reverted = applyPatch(next, inverse);
    expect(reverted.nodes['1-0']).toBeUndefined();
    expect(reverted.nodes[rootId]?.children).toEqual([]);
    // Counters never go backwards, so ids are not reused after undo.
    expect(reverted.counters.nodes).toBe(2);

    const replayed = applyPatch(reverted, patch);
    expect(replayed.nodes['2-0']?.textValue).toBe('Hello world');
  });

  it('aborts cleanly when an op throws', () => {
    const { doc } = newDoc();
    const tx = new Transaction(doc);
    expect(() => createSubtree(tx, 'nope', { component: 'Frame' })).toThrow(OpError);
  });
});

describe('ops', () => {
  function setup() {
    const { doc, rootId } = newDoc();
    const tx = new Transaction(doc);
    const board = createSubtree(tx, rootId, { component: 'Frame', label: 'Board', styles: { width: '400px' } });
    const a = createSubtree(tx, board.id, { component: 'Frame', label: 'A' });
    const b = createSubtree(tx, board.id, { component: 'Frame', label: 'B' });
    const t = createSubtree(tx, a.id, { component: 'Text', textValue: 'hi' });
    return { tx, rootId, board, a, b, t };
  }

  it('knows artboards and pages', () => {
    const { tx, board, t } = setup();
    expect(isArtboard(tx, tx.getNode(board.id))).toBe(true);
    expect(isArtboard(tx, tx.getNode(t.id))).toBe(false);
    expect(artboardOf(tx, t.id)?.id).toBe(board.id);
    expect(pageIdOfNode(tx, t.id)).toBe('p-1-0');
  });

  it('moves nodes and refuses cycles', () => {
    const { tx, a, b, t } = setup();
    moveNode(tx, t.id, b.id, 0);
    expect(tx.getNode(b.id)?.children).toEqual([t.id]);
    expect(tx.getNode(a.id)?.children).toEqual([]);
    expect(tx.getNode(t.id)?.parentId).toBe(b.id);
    expect(() => moveNode(tx, a.id, a.id)).toThrow(OpError);
    expect(() => moveNode(tx, b.id, t.id)).toThrow(/cannot have children/);
  });

  it('duplicates subtrees with an id map and places the copy after the source', () => {
    const { tx, board, a } = setup();
    const { rootId, idMap } = duplicateSubtree(tx, a.id);
    expect(tx.getNode(board.id)?.children.indexOf(rootId)).toBe(1);
    expect(Object.keys(idMap)).toHaveLength(2);
    const copyText = tx.getNode(idMap[tx.getNode(a.id)!.children[0]!]!);
    expect(copyText?.textValue).toBe('hi');
    expect(copyText?.parentId).toBe(rootId);
  });

  it('deletes subtrees', () => {
    const { tx, board, a, t } = setup();
    const removed = deleteSubtree(tx, a.id);
    expect(removed).toEqual([a.id, t.id]);
    expect(tx.getNode(t.id)).toBeUndefined();
    expect(tx.getNode(board.id)?.children).not.toContain(a.id);
    expect(subtreeOf(tx, board.id)).toHaveLength(2);
  });

  it('patches styles with removal semantics', () => {
    const { tx, a, t } = setup();
    patchStyles(tx, a.id, { width: 120, opacity: 0.5, padding: '8px', margin: null });
    expect(tx.getNode(a.id)?.styles).toEqual({ width: '120px', opacity: '0.5', padding: '8px' });
    patchStyles(tx, a.id, { padding: '' });
    expect(tx.getNode(a.id)?.styles.padding).toBeUndefined();
    expect(() => setTextValue(tx, a.id, 'x')).toThrow(/not a Text node/);
    setTextValue(tx, t.id, 'changed');
    expect(tx.getNode(t.id)?.textValue).toBe('changed');
  });
});
