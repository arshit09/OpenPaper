import { describe, expect, it } from 'vitest';
import { deflateSync } from 'fflate';
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { importHtml, type ImportedNode } from '../html/import.ts';
import { figmaToHtml } from './convert.ts';
import { isFigmaClipboard, readFigmaClipboard } from './decode.ts';

/**
 * Synthetic Figma clipboard payloads: a small kiwi schema with Figma's field names, encoded and
 * wrapped exactly like Figma's clipboard (fig-kiwi archive in text/html).
 */
const SCHEMA = `
enum NodeType { NONE = 0; DOCUMENT = 1; CANVAS = 2; GROUP = 3; FRAME = 4; VECTOR = 6; STAR = 7; ELLIPSE = 9; RECTANGLE = 10; TEXT = 13; SYMBOL = 15; INSTANCE = 16; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; IMAGE = 5; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
enum StackJustify { MIN = 0; CENTER = 1; MAX = 2; SPACE_EVENLY = 3; SPACE_BETWEEN = 4; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; BASELINE = 3; }
enum StackCounterAlign { MIN = 0; CENTER = 1; MAX = 2; STRETCH = 3; AUTO = 4; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT = 1; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 2; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; JUSTIFIED = 3; }
enum WindingRule { NONZERO = 0; ODD = 1; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
struct ParentIndex { GUID guid; string position; }
struct Number { float value; NumberUnits units; }
struct FontName { string family; string style; string postscript; }
message Image { byte[] hash = 1; string name = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; ColorStop[] stops = 5; Matrix transform = 6; Image image = 7; }
message Effect { EffectType type = 1; Color color = 2; Vector offset = 3; float radius = 4; float spread = 5; bool visible = 6; }
message Path { WindingRule windingRule = 1; uint commandsBlob = 2; uint styleID = 3; }
message GUIDPath { GUID[] guids = 1; }
message TextData { string characters = 1; uint[] characterStyleIDs = 2; NodeChange[] styleOverrideTable = 3; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message NodeChange {
  GUID guid = 1; ParentIndex parentIndex = 2; NodeType type = 3; string name = 4; bool visible = 5; float opacity = 6;
  Vector size = 7; Matrix transform = 8; Paint[] fillPaints = 9; Paint[] strokePaints = 10; float strokeWeight = 11;
  float cornerRadius = 12; Effect[] effects = 13; bool frameMaskDisabled = 14; StackMode stackMode = 15; float stackSpacing = 16;
  float stackHorizontalPadding = 17; float stackVerticalPadding = 18; StackJustify stackPrimaryAlignItems = 19; StackAlign stackCounterAlignItems = 20;
  StackSize stackPrimarySizing = 21; StackSize stackCounterSizing = 22; float stackChildPrimaryGrow = 23; StackCounterAlign stackChildAlignSelf = 24;
  TextData textData = 25; float fontSize = 26; FontName fontName = 27; Number lineHeight = 28; Number letterSpacing = 29;
  TextAutoResize textAutoResize = 30; TextAlignHorizontal textAlignHorizontal = 31; Path[] fillGeometry = 32; SymbolData symbolData = 33;
  GUIDPath guidPath = 34; bool internalOnly = 35; uint styleID = 36; uint count = 37; float starInnerScale = 38;
}
message Blob { byte[] bytes = 1; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; string pasteFileKey = 3; }
`;

const schema = parseSchema(SCHEMA);
const codec = compileSchema(schema) as { encodeMessage(m: unknown): Uint8Array };

