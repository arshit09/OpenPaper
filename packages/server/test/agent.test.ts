import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent } from '@openpaper/core';
import { AgentService } from '../src/agent/agent.ts';
import { claudeCodeStatus } from '../src/agent/claude-code.ts';
import { AgentSettings } from '../src/agent/settings.ts';
import { resolvePaths } from '../src/paths.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { ToolRuntime } from '../src/tools/runtime.ts';

let server: RunningServer;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'openpaper-agent-test-'));
  server = await startServer({ paths: { ...resolvePaths(home), exports: join(home, 'exports') }, port: 33000 + Math.floor(Math.random() * 2000) });
});

afterAll(async () => {
  await server?.close();
  await rm(home, { recursive: true, force: true }).catch(() => {});
});

/** Scripted stand-in for `client.beta.messages.stream()` (no network). */
type FakeTurn =
  | { text: string; toolUses?: Array<{ id: string; name: string; input: unknown }>; stop: string }
  | { throws: Error };

function fakeClient(turns: FakeTurn[]) {
  const requests: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const turn = turns[i++]!;
          if ('throws' in turn) {
            return {
              async *[Symbol.asyncIterator]() {
                throw turn.throws;
              },
              finalMessage: async () => {
                throw turn.throws;
              },
            };
          }
          const events = [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }];
          const message = {
            id: `msg_${i}`,
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'text', text: turn.text }, ...(turn.toolUses ?? []).map((t) => ({ type: 'tool_use', ...t }))],
            stop_reason: turn.stop,
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
          };
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
  return { client, requests };
}

