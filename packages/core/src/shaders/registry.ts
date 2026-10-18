import { SHADER_PRESETS } from './presets.generated.ts';

/**
 * Shader layers: GPU effects rendered by @paper-design/shaders (Apache-2.0). Each effect is its own
 * leaf component type (`ShaderMeshGradient`, …), with its settings in `node.props` keyed by the
 * library's parameter names. This registry describes the editable parameters (ranges, controls,
 * optional groups); defaults and presets come from the library's preset lists.
 */

export const SHADER_COMPONENTS = [
  'ShaderPaperTexture',
  'ShaderFlutedGlass',
  'ShaderWater',
  'ShaderImageDithering',
  'ShaderHalftoneDots',
  'ShaderHalftoneCmyk',
  'ShaderLensDistortion',
  'ShaderHeatmap',
  'ShaderLiquidMetal',
  'ShaderGemSmoke',
  'ShaderMeshGradient',
  'ShaderStaticMeshGradient',
  'ShaderStaticRadialGradient',
  'ShaderDithering',
  'ShaderGrainGradient',
  'ShaderDotOrbit',
  'ShaderDotGrid',
  'ShaderWarp',
  'ShaderSpiral',
  'ShaderSwirl',
  'ShaderWaves',
  'ShaderNeuroNoise',
  'ShaderPerlinNoise',
  'ShaderSimplexNoise',
  'ShaderVoronoi',
  'ShaderPulsingBorder',
  'ShaderMetaBalls',
  'ShaderColorPanels',
  'ShaderSmokeRing',
  'ShaderGodRays',
] as const;

export type ShaderComponent = (typeof SHADER_COMPONENTS)[number];

export type ShaderPropValue = number | string | boolean | string[];
export type ShaderProps = Record<string, ShaderPropValue>;

export type ShaderParam =
  | {
      kind: 'number';
      name: string;
      label: string;
      /** percent: stored 0–1, shown ×100 · degrees · number: plain. */
      format: 'percent' | 'degrees' | 'number';
      min: number;
      max: number;
      step: number;
      snaps?: number[];
      group?: string;
    }
  | { kind: 'enum'; name: string; label: string; options: string[]; control: 'segmented' | 'select'; group?: string }
  | { kind: 'boolean'; name: string; label: string; group?: string }
  | { kind: 'color'; name: string; label: string; group?: string }
  | { kind: 'colors'; name: string; label: string; max: number; group?: string }
  | { kind: 'image'; name: 'image'; label: string; group?: string };

export interface ShaderGroup {
  id: string;
  label: string;
  /** Optional groups can be switched off (their params are then left unset and render as 0). */
  optional: boolean;
  /** Values written when an optional group is switched on. */
  enable?: Record<string, number>;
}

export type ShaderCategory = 'image' | 'logo' | 'effect';

export interface ShaderDef {
  component: ShaderComponent;
  /** Export name in @paper-design/shaders-react (also the JSX tag). */
  name: string;
  label: string;
  /** kebab-case name, e.g. "mesh-gradient". */
  slug: string;
  category: ShaderCategory;
  animated: boolean;
  description: string;
  params: ShaderParam[];
  groups: ShaderGroup[];
}

// ---- parameter builders ------------------------------------------------------

type Opts = { snaps?: number[]; group?: string; step?: number };
const pct = (name: string, label: string, min: number, max: number, o: Opts = {}): ShaderParam => ({
  kind: 'number',
  name,
  label,
  format: 'percent',
  min,
  max,
  step: o.step ?? 0.01,
  ...(o.snaps ? { snaps: o.snaps } : {}),
  ...(o.group ? { group: o.group } : {}),
});
const deg = (name: string, label: string, min: number, max: number, o: Opts = {}): ShaderParam => ({
  kind: 'number',
  name,
  label,
  format: 'degrees',
  min,
  max,
  step: o.step ?? 1,
  ...(o.snaps ? { snaps: o.snaps } : {}),
  ...(o.group ? { group: o.group } : {}),
});
const num = (name: string, label: string, min: number, max: number, step: number, o: Opts = {}): ShaderParam => ({
  kind: 'number',
  name,
  label,
  format: 'number',
  min,
  max,
  step,
  ...(o.group ? { group: o.group } : {}),
});
const seg = (name: string, label: string, options: string[], group?: string): ShaderParam => ({
  kind: 'enum',
  name,
  label,
  options,
  control: 'segmented',
  ...(group ? { group } : {}),
});
const menu = (name: string, label: string, options: string[]): ShaderParam => ({ kind: 'enum', name, label, options, control: 'select' });
const bool = (name: string, label: string): ShaderParam => ({ kind: 'boolean', name, label });
const color = (name: string, label: string, group?: string): ShaderParam => ({ kind: 'color', name, label, ...(group ? { group } : {}) });
const colors = (max: number, label = 'Colors'): ShaderParam => ({ kind: 'colors', name: 'colors', label, max });
const image = (label = 'Image'): ShaderParam => ({ kind: 'image', name: 'image', label });

