import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createSubtree, type AgentEvent, type SiteElementInfo, type SiteInfo } from '@openpaper/core';
import { AgentService } from '../src/agent/agent.ts';
import { AGY_RULE, agyStatus, allowAgyDesignTools } from '../src/agent/agy.ts';
import { claudeCodeStatus } from '../src/agent/claude-code.ts';
import { codexStatus } from '../src/agent/codex.ts';
import { AgentSettings } from '../src/agent/settings.ts';
import { resolvePaths } from '../src/paths.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { ToolRuntime } from '../src/tools/runtime.ts';

let server: RunningServer;
let home: string;

/** No coding agents installed: info() would otherwise ask the real ones on this machine. */
const NO_PROBES = {
  claudeCode: async () => null,
  codex: async () => null,
  agy: async () => null,
  codexModels: async () => [],
  codexDefault: async () => null,
  agyModels: async () => [],
};

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
    const settings = new AgentSettings(join(home, 'empty-config.json'), NO_PROBES);
    const configDir = await mkdtemp(join(home, 'anthropic-empty-'));
    expect(await withCredentialEnv(configDir, async () => (await settings.info()).keySource)).toBeNull();
  });

  it('recognises an `ant auth login` profile', async () => {
    const settings = new AgentSettings(join(home, 'empty-config.json'), NO_PROBES);
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
  fs.appendFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
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
  const tool = prompt.includes('SITE_EDIT')
    ? { id: 't1', name: 'Edit', input: { file_path: require('node:path').join(process.cwd(), 'src', 'App.tsx'), old_string: 'a', new_string: 'b' } }
    : { id: 't1', name: 'mcp__openpaper__create_artboard', input: { name: 'Board' } };
  out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: tool.name } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', ...tool }] } });
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
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string; cwd: string });

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
    const settings = new AgentSettings(join(home, `cc-${doc.id}.json`), NO_PROBES);
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

  /** A chat for a live site whose project lives in a temp folder. */
  async function siteChat(runner: 'claude-code' | 'api' = 'claude-code') {
    const folder = await mkdtemp(join(home, 'site-project-'));
    const site: SiteInfo = { id: 'site1', name: 'My site', url: 'http://localhost:5173/', folder, createdAt: '', updatedAt: '' };
    const settings = new AgentSettings(join(folder, '..', `site-${runner}-${Date.now()}.json`), NO_PROBES);
    await settings.update({ runner });
    const agents = new AgentService({
      runtime: new ToolRuntime(server.env),
      settings,
      getDoc: () => undefined,
      viewFor: () => null,
      getSite: (id) => (id === site.id ? site : undefined),
      emit: () => {},
      claudeCode: { mcpUrl: 'http://127.0.0.1:1/mcp', dir: join(home, 'claude-code'), command },
    });
    return { chat: agents.chat(`site:${site.id}`), folder };
  }

  const element: SiteElementInfo = {
    selector: 'main > section.hero > a.btn',
    tag: 'a',
    classes: ['btn', 'primary'],
    text: 'Get started',
    html: '<a class="btn primary" href="/signup">Get started</a>',
    rect: { x: 10, y: 20, width: 120, height: 40 },
    attributes: { href: '/signup' },
    styles: { 'border-radius': '4px' },
    ancestors: [{ tag: 'section', classes: ['hero'] }],
    source: { file: 'src/Hero.tsx', line: 12, column: 7 },
    components: ['Hero', 'App'],
    framework: 'react',
  };

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
    const settings = new AgentSettings(join(home, 'runner-config.json'), { ...NO_PROBES, claudeCode: () => claudeCodeStatus(command) });
    expect((await settings.info()).runner).toBe('api');
    await settings.update({ runner: 'claude-code' });
    expect(await settings.info()).toMatchObject({ runner: 'claude-code', claudeCode: { loggedIn: true, plan: 'max' } });
  });

  it('tells the agent which layers the user pointed at', async () => {
    const chat = await claudeCodeChat('Pointing');
    const live = await server.env.hub.get(chat.fileId);
    const rootId = live.doc.pages[live.doc.pageList.find((p) => p.type === 'page')!.id]!.rootId;
    const board = live.transact({ kind: 'user', id: 'u', name: 'u' }, 'Add', (tx) =>
      createSubtree(tx, rootId, { component: 'Frame', label: 'Home', styles: { width: '400px', height: '400px' }, children: [{ component: 'Frame', label: 'Card' }] })
    );
    const card = live.doc.nodes[board.id]!.children[0]!;
    await chat.send('Make it darker', { target: { label: 'Card', nodeIds: [card] } });
    expect(chat.items[0]).toMatchObject({ kind: 'user', text: 'Make it darker', target: 'Card' });
    const prompt = (await calls()).at(-1)!.prompt;
    expect(prompt).toContain('<target>');
    expect(prompt).toContain(`${card} Frame "Card" in "Home"`);
    expect(prompt.indexOf('<target>')).toBeLessThan(prompt.indexOf('Make it darker'));
  });

  it('edits a live site in its project folder with only the file tools', async () => {
    const { chat, folder } = await siteChat();
    await chat.send('SITE_EDIT make this rounder', { target: { label: 'a “Get started”', elements: [element] }, page: 'http://localhost:5173/pricing' });

    const run = (await calls()).at(-1)!;
    const arg = (flag: string) => run.args[run.args.indexOf(flag) + 1];
    expect(run.cwd).toBe(folder);
    expect(arg('--tools')).toBe('Read,Edit,Write,Glob,Grep');
    expect(arg('--permission-mode')).toBe('acceptEdits');
    expect(arg('--permission-prompts')).toBe('none');
    expect(run.args).not.toContain('--mcp-config');
    expect(run.args).not.toContain('--system-prompt-file');
    expect(await readFile(arg('--append-system-prompt-file')!, 'utf8')).toContain("OpenPaper's live-site agent");
    expect(run.prompt).toContain(`project folder: ${folder}`);
    expect(run.prompt).toContain('page: http://localhost:5173/pricing');
    expect(run.prompt).toContain('source: src/Hero.tsx:12:7');
    expect(run.prompt).toContain('components: Hero < App (react)');
    expect(chat.items.find((i) => i.kind === 'tool')).toMatchObject({ summary: 'Edited src/App.tsx', status: 'done' });
  });

  it('asks for Claude Code to edit a live site', async () => {
    const { chat } = await siteChat('api');
    await chat.send('Make it blue');
    const last = chat.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last.kind === 'notice' && last.text).toContain('Claude Code');
  });
});

