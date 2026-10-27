import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'puppeteer-core';
import { findBrowserExecutable } from './browser-path.ts';

const IDLE_CLOSE_MS = 5 * 60 * 1000;
const NAV_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 10_000;
const SHADER_TIMEOUT_MS = 12_000;

export interface RenderViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

/**
 * Headless Chromium used for pixel-exact screenshots, exports (PNG/JPEG/WebP/PDF),
 * computed styles and layout measurement. Pages are served by the OpenPaper server
 * itself (`/__render/<token>`) so media and local assets load same-origin.
 */
export class HeadlessRenderer {
  private browser: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly documents = new Map<string, string>();
  private active = 0;
  readonly executablePath: string | null;

  constructor(private readonly baseUrl: () => string) {
    this.executablePath = findBrowserExecutable();
  }

  get available(): boolean {
    return this.executablePath !== null;
  }

  /** Serve a registered render document (called by the HTTP app). */
  documentFor(token: string): string | null {
    return this.documents.get(token) ?? null;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.executablePath) {
      throw new Error(
        'No Chrome, Edge, Brave or Chromium was found for rendering. Install one or set OPENPAPER_BROWSER to its executable.'
      );
    }
    if (!this.browser) {
      const { default: puppeteer } = await import('puppeteer-core');
      const launching: Promise<Browser> = puppeteer
        .launch({
          executablePath: this.executablePath,
          headless: true,
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--font-render-hinting=none',
            '--force-color-profile=srgb',
            '--hide-scrollbars',
          ],
        })
        .then((b) => {
          // Only forget this browser: an idle close can be followed by a new launch before it disconnects.
          b.on('disconnected', () => {
            if (this.browser === launching) this.browser = null;
          });
          return b;
        })
        .catch((error) => {
          if (this.browser === launching) this.browser = null;
          throw error;
        });
      this.browser = launching;
    }
    return this.browser;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active === 0) void this.close();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  /**
   * Load `html` in a fresh page sized to `viewport`, wait for fonts and images,
   * run `fn`, then dispose the page.
   */
  async withDocument<T>(html: string, viewport: RenderViewport, fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.getBrowser();
    const token = randomUUID();
    this.documents.set(token, html);
    this.active++;
    let page: Page | undefined;
    try {
      // Inside the try: if the browser died, the count must still come back down or it never idles out.
      page = await browser.newPage();
      await page.setViewport({
        width: Math.max(1, Math.ceil(viewport.width)),
        height: Math.max(1, Math.ceil(viewport.height)),
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
      });
      await page.goto(`${this.baseUrl()}/__render/${token}`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      await page.evaluate(waitForAssetsInPage, ASSET_TIMEOUT_MS);
      if (html.includes('data-op-shader=')) {
        await page
          .waitForFunction(() => (window as unknown as { __opShadersReady?: boolean }).__opShadersReady === true, { timeout: SHADER_TIMEOUT_MS })
          .catch(() => {});
      }
      return await fn(page);
    } finally {
      this.documents.delete(token);
      this.active--;
      await page?.close().catch(() => {});
      this.touch();
    }
  }

  /** Installed font faces via the Local Font Access API (permission granted for our origin). */
  async withLocalFonts(): Promise<Array<{ family: string; style: string }>> {
    const browser = await this.getBrowser();
    const origin = this.baseUrl();
    await browser.setPermission(origin, { permission: { name: 'local-fonts' }, state: 'granted' }).catch(() => {});
    return this.withDocument('<!doctype html><html><body></body></html>', { width: 10, height: 10 }, (page) =>
      page.evaluate(async () => {
        const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string; style: string }>> }).queryLocalFonts;
        if (!query) return [];
        try {
          const fonts = await query();
          return fonts.map((f) => ({ family: f.family, style: f.style }));
        } catch {
          return [];
        }
      })
    );
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    if (pending) await pending.then((b) => b.close()).catch(() => {});
  }
}

/** Runs inside the page: wait for web fonts, <img> elements and CSS background images. */
async function waitForAssetsInPage(timeoutMs: number): Promise<void> {
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  const work = (async () => {
    const urls = new Set<string>();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) urls.add(m[1]!);
    }
    const loads: Promise<unknown>[] = [document.fonts.ready];
    for (const img of Array.from(document.images)) {
      if (!img.complete) loads.push(new Promise((r) => ((img.onload = r), (img.onerror = r))));
      else if (img.decode) loads.push(img.decode().catch(() => {}));
    }
    for (const url of urls) {
      loads.push(
        new Promise((resolve) => {
          const probe = new Image();
          probe.onload = probe.onerror = resolve;
          probe.src = url;
        })
      );
    }
    await Promise.all(loads);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })();
  await Promise.race([work, deadline]);
}
