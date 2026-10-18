import Anthropic from '@anthropic-ai/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { displayName, type AgentChatItem, type AgentEvent, type AgentUsage, type PaperDocument, type ViewState } from '@openpaper/core';
import type { McpSession } from '../mcp/http.ts';
import { mcpToolList } from '../tools/definitions.ts';
import { MAIN_GUIDE, SERVER_INSTRUCTIONS } from '../tools/guides.ts';
import { summarize, type ToolRuntime } from '../tools/runtime.ts';
import type { AgentSettings } from './settings.ts';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type Message = Anthropic.Beta.BetaMessage;

const MAX_TOKENS = 64_000;
const MAX_TURNS = 80;
const MAX_JSON_RETRIES = 2;

/** Models offered in the chat panel. Opus is the default. */
export const AGENT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

const AGENT_NOTES = `## You are OpenPaper's built-in design agent

The user is chatting with you from a chat box docked on the OpenPaper canvas, which shows your work live. Each message starts with a <context> block describing the file, page and selection they are looking at — use those ids instead of asking.

- Keep chat replies short: a sentence or two between steps, a brief summary at the end. Do the design work with tools, not in prose.
- The design brief from the guide still applies: post it in your reply before creating a new design.
- Work on the user's current file unless they ask otherwise; pass its fileId to every file-scoped tool.
- When you finish, call finish_working_on_nodes and give a one-line summary of what changed.`;

/** The cacheable system prompt: server instructions + full guide + chat notes (never changes per turn). */
const SYSTEM_PROMPT = `${SERVER_INSTRUCTIONS}\n\n${MAIN_GUIDE}\n\n${AGENT_NOTES}`;

let toolsCache: Anthropic.Beta.BetaTool[] | null = null;

/** Our MCP tools as Messages API tools (input streamed as generated; validated before running). */
function apiTools(): Anthropic.Beta.BetaTool[] {
  toolsCache ??= mcpToolList().map((t) => {
    const { $schema: _ignored, ...schema } = t.inputSchema as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
      eager_input_streaming: true,
    };
  });
  return toolsCache;
}

function toToolResultContent(result: CallToolResult): ToolResultBlockParam['content'] {
  const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
  for (const c of result.content) {
    if (c.type === 'text') blocks.push({ type: 'text', text: c.text });
    else if (c.type === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: c.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: c.data },
      });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '(no output)' }];
}

/** The SDK's error for streamed tool input it could not parse at all (not an API error). */
function isToolJsonError(error: unknown): boolean {
  return (
    error instanceof Anthropic.AnthropicError &&
    !(error instanceof Anthropic.APIError) &&
    error.message.startsWith('Unable to parse tool parameter JSON')
  );
}

