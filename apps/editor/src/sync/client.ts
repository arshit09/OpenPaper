import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@openpaper/core';

type PushMessage = Exclude<ServerMessage, { t: 'res' } | { t: 'rpc' } | { t: 'welcome' }>;
type Listener = (message: PushMessage) => void;
type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** How long a request waits for the connection (the server may be restarting) before it fails. */
const CONNECT_WAIT_MS = 8000;

/**
 * WebSocket connection to the local OpenPaper server with request/response,
 * server pushes and server→editor RPCs. Reconnects automatically.
 */
export class SyncClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly rpcHandlers = new Map<string, RpcHandler>();
  private readonly onOpenHooks = new Set<() => void>();
  private retry = 0;
  private stopped = false;
  state: ConnectionState = 'connecting';
  clientId: string | null = null;
  serverVersion = '';
  mcpUrl = '';
  /** Settles once the server has welcomed this connection; shared by every request made meanwhile. */
  private welcome: Promise<void>;
  private resolveWelcome!: () => void;
  private welcomed = false;

  constructor(private readonly url = SyncClient.defaultUrl()) {
    this.welcome = new Promise((r) => (this.resolveWelcome = r));
    this.connect();
  }

  static defaultUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  private setState(state: ConnectionState) {
    this.state = state;
    for (const l of this.stateListeners) l(state);
  }

  private connect() {
    this.setState('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const stored = sessionStorage.getItem('openpaper.clientId') ?? undefined;
      this.sendRaw({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: stored });
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };
    ws.onclose = () => {
      this.ws = null;
      for (const [, p] of this.pending) p.reject(new Error('Connection lost'));
      this.pending.clear();
      this.setState('closed');
      if (this.stopped) return;
      // A fresh wait only after a welcome: a failed reconnect must not orphan the requests already waiting.
      if (this.welcomed) {
        this.welcomed = false;
        this.welcome = new Promise((r) => (this.resolveWelcome = r));
      }
      const delay = Math.min(5000, 300 * 2 ** this.retry++) + Math.random() * 200;
      setTimeout(() => this.connect(), delay);
    };
  }

  private handle(message: ServerMessage) {
    switch (message.t) {
      case 'welcome':
        this.clientId = message.clientId;
        this.serverVersion = message.serverVersion;
        this.mcpUrl = message.mcpUrl;
        sessionStorage.setItem('openpaper.clientId', message.clientId);
        this.setState('open');
        this.welcomed = true;
        this.resolveWelcome();
        for (const hook of this.onOpenHooks) hook();
        return;
      case 'res': {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error));
        else p.resolve(message.result);
        return;
      }
      case 'rpc': {
        const handler = this.rpcHandlers.get(message.method);
        const reply = (result?: unknown, error?: string) =>
          this.sendRaw({ t: 'rpc-res', id: message.id, ...(error ? { error } : { result }) });
        if (!handler) {
          reply(undefined, `Editor does not implement "${message.method}"`);
          return;
        }
        Promise.resolve()
          .then(() => handler(message.params))
          .then((result) => reply(result))
          .catch((error: unknown) => reply(undefined, error instanceof Error ? error.message : String(error)));
        return;
      }
      default:
        for (const l of this.listeners) l(message);
    }
  }

  private sendRaw(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  /** Send a request and await its response (waits a while for the connection if needed). */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.welcomed) await this.connected();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sendRaw({ t: 'req', id, method, params });
    });
  }

  private connected(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Not connected to the OpenPaper server. Is it still running?')), CONNECT_WAIT_MS);
    });
    return Promise.race([this.welcome, timeout]).finally(() => clearTimeout(timer));
  }

  /** Fire-and-forget request (errors are logged). */
  notify(method: string, params?: unknown): void {
    this.request(method, params).catch((error) => console.warn(`[openpaper] ${method} failed:`, error));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Called after every (re)connect, once the server has welcomed us. */
  onOpen(hook: () => void): () => void {
    this.onOpenHooks.add(hook);
    return () => this.onOpenHooks.delete(hook);
  }

  handleRpc(method: string, handler: RpcHandler): void {
    this.rpcHandlers.set(method, handler);
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
