import { toKebabCase } from '@openpaper/core';

/**
 * The design's own motion on the canvas: CSS animations of layers (and of parts inside SVG layers).
 * Video, Lottie, embed and shader layers follow the pause state themselves (their components read
 * it from the store); the editor's own effects (live build, overlays) are Web Animations and are
 * never touched here.
 */

const TIMING = new Set(['offset', 'computedOffset', 'easing', 'composite']);

/** CSS animations (not the editor's script animations) of an element, or of everything inside it. */
export function cssAnimationsOf(root: Element, subtree = false): CSSAnimation[] {
  if (!root.getAnimations) return [];
  return root.getAnimations({ subtree }).filter((a): a is CSSAnimation => typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation);
}

/** Start a layer's CSS animations (and SVG animations inside it) over: it just appeared. */
export function restartAnimations(el: Element): void {
  for (const a of cssAnimationsOf(el, true)) {
    try {
      // A finished animation plays again from 0; one the design pauses (`animation-play-state`) stays paused.
      a.currentTime = 0;
    } catch {
      // an animation the browser can't restart keeps playing as it is
    }
  }
  const svgs = el instanceof SVGSVGElement ? [el] : Array.from(el.querySelectorAll('svg'));
  for (const svg of svgs) {
    try {
      svg.setCurrentTime(0);
    } catch {
      // not animated
    }
  }
}

/** Properties that can move or resize a box (the ones a measurement must see at rest). */
const GEOMETRY =
  /^(transform|translate|rotate|scale|zoom|perspective|offset|width|height|min-|max-|inset|top|right|bottom|left|margin|padding|border$|border-(top|right|bottom|left)$|border(-\w+)?-width|font-size|line-height|letter-spacing|word-spacing|gap|row-gap|column-gap|flex|grid|aspect-ratio|display|position)/;

/** An element's style attribute as it was before any hold, and as the holds left it. */
interface Held {
  el: HTMLElement | SVGElement;
  before: string | null;
  after: string | null;
  /** Properties set `!important`, for undoing them one by one if the layer re-rendered meanwhile. */
  props: Array<{ prop: string; value: string; priority: string }>;
}

/**
 * Run `fn` with every CSS animation in `world` showing its layer's own geometry, without stopping
 * or restarting anything: each animated property that can move a box gets the layer's own value as
 * `!important` (which wins over animations), and the style attribute is put back afterwards.
 */
export function atRest<T>(world: Element, fn: () => T): T {
  const held = hold(world, cssAnimationsOf(world, true), true);
  try {
    return fn();
  } finally {
    release(held);
  }
}

/**
 * Hold the design still for a capture: animations that end jump to their end (as they would in a
 * moment), loops show the layer's own styles until the returned release is called.
 */
export function settleForCapture(world: Element): () => void {
  const loops: CSSAnimation[] = [];
  for (const a of cssAnimationsOf(world, true)) {
    const end = Number(a.effect?.getComputedTiming().endTime ?? Infinity);
    if (!Number.isFinite(end)) loops.push(a);
    else if (a.playState === 'running') {
      try {
        a.finish();
      } catch {
        loops.push(a);
      }
    }
  }
  const held = hold(world, loops, false);
  return () => release(held);
}

function hold(world: Element, animations: CSSAnimation[], geometryOnly: boolean): Held[] {
  const byElement = new Map<Element, Held>();
  for (const a of animations) {
    const effect = a.effect as KeyframeEffect | null;
    const el = effect?.target as HTMLElement | SVGElement | null;
    if (!effect || !el?.style || !world.contains(el)) continue;
    let held = byElement.get(el);
    if (!held) byElement.set(el, (held = { el, before: el.getAttribute('style'), after: null, props: [] }));
    for (const frame of effect.getKeyframes()) {
      for (const key of Object.keys(frame)) {
        if (TIMING.has(key)) continue;
        const prop = key === 'cssFloat' ? 'float' : key.startsWith('--') ? key : toKebabCase(key);
        if (held.props.some((p) => p.prop === prop) || (geometryOnly && !GEOMETRY.test(prop))) continue;
        const value = el.style.getPropertyValue(prop);
        // No value of its own: an HTML layer's is the initial or inherited one. Not so for a part of
        // a `var()` shorthand (declared, but pending until computed) or an SVG part's presentation
        // attribute: those are left to the animation rather than replaced.
        if (!value && (!(el instanceof HTMLElement) || Array.prototype.includes.call(el.style, prop))) continue;
        held.props.push({ prop, value, priority: el.style.getPropertyPriority(prop) });
        el.style.setProperty(prop, value || 'unset', 'important');
      }
    }
    held.after = el.getAttribute('style');
  }
  return [...byElement.values()];
}

function release(held: Held[]): void {
  for (const h of held) {
    if (h.el.getAttribute('style') === h.after) {
      // Untouched since: the attribute goes back exactly as it was (a shorthand with var() included).
      if (h.before === null) h.el.removeAttribute('style');
      else h.el.setAttribute('style', h.before);
      continue;
    }
    // The layer re-rendered meanwhile: undo only the holds still in place.
    for (const p of h.props) {
      if (h.el.style.getPropertyPriority(p.prop) !== 'important') continue;
      if (p.value) h.el.style.setProperty(p.prop, p.value, p.priority);
      else h.el.style.removeProperty(p.prop);
    }
  }
}