const speed = (max: number, step = 0.01) => pct('speed', 'Speed', 0, max, { snaps: [1], step });
const scale = (min: number, max: number) => pct('scale', 'Scale', min, max, { snaps: [1] });
const rotation = () => deg('rotation', 'Rotation', -360, 360, { snaps: [0] });
const angle = (min = -360, max = 360) => deg('angle', 'Angle', min, max, min < 0 ? { snaps: [0] } : {});
const offsets = () => [pct('offsetX', 'Offset X', -1, 1, { snaps: [0] }), pct('offsetY', 'Offset Y', -1, 1, { snaps: [0] })];
const fit = (label = 'Fit') => seg('fit', label, ['contain', 'cover']);
const grain = (withSize = false) => [
  pct('grainMixer', 'Mixing', 0, 1, { group: 'grain' }),
  pct('grainOverlay', 'Overlay', 0, 1, { group: 'grain' }),
  ...(withSize ? [pct('grainSize', 'Size', 0, 1, { group: 'grain' })] : []),
];
const GRAIN: ShaderGroup = { id: 'grain', label: 'Grain', optional: true, enable: { grainMixer: 0.1, grainOverlay: 0.1 } };
const MARGIN_SNAPS = [0.1, 0.3, 0.5, 0.7, 0.9];
const margins = (group: string) =>
  (['Left', 'Right', 'Top', 'Bottom'] as const).map((side) => pct(`margin${side}`, side, 0, 1, { snaps: MARGIN_SNAPS, group }));
const SHAPES = ['none', 'circle', 'daisy', 'diamond', 'metaballs'];
const DITHER_TYPES = ['random', '2x2', '4x4', '8x8'];

function def(
  component: ShaderComponent,
  name: string,
  label: string,
  category: ShaderCategory,
  animated: boolean,
  description: string,
  params: ShaderParam[],
  groups: ShaderGroup[] = []
): ShaderDef {
  const slug = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return { component, name, label, slug, category, animated, description, params, groups };
}

