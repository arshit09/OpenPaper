import { inflateSync, unzlibSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { compileSchema, decodeBinarySchema } from 'kiwi-schema';

/**
 * Figma clipboard payloads: `text/html` with a base64 "fig-kiwi" archive between `(figma)` markers
 * and base64 JSON metadata between `(figmeta)` markers. The archive holds a compressed kiwi schema
 * (chunk 0) and a compressed message encoded with it (chunk 1), so it is self-describing.
 */

export interface FigmaGuid {
  sessionID: number;
  localID: number;
}
export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface FigmaMatrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}
export interface FigmaVector {
  x: number;
  y: number;
}
export interface FigmaNumber {
  value: number;
  units?: 'RAW' | 'PIXELS' | 'PERCENT';
}
export interface FigmaPaint {
  type?: string;
  color?: FigmaColor;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  stops?: Array<{ color: FigmaColor; position: number }>;
  transform?: FigmaMatrix;
  image?: { hash?: Uint8Array; name?: string };
  imageScaleMode?: string;
}
export interface FigmaEffect {
  type?: string;
  color?: FigmaColor;
  offset?: FigmaVector;
  radius?: number;
  spread?: number;
  visible?: boolean;
}
export interface FigmaPath {
  windingRule?: 'NONZERO' | 'ODD';
  commandsBlob?: number;
  styleID?: number;
}
export interface FigmaFontMeta {
  key?: { family?: string; style?: string };
  fontWeight?: number;
  fontStyle?: 'NORMAL' | 'ITALIC';
  fontLineHeight?: number;
}
export interface FigmaTextData {
  characters?: string;
  characterStyleIDs?: number[];
  styleOverrideTable?: FigmaNode[];
  fontMetaData?: FigmaFontMeta[];
}

/** A NodeChange (only the fields OpenPaper reads). */
export interface FigmaNode {
  guid?: FigmaGuid;
  guidPath?: { guids?: FigmaGuid[] };
  parentIndex?: { guid: FigmaGuid; position: string };
  type?: string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  size?: FigmaVector;
  transform?: FigmaMatrix;
  mask?: boolean;
  internalOnly?: boolean;
  styleID?: number;
  fillPaints?: FigmaPaint[];
  strokePaints?: FigmaPaint[];
  strokeWeight?: number;
  strokeAlign?: 'CENTER' | 'INSIDE' | 'OUTSIDE';
  dashPattern?: number[];
  borderStrokeWeightsIndependent?: boolean;
  borderTopWeight?: number;
  borderRightWeight?: number;
  borderBottomWeight?: number;
  borderLeftWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadiiIndependent?: boolean;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  effects?: FigmaEffect[];
  frameMaskDisabled?: boolean;
  resizeToFit?: boolean;
  stackMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  stackSpacing?: number;
  stackCounterSpacing?: number;
  stackPadding?: number;
  stackHorizontalPadding?: number;
  stackVerticalPadding?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
  stackPrimaryAlignItems?: string;
  stackCounterAlignItems?: string;
  stackPrimarySizing?: string;
  stackCounterSizing?: string;
  stackChildPrimaryGrow?: number;
  stackChildAlignSelf?: string;
  stackPositioning?: 'AUTO' | 'ABSOLUTE';
  stackWrap?: 'NO_WRAP' | 'WRAP';
  textData?: FigmaTextData;
  fontSize?: number;
  fontName?: { family?: string; style?: string };
  lineHeight?: FigmaNumber;
  letterSpacing?: FigmaNumber;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  textCase?: string;
  textDecoration?: string;
  fillGeometry?: FigmaPath[];
  strokeGeometry?: FigmaPath[];
  count?: number;
  starInnerScale?: number;
  arcData?: { startingAngle?: number; endingAngle?: number; innerRadius?: number };
  symbolData?: { symbolID?: FigmaGuid; symbolOverrides?: FigmaNode[] };
  derivedSymbolData?: FigmaNode[];
}

export interface FigmaMessage {
  nodeChanges?: FigmaNode[];
  blobs?: Array<{ bytes: Uint8Array }>;
  pasteFileKey?: string;
}

export interface FigmaClipboard {
  meta: { fileKey?: string; pasteID?: number; dataType?: string } | null;
  message: FigmaMessage;
}

const FIGMA_BUFFER = /\(figma\)([A-Za-z0-9+/=\s]+)\(\/figma\)/;
const FIGMA_META = /\(figmeta\)([A-Za-z0-9+/=\s]+)\(\/figmeta\)/;

/** Whether pasted HTML came from Figma. */
export function isFigmaClipboard(html: string): boolean {
  return FIGMA_BUFFER.test(html);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decompress(chunk: Uint8Array): Uint8Array {
  if (chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd) return zstdDecompress(chunk);
  if ((chunk[0]! & 0x0f) === 8 && ((chunk[0]! << 8) | chunk[1]!) % 31 === 0) return unzlibSync(chunk);
  return inflateSync(chunk);
}

/** Decode a fig-kiwi archive (clipboard buffer or .fig canvas data) into its message. */
export function decodeFigKiwi(bytes: Uint8Array): FigmaMessage {
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== 'fig-kiwi') throw new Error('Not a Figma clipboard payload.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let off = 12; // magic + uint32 version
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true);
    off += 4;
    chunks.push(bytes.subarray(off, off + len));
    off += len;
  }
  if (chunks.length < 2) throw new Error('The Figma clipboard payload is incomplete.');
  const schema = compileSchema(decodeBinarySchema(decompress(chunks[0]!))) as { decodeMessage(b: Uint8Array): unknown };
  return schema.decodeMessage(decompress(chunks[1]!)) as FigmaMessage;
}

/** Extract and decode Figma data from clipboard HTML. Returns null when the HTML is not from Figma. */
export function readFigmaClipboard(html: string): FigmaClipboard | null {
  const buffer = FIGMA_BUFFER.exec(html)?.[1];
  if (!buffer) return null;
  const metaText = FIGMA_META.exec(html)?.[1];
  let meta: FigmaClipboard['meta'] = null;
  if (metaText) {
    try {
      meta = JSON.parse(utf8(base64ToBytes(metaText)));
    } catch {
      meta = null;
    }
  }
  return { meta, message: decodeFigKiwi(base64ToBytes(buffer)) };
}
