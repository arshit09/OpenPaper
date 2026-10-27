import { describe, expect, it } from 'vitest';
import { importHtml, collectImageUrls, type ImportedNode } from './import.ts';
import { createDocument, createSubtree, generateJsx, identityUrls, insertImported, nodesToHtml, readerOf, renderNodeHtml, setTextRuns, Transaction } from '../index.ts';

const brief = (n: ImportedNode): unknown => ({
  c: n.component,
  ...(n.label !== n.component ? { label: n.label } : {}),
  ...(n.textValue !== undefined ? { text: n.textValue } : {}),
  ...(n.cloneOf ? { cloneOf: n.cloneOf } : {}),
  ...(n.children.length ? { children: n.children.map(brief) } : {}),
});

describe('importHtml', () => {
  it('turns a card into a frame with Text children carrying the typography', () => {
    const { roots } = importHtml(
      `<div style="display:flex; flex-direction:column; gap:8px; padding:24px; background-color:#fff; font-family: Inter">
         <h2 style="font-size:20px; font-weight:600; color:#111">Weekly summary</h2>
         <p style="color:#666">Details</p>
       </div>`
    );
    expect(roots.map(brief)).toEqual([{ c: 'Frame', children: [{ c: 'Text', text: 'Weekly summary' }, { c: 'Text', text: 'Details' }] }]);
    const card = roots[0]!;
    expect(card.styles).toEqual({ display: 'flex', flexDirection: 'column', gap: '8px', padding: '24px', backgroundColor: '#fff' });
    expect(card.children[0]!.styles).toMatchObject({ fontSize: '20px', fontWeight: '600', color: '#111', fontFamily: 'Inter' });
    expect(card.children[1]!.styles).toMatchObject({ fontSize: '16px', color: '#666', fontFamily: 'Inter' });
  });

  it('gives boxed elements (buttons) a separate Text child', () => {
    const { roots } = importHtml('<button style="padding:8px 16px; background:blue; color:white; font-size:14px">Sign up</button>');
    expect(roots.map(brief)).toEqual([{ c: 'Frame', label: 'Button', children: [{ c: 'Text', text: 'Sign up' }] }]);
    expect(roots[0]!.labelIsModified).toBe(true);
    expect(roots[0]!.styles.color).toBeUndefined();
    expect(roots[0]!.styles.fontSize).toBeUndefined();
    expect(roots[0]!.children[0]!.styles).toMatchObject({ color: 'white', fontSize: '14px' });
  });

  it('flattens inline formatting into one Text node', () => {
    const { roots } = importHtml('<p style="font-size:18px">Hello <b>World</b> and <span style="color:red">red</span></p>');
    expect(roots.map(brief)).toEqual([{ c: 'Text', text: 'Hello World and red' }]);
  });

  it('keeps flex children as separate Text nodes', () => {
    const { roots } = importHtml('<div style="display:flex">Hello <b>World</b></div>');
    expect(roots.map(brief)).toEqual([{ c: 'Frame', children: [{ c: 'Text', text: 'Hello' }, { c: 'Text', text: 'World' }] }]);
  });

  it('detects freeform containers from absolutely positioned children', () => {
    const { roots } = importHtml(
      '<div style="position:relative; width:200px; height:100px"><div style="position:absolute; left:10px; top:20px; width:50px; height:50px; background:red"></div></div>'
    );
    const outer = roots[0]!;
    expect(outer.styles.display).toBe('*');
    expect(outer.children[0]!.styles).toMatchObject({ left: '10px', top: '20px', width: '50px' });
    expect(outer.children[0]!.styles.position).toBeUndefined();
  });

  it('imports <img> as a Rectangle with an image fill sized from intrinsic dimensions', () => {
    const { roots } = importHtml('<img src="https://example.com/photo.png" style="width:100px">', {
      resolveImage: () => ({ url: '/media/abc.png', width: 200, height: 100 }),
    });
    expect(roots[0]!.component).toBe('Rectangle');
    expect(roots[0]!.styles).toMatchObject({
      width: '100px',
      backgroundImage: 'url("/media/abc.png")',
      backgroundSize: '100% 100%',
      aspectRatio: '2 / 1',
    });
    expect(roots[0]!.styles.height).toBeUndefined();
    expect(collectImageUrls('<img src="a.png"><div style="background-image:url(b.jpg)"></div>')).toEqual(['a.png', 'b.jpg']);
  });

  it('imports inline SVG with its markup', () => {
    const { roots } = importHtml('<svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="currentColor"/></svg>');
    expect(roots[0]!.component).toBe('SVG');
    expect(roots[0]!.svg).toContain('<path d="M0 0h24v24H0z" fill="currentColor"/>');
    expect(roots[0]!.svg).toContain('viewBox="0 0 24 24"');
    expect(roots[0]!.styles.display).toBe('inline-block');
  });

  it('supports self-closing x-paper-clone without swallowing siblings', () => {
    const { roots } = importHtml('<div style="display:flex"><x-paper-clone node-id="1-0" style="width: 200px" /><div style="width:4px">Next</div></div>', {
      nodeExists: (id) => id === '1-0',
    });
    expect(roots.map(brief)).toEqual([{ c: 'Frame', children: [{ c: 'Frame', cloneOf: '1-0' }, { c: 'Text', text: 'Next' }] }]);
    expect(roots[0]!.children[0]!.styles).toEqual({ width: '200px' });
  });

  it('prunes empty nodes and ignores head-only content', () => {
    const { roots } = importHtml('<style>.a{}</style><script>alert(1)</script><div></div><div style="width:10px"></div>');
    expect(roots).toHaveLength(1);
    expect(roots[0]!.styles).toEqual({ width: '10px' });
  });

  it('handles whitespace, <pre> and <br>', () => {
    expect(importHtml('<div>\n   Hello   world  \n</div>').roots.map(brief)).toEqual([{ c: 'Text', text: 'Hello world' }]);
    expect(importHtml('<pre style="font-family:monospace">line1\n  line2</pre>').roots[0]!.textValue).toBe('line1\n  line2');
    expect(importHtml('<p>Line one<br>Line two</p>').roots[0]!.textValue).toBe('Line one\nLine two');
  });

  it('honors hidden, layer-name and locked attributes', () => {
    const { roots } = importHtml('<div hidden style="width:10px"></div><div layer-name="Hero" data-paper-locked style="padding:4px">x</div>');
    expect(roots[0]!.isVisible).toBe(false);
    expect(roots[1]!.label).toBe('Hero');
    expect(roots[1]!.labelIsModified).toBe(true);
    expect(roots[1]!.isLocked).toBe(true);
  });

  it('turns inputs into a frame with placeholder text', () => {
    const { roots } = importHtml('<input placeholder="Email" style="padding:8px; border:1px solid #ccc; width: 240px">');
    expect(roots.map(brief)).toEqual([{ c: 'Frame', label: 'Input', children: [{ c: 'Text', text: 'Email' }] }]);
    expect(roots[0]!.children[0]!.styles.opacity).toBe('0.5');
  });

  it('re-parents absolute elements to their containing block', () => {
    const { roots } = importHtml(
      '<div style="position:relative; display:flex; width:300px"><div style="display:flex"><span style="position:absolute; top:0; right:0; width:8px; height:8px; background:red"></span><div style="width:20px; height:20px; background:blue"></div></div></div>'
    );
    const outer = roots[0]!;
    // The badge moved up to the positioned ancestor, after the branch that contained it.
    expect(outer.children).toHaveLength(2);
    expect(outer.children[1]!.styles).toMatchObject({ position: 'absolute', right: '0', top: '0' });
  });
});