/** Stand-in for the `codex` CLI: logs its args and prompt, then prints scripted `exec --json` events (no network). */
const FAKE_CODEX = `
const fs = require('node:fs');
const [log, ...args] = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  fs.appendFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
  const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  out({ type: 'thread.started', thread_id: 'thread-1' });
  out({ type: 'turn.started' });
  if (prompt.includes('SIGNED_OUT')) {
    out({ type: 'error', message: 'unexpected status 401 Unauthorized' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized' } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Planning.' } });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Placing the image.' } });
  const call = { id: 'i2', type: 'mcp_tool_call', server: 'openpaper', tool: 'create_artboard', arguments: { name: 'Hero shot' } };
  out({ type: 'item.started', item: { ...call, result: null, error: null, status: 'in_progress' } });
  out({ type: 'item.completed', item: { ...call, result: { content: [{ type: 'text', text: 'ok' }] }, error: null, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Done.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 7 } });
});
`;

/** Stand-in for the `agy` CLI: logs its args, then prints scripted stream-json (no network). */
const FAKE_AGY = `
const fs = require('node:fs');
const [log, ...args] = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.4.8'); process.exit(0); }
if (args[0] === 'models') { console.log('Fetching available models...'); console.log('gem-fast-low\\tGem Fast (Low)'); process.exit(0); }
const prompt = args[args.indexOf('--print') + 1] || '';
fs.appendFileSync(log, JSON.stringify({ args, prompt, cwd: process.cwd() }) + '\\n');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const step = (s) => out({ event: 'step_update', step_update: { conversation_id: 'conv-1', ...s } });
out({ event: 'init', conversation_id: 'conv-1', init: { model: 'gem-fast-low' } });
step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Making ' });
step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'an image.' });
const read = { name: 'read_file', parameters: { Path: 'C:/schemas/create_artboard.json' } };
step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: read });
step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: read });
const image = { name: 'generate_image', parameters: { ImageName: 'hero', Prompt: 'a hero' } };
step({ step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'generate_image', tool_info: image });
step({ step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'generate_image', tool_info: image });
const mcp = { name: 'call_mcp_tool', parameters: { ServerName: 'openpaper_openpaper', ToolName: 'create_artboard', Arguments: { name: 'Hero' } } };
step({ step_index: 4, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: mcp });
step({ step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: mcp });
step({ step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.' });
const denied = prompt.includes('DENIED') ? [{ action: 'mcp', display_name: 'CallMcpTool' }] : undefined;
out({ event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'Done.', usage: { input_tokens: 50, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 10 }, denied_actions: denied } });
console.log('jetski: a note that is not JSON');
`;

