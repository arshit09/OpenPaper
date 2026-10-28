import type { StyleMap } from './css.ts';

/**
 * CSS normalization shared by HTML import, update_styles and create_artboard.
 *
 * Follows Paper's model: typography lives on Text nodes only, values equal to the
 * CSS initial value are dropped, overflow is either `clip` or `visible`, and styles
 * that cannot have an effect in their layout context are stripped ("inert").
 */

/** Typographic properties that cascade from ancestors into Text nodes on import. */
export const INHERITED_TEXT_PROPS = [
  'fontFamily',
  'fontFeatureSettings',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontVariantCaps',
  'fontVariantNumeric',
  'fontVariantLigatures',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'overflowWrap',
  'wordWrap',
  'textAlign',
  'textOverflow',
  'textShadow',
  'textTransform',
  'textWrap',
  'textWrapMode',
  'textWrapStyle',
  'wordBreak',
  'WebkitTextStroke',
  'WebkitTextStrokeColor',
  'WebkitTextStrokeWidth',
  'paintOrder',
  'color',
  'WebkitTextFillColor',
  'fontStretch',
  'hyphens',
  'textIndent',
  'wordSpacing',
] as const;

/** Text-only properties removed from non-Text nodes (they live on Text nodes). */
const TEXT_ONLY_PROPS = new Set<string>([
  'color',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontVariant',
  'fontVariantCaps',
  'fontVariantNumeric',
  'fontVariantLigatures',
  'fontFeatureSettings',
  'fontStretch',
  'letterSpacing',
  'lineHeight',
  'overflowWrap',
  'wordWrap',
  'textOverflow',
  'textShadow',
  'textTransform',
  'textWrap',
  'textWrapMode',
  'textWrapStyle',
  'wordBreak',
  'WebkitTextStroke',
  'WebkitTextStrokeColor',
  'WebkitTextStrokeWidth',
  'WebkitTextFillColor',
  'textDecoration',
  'textDecorationLine',
  'textDecorationColor',
  'textDecorationStyle',
  'textDecorationThickness',
  'textUnderlineOffset',
  'textIndent',
  'wordSpacing',
  'hyphens',
]);

/** Interaction-only properties that never affect a design. (Animations and transitions are kept: see animation/keyframes.ts.) */
const DROPPED_PROPS = new Set<string>([
  'boxSizing',
  'textSizeAdjust',
  'WebkitTextSizeAdjust',
  'MozOsxFontSmoothing',
  'WebkitFontSmoothing',
  'cursor',
  'pointerEvents',
  'userSelect',
  'WebkitUserSelect',
  'touchAction',
  'willChange',
  'caretColor',
  'scrollBehavior',
  'scrollbarWidth',
  'scrollbarColor',
  'scrollbarGutter',
  'scrollPadding',
  'scrollMargin',
  'scrollSnapType',
  'scrollSnapAlign',
  'WebkitTapHighlightColor',
  'WebkitUserDrag',
  'listStyle',
  'listStyleType',
  'listStylePosition',
  'listStyleImage',
  'content',
  'resize',
  'outlineOffset',
  'appRegion',
  'WebkitAppRegion',
]);