let itemSeq = 1;
const nextId = () => `a${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

export interface AgentHost {
  runtime: ToolRuntime;
  settings: AgentSettings;
  getDoc(fileId: string): PaperDocument | undefined;
  viewFor(fileId: string): ViewState | null;
  emit(fileId: string, event: AgentEvent): void;
  /** Override for tests. */
  createClient?: (apiKey: string | undefined) => Pick<Anthropic, 'beta'>;
}

/** One conversation with the built-in agent, bound to a file. */
export class AgentChat {
  readonly items: AgentChatItem[] = [];
  private messages: MessageParam[] = [];
  private controller: AbortController | null = null;
  private readonly session: McpSession;
  usage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  constructor(
    readonly fileId: string,
    private readonly host: AgentHost
  ) {
    this.session = {
      id: `openpaper-agent-${fileId}`,
      clientInfo: { name: 'openpaper-agent', title: 'OpenPaper Agent' },
      transport: 'http',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
  }

  get running(): boolean {
    return this.controller !== null;
  }

  private push(item: AgentChatItem) {
    this.items.push(item);
    if (this.items.length > 500) this.items.splice(0, this.items.length - 500);
    this.host.emit(this.fileId, { type: 'item', item });
  }

  private notice(level: 'info' | 'error', text: string) {
    this.push({ kind: 'notice', id: nextId(), level, text });
  }

  reset() {
    this.stop();
    this.items.length = 0;
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    this.host.emit(this.fileId, { type: 'reset' });
  }

  stop() {
    this.controller?.abort();
  }

  /** Describe what the user is looking at (sent with each message, after the cached prefix). */
  private context(): string {
    const doc = this.host.getDoc(this.fileId);
    const view = this.host.viewFor(this.fileId);
    if (!doc) return `<context>fileId: ${this.fileId}</context>`;
    const pageId = view?.pageId && doc.pages[view.pageId] ? view.pageId : doc.pageList.find((p) => p.type === 'page')?.id;
    const page = pageId ? doc.pages[pageId] : undefined;
    const selection = (view?.selection ?? [])
      .map((id) => doc.nodes[id])
      .filter((n) => !!n)
      .slice(0, 20)
      .map((n) => `${n!.id} ${n!.component} "${displayName(n!)}"`);
    return [
      '<context>',
      `fileId: ${doc.id} ("${doc.name}")`,
      page ? `page: ${page.id} ("${page.name}")` : '',
      `selection: ${selection.length ? selection.join('; ') : 'nothing selected'}`,
      '</context>',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async send(text: string): Promise<void> {
    if (this.running) throw new Error('The agent is already working. Stop it first or wait.');
    const config = await this.host.settings.resolved();
    const client = this.host.createClient
      ? this.host.createClient(config.apiKey)
      : new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});

    this.push({ kind: 'user', id: nextId(), text });
    this.messages.push({ role: 'user', content: `${this.context()}\n\n${text}` });

    const controller = new AbortController();
    this.controller = controller;
    this.host.emit(this.fileId, { type: 'status', running: true, usage: this.usage });
    try {
      await this.loop(client, config.model, config.effort, controller.signal);
    } catch (error) {
      if (error instanceof Anthropic.APIUserAbortError || controller.signal.aborted) {
        this.notice('info', 'Stopped.');
      } else if (error instanceof Anthropic.AuthenticationError) {
        this.notice('error', 'The Anthropic API key was rejected. Check it in the agent settings.');
      } else if (error instanceof Anthropic.RateLimitError) {
        this.notice('error', 'Rate limited by the Anthropic API — wait a moment and try again.');
      } else if (error instanceof Anthropic.APIError) {
        this.notice('error', `Anthropic API error ${error.status ?? ''}: ${error.message}`);
      } else if (error instanceof Error && error.message.startsWith('Could not resolve authentication method')) {
        this.notice('error', 'No Anthropic credentials found. Add an API key in the agent settings, set ANTHROPIC_API_KEY, or sign in with `ant auth login`.');
      } else {
        this.notice('error', error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.closeDanglingToolUses();
      this.controller = null;
      this.host.emit(this.fileId, { type: 'status', running: false, usage: this.usage });
    }
  }

  /** If we stopped between a tool_use and its result, answer it so the history stays valid. */
  private closeDanglingToolUses() {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant' || typeof last.content === 'string') return;
    const pending = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use');
    if (!pending.length) return;
    this.messages.push({
      role: 'user',
      content: pending.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, is_error: true, content: 'Stopped by the user before this ran.' })),
    });
  }

  private async loop(client: Pick<Anthropic, 'beta'>, model: string, effort: AgentSettings['defaults']['effort'], signal: AbortSignal) {
    const supportsFallbacks = !model.startsWith('claude-haiku');
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal.aborted) return;
      const textItem: AgentChatItem = { kind: 'assistant', id: nextId(), text: '', thinking: '' };
      let shown = false;
      const show = () => {
        if (!shown) {
          shown = true;
          this.push(textItem);
        }
      };

      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          betas: supportsFallbacks ? ['server-side-fallback-2026-07-01', 'compact-2026-01-12'] : ['compact-2026-01-12'],
          ...(supportsFallbacks ? { fallbacks: 'default' as const } : {}),
          context_management: { edits: [{ type: 'compact_20260112' }] },
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort },
          // Stable prefix (tools → system) is cached; top-level cache_control also caches the growing conversation.
          cache_control: { type: 'ephemeral' },
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: apiTools(),
          messages: this.messages,
        },
        { signal }
      );

      let message: Message;
      try {
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          if (event.delta.type === 'text_delta') {
            show();
            textItem.text += event.delta.text;
            this.host.emit(this.fileId, { type: 'delta', id: textItem.id, text: event.delta.text });
          } else if (event.delta.type === 'thinking_delta') {
            show();
            textItem.thinking += event.delta.thinking;
            this.host.emit(this.fileId, { type: 'delta', id: textItem.id, thinking: event.delta.thinking });
          }
        }
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (error) {
        // Only tool input the SDK could not parse at all is retried; API errors, aborts and anything else propagate.
        if (!isToolJsonError(error) || signal.aborted || jsonRetries++ >= MAX_JSON_RETRIES) throw error;
        this.notice('info', 'A tool call came back malformed; retrying that step.');
        continue;
      }

      const u = message.usage;
      this.usage.inputTokens += u.input_tokens ?? 0;
      this.usage.outputTokens += u.output_tokens ?? 0;
      this.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      this.usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;

      if (message.stop_reason === 'refusal') {
        this.notice('error', 'Claude declined this request. Try rephrasing it.');
        return;
      }
      // Append the full content (thinking + compaction blocks must be kept as-is).
      this.messages.push({ role: 'assistant', content: message.content as unknown as ContentBlockParam[] });

      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!toolUses.length) return; // end_turn and other terminal stops
      if (message.stop_reason === 'max_tokens') {
        this.messages.push({
          role: 'user',
          content: toolUses.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, is_error: true, content: 'Output was cut off (max_tokens). Write smaller pieces.' })),
        });
        continue;
      }

      const results: ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        if (signal.aborted) break;
        const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>;
        const toolItem: AgentChatItem = { kind: 'tool', id: nextId(), name: use.name, status: 'running', summary: summarize(use.name, input) };
        this.push(toolItem);
        // The runtime validates the input against the tool's schema before running it.
        const result = await this.host.runtime.callTool(this.session, use.name, input);
        toolItem.status = result.isError ? 'error' : 'done';
        if (result.isError) {
          const last = [...result.content].reverse().find((c) => c.type === 'text');
          toolItem.summary = last && last.type === 'text' ? last.text.slice(0, 200) : 'Failed';
        }
        this.host.emit(this.fileId, { type: 'tool', id: toolItem.id, status: toolItem.status, summary: toolItem.summary });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: toToolResultContent(result), ...(result.isError ? { is_error: true } : {}) });
      }
      if (signal.aborted) return;
      this.messages.push({ role: 'user', content: results });
    }
    this.notice('info', 'Paused after many steps — say "continue" to keep going.');
  }
}

/** Chats per file. */
export class AgentService {
  private readonly chats = new Map<string, AgentChat>();

  constructor(private readonly host: AgentHost) {}

  chat(fileId: string): AgentChat {
    let c = this.chats.get(fileId);
    if (!c) {
      c = new AgentChat(fileId, this.host);
      this.chats.set(fileId, c);
    }
    return c;
  }

  stopAll() {
    for (const c of this.chats.values()) c.stop();
  }
}