describe('built-in design agent on Codex and Antigravity', () => {
  let dir: string;
  let codexCommand: string[];
  let agyCommand: string[];
  let codexLog: string;
  let agyLog: string;
  let agySettings: string;
  const calls = async (log: string) =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; prompt: string; cwd: string });

  beforeAll(async () => {
    dir = await mkdtemp(join(home, 'fake-clis-'));
    codexLog = join(dir, 'codex-calls.jsonl');
    agyLog = join(dir, 'agy-calls.jsonl');
    await writeFile(join(dir, 'codex.cjs'), FAKE_CODEX);
    await writeFile(join(dir, 'agy.cjs'), FAKE_AGY);
    codexCommand = [process.execPath, join(dir, 'codex.cjs'), codexLog];
    agyCommand = [process.execPath, join(dir, 'agy.cjs'), agyLog];
    agySettings = join(dir, 'agy-home', 'settings.json');
    // Codex reads the user's default model from CODEX_HOME/config.toml.
    process.env.CODEX_HOME = join(dir, 'codex-home');
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(join(process.env.CODEX_HOME, 'config.toml'), 'model = "gpt-test"\n\n[tui]\nmodel = "not-this-one"\n');
  });

  afterAll(() => {
    delete process.env.CODEX_HOME;
  });

  async function cliChat(runner: 'codex' | 'agy', name: string, model?: string) {
    const doc = await server.env.store.create({ name });
    server.env.hub.adopt(doc);
    const settings = new AgentSettings(join(dir, `${runner}-${doc.id}.json`), NO_PROBES);
    await settings.update({ runner, ...(model ? { model } : {}) });
    const agents = new AgentService({
      runtime: new ToolRuntime(server.env),
      settings,
      getDoc: (id) => server.env.hub.peek(id)?.doc,
      viewFor: () => null,
      emit: () => {},
      codex: { mcpUrl: 'http://127.0.0.1:1/mcp', dir: join(dir, 'codex-run'), command: codexCommand },
      agy: { mcpUrl: 'http://127.0.0.1:1/mcp', dir: join(dir, 'agy-run'), command: agyCommand, settingsPath: agySettings },
    });
    return agents.chat(doc.id);
  }

  it('runs a turn on Codex with only the design tools, then resumes its thread', async () => {
    const chat = await cliChat('codex', 'Codex test');
    await chat.send('Generate a hero image');

    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(chat.items[1]).toMatchObject({ kind: 'assistant', text: 'Placing the image.', thinking: 'Planning.' });
    expect(chat.items[2]).toMatchObject({ kind: 'tool', name: 'create_artboard', status: 'done', summary: 'Created artboard “Hero shot”' });
    expect(chat.items[3]).toMatchObject({ kind: 'assistant', text: 'Done.' });
    expect(chat.usage).toEqual({ inputTokens: 40, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 0 });

    const [first] = await calls(codexLog);
    const args = first!.args;
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['--json', '--skip-git-repo-check', '--ignore-user-config']));
    expect(args.join(' ')).toContain('--disable shell_tool --disable unified_exec');
    expect(args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'approval_policy="never"', 'mcp_servers.openpaper.url="http://127.0.0.1:1/mcp"', 'mcp_servers.openpaper.default_tools_approval_mode="approve"', 'model_reasoning_effort="high"']));
    // The user's own default model, from the top of their config.toml.
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-test');
    expect(args.at(-1)).toBe('-');
    expect(first!.cwd).toBe(join(dir, 'codex-run'));
    const instructions = await readFile(join(dir, 'codex-run', 'AGENTS.md'), 'utf8');
    expect(instructions).toContain("You are OpenPaper's built-in design agent");
    expect(instructions).toContain('image_gen');
    expect(instructions).toContain('paper-asset:///');
    expect(first!.prompt).toContain('<context>');
    expect(first!.prompt).toContain('Generate a hero image');

    await chat.send('Make it warmer');
    const second = (await calls(codexLog)).at(-1)!.args;
    expect(second.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second.at(-2)).toBe('thread-1');
  });

  it('passes the Codex model the user picked', async () => {
    const chat = await cliChat('codex', 'Codex model', 'gpt-picked');
    await chat.send('Hello');
    const args = (await calls(codexLog)).at(-1)!.args;
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-picked');
  });

  it('asks the user to sign in to Codex', async () => {
    const chat = await cliChat('codex', 'Codex signed out');
    await chat.send('SIGNED_OUT');
    const last = chat.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last.kind === 'notice' && last.text).toContain('codex login');
    expect(chat.running).toBe(false);
  });

  it('asks before running Antigravity without its permission', async () => {
    const chat = await cliChat('agy', 'agy not allowed');
    await chat.send('Hello');
    const last = chat.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last.kind === 'notice' && last.text).toContain('Allow');
    expect(existsSync(agyLog)).toBe(false);
  });

  it('runs a turn on Antigravity from its own workspace, then resumes the conversation', async () => {
    await allowAgyDesignTools(agySettings);
    const chat = await cliChat('agy', 'agy test');
    await chat.send('Generate a hero image');

    // Reading OpenPaper's tool docs stays out of the chat.
    expect(chat.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(chat.items[1]).toMatchObject({ kind: 'assistant', text: 'Making an image.' });
    expect(chat.items[2]).toMatchObject({ kind: 'tool', name: 'generate_image', status: 'done', summary: 'Generated image “hero”' });
    expect(chat.items[3]).toMatchObject({ kind: 'tool', name: 'create_artboard', status: 'done', summary: 'Created artboard “Hero”' });
    expect(chat.items[4]).toMatchObject({ kind: 'assistant', text: 'Done.' });
    expect(chat.usage).toEqual({ inputTokens: 50, outputTokens: 7, cacheReadTokens: 10, cacheWriteTokens: 0 });

    const [first] = await calls(agyLog);
    const run = join(dir, 'agy-run');
    expect(first!.cwd).toBe(run);
    expect(first!.args.slice(0, 2)).toEqual(['--output-format', 'stream-json']);
    expect(first!.args).not.toContain('--model');
    expect(first!.args).not.toContain('--conversation');
    expect(first!.prompt).toContain('<context>');
    expect(await readFile(join(run, 'AGENTS.md'), 'utf8')).toContain('image-generator');
    const plugin = join(run, '.agents', 'plugins', 'openpaper');
    expect(JSON.parse(await readFile(join(plugin, 'mcp_config.json'), 'utf8'))).toEqual({ mcpServers: { openpaper: { url: 'http://127.0.0.1:1/mcp' } } });
    const hooks = JSON.parse(await readFile(join(plugin, 'hooks.json'), 'utf8'));
    expect(hooks.openpaper.PreToolUse[0].matcher).toBe('*');
    expect(hooks.openpaper.Stop).toHaveLength(1);
    expect(existsSync(join(plugin, 'hook.cjs'))).toBe(true);

    await chat.send('Make it warmer');
    const second = (await calls(agyLog)).at(-1)!.args;
    expect(second[second.indexOf('--conversation') + 1]).toBe('conv-1');
  });

  it('reports a refused design tool on Antigravity', async () => {
    await allowAgyDesignTools(agySettings);
    const chat = await cliChat('agy', 'agy denied');
    await chat.send('DENIED');
    const last = chat.items.at(-1)!;
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last.kind === 'notice' && last.text).toContain("hasn't allowed OpenPaper's design tools");
  });

  it("only lets OpenPaper's tools through agy's hook, and waits for images", async () => {
    await allowAgyDesignTools(agySettings);
    const chat = await cliChat('agy', 'agy gate');
    await chat.send('Hello');
    const hook = join(dir, 'agy-run', '.agents', 'plugins', 'openpaper', 'hook.cjs');
    const schemas = join(dirname(agySettings), 'mcp', 'openpaper_openpaper');
    const artifacts = join(dir, 'brain', 'conv-1');
    const run = (payload: unknown) => JSON.parse(spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8' }).stdout) as { decision?: string; reason?: string };
    const decide = (toolCall: unknown) => run({ toolCall, artifactDirectoryPath: artifacts });
    expect(decide({ name: 'call_mcp_tool', args: { ServerName: 'openpaper_openpaper', ToolName: 'write_html' } }).decision).toBe('allow');
    expect(decide({ name: 'call_mcp_tool', args: { ServerName: 'github_github', ToolName: 'create_issue' } }).decision).toBe('deny');
    expect(decide({ name: 'generate_image', args: { Prompt: 'a cat' } }).decision).toBe('allow');
    expect(decide({ name: 'run_command', args: { CommandLine: 'echo hi' } }).decision).toBe('deny');
    expect(decide({ name: 'write_to_file', args: { TargetFile: join(dir, 'x.txt') } }).decision).toBe('deny');
    expect(decide({ name: 'read_file', args: { Path: join(schemas, 'write_html.json') } }).decision).toBe('allow');
    expect(decide({ name: 'view_file', args: { AbsolutePath: join(artifacts, 'hero.png') } }).decision).toBe('allow');
    expect(decide({ name: 'read_file', args: { Path: join(dir, 'agy-home', 'settings.json') } }).decision).toBe('deny');
    expect(decide({ name: 'read_file', args: { Path: `${schemas}-evil${'/'}x.json` } }).decision).toBe('deny');
    // agy's main agent makes images through its image subagent, which messages back the file.
    expect(decide({ name: 'invoke_subagent', args: { TypeName: 'image-generator' } }).decision).toBe('allow');
    expect(decide({ name: 'invoke_subagent', args: { TypeName: 'browser' } }).decision).toBe('deny');
    expect(decide({ name: 'wait_5_seconds', args: {} }).decision).toBe('allow');
    // While the image subagent works, stopping waits for it.
    expect(run({ fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })).toMatchObject({ decision: 'continue' });
    expect(run({ fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })).toEqual({});
  });

  it('adds the agy allow rule once, keeping the rest of its settings', async () => {
    const path = join(dir, 'allow-test', 'settings.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ model: 'Gemini', permissions: { allow: ['command(ls)'], deny: ['command(rm)'] }, trustedWorkspaces: ['C:/work'] }));
    await allowAgyDesignTools(path);
    await allowAgyDesignTools(path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      model: 'Gemini',
      permissions: { allow: ['command(ls)', AGY_RULE], deny: ['command(rm)'] },
      trustedWorkspaces: ['C:/work'],
    });

    const fresh = join(dir, 'allow-fresh', 'settings.json');
    await allowAgyDesignTools(fresh);
    expect(JSON.parse(await readFile(fresh, 'utf8'))).toEqual({ permissions: { allow: [AGY_RULE] } });

    // A file it can't read is the user's to fix, never overwritten.
    const broken = join(dir, 'allow-broken', 'settings.json');
    await mkdir(dirname(broken), { recursive: true });
    await writeFile(broken, '{ "model": "Gemini", // a comment\n}');
    await expect(allowAgyDesignTools(broken)).rejects.toThrow(AGY_RULE);
    expect(await readFile(broken, 'utf8')).toBe('{ "model": "Gemini", // a comment\n}');
  });

  it('reports Codex and agy installs as they report themselves', async () => {
    expect(await codexStatus(codexCommand)).toEqual({ version: '0.160.0', loggedIn: true, plan: 'ChatGPT' });
    expect(await codexStatus(null)).toBeNull();
    const settingsPath = join(dir, 'status', 'settings.json');
    expect(await agyStatus(agyCommand, settingsPath)).toEqual({ version: '1.4.8', allowed: false });
    await allowAgyDesignTools(settingsPath);
    expect(await agyStatus(agyCommand, settingsPath)).toEqual({ version: '1.4.8', allowed: true });
  });

  it('keeps a model per runner, with the CLI default as ""', async () => {
    const settings = new AgentSettings(join(dir, 'models.json'), { ...NO_PROBES, codexModels: async () => [{ id: 'gpt-a', label: 'GPT A' }], codexDefault: async () => 'gpt-a' });
    await settings.update({ runner: 'codex', model: 'gpt-a' });
    expect(await settings.resolved()).toMatchObject({ runner: 'codex', model: 'gpt-a' });
    const info = await settings.info();
    expect(info.models).toEqual([{ id: '', label: 'Default (gpt-a)' }, { id: 'gpt-a', label: 'GPT A' }]);
    // A model can't smuggle in a flag.
    await settings.update({ model: '--dangerously-bypass-approvals-and-sandbox' });
    expect((await settings.resolved()).model).toBe('');
    // The Claude model is untouched.
    await settings.update({ runner: 'claude-code' });
    expect((await settings.resolved()).model).toBe('claude-opus-5-5');
  });
});