export const SHADERS: readonly ShaderDef[] = [
  // ---- image filters ----
  def('ShaderPaperTexture', 'PaperTexture', 'Paper Texture', 'image', false, 'A paper or card surface with grain, fibres, folds, wrinkles and crumples; an image is printed onto the sheet and bends with it.', [
    image(),
    fit(),
    bool('clip', 'Clip to image'),
    pct('scale', 'Scale', 0.3, 3, { snaps: [1] }),
    num('seed', 'Seed', 0, 1000, 1),
    deg('angle', 'Angle', 0, 360),
    pct('distortion', 'Distortion', -1, 1, { snaps: [0] }),
    pct('roughness', 'Roughness', 0, 1),
    pct('roughnessSize', 'Roughness size', 0, 1),
    pct('roughnessRows', 'Roughness rows', 0, 1),
    pct('fiber', 'Fiber', 0, 1),
    pct('fiberSize', 'Fiber size', 0, 1),
    pct('drops', 'Drops', 0, 1),
    pct('blending', 'Blending', 0, 1),
    pct('folds', 'Strength', 0, 1, { group: 'folds' }),
    pct('foldSizeX', 'Size X', 0, 1, { snaps: [0.5], group: 'folds' }),
    pct('foldSizeY', 'Size Y', 0, 1, { snaps: [0.5], group: 'folds' }),
    pct('foldOffsetX', 'Offset X', 0, 1, { snaps: [0.5], group: 'folds' }),
    pct('foldOffsetY', 'Offset Y', 0, 1, { snaps: [0.5], group: 'folds' }),
    pct('wrinkles', 'Strength', 0, 1, { group: 'wrinkles' }),
    pct('wrinkleSize', 'Size', 0, 1, { group: 'wrinkles' }),
    pct('crumples', 'Strength', 0, 1, { group: 'crumples' }),
    num('crumpleCount', 'Count', 2, 15, 1, { group: 'crumples' }),
    color('colorPaper', 'Paper', 'colors'),
    color('colorShadow', 'Shadow', 'colors'),
  ], [
    { id: 'folds', label: 'Folds', optional: true, enable: { folds: 0.4 } },
    { id: 'wrinkles', label: 'Wrinkles', optional: true, enable: { wrinkles: 0.4 } },
    { id: 'crumples', label: 'Crumples', optional: true, enable: { crumples: 0.4, crumpleCount: 6 } },
    { id: 'colors', label: 'Colors', optional: false },
  ]),
  def('ShaderFlutedGlass', 'FlutedGlass', 'Fluted Glass', 'image', false, 'Ribbed glass: the image is sliced into stripes that each refract it, with optional highlights and shadows on the ribs.', [
    image(),
    menu('shape', 'Shape', ['lines', 'linesIrregular', 'wave', 'zigzag', 'pattern']),
    menu('distortionShape', 'Distortion shape', ['prism', 'lens', 'contour', 'cascade', 'flat']),
    fit(),
    pct('size', 'Size', 0.01, 1),
    pct('highlights', 'Highlights', 0, 1),
    pct('shadows', 'Shadows', 0, 1),
    angle(),
    pct('distortion', 'Distortion', 0, 1),
    pct('shift', 'Shift', -1, 1, { snaps: [0] }),
    pct('stretch', 'Stretch', 0, 1),
    pct('blur', 'Blur', 0, 1),
    pct('edges', 'Edges', 0, 1),
    scale(0.1, 3),
    ...grain(),
    ...margins('margin'),
    color('colorHighlight', 'Highlight', 'colors'),
    color('colorShadow', 'Shadow', 'colors'),
  ], [GRAIN, { id: 'margin', label: 'Margin', optional: true, enable: { marginLeft: 0.1, marginRight: 0.1, marginTop: 0.1, marginBottom: 0.1 } }, { id: 'colors', label: 'Colors', optional: false }]),
  def('ShaderWater', 'Water', 'Water', 'image', true, 'Water caustics: the image wobbles under moving ripples of refracted light.', [
    image(),
    fit('Image fit'),
    speed(2),
    pct('size', 'Size', 0.01, 7, { snaps: [1] }),
    scale(0.1, 3),
    pct('highlights', 'Highlights', 0, 1),
    pct('layering', 'Layering', 0, 1),
    pct('edges', 'Edges', 0, 1),
    pct('waves', 'Waves', 0, 1),
    pct('caustic', 'Caustic', 0, 1),
    color('colorHighlight', 'Highlight'),
  ]),
  def('ShaderImageDithering', 'ImageDithering', 'Image Dithering', 'image', false, 'Turns an image into a retro pixel dither (random or Bayer patterns) with a small palette or its own quantised colours.', [
    image(),
    seg('type', 'Type', DITHER_TYPES),
    fit(),
    bool('originalColors', 'Original colors'),
    bool('inverted', 'Inverted'),
    scale(0.1, 3),
    num('size', 'Dither size', 0.1, 120, 0.1),
    num('colorSteps', 'Color steps', 1, 7, 1),
    color('colorFront', 'Front', 'colors'),
    color('colorHighlight', 'Highlight', 'colors'),
  ], [{ id: 'colors', label: 'Foreground', optional: false }]),
  def('ShaderHalftoneDots', 'HalftoneDots', 'Halftone Dots', 'image', false, 'A halftone screen of the image on a square or hex grid, from classic dots to gooey, merging blobs.', [
    image(),
    seg('type', 'Type', ['classic', 'gooey', 'holes', 'soft']),
    fit(),
    bool('originalColors', 'Original colors'),
    bool('inverted', 'Inverted'),
    seg('grid', 'Grid', ['hex', 'square']),
    pct('size', 'Size', 0.01, 1),
    pct('radius', 'Radius', 0, 2, { snaps: [1] }),
    pct('contrast', 'Contrast', 0, 1),
    scale(0.1, 4),
    ...grain(true),
    color('colorFront', 'Foreground'),
  ], [GRAIN]),
  def('ShaderHalftoneCmyk', 'HalftoneCmyk', 'Halftone CMYK', 'image', false, 'Four-colour print: the image separated into cyan, magenta, yellow and black dot screens on paper.', [
    image(),
    seg('type', 'Type', ['dots', 'ink', 'sharp']),
    fit(),
    pct('size', 'Size', 0.01, 1),
    pct('gridNoise', 'Grid noise', 0.01, 1),
    pct('softness', 'Softness', 0, 1),
    pct('contrast', 'Contrast', 0, 2, { snaps: [1] }),
    scale(0.1, 4),
    color('colorC', 'Cyan', 'inks'),
    color('colorM', 'Magenta', 'inks'),
    color('colorY', 'Yellow', 'inks'),
    color('colorK', 'Black', 'inks'),
    pct('gainC', 'Cyan', -1, 1, { snaps: [0], group: 'gain' }),
    pct('gainM', 'Magenta', -1, 1, { snaps: [0], group: 'gain' }),
    pct('gainY', 'Yellow', -1, 1, { snaps: [0], group: 'gain' }),
    pct('gainK', 'Black', -1, 1, { snaps: [0], group: 'gain' }),
    pct('floodC', 'Cyan', 0, 1, { group: 'flood' }),
    pct('floodM', 'Magenta', 0, 1, { group: 'flood' }),
    pct('floodY', 'Yellow', 0, 1, { group: 'flood' }),
    pct('floodK', 'Black', 0, 1, { group: 'flood' }),
    ...grain(true),
  ], [
    { id: 'inks', label: 'Inks', optional: false },
    { id: 'gain', label: 'Gain', optional: false },
    { id: 'flood', label: 'Flood', optional: false },
    GRAIN,
  ]),
  def('ShaderLensDistortion', 'LensDistortion', 'Lens Distortion', 'image', false, 'Chromatic aberration and lens bulge: the image splits into shifted colour layers, optionally swirled or noisy.', [
    image(),
    fit(),
    pct('spread', 'Spread', 0, 1),
    pct('bias', 'Bias', -1, 1, { snaps: [0] }),
    deg('angle', 'Angle', 0, 360),
    pct('perspective', 'Perspective', 0, 1),
    num('count', 'Count', 2, 50, 1),
    pct('dispersion', 'Dispersion', 0, 1),
    pct('dispersionShift', 'Dispersion shift', -1, 1, { snaps: [0] }),
    pct('dispersionColor', 'Dispersion color', 0, 1),
    pct('focusCenter', 'Focus center', 0, 1),
    pct('focusEdges', 'Focus edges', 0, 1),
    pct('swirl', 'Swirl', -1, 1, { snaps: [0] }),
    pct('noise', 'Noise', 0, 1),
    pct('noiseFrequency', 'Noise frequency', 0, 1),
    pct('noiseOffset', 'Noise offset', 0, 1),
    pct('lensBulge', 'Lens bulge', -1, 1, { snaps: [0] }),
    pct('lensCircle', 'Lens circle', 0, 1),
    scale(0.1, 3),
    pct('imageX', 'Position X', -1, 1, { snaps: [0] }),
    pct('imageY', 'Position Y', -1, 1, { snaps: [0] }),
    ...grain(),
  ], [GRAIN]),

  // ---- logo animations ----
  def('ShaderHeatmap', 'Heatmap', 'Heatmap', 'logo', true, 'A thermal-camera glow sweeping through and around a logo silhouette.', [
    image('Shape'),
    angle(),
    pct('noise', 'Noise', 0, 1),
    pct('innerGlow', 'Inner glow', 0, 1),
    pct('outerGlow', 'Outer glow', 0, 1),
    pct('contour', 'Contour', 0, 1, { step: 0.001 }),
    speed(5),
    scale(0.1, 2),
    colors(10, 'Foreground'),
  ]),
  def('ShaderLiquidMetal', 'LiquidMetal', 'Liquid Metal', 'logo', true, 'Liquid chrome: reflective stripes flowing along the edges of a logo or a built-in shape.', [
    image('Shape'),
    menu('shape', 'Shape', SHAPES),
    pct('repetition', 'Repetition', 1, 10),
    pct('contour', 'Contour', 0, 1),
    pct('distortion', 'Distortion', 0, 1),
    pct('softness', 'Softness', 0, 1),
    angle(),
    pct('shiftRed', 'Redshift', -1, 1, { snaps: [0] }),
    pct('shiftBlue', 'Blueshift', -1, 1, { snaps: [0] }),
    speed(3),
    scale(0, 4),
    color('colorTint', 'Tint'),
  ]),
  def('ShaderGemSmoke', 'GemSmoke', 'Gem Smoke', 'logo', true, 'Coloured smoke swirling inside and around a glassy logo or shape.', [
    image('Shape'),
    menu('shape', 'Shape', SHAPES),
    pct('size', 'Size', 0, 1),
    pct('outerDistortion', 'Outer distortion', 0, 1),
    pct('innerDistortion', 'Inner distortion', 0, 1),
    pct('outerGlow', 'Outer glow', 0, 1),
    pct('innerGlow', 'Inner glow', 0, 1),
    pct('offset', 'Offset', -1, 1, { snaps: [0] }),
    angle(),
    speed(3),
    scale(0, 4),
    colors(5),
    color('colorInner', 'Inner'),
  ]),

  // ---- effects ----
  def('ShaderMeshGradient', 'MeshGradient', 'Mesh Gradient', 'effect', true, 'Soft colour blobs drifting and blending into each other, with organic distortion and swirl.', [
    speed(2),
    scale(0.1, 5),
    pct('distortion', 'Distortion', 0, 1),
    pct('swirl', 'Swirl', 0, 1),
    ...grain(),
    colors(10, 'Foreground'),
  ], [GRAIN]),
  def('ShaderStaticMeshGradient', 'StaticMeshGradient', 'Static Mesh Gradient', 'effect', false, 'A still mesh gradient from seeded colour points, warped by horizontal and vertical waves.', [
    num('positions', 'Positions', 0, 100, 0.1),
    pct('waveX', 'Horizontal wave', 0, 1),
    pct('waveXShift', 'Horizontal wave shift', 0, 1),
    pct('waveY', 'Vertical wave', 0, 1),
    pct('waveYShift', 'Vertical wave shift', 0, 1),
    pct('mixing', 'Mixing', 0, 1),
    pct('scale', 'Scale', 0.01, 10, { snaps: [1] }),
    rotation(),
    ...grain(),
    colors(10, 'Foreground'),
  ], [GRAIN]),
  def('ShaderStaticRadialGradient', 'StaticRadialGradient', 'Static Radial Gradient', 'effect', false, 'A radial gradient with a movable focal point, falloff, optional ripples and grain.', [
    pct('radius', 'Radius', 0, 3, { snaps: [1] }),
    pct('focalDistance', 'Focal distance', 0, 3, { snaps: [1] }),
    deg('focalAngle', 'Focal angle', -360, 360, { snaps: [0] }),
    pct('falloff', 'Falloff', -1, 1, { snaps: [0] }),
    pct('mixing', 'Mixing', 0, 1),
    pct('scale', 'Scale', 0.01, 10, { snaps: [1] }),
    ...offsets(),
    pct('distortion', 'Strength', 0, 1, { group: 'distortion' }),
    pct('distortionShift', 'Shift', -1, 1, { snaps: [0], group: 'distortion' }),
    num('distortionFreq', 'Frequency', 0, 40, 1, { group: 'distortion' }),
    ...grain(),
    colors(10, 'Foreground'),
  ], [{ id: 'distortion', label: 'Distortion', optional: true, enable: { distortion: 0.5 } }, GRAIN]),
  def('ShaderDithering', 'Dithering', 'Dithering', 'effect', true, 'Two-colour pixel dithering of an animated shape (sphere, waves, ripples, swirl…).', [
    seg('type', 'Type', DITHER_TYPES),
    menu('shape', 'Shape', ['simplex', 'warp', 'dots', 'wave', 'ripple', 'swirl', 'sphere']),
    speed(2),
    scale(0, 4),
    num('size', 'Dither size', 0.1, 120, 0.1),
    color('colorFront', 'Foreground'),
  ]),
  def('ShaderGrainGradient', 'GrainGradient', 'Grain Gradient', 'effect', true, 'A grainy, noise-textured multi-colour gradient in several animated shapes.', [
    menu('shape', 'Shape', ['blob', 'corners', 'dots', 'ripple', 'sphere', 'truchet', 'wave']),
    speed(2),
    pct('softness', 'Softness', 0, 1),
    pct('intensity', 'Intensity', 0, 1),
    pct('noise', 'Noise', 0, 1),
    scale(0, 4),
    rotation(),
    ...offsets(),
    colors(7, 'Foreground'),
  ]),
  def('ShaderDotOrbit', 'DotOrbit', 'Dot Orbit', 'effect', true, 'A grid of dots, each circling its cell while cycling through the palette.', [
    speed(2),
    scale(0.1, 2),
    pct('size', 'Size', 0, 1),
    pct('sizeRange', 'Size range', 0, 1),
    pct('spreading', 'Spreading', 0, 1),
    num('stepsPerColor', 'Steps per color', 1, 4, 1),
    colors(10, 'Foreground'),
  ]),
  def('ShaderDotGrid', 'DotGrid', 'Dot Grid', 'effect', false, 'A regular grid of circles, diamonds, squares or triangles with optional stroke and random variation.', [
    seg('shape', 'Shape', ['circle', 'diamond', 'square', 'triangle']),
    num('size', 'Size', 0, 100, 0.1),
    num('gapX', 'Gap X', 0, 1000, 1),
    num('gapY', 'Gap Y', 0, 1000, 1),
    num('strokeWidth', 'Stroke width', 0, 100, 0.1),
    pct('sizeRange', 'Size range', 0, 1),
    pct('opacityRange', 'Opacity range', 0, 1),
    color('colorFill', 'Foreground'),
    color('colorStroke', 'Stroke'),
  ]),
  def('ShaderWarp', 'Warp', 'Warp', 'effect', true, 'Colour fields over checks or stripes, warped by noise and swirls into marbled, fluid forms.', [
    seg('shape', 'Shape', ['checks', 'stripes', 'edge']),
    speed(10, 0.1),
    scale(0, 5),
    pct('softness', 'Softness', 0, 1),
    pct('proportion', 'Proportion', 0, 1),
    pct('swirl', 'Swirl', 0, 2, { snaps: [1] }),
    num('swirlIterations', 'Swirl iterations', 1, 20, 1),
    pct('distortion', 'Distortion', 0, 2, { snaps: [1] }),
    pct('shapeScale', 'Shape scale', 0, 2, { snaps: [1] }),
    colors(10, 'Foreground'),
  ]),
  def('ShaderSpiral', 'Spiral', 'Spiral', 'effect', true, 'A single-colour spiral, from crisp lines to whirlpools and wavy rings.', [
    speed(5),
    scale(0, 4),
    rotation(),
    pct('softness', 'Softness', 0, 1),
    pct('density', 'Density', 0, 1),
    pct('distortion', 'Distortion', 0, 1),
    pct('strokeWidth', 'Stroke width', 0, 1),
    pct('strokeTaper', 'Stroke taper', 0, 1),
    pct('strokeCap', 'Stroke cap', 0, 1),
    pct('noiseFrequency', 'Noise frequency', 0, 2, { snaps: [1] }),
    pct('noise', 'Noise power', 0, 1),
    ...offsets(),
    color('colorFront', 'Foreground'),
  ]),
  def('ShaderSwirl', 'Swirl', 'Swirl', 'effect', true, 'Bands of colour twisting around a centre into spirals and arcs.', [
    speed(5),
    scale(0, 4),
    pct('softness', 'Softness', 0, 1),
    num('bandCount', 'Band count', 0, 15, 1),
    pct('twist', 'Twist', 0, 1),
    pct('proportion', 'Proportion', 0, 1),
    pct('center', 'Center', 0, 1),
    pct('noiseFrequency', 'Noise frequency', 0, 2, { snaps: [1] }),
    pct('noise', 'Noise power', 0, 1),
    ...offsets(),
    colors(10, 'Foreground'),
  ]),
  def('ShaderWaves', 'Waves', 'Waves', 'effect', false, 'Repeating lines, from sharp zigzags through sine waves to irregular waves.', [
    pct('scale', 'Scale', 0.01, 10, { snaps: [1] }),
    rotation(),
    pct('frequency', 'Frequency', 0, 2, { snaps: [1] }),
    pct('amplitude', 'Amplitude', 0, 10, { snaps: [1] }),
    pct('spacing', 'Spacing', 0, 10, { snaps: [1] }),
    pct('proportion', 'Proportion', 0, 1),
    pct('softness', 'Softness', 0, 1),
    pct('shape', 'Shape', 0, 3, { snaps: [1] }),
    color('colorFront', 'Foreground'),
  ]),
  def('ShaderNeuroNoise', 'NeuroNoise', 'Neuro Noise', 'effect', true, 'A glowing web of fluid lines with bright crossings.', [
    speed(10),
    scale(0, 2),
    pct('brightness', 'Brightness', 0, 1),
    pct('contrast', 'Contrast', 0, 1),
    color('colorFront', 'Foreground'),
    color('colorMid', 'Tint'),
  ]),
  def('ShaderPerlinNoise', 'PerlinNoise', 'Perlin Noise', 'effect', true, 'Animated 3D Perlin noise with octave controls, thresholded into two colours.', [
    speed(3),
    scale(0, 10),
    pct('proportion', 'Proportion', 0, 1),
    pct('softness', 'Softness', 0, 1),
    num('octaveCount', 'Octaves', 1, 8, 1),
    num('lacunarity', 'Lacunarity', 1.5, 10, 0.1),
    pct('persistence', 'Persistence', 0, 1),
    color('colorFront', 'Foreground'),
  ]),
  def('ShaderSimplexNoise', 'SimplexNoise', 'Simplex Noise', 'effect', true, 'A multi-colour gradient mapped onto smooth, slowly morphing noise curves.', [
    speed(10, 0.1),
    pct('scale', 'Scale', 0, 10, { snaps: [1], step: 0.1 }),
    num('stepsPerColor', 'Steps per color', 1, 10, 1),
    pct('softness', 'Softness', 0, 1),
    colors(10, 'Foreground'),
  ]),
  def('ShaderVoronoi', 'Voronoi', 'Voronoi', 'effect', true, 'Animated Voronoi cells with gap lines and an inner glow.', [
    speed(2, 0.1),
    scale(0.1, 5),
    num('stepsPerColor', 'Steps per color', 1, 5, 1),
    pct('glow', 'Inner glow', 0, 1),
    pct('gap', 'Gap', 0, 0.1, { step: 0.001 }),
    pct('distortion', 'Distortion', 0, 0.5),
    colors(5, 'Foreground'),
    color('colorGlow', 'Glow'),
    color('colorGap', 'Gap'),
  ]),
  def('ShaderPulsingBorder', 'PulsingBorder', 'Pulsing Border', 'effect', true, 'Luminous colour trails racing around a glowing rounded border, with pulse and smoke.', [
    seg('aspectRatio', 'Aspect ratio', ['auto', 'square']),
    speed(2),
    pct('scale', 'Scale', 0, 1.5, { snaps: [1] }),
    pct('roundness', 'Roundness', 0, 1),
    pct('softness', 'Softness', 0, 1),
    rotation(),
    pct('thickness', 'Thickness', 0, 1),
    pct('intensity', 'Intensity', 0, 1),
    pct('bloom', 'Bloom', 0, 1),
    num('spots', 'Spot count', 1, 4, 1),
    pct('spotSize', 'Spot size', 0, 1),
    pct('pulse', 'Pulse', 0, 1),
    pct('smoke', 'Smoke', 0, 1),
    pct('smokeSize', 'Smoke size', 0, 1),
    ...margins('margins'),
    colors(5, 'Foreground'),
  ], [{ id: 'margins', label: 'Margins', optional: true, enable: { marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0 } }]),
  def('ShaderMetaBalls', 'Metaballs', 'Metaballs', 'effect', true, 'Gooey coloured balls orbiting the centre and merging into each other.', [
    speed(2),
    scale(0, 4),
    pct('size', 'Size', 0.01, 1.25, { snaps: [1] }),
    num('count', 'Count', 1, 20, 1),
    colors(8, 'Foreground'),
  ]),
  def('ShaderColorPanels', 'ColorPanels', 'Color Panels', 'effect', true, 'Translucent panels rotating around a central axis in pseudo-3D.', [
    speed(4),
    scale(0, 4),
    pct('density', 'Density', 0, 7, { snaps: [1] }),
    pct('angle1', 'Skew left', -1, 1, { snaps: [0] }),
    pct('angle2', 'Skew right', -1, 1, { snaps: [0] }),
    pct('length', 'Length', 0, 3, { snaps: [1] }),
    bool('edges', 'Edges'),
    pct('blur', 'Blur', 0, 0.5),
    pct('fadeIn', 'Fade in', 0, 1),
    pct('fadeOut', 'Fade out', 0, 1),
    pct('gradient', 'Gradient', 0, 1),
    rotation(),
    ...offsets(),
    colors(7, 'Foreground'),
  ]),
  def('ShaderSmokeRing', 'SmokeRing', 'Smoke Ring', 'effect', true, 'A smoky, multi-colour halo shaped by layered noise.', [
    speed(3),
    scale(0, 2),
    pct('thickness', 'Thickness', 0, 1),
    pct('radius', 'Radius', 0, 1),
    pct('innerShape', 'Inner shape', 0, 2, { snaps: [1] }),
    pct('noiseScale', 'Noise scale', 0, 5, { snaps: [1] }),
    num('noiseIterations', 'Noise iterations', 1, 8, 1),
    ...offsets(),
    colors(10, 'Foreground'),
  ]),
  def('ShaderGodRays', 'GodRays', 'God Rays', 'effect', true, 'Light rays streaming out from a glowing centre, with bloom.', [
    speed(4),
    scale(0, 4),
    pct('intensity', 'Intensity', 0, 1),
    pct('density', 'Density', 0, 1),
    pct('spotty', 'Spotty', 0, 1),
    pct('midSize', 'Mid size', 0, 10),
    pct('midIntensity', 'Mid intensity', 0, 1),
    pct('bloom', 'Bloom', 0, 1),
    ...offsets(),
    colors(5, 'Foreground'),
    color('colorBloom', 'Bloom'),
  ]),
];

const BY_COMPONENT = new Map<string, ShaderDef>(SHADERS.map((s) => [s.component, s]));
const BY_ALIAS = new Map<string, ShaderDef>();
for (const s of SHADERS) {
  for (const alias of [s.component, s.name, s.slug, s.label, s.component.slice('Shader'.length)]) {
    BY_ALIAS.set(alias.toLowerCase().replace(/[\s_-]/g, ''), s);
  }
}

export function isShaderComponent(component: string | undefined): component is ShaderComponent {
  return !!component && BY_COMPONENT.has(component);
}

export function shaderDef(component: string): ShaderDef | undefined {
  return BY_COMPONENT.get(component);
}

/** Find a shader by component id, library name, slug or label ("mesh-gradient", "MeshGradient", …). */
export function findShader(name: string): ShaderDef | undefined {
  return BY_ALIAS.get(name.toLowerCase().replace(/[\s_-]/g, ''));
}

export function shaderPresets(s: ShaderDef) {
  return SHADER_PRESETS[s.name] ?? [];
}

/** Whether the effect has a background-colour uniform (drawn transparent; the layer's fill shows instead). */
export function shaderHasColorBack(s: ShaderDef): boolean {
  return shaderPresets(s).some((p) => 'colorBack' in p.params);
}
