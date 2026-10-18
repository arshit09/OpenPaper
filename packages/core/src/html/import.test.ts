import { describe, expect, it } from 'vitest';
import { importHtml, collectImageUrls, type ImportedNode } from './import.ts';

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