describe('rich text runs', () => {
  const textOf = (html: string) => importHtml(html).roots[0]!;

  it('keeps a styled span as a run inside one Text node', () => {
    const t = textOf('<p style="font-size:14px">Made with <span style="color:#ff3e3e;font-weight:700">love</span> by Arshit</p>');
    expect(t.component).toBe('Text');
    expect(t.children).toEqual([]);
    expect(t.textValue).toBe('Made with love by Arshit');
    expect(t.styles).toMatchObject({ fontSize: '14px', color: '#000000' });
    expect(t.textRuns).toEqual([{ text: 'Made with ' }, { text: 'love', styles: { color: '#ff3e3e', fontWeight: '700' } }, { text: ' by Arshit' }]);
  });

  it('gives plain paragraphs no runs', () => {
    for (const html of ['<p style="font-size:18px; color:#111">Just words</p>', '<p>One <span>Two</span> three</p>', '<p style="color:#111">a <span style="color:#111111">b</span></p>']) {
      expect(textOf(html).textRuns).toBeUndefined();
    }
    const t = textOf('<p style="color:#666"><span style="color:red">all</span> <span style="color:red">red</span></p>');
    expect(t.textRuns).toBeUndefined();
    expect(t.styles.color).toBe('red');
  });

  it('collapses whitespace across run boundaries exactly like plain text', () => {
    expect(textOf('<p>Hello <b>World</b></p>').textRuns).toEqual([{ text: 'Hello ' }, { text: 'World', styles: { fontWeight: '700' } }]);
    const t = textOf('<p>\n  Hello  <b>  World </b>  again\n</p>');
    expect(t.textValue).toBe('Hello World again');
    expect(t.textRuns).toEqual([{ text: 'Hello ' }, { text: 'World ', styles: { fontWeight: '700' } }, { text: 'again' }]);
    expect(textOf('<pre>  a <i>b</i>\n  c</pre>').textRuns).toEqual([{ text: '  a ' }, { text: 'b', styles: { fontStyle: 'italic' } }, { text: '\n  c' }]);
    expect(textOf('<p>one<br><u>two</u></p>').textRuns).toEqual([{ text: 'one\n' }, { text: 'two', styles: { textDecoration: 'underline' } }]);
  });

  it('applies tag defaults and adds up nested decorations', () => {
    const t = textOf('<p>a <a style="text-decoration:underline; text-underline-offset:2px">link <s>gone</s></a> <code>x()</code> <mark>hi</mark></p>');
    expect(t.textRuns).toEqual([
      { text: 'a ' },
      { text: 'link ', styles: { textDecoration: 'underline', textUnderlineOffset: '2px' } },
      { text: 'gone', styles: { textDecoration: 'underline line-through', textUnderlineOffset: '2px' } },
      { text: ' ' },
      { text: 'x()', styles: { fontFamily: 'monospace' } },
      { text: ' ' },
      { text: 'hi', styles: { backgroundColor: '#ffff00' } },
    ]);
  });

  it('keeps runs on the text child of boxed elements', () => {
    const button = textOf('<button style="padding:8px 16px; background:blue; color:white">Go <b>now</b></button>');
    expect(button.component).toBe('Frame');
    expect(button.children[0]!.textRuns).toEqual([{ text: 'Go ' }, { text: 'now', styles: { fontWeight: '700' } }]);
  });

  function inserted(html: string) {
    const doc = createDocument({ name: 'Runs' });
    const rootId = doc.pages[doc.pageList[0]!.id]!.rootId;
    const tx = new Transaction(doc);
    const { topLevelIds } = insertImported(tx, importHtml(html).roots, rootId, 'insert-children');
    return { reader: readerOf(tx.commit().doc), id: topLevelIds[0]! };
  }

  it('round-trips through HTML export (copy/paste)', () => {
    const { reader, id } = inserted('<p style="font-size:14px; color: var(--ink)">Made with <span style="color:var(--color-accent);font-weight:700">love</span> by <i>Arshit</i></p>');
    const node = reader.getNode(id)!;
    const html = nodesToHtml(reader, [id]);
    expect(html).toContain('<span style="color: var(--color-accent); font-weight: 700;">love</span>');
    const again = importHtml(html).roots[0]!;
    expect(again.textValue).toBe(node.textValue);
    expect(again.textRuns).toEqual(node.textRuns);
    // A lone styled part still comes back as one text layer.
    const { reader: r2, id: id2 } = inserted('<p>x <mark>all</mark></p>');
    expect(importHtml(nodesToHtml(r2, [id2])).roots[0]!.textRuns).toEqual(r2.getNode(id2)!.textRuns);
  });

  it('keeps line breaks of text set without white-space through a paste', () => {
    const doc = createDocument({ name: 'Breaks' });
    const rootId = doc.pages[doc.pageList[0]!.id]!.rootId;
    const tx = new Transaction(doc);
    const plain = createSubtree(tx, rootId, { component: 'Text', textValue: 'one\ntwo', styles: { fontSize: '16px' } });
    const rich = createSubtree(tx, rootId, { component: 'Text', textValue: 'x', styles: { fontSize: '16px' } });
    setTextRuns(tx, rich.id, [{ text: 'bold', styles: { fontWeight: '700' } }, { text: ' line\nnext' }]);
    const reader = readerOf(tx.commit().doc);
    expect(importHtml(nodesToHtml(reader, [plain.id])).roots[0]!.textValue).toBe('one\ntwo');
    const again = importHtml(nodesToHtml(reader, [rich.id])).roots[0]!;
    expect(again.textValue).toBe('bold line\nnext');
    expect(again.textRuns).toEqual(reader.getNode(rich.id)!.textRuns);
  });

  it('renders runs as spans in static HTML and JSX', async () => {
    const { reader, id } = inserted('<p style="font-size:14px; white-space:pre-wrap">Read the <a style="font-weight:600; color:var(--link)">docs</a>  first</p>');
    const node = reader.getNode(id)!;
    expect(renderNodeHtml(reader, node, identityUrls)).toContain('>Read the <span style="color: var(--link); font-weight: 600;">docs</span>  first</div>');
    const jsx = await generateJsx(reader, id, { format: 'inline-styles', includeNodeIds: false, includeRootPositioning: false });
    expect(jsx).toContain("Read the <span style={{ color: 'var(--link)', fontWeight: 600 }}>docs</span>{'  '}first");
  });
});
