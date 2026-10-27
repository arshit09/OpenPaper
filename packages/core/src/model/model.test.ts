import { describe, expect, it } from 'vitest';
import { applyPatch, createDocument, formatNodeId, formatPageId, Transaction } from '../index.ts';
import { createSubtree, deleteSubtree, duplicateSubtree, moveNode, OpError, patchStyles, setTextRuns, setTextValue } from './ops.ts';
import { normalizeRuns } from './text-runs.ts';
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

describe('text runs', () => {
  const base = { fontSize: '14px', color: '#333333', fontFamily: 'Inter' };

  it('drops empty runs and what repeats the node, and merges equal neighbours', () => {
    const { runs, hoist } = normalizeRuns(
      [
        { text: 'Made ', styles: { color: '#333' } },
        { text: '' , styles: { color: 'red' } },
        { text: 'with ' },
        { text: 'love', styles: { color: '#FF3E3E', fontWeight: 700, lineHeight: '20px' } },
        { text: '!', styles: { color: '#ff3e3e', fontWeight: '700' } },
      ],
      base
    );
    expect(hoist).toEqual({});
    expect(runs).toEqual([{ text: 'Made with ' }, { text: 'love!', styles: { color: '#FF3E3E', fontWeight: '700' } }]);
  });

  it('lets spaces between same-coloured parts join them, and moves a single style onto the node', () => {
    const { runs, hoist } = normalizeRuns([{ text: 'a', styles: { color: 'red' } }, { text: ' ' }, { text: 'b', styles: { color: 'red' } }], base);
    expect(runs).toBeUndefined();
    expect(hoist).toEqual({ color: 'red' });
    // A highlight on a lone run stays a run: on the node it would fill the whole box.
    expect(normalizeRuns([{ text: 'all', styles: { backgroundColor: 'yellow', fontWeight: '700' } }], base)).toEqual({
      runs: [{ text: 'all', styles: { backgroundColor: 'yellow' } }],
      hoist: { fontWeight: '700' },
    });
  });

  it('sets, clears, duplicates and undoes runs through transactions', () => {
    const { doc, rootId } = newDoc();
    const tx = new Transaction(doc);
    const t = createSubtree(tx, rootId, { component: 'Text', textValue: 'plain', styles: base });
    const { doc: d1 } = tx.commit();

    const tx2 = new Transaction(d1);
    setTextRuns(tx2, t.id, [{ text: 'Hello ' }, { text: 'World', styles: { fontWeight: '700' } }]);
    const copy = duplicateSubtree(tx2, t.id).rootId;
    const { doc: d2, inverse } = tx2.commit();
    expect(d2.nodes[t.id]?.textValue).toBe('Hello World');
    expect(d2.nodes[t.id]?.textRuns).toEqual([{ text: 'Hello ' }, { text: 'World', styles: { fontWeight: '700' } }]);
    expect(d2.nodes[copy]?.textRuns).toEqual(d2.nodes[t.id]?.textRuns);
    expect(d2.nodes[copy]?.textRuns).not.toBe(d2.nodes[t.id]?.textRuns);
    const undone = applyPatch(d2, inverse);
    expect(undone.nodes[t.id]?.textValue).toBe('plain');
    expect(undone.nodes[t.id]?.textRuns).toBeUndefined();

    const tx3 = new Transaction(d2);
    setTextValue(tx3, t.id, 'plain again');
    expect(tx3.getNode(t.id)?.textRuns).toBeUndefined();
    // Drafts are deep copies: the committed record keeps its runs.
    expect(d2.nodes[t.id]?.textRuns).toHaveLength(2);
  });
});
