import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MCP_PATH } from '../paths.ts';

const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';

interface RelayOptions {
  /** Starts the OpenPaper server if needed and returns its port. */
  ensureServer: () => Promise<number>;
}

function isRequest(m: JSONRPCMessage): m is JSONRPCMessage & { id: string | number; method: string; params?: Record<string, unknown> } {
  return 'method' in m && 'id' in m;
}

/**
 * `openpaper mcp`: speak MCP over stdio to the agent harness and relay every
 * message to the long-running OpenPaper server over Streamable HTTP.
 * Logs go to stderr; stdout carries only protocol messages.
 */
export async function runStdioRelay({ ensureServer }: RelayOptions): Promise<void> {
  const stdio = new StdioServerTransport();
  let clientInfo: Record<string, unknown> | undefined;
  let port = await ensureServer();
  let http = connect(port);

  function connect(p: number, sessionId?: string): StreamableHTTPClientTransport {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${p}${MCP_PATH}`), {
      requestInit: { headers: { 'X-OpenPaper-From': 'CLI' } },
      ...(sessionId ? { sessionId } : {}),
    });
    transport.onmessage = (message) => {
      void stdio.send(message).catch((error) => console.error('[openpaper mcp] stdout write failed', error));
    };
    transport.onerror = (error) => console.error('[openpaper mcp]', error.message);
    return transport;
  }

  async function forward(message: JSONRPCMessage): Promise<void> {
    if (isRequest(message)) {
      if (message.method === 'initialize') {
        clientInfo = (message.params?.clientInfo as Record<string, unknown> | undefined) ?? clientInfo;
      } else if (clientInfo) {
        const params = (message.params ?? {}) as Record<string, unknown>;
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        message.params = { ...params, _meta: { ...meta, [CLIENT_INFO_META_KEY]: clientInfo } };
      }
    }
    try {
      await http.send(message);
    } catch (firstError) {
      // The server may have exited (e.g. after a reboot). Start it again and retry once,
      // keeping the session id so the server resumes the same agent session.
      try {
        const sessionId = http.sessionId;
        port = await ensureServer();
        const next = connect(port, sessionId);
        await http.close().catch(() => {});
        http = next;
        await http.start();
        await http.send(message);
      } catch {
        if (isRequest(message)) {
          await stdio.send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32000,
              message:
                'OpenPaper is not running and could not be started. Ask the user to run `openpaper start`, then try again. ' +
                `(${firstError instanceof Error ? firstError.message : String(firstError)})`,
            },
          });
        }
      }
    }
  }

  stdio.onmessage = (message) => {
    void forward(message);
  };
  stdio.onclose = () => {
    void http.close().finally(() => process.exit(0));
  };

  await http.start();
  await stdio.start();
}
