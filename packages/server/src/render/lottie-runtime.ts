/**
 * Browser script for static renders (headless screenshots, exports): draws every Lottie layer
 * (`[data-op-lottie]`) with lottie-web's SVG player (the light build: no expressions, no eval), then
 * sets `window.__opLottieReady`. A layer shows its settled look: the last frame when it plays once,
 * the middle of its loop otherwise; `__opSeekLottie(ms)` shows the moment `ms` into the animation.
 * Bundled to an IIFE and served at LOTTIE_RUNTIME_PATH.
 */
import lottie from 'lottie-web/build/player/lottie_light';
import type { AnimationItem } from 'lottie-web';

interface LottieWindow {
  __opLottieReady?: boolean;
  __opLottieErrors?: string[];
  __opSeekLottie?: (ms: number | null) => void;
}
const w = window as unknown as LottieWindow;
const errors: string[] = (w.__opLottieErrors = []);
const TIMEOUT_MS = 10_000;

const players: Array<{ anim: AnimationItem; loop: boolean }> = [];

function show(anim: AnimationItem, loop: boolean, ms: number | null) {
  const frames = Math.max(0, anim.totalFrames - 1);
  if (ms === null) {
    anim.goToAndStop(loop ? Math.floor(frames / 2) : frames, true);
    return;
  }
  const rate = anim.frameRate || 30;
  const frame = (ms / 1000) * rate;
  anim.goToAndStop(loop ? frame % (frames || 1) : Math.min(frame, frames), true);
}

async function mount(host: HTMLElement) {
  const src = host.dataset.opLottie ?? '';
  const loop = host.dataset.opLottieLoop !== 'false';
  const data: unknown = await fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${src}`))));
  await new Promise<void>((resolve) => {
    const anim = lottie.loadAnimation({
      container: host,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      animationData: data,
      rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
    });
    anim.addEventListener('DOMLoaded', () => {
      players.push({ anim, loop });
      show(anim, loop, null);
      resolve();
    });
    anim.addEventListener('data_failed', () => resolve());
  });
}

w.__opSeekLottie = (ms) => {
  for (const p of players) show(p.anim, p.loop, ms);
};

const hosts = Array.from(document.querySelectorAll<HTMLElement>('[data-op-lottie]'));
const all = Promise.all(hosts.map((h) => mount(h).catch((error: unknown) => void errors.push(String(error)))));
void Promise.race([all, new Promise((r) => setTimeout(r, TIMEOUT_MS))]).finally(() => {
  w.__opLottieReady = true;
});
