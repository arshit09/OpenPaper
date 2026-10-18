import type { IncomingMessage } from 'node:http';

/**
 * OpenPaper only listens on 127.0.0.1, but any web page the user visits can still
 * try to reach it. These checks keep other sites out:
 *  - Host must be our loopback host:port (blocks DNS rebinding).
 *  - /mcp rejects anything with an Origin header (browsers always send one on CORS).
 *  - The editor WebSocket and mutating endpoints require a same-origin Origin.
 *  - Media/local-asset GETs reject cross-site fetches (Sec-Fetch-Site).
 */
export class OriginPolicy {
  private readonly hosts: Set<string>;
  private readonly origins: Set<string>;

  constructor(port: number, extraOrigins: string[] = []) {
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extraOrigins]);
  }

  allowOrigin(origin: string): void {
    this.origins.add(origin);
    try {
      this.hosts.add(new URL(origin).host);
    } catch {
      // ignore malformed
    }
  }

  hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return !host || this.hosts.has(host);
  }

  /** For /mcp: MCP clients are not browsers and never send Origin. */
  noBrowserOrigin(req: IncomingMessage): boolean {
    return !req.headers.origin && req.method !== 'OPTIONS';
  }

  sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return typeof origin === 'string' && this.origins.has(origin);
  }

  /** GETs of images: allow same-origin, direct navigation and non-browser clients. */
  notCrossSite(req: IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site === undefined || site === 'same-origin' || site === 'none') return true;
    // Vite dev server proxies from another loopback port.
    if (site === 'same-site') {
      const origin = req.headers.origin ?? req.headers.referer;
      if (typeof origin === 'string') {
        try {
          return this.origins.has(new URL(origin).origin);
        } catch {
          return false;
        }
      }
    }
    return false;
  }
}