describe('built-in design agent', () => {
  it('runs a tool loop against the design tools', async () => {
    const { fileId } = await (async () => {
      const doc = await server.env.store.create({ name: 'Agent test' });
      server.env.hub.adopt(doc);
      return { fileId: doc.id };
    })();
    const { client, requests } = fakeClient([
      {
        text: 'Creating a mobile artboard.',
        toolUses: [{ id: 'toolu_1', name: 'create_artboard', input: { fileId, name: 'Agent board', styles: { width: '390px', height: '844px' } } }],
        stop: 'tool_use',
      },
      { text: 'Done — added a 390×844 artboard.', stop: 'end_turn' },
    ]);
    const events: AgentEvent[] = [];
    const settings = new AgentSettings(join(home, 'config.json'));
    await settings.update({ apiKey: 'sk-test' });
    const agents = new AgentService({
      runtime: new ToolRuntime(server.env),
      settings,
      getDoc: (id) => server.env.hub.peek(id)?.doc,
      viewFor: () => null,
      emit: (_f, e) => events.push(e),
      createClient: () => client as never,
    });

    const chat = agents.chat(fileId);
    await chat.send('Make me a mobile artboard');

    // The tool really ran against the document.
    const doc = server.env.hub.peek(fileId)!.doc;
    const board = Object.values(doc.nodes).find((n) => n.label === 'Agent board');
    expect(board?.styles.width).toBe('390px');

    // Request shape follows the Claude API guidance.
    const first = requests[0];
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.fallbacks).toBe('default');
    expect(first.betas).toContain('server-side-fallback-2026-07-01');
    expect(first.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(first.output_config).toEqual({ effort: 'high' });
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.tools).toHaveLength(38);
    expect(first.tools.every((t: { eager_input_streaming: boolean }) => t.eager_input_streaming)).toBe(true);
    expect(first.tools[0].input_schema.$schema).toBeUndefined();
    expect(first.messages[0].content).toContain('<context>');

    // The tool result went back as a user message.
    const second = requests[1];
    const toolResultMsg = second.messages[second.messages.length - 1];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });

    // Transcript and usage.
    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(chat.items[2]).toMatchObject({ kind: 'tool', name: 'create_artboard', status: 'done' });
    expect(chat.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 20 });
    expect(events.some((e) => e.type === 'status' && !e.running)).toBe(true);

    // The Agents panel can undo the built-in agent's change (its actor id is its session id).
    const live = await server.env.hub.get(fileId);
    expect(await live.undo({ kind: 'agent', id: `openpaper-agent-${fileId}`, name: 'agent' })).toBeTruthy();
    expect(Object.values(live.doc.nodes).some((n) => n.label === 'Agent board')).toBe(false);
  });

  /** Run with no key in the environment and the SDK's profile directory pointed at `configDir`. */
  async function withCredentialEnv<T>(configDir: string, fn: () => Promise<T>): Promise<T> {
    const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    process.env.ANTHROPIC_CONFIG_DIR = configDir;
    try {
      return await fn();
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  }

  it('asks for a key when none is configured', async () => {
    const settings = new AgentSettings(join(home, 'empty-config.json'));
    const configDir = await mkdtemp(join(home, 'anthropic-empty-'));
    expect(await withCredentialEnv(configDir, async () => (await settings.info()).keySource)).toBeNull();
  });

  it('recognises an `ant auth login` profile', async () => {
    const settings = new AgentSettings(join(home, 'empty-config.json'));
    const configDir = await mkdtemp(join(home, 'anthropic-profile-'));
    await mkdir(join(configDir, 'configs'));
    await writeFile(join(configDir, 'configs', 'default.json'), JSON.stringify({ authentication: { type: 'user_oauth' } }));
    expect(await withCredentialEnv(configDir, async () => (await settings.info()).keySource)).toBe('profile');
  });

  function agentsWith(client: unknown, events: AgentEvent[] = []) {
    const settings = new AgentSettings(join(home, 'config.json'));
    return new AgentService({
      runtime: new ToolRuntime(server.env),
      settings,
      getDoc: (id) => server.env.hub.peek(id)?.doc,
      viewFor: () => null,
      emit: (_f, e) => events.push(e),
      createClient: () => client as never,
    });
  }

  it('reports missing credentials without retrying', async () => {
    const doc = await server.env.store.create({ name: 'No credentials' });
    server.env.hub.adopt(doc);
    const { client, requests } = fakeClient([
      { throws: new Error('Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.') },
    ]);
    const chat = agentsWith(client).chat(doc.id);
    await chat.send('Hello');
    expect(requests).toHaveLength(1);
    const last = chat.items[chat.items.length - 1];
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last?.kind === 'notice' && last.text).toContain('No Anthropic credentials found');
    expect(chat.running).toBe(false);
  });

  it('retries a step whose tool input JSON could not be parsed', async () => {
    const doc = await server.env.store.create({ name: 'Bad JSON' });
    server.env.hub.adopt(doc);
    const { client, requests } = fakeClient([
      { throws: new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt.') },
      { text: 'All good.', stop: 'end_turn' },
    ]);
    const chat = agentsWith(client).chat(doc.id);
    await chat.send('Hello');
    expect(requests).toHaveLength(2);
    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'notice', 'assistant']);
  });

  it('does not retry API errors', async () => {
    const doc = await server.env.store.create({ name: 'API error' });
    server.env.hub.adopt(doc);
    const overloaded = Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());
    const { client, requests } = fakeClient([{ throws: overloaded }]);
    const chat = agentsWith(client).chat(doc.id);
    await chat.send('Hello');
    expect(requests).toHaveLength(1);
    expect(chat.items[chat.items.length - 1]).toMatchObject({ kind: 'notice', level: 'error' });
  });
});

/** Stand-in for the `claude` CLI: logs its args and prompt, then prints scripted stream-json (no network). */
const FAKE_CLAUDE = `
const fs = require('node:fs');
const [log, ...args] = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ args, prompt }) + '\\n');
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'openpaper', status: 'connected' }] });
  if (prompt.includes('SIGNED_OUT')) {
    out({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} });
    process.exit(1);
  }
  out({ type: 'stream_event', event: { type: 'message_start' } });
  delta('Adding ');
  delta('an artboard.');
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'mcp__openpaper__create_artboard' } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__openpaper__create_artboard', input: { name: 'Board' } }] } });
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); return; }
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  delta('Done.');
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } });
});
`;