function clipboardHtml(message: unknown, fileKey = 'FILEKEY123'): string {
  const chunk = (bytes: Uint8Array) => {
    const d = deflateSync(bytes);
    const out = new Uint8Array(4 + d.length);
    new DataView(out.buffer).setUint32(0, d.length, true);
    out.set(d, 4);
    return out;
  };
  const head = new Uint8Array(12);
  head.set([...'fig-kiwi'].map((c) => c.charCodeAt(0)));
  new DataView(head.buffer).setUint32(8, 101, true);
  const parts = [head, chunk(encodeBinarySchema(schema)), chunk(codec.encodeMessage(message))];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  let bin = '';
  for (const byte of all) bin += String.fromCharCode(byte);
  const b64 = btoa(bin);
  const meta = btoa(JSON.stringify({ fileKey, pasteID: 1, dataType: 'scene' }));
  return `<meta charset="utf-8"><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${b64}(/figma)-->"></span>`;
}

const I = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const at = (x: number, y: number) => ({ ...I, m02: x, m12: y });
const g = (localID: number, sessionID = 1) => ({ sessionID, localID });
const color = (r: number, gg: number, b: number, a = 1) => ({ r, g: gg, b, a });
const solid = (r: number, gg: number, b: number, a = 1) => ({ type: 'SOLID', color: color(r, gg, b, a), opacity: 1, visible: true });
const page = (nodes: unknown[]): unknown => ({
  nodeChanges: [
    { guid: g(0, 0), type: 'DOCUMENT', name: 'Document' },
    { guid: g(1, 0), parentIndex: { guid: g(0, 0), position: '!' }, type: 'CANVAS', name: 'Page 1' },
    ...nodes,
  ],
});
const child = (parent: { sessionID: number; localID: number }, position: string) => ({ guid: parent, position });

function convert(message: unknown, keepPositions = false) {
  const html = clipboardHtml(message);
  expect(isFigmaClipboard(html)).toBe(true);
  const clip = readFigmaClipboard(html)!;
  expect(clip.meta?.fileKey).toBe('FILEKEY123');
  const result = figmaToHtml(clip.message, { fileKey: clip.meta?.fileKey, keepPositions });
  return { ...result, roots: importHtml(result.html).roots };
}

const find = (nodes: ImportedNode[], label: string): ImportedNode | undefined => {
  for (const n of nodes) {
    if (n.label === label) return n;
    const hit = find(n.children, label);
    if (hit) return hit;
  }
  return undefined;
};