/** Values equal to CSS initial values (dropped to keep styles minimal). */
const INITIAL_VALUES: Record<string, string[]> = {
  display: ['block'],
  position: ['static'],
  flexDirection: ['row'],
  flexWrap: ['nowrap'],
  flexGrow: ['0'],
  flexShrink: ['1'],
  flexBasis: ['auto'],
  alignItems: ['stretch', 'normal'],
  alignContent: ['normal'],
  justifyContent: ['normal'],
  justifyItems: ['normal', 'legacy'],
  alignSelf: ['auto'],
  justifySelf: ['auto'],
  width: ['auto'],
  height: ['auto'],
  minWidth: ['auto'],
  minHeight: ['auto'],
  maxWidth: ['none'],
  maxHeight: ['none'],
  margin: ['0', '0px'],
  marginTop: ['0', '0px'],
  marginRight: ['0', '0px'],
  marginBottom: ['0', '0px'],
  marginLeft: ['0', '0px'],
  padding: ['0', '0px'],
  gap: ['0', '0px', 'normal'],
  rowGap: ['0', '0px', 'normal'],
  columnGap: ['0', '0px', 'normal'],
  opacity: ['1'],
  zIndex: ['auto'],
  order: ['0'],
  top: ['auto'],
  right: ['auto'],
  bottom: ['auto'],
  left: ['auto'],
  inset: ['auto'],
  overflowWrap: ['normal'],
  whiteSpace: ['normal'],
  wordBreak: ['normal'],
  verticalAlign: ['baseline'],
  visibility: ['visible'],
  mixBlendMode: ['normal'],
  objectFit: ['fill'],
  aspectRatio: ['auto'],
  borderRadius: ['0', '0px'],
  textTransform: ['none'],
  textIndent: ['0', '0px'],
  letterSpacing: ['normal'],
  lineHeight: ['normal'],
  fontStyle: ['normal'],
  textDecoration: ['none'],
  textDecorationLine: ['none'],
  boxShadow: ['none'],
  textShadow: ['none'],
  filter: ['none'],
  backdropFilter: ['none'],
  transform: ['none'],
  rotate: ['none', '0deg', '0'],
  translate: ['none'],
  scale: ['none'],
  float: ['none'],
  clear: ['none'],
  backgroundImage: ['none'],
  backgroundColor: ['transparent', 'rgba(0, 0, 0, 0)'],
  animation: ['none'],
  animationName: ['none'],
  transition: ['none'],
  outline: ['none'],
  border: ['none', '0', '0px'],
  borderStyle: ['none'],
  tableLayout: ['auto'],
};

const FLEX_PARENT = /^(inline-)?flex$/;
const GRID_PARENT = /^(inline-)?grid$/;

function isFlexLike(display: string | undefined): boolean {
  return !!display && FLEX_PARENT.test(display);
}
function isGridLike(display: string | undefined): boolean {
  return !!display && GRID_PARENT.test(display);
}

export interface NormalizeContext {
  isText: boolean;
  isSvg: boolean;
  /** <img>, top-level <svg> etc. */
  isReplaced?: boolean;
}

/** Normalize one node's styles (in place copy). */
export function normalizeNodeStyles(input: StyleMap, ctx: NormalizeContext): StyleMap {
  const s: StyleMap = {};
  for (const [k, raw] of Object.entries(input)) {
    if (k.startsWith('--')) continue; // custom properties are not stored on nodes
    const v = raw.trim();
    if (!v || DROPPED_PROPS.has(k)) continue;
    s[k] = v;
  }
  if (s.wordWrap && !s.overflowWrap) s.overflowWrap = s.wordWrap;
  delete s.wordWrap;
  if (s.wordBreak === 'break-word') {
    s.wordBreak = 'normal';
    s.overflowWrap = 'anywhere';
  }
  if (s.position === 'sticky') {
    s.position = 'relative';
    delete s.top;
    delete s.right;
    delete s.bottom;
    delete s.left;
    delete s.inset;
  }
  for (const key of ['overflow', 'overflowX', 'overflowY'] as const) {
    const v = s[key];
    if (!v) continue;
    if (/^(hidden|clip|scroll|auto)(\s|$)/.test(v)) s[key] = 'clip';
    else if (/^visible/.test(v)) s[key] = 'visible';
  }
  if (s.overflowX && s.overflowX === s.overflowY) {
    s.overflow = s.overflowX;
    delete s.overflowX;
    delete s.overflowY;
  }
  if (!ctx.isText) {
    for (const prop of TEXT_ONLY_PROPS) {
      if (prop === 'color' && ctx.isSvg) continue; // currentColor inside SVGs
      delete s[prop];
    }
    if (s.display === 'inline') s.display = ctx.isReplaced ? 'inline-block' : 'block';
    if (s.textWrapMode === 'nowrap') {
      s.whiteSpace = 'nowrap';
      delete s.textWrapMode;
    }
  } else {
    if (s.textWrapMode === 'nowrap' && !s.width) {
      s.width = 'max-content';
      delete s.textWrapMode;
    }
    if (s.WebkitTextFillColor && !s.color) s.color = s.WebkitTextFillColor;
    if (s.WebkitTextFillColor === s.color) delete s.WebkitTextFillColor;
  }
  if (s.backgroundClip === 'text' || s.WebkitBackgroundClip === 'text') {
    // Gradient text keeps its background; nothing else to do.
  }
  for (const [k, values] of Object.entries(INITIAL_VALUES)) {
    if (s[k] !== undefined && values.includes(s[k]!)) delete s[k];
  }
  return s;
}