describe('built-in design agent on Claude Code', () => {
  let command: string[];
  let log: string;
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string });

  beforeAll(async () => {
    const dir = await mkdtemp(join(home, 'fake-claude-'));
    const script = join(dir, 'claude.cjs');
    log = join(dir, 'calls.jsonl');
    await writeFile(script, FAKE_CLAUDE);
    command = [process.execPath, script, log];
  });

  async function claudeCodeChat(name: string, events: AgentEvent[] = []) {
    const doc = await server.env.store.create({ name });
    server.env.hub.adopt(doc);
    const settings = new AgentSettings(join(home, `cc-${doc.id}.json`), async () => null);
    await settings.update({ runner: 'claude-code' });
    const agents = new AgentService({
      runtime: new ToolRuntime(server.env),
      settings,
      getDoc: (id) => server.env.hub.peek(id)?.doc,
      viewFor: () => null,
      emit: (_f, e) => events.push(e),
      claudeCode: { mcpUrl: 'http://127.0.0.1:1/mcp', dir: join(home, 'claude-code'), command },
    });
    return agents.chat(doc.id);
  }

  it('runs a turn on Claude Code with only the design tools, then resumes its session', async () => {
    const events: AgentEvent[] = [];
    const chat = await claudeCodeChat('Claude Code test', events);
    await chat.send('Make me a mobile artboard');

    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(chat.items[1]).toMatchObject({ kind: 'assistant', text: 'Adding an artboard.' });
    expect(chat.items[2]).toMatchObject({ kind: 'tool', name: 'create_artboard', status: 'done' });
    expect(chat.items[3]).toMatchObject({ kind: 'assistant', text: 'Done.' });
    expect(chat.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 });
    expect(events.some((e) => e.type === 'status' && !e.running)).toBe(true);

    const [first] = await calls();
    const arg = (flag: string) => first!.args[first!.args.indexOf(flag) + 1];
    expect(first!.args).toContain('-p');
    expect(first!.args).toContain('--strict-mcp-config');
    expect(arg('--tools')).toBe('');
    expect(arg('--allowedTools')).toBe('mcp__openpaper');
    expect(arg('--permission-mode')).toBe('dontAsk');
    expect(arg('--model')).toBe('claude-opus-5-5');
    expect(arg('--effort')).toBe('high');
    expect(first!.args).not.toContain('--resume');
    expect(JSON.parse(await readFile(arg('--mcp-config')!, 'utf8'))).toEqual({ mcpServers: { openpaper: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } });
    expect(await readFile(arg('--system-prompt-file')!, 'utf8')).toContain("You are OpenPaper's built-in design agent");
    expect(first!.prompt).toContain('<context>');
    expect(first!.prompt).toContain('Make me a mobile artboard');

    await chat.send('Now a desktop one');
    const second = (await calls()).at(-1)!;
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe('sess-1');
  });

  it('asks the user to sign in to Claude Code', async () => {
    const chat = await claudeCodeChat('Signed out');
    await chat.send('SIGNED_OUT');
    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'notice']);
    expect(chat.items[1]).toMatchObject({ kind: 'notice', level: 'error' });
    expect(chat.items[1]!.kind === 'notice' && chat.items[1]!.text).toContain('claude auth login');
    expect(chat.running).toBe(false);
  });

  it('stops a running Claude Code turn', async () => {
    const chat = await claudeCodeChat('Stop me');
    const sending = chat.send('HANG');
    await expect.poll(() => chat.items.some((i) => i.kind === 'tool'), { timeout: 10_000 }).toBe(true);
    chat.stop();
    await sending;
    expect(chat.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error' });
    expect(chat.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped.' });
    expect(chat.running).toBe(false);
  });

  it('reports the install and sign-in from Claude Code itself', async () => {
    expect(await claudeCodeStatus(command)).toEqual({ version: '9.9.9', loggedIn: true, plan: 'max' });
    expect(await claudeCodeStatus(null)).toBeNull();
    const settings = new AgentSettings(join(home, 'runner-config.json'), () => claudeCodeStatus(command));
    expect((await settings.info()).runner).toBe('api');
    await settings.update({ runner: 'claude-code' });
    expect(await settings.info()).toMatchObject({ runner: 'claude-code', claudeCode: { loggedIn: true, plan: 'max' } });
  });
});
