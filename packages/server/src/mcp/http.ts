import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface McpClientInfo {
  name: string;
  version?: string;
  title?: string;
}

export interface McpSession {
  id: string;
  clientInfo: McpClientInfo;
  /** "stdio" when the request came through the `openpaper mcp` relay. */
  transport: 'http' | 'stdio';
  createdAt: number;
  lastSeen: number;
}

export interface McpRuntime {
  serverName: string;
  serverVersion: string;
  instructions(): string;
  listTools(): Tool[];
  callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  onSessionEnded(session: McpSession): void;
}

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function clientInfoFrom(value: unknown): McpClientInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || !v.name.trim()) return undefined;
  const info: McpClientInfo = { name: v.name.trim() };
  if (typeof v.version === 'string' && v.version.trim()) info.version = v.version.trim();
  if (typeof v.title === 'string' && v.title.trim()) info.title = v.title.trim();
  return info;
}

/** Client identity carried by a JSON-RPC message (initialize params or `_meta`). */
function clientInfoFromMessage(message: unknown): McpClientInfo | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const m = message as { method?: string; params?: Record<string, unknown> };
  const meta = m.params?._meta as Record<string, unknown> | undefined;
  return (
    clientInfoFrom(meta?.[CLIENT_INFO_META_KEY]) ??
    (m.method === 'initialize' ? clientInfoFrom(m.params?.clientInfo) : undefined)
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Streamable HTTP endpoint for MCP.
 *
 * Every POST gets a fresh stateless SDK transport + Server, while OpenPaper keeps
 * its own session table keyed by `mcp-session-id`. A client that still holds a
 * session id from before a server restart is simply resumed instead of getting a
 * 404, which some harnesses handle poorly.
 */
export function createMcpHttpHandler(runtime: McpRuntime) {
  const sessions = new Map<string, McpSession>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastSeen > SESSION_IDLE_MS) endSession(session.id);
    }
  }, 60_000);
  sweep.unref();

  function endSession(id: string): void {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      runtime.onSessionEnded(session);
    } catch (error) {
      console.warn('[mcp] onSessionEnded failed', error);
    }
  }

  function buildServer(session: McpSession): Server {
    const server = new Server(
      { name: runtime.serverName, version: runtime.serverVersion },
      { capabilities: { tools: {} }, instructions: runtime.instructions() }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const fromMeta = clientInfoFromMessage(request);
      if (fromMeta) session.clientInfo = fromMeta;
      session.lastSeen = Date.now();
      try {
        return await runtime.callTool(session, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        } satisfies CallToolResult;
      }
    });
    return server;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const headerSession = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(headerSession) ? headerSession[0] : headerSession;
    const from = req.headers['x-openpaper-from'];
    const transportKind: McpSession['transport'] = from === 'CLI' ? 'stdio' : 'http';

    if (method === 'DELETE') {
      if (sessionId) endSession(sessionId);
      res.writeHead(202).end();
      return;
    }
    if (method === 'GET') {
      // No standalone server→client SSE stream; the spec allows 405 here.
      res.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { status: 'method_not_allowed', message: 'Use POST for MCP messages.' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      sendJson(res, status, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const id = sessionId || randomUUID();
    let session = sessions.get(id);
    if (!session) {
      const info = messages.map(clientInfoFromMessage).find(Boolean);
      session = {
        id,
        clientInfo: info ?? { name: 'unknown' },
        transport: transportKind,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      sessions.set(id, session);
    } else {
      const info = messages.map(clientInfoFromMessage).find(Boolean);
      if (info) session.clientInfo = info;
      session.transport = transportKind;
      session.lastSeen = Date.now();
    }

    // Some clients omit the Accept header the spec requires; add it rather than 406.
    const accept = req.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      req.headers.accept = 'application/json, text/event-stream';
    }

    const server = buildServer(session);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.setHeader('mcp-session-id', id);
    res.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  }

  return {
    handle,
    sessions,
    endSession,
    close() {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) endSession(id);
    },
  };
}