/**
 * Remove styles that have no effect given the parent's display (Paper's "inert"
 * styles). Returns the removed property names.
 */
export function stripInertStyles(styles: StyleMap, parentDisplay: string | undefined, isText: boolean): string[] {
  const removed: string[] = [];
  const drop = (k: string) => {
    if (styles[k] !== undefined) {
      delete styles[k];
      removed.push(k);
    }
  };
  const own = styles.display;
  const absolute = styles.position === 'absolute' || styles.position === 'fixed';
  const parentFlex = isFlexLike(parentDisplay);
  const parentGrid = isGridLike(parentDisplay);
  if (!parentFlex) {
    if (styles.flexShrink === '0') drop('flexShrink');
    drop('flexGrow');
    drop('flexBasis');
    drop('flex');
  }
  if (!parentFlex && !parentGrid) {
    drop('alignSelf');
    drop('order');
    if (styles.minWidth === '0' || styles.minWidth === '0px') drop('minWidth');
    if (styles.minHeight === '0' || styles.minHeight === '0px') drop('minHeight');
    drop('zIndex');
  }
  if (!parentGrid) {
    for (const k of ['gridColumn', 'gridColumnStart', 'gridColumnEnd', 'gridRow', 'gridRowStart', 'gridRowEnd', 'gridArea']) drop(k);
  }
  if (parentFlex || parentDisplay === '*' || absolute) drop('justifySelf');
  if (absolute) drop('alignSelf');
  if (!isFlexLike(own)) {
    drop('flexDirection');
    drop('flexWrap');
  }
  if (!isFlexLike(own) && !isGridLike(own) && !isText) {
    drop('justifyContent');
    drop('alignItems');
  }
  if (styles.position === 'relative' && !['top', 'right', 'bottom', 'left', 'inset'].some((k) => styles[k] !== undefined)) {
    drop('position');
  }
  if (!isFlexLike(own) && !isGridLike(own)) {
    drop('gap');
    drop('rowGap');
    drop('columnGap');
  }
  if ((isFlexLike(own) || isGridLike(own)) && !isText && styles.whiteSpace === 'nowrap') drop('whiteSpace');
  if (
    styles.verticalAlign !== undefined &&
    (!['inline', 'inline-block', 'table-cell'].includes(own ?? '') || parentFlex || parentGrid || absolute || styles.float)
  ) {
    drop('verticalAlign');
  }
  return removed;
}

/** Does a style map draw a visible box (padding, border, background, shadow…)? */
export function hasBoxStyles(s: StyleMap): boolean {
  const nonZero = (v: string | undefined) => !!v && !/^(0|0px|none|transparent)(\s+(0|0px))*$/.test(v.trim());
  if (['padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingBlock', 'paddingInline'].some((k) => nonZero(s[k]))) {
    return true;
  }
  if (s.border && !/^(none|0)/.test(s.border)) return true;
  if (['borderWidth', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'].some((k) => nonZero(s[k]))) return true;
  if (s.outline && !/^(none|0)/.test(s.outline)) return true;
  if (nonZero(s.boxShadow)) return true;
  const clipText = s.backgroundClip === 'text' || s.WebkitBackgroundClip === 'text';
  if (!clipText && (nonZero(s.backgroundColor) || nonZero(s.backgroundImage) || nonZero(s.background))) return true;
  return false;
}