describe('Figma clipboard paste', () => {
  it('ignores HTML that is not from Figma', () => {
    expect(isFigmaClipboard('<div>hello</div>')).toBe(false);
    expect(readFigmaClipboard('<div>hello</div>')).toBeNull();
  });

  it('converts an auto-layout card with text', () => {
    const card = g(10);
    const row = g(13);
    const { roots, warnings } = convert(
      page([
        {
          guid: card,
          parentIndex: child(g(1, 0), '!'),
          type: 'FRAME',
          name: 'Card',
          size: { x: 320, y: 200 },
          transform: at(100, 50),
          fillPaints: [solid(1, 1, 1)],
          cornerRadius: 12,
          effects: [{ type: 'DROP_SHADOW', color: color(0, 0, 0, 0.25), offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true }],
          stackMode: 'VERTICAL',
          stackSpacing: 12,
          stackHorizontalPadding: 16,
          stackVerticalPadding: 24,
          stackPrimarySizing: 'RESIZE_TO_FIT',
          frameMaskDisabled: false,
        },
        {
          guid: g(11),
          parentIndex: child(card, '!'),
          type: 'TEXT',
          name: 'Title',
          size: { x: 120, y: 29 },
          transform: I,
          fillPaints: [solid(0.07, 0.07, 0.07)],
          fontSize: 24,
          fontName: { family: 'Inter', style: 'Bold', postscript: '' },
          textAutoResize: 'WIDTH_AND_HEIGHT',
          textData: { characters: 'Welcome back' },
        },
        {
          guid: g(12),
          parentIndex: child(card, '"'),
          type: 'TEXT',
          name: 'Body',
          size: { x: 288, y: 48 },
          transform: I,
          fillPaints: [solid(0.4, 0.4, 0.4)],
          fontSize: 16,
          fontName: { family: 'Inter', style: 'Regular', postscript: '' },
          lineHeight: { value: 150, units: 'PERCENT' },
          letterSpacing: { value: 2, units: 'PERCENT' },
          textAutoResize: 'HEIGHT',
          textAlignHorizontal: 'CENTER',
          stackChildAlignSelf: 'STRETCH',
          textData: { characters: 'Line one\nLine two' },
        },
        { guid: row, parentIndex: child(card, '#'), type: 'FRAME', name: 'Row', size: { x: 288, y: 40 }, transform: I, stackMode: 'HORIZONTAL', stackSpacing: 8, stackCounterAlignItems: 'CENTER', frameMaskDisabled: true },
        { guid: g(14), parentIndex: child(row, '!'), type: 'RECTANGLE', name: 'Grow', size: { x: 200, y: 40 }, transform: I, fillPaints: [solid(0, 0.5, 1)], stackChildPrimaryGrow: 1 },
        { guid: g(15), parentIndex: child(row, '"'), type: 'ELLIPSE', name: 'Dot', size: { x: 24, y: 24 }, transform: I, fillPaints: [solid(1, 0, 0)] },
      ])
    );
    expect(warnings).toEqual([]);
    const cardNode = roots[0]!;
    expect(cardNode.component).toBe('Frame');
    expect(cardNode.styles).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      padding: '24px 16px 24px 16px',
      height: 'fit-content',
      width: '320px',
      backgroundColor: '#FFFFFF',
      borderRadius: '12px',
      boxShadow: '0px 4px 12px 0px rgba(0, 0, 0, 0.25)',
    });
    const title = find(roots, 'Title')!;
    expect(title.component).toBe('Text');
    expect(title.textValue).toBe('Welcome back');
    expect(title.styles).toMatchObject({ fontFamily: 'Inter', fontWeight: '700', fontSize: '24px', color: '#121212' });
    expect(title.styles.width).toBeUndefined();
    const body = find(roots, 'Body')!;
    expect(body.textValue).toBe('Line one\nLine two');
    expect(body.styles).toMatchObject({ lineHeight: '1.5', letterSpacing: '0.02em', textAlign: 'center', alignSelf: 'stretch' });
    const grow = find(roots, 'Grow')!;
    expect(grow.styles).toMatchObject({ flexGrow: '1' });
    expect(grow.styles.width).toBeUndefined();
    expect(find(roots, 'Dot')!.styles).toMatchObject({ borderRadius: '50%', width: '24px' });
    expect(find(roots, 'Row')!.styles).toMatchObject({ display: 'flex', alignItems: 'center' });
  });

  it('keeps relative positions of several top-level layers', () => {
    const { roots } = convert(
      page([
        { guid: g(20), parentIndex: child(g(1, 0), '!'), type: 'RECTANGLE', name: 'A', size: { x: 10, y: 10 }, transform: at(500, 300), fillPaints: [solid(0, 0, 0)] },
        { guid: g(21), parentIndex: child(g(1, 0), '"'), type: 'RECTANGLE', name: 'B', size: { x: 10, y: 10 }, transform: at(560, 340), fillPaints: [solid(0, 0, 0)] },
      ]),
      true
    );
    expect(roots.map((r) => [r.styles.left, r.styles.top])).toEqual([
      ['0px', '0px'],
      ['60px', '40px'],
    ]);
  });

  it('converts gradients, image fills and vector paths', () => {
    const blob = new Uint8Array(1 + 8 + 1 + 8 + 1 + 8 + 1);
    const v = new DataView(blob.buffer);
    let o = 0;
    const cmd = (c: number, ...xy: number[]) => {
      blob[o++] = c;
      for (const n of xy) {
        v.setFloat32(o, n, true);
        o += 4;
      }
    };
    cmd(1, 0, 0);
    cmd(2, 10, 0);
    cmd(2, 10, 10);
    cmd(0);
    const message = page([
      {
        guid: g(30),
        parentIndex: child(g(1, 0), '!'),
        type: 'RECTANGLE',
        name: 'Gradient',
        size: { x: 200, y: 100 },
        transform: I,
        fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, transform: I, stops: [{ color: color(1, 0, 0), position: 0 }, { color: color(0, 0, 1), position: 1 }] }],
      },
      { guid: g(31), parentIndex: child(g(1, 0), '"'), type: 'RECTANGLE', name: 'Photo', size: { x: 100, y: 100 }, transform: I, fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: new Uint8Array([0xab, 0xcd]) } }] },
      { guid: g(32), parentIndex: child(g(1, 0), '#'), type: 'VECTOR', name: 'Arrow', size: { x: 10, y: 10 }, transform: I, fillPaints: [solid(0, 0, 0)], fillGeometry: [{ windingRule: 'ODD', commandsBlob: 0 }] },
    ]) as { nodeChanges: unknown[] };
    const { roots, images, html } = convert({ ...message, blobs: [{ bytes: blob }] });
    expect(find(roots, 'Gradient')!.styles.backgroundImage).toBe('linear-gradient(90deg, #FF0000 0%, #0000FF 100%)');
    expect(images).toBe(1);
    expect(html).toContain('figma-image://FILEKEY123/abcd');
    expect(find(roots, 'Photo')!.styles).toMatchObject({ backgroundColor: '#E8E8E8', backgroundSize: 'cover' });
    const arrow = find(roots, 'Arrow')!;
    expect(arrow.component).toBe('SVG');
    expect(arrow.svg).toContain('d="M0 0L10 0L10 10Z"');
    expect(arrow.svg).toContain('fill-rule="evenodd"');
  });

  it('expands component instances with text overrides', () => {
    const internal = g(2, 0);
    const symbol = g(40);
    const label = g(41);
    const { roots } = convert(
      page([
        { guid: internal, parentIndex: child(g(0, 0), '"'), type: 'CANVAS', name: 'Internal Only Canvas', internalOnly: true },
        { guid: symbol, parentIndex: child(internal, '!'), type: 'SYMBOL', name: 'Button', size: { x: 120, y: 40 }, transform: I, fillPaints: [solid(0, 0, 0)], stackMode: 'HORIZONTAL', stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER' },
        { guid: label, parentIndex: child(symbol, '!'), type: 'TEXT', name: 'Label', size: { x: 60, y: 20 }, transform: I, fontSize: 14, fillPaints: [solid(1, 1, 1)], textAutoResize: 'WIDTH_AND_HEIGHT', textData: { characters: 'Button' } },
        {
          guid: g(50),
          parentIndex: child(g(1, 0), '!'),
          type: 'INSTANCE',
          name: 'Buy button',
          size: { x: 120, y: 40 },
          transform: I,
          fillPaints: [solid(0, 0, 0)],
          stackMode: 'HORIZONTAL',
          symbolData: { symbolID: symbol, symbolOverrides: [{ guidPath: { guids: [label] }, textData: { characters: 'Buy now' } }] },
        },
      ])
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe('Buy button');
    expect(find(roots, 'Label')!.textValue).toBe('Buy now');
  });

  it('keeps mixed text styles as runs', () => {
    const { html, roots } = convert(
      page([
        {
          guid: g(60),
          parentIndex: child(g(1, 0), '!'),
          type: 'TEXT',
          name: 'Mixed',
          size: { x: 200, y: 20 },
          transform: I,
          fontSize: 16,
          fontName: { family: 'Inter', style: 'Regular', postscript: '' },
          textData: {
            characters: 'Hello world',
            characterStyleIDs: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
            styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold', postscript: '' } }],
          },
        },
      ])
    );
    void html;
    const row = find(roots, 'Mixed')!;
    expect(row.component).toBe('Frame');
    expect(row.styles).toMatchObject({ display: 'flex', alignItems: 'baseline' });
    expect(row.children.map((c) => [c.textValue, c.styles.fontWeight])).toEqual([
      ['Hello ', '400'],
      ['world', '700'],
    ]);
  });
});
