import type { WebSocket } from 'ws';
import type { ServerMessage, ViewState } from '@openpaper/core';

export interface EditorConnection {
  clientId: string;
  ws: WebSocket;
  view: ViewState;
  /** Files this connection receives patches for. */
  subscriptions: Set<string>;
  /** Last time this editor was focused (or connected). */
  lastActiveAt: number;
  /** Highest document version the editor has acknowledged per file. */
  pendingRpc: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
}

let rpcSeq = 1;

/** All connected editors and what each one is looking at. */
export class ViewRegistry {
  readonly conns = new Map<string, EditorConnection>();

  add(conn: EditorConnection) {
    this.conns.set(conn.clientId, conn);
  }

  remove(clientId: string) {
    const conn = this.conns.get(clientId);
    if (!conn) return;
    for (const [, p] of conn.pendingRpc) {
      clearTimeout(p.timer);
      p.reject(new Error('Editor disconnected'));
    }
    this.conns.delete(clientId);
  }

  send(conn: EditorConnection, message: ServerMessage) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  }

  broadcast(fileId: string | null, message: ServerMessage) {
    const text = JSON.stringify(message);
    for (const conn of this.conns.values()) {
      if (fileId && !conn.subscriptions.has(fileId)) continue;
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(text);
    }
  }

  /** Editors ordered by recency of focus (focused first). */
  ordered(): EditorConnection[] {
    return [...this.conns.values()].sort(
      (a, b) => Number(b.view.focused) - Number(a.view.focused) || b.lastActiveAt - a.lastActiveAt
    );
  }

  /** The view of the editor the user is most likely looking at. */
  activeView(): ViewState | null {
    return this.ordered()[0]?.view ?? null;
  }

  activeFileId(): string | null {
    return this.ordered().find((c) => c.view.fileId)?.view.fileId ?? null;
  }

  /** Most recent view showing a file. */
  viewFor(fileId: string): ViewState | null {
    return this.ordered().find((c) => c.view.fileId === fileId)?.view ?? null;
  }

  editorShowing(fileId: string, pageId?: string): EditorConnection | null {
    return this.ordered().find((c) => c.view.fileId === fileId && (!pageId || c.view.pageId === pageId)) ?? null;
  }

  openFileIds(): string[] {
    const ids: string[] = [];
    for (const c of this.ordered()) if (c.view.fileId && !ids.includes(c.view.fileId)) ids.push(c.view.fileId);
    return ids;
  }

  /** Visible canvas rect (world coordinates) of the editor showing this page. */
  viewportFor(fileId: string, pageId: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const conn = this.editorShowing(fileId, pageId);
    const vp = conn?.view.viewport;
    if (!vp || !vp.zoom) return null;
    const minX = -vp.x / vp.zoom;
    const minY = -vp.y / vp.zoom;
    return { minX, minY, maxX: minX + vp.width / vp.zoom, maxY: minY + vp.height / vp.zoom };
  }

  /** Call a method implemented by an editor (see EditorRpc in core). */
  rpc<T>(conn: EditorConnection, method: string, params: unknown, timeoutMs = 5000): Promise<T> {
    const id = rpcSeq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRpc.delete(id);
        reject(new Error(`Editor did not answer "${method}" in time`));
      }, timeoutMs);
      conn.pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(conn, { t: 'rpc', id, method, params });
    });
  }

  resolveRpc(conn: EditorConnection, id: number, result: unknown, error?: string) {
    const p = conn.pendingRpc.get(id);
    if (!p) return;
    conn.pendingRpc.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  }
}
