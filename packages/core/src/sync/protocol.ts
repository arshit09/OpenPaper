import type { Patch } from '../model/transaction.ts';
import type { LayoutMap, PaperDocument } from '../model/types.ts';

/**
 * Editor ⇄ server WebSocket protocol (JSON messages, one per frame).
 *
 * The server owns every document. Editors send commands; the server applies
 * them and broadcasts the resulting Patch to all editors viewing that file.
 */
export const PROTOCOL_VERSION = 1;

export interface ActorInfo {
  kind: 'user' | 'agent' | 'system';
  id: string;
  name: string;
}

/** A connected MCP agent, as shown in the editor. */
export interface AgentPresence {
  sessionId: string;
  name: string;
  /** Short client identifier (e.g. "claude-code", "cursor"). */
  clientId: string;
  color: string;
  /** Artboards the agent is currently working on (working indicators). */
  workingOn: string[];
  /** Node the agent touched most recently (for the agent cursor). */
  lastNodeId: string | null;
  /** Last tool the agent ran. */
  lastTool: string | null;
  lastActiveAt: number;
}

export interface ActivityEntry {
  id: string;
  at: number;
  actor: ActorInfo;
  tool: string;
  summary: string;
  isError: boolean;
  durationMs: number;
}

export interface ResourceInfo {
  id: string;
  type: 'file' | 'folder';
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  open?: boolean;
  active?: boolean;
  /**
   * Preview of the file's canvas (absent until one has been taken, or when there is nothing to show).
   * The image is transparent where the canvas shows: `background` is the page's canvas colour, or
   * null for the editor's own.
   */
  thumbnail?: { url: string; background: string | null };
}

export interface ViewState {
  fileId: string | null;
  pageId: string | null;
  selection: string[];
  /** Whether the editor tab currently has focus / is visible. */
  focused: boolean;
  viewport?: { x: number; y: number; zoom: number; width: number; height: number };
}

export type ClientMessage =
  | { t: 'hello'; protocol: number; clientId?: string; name?: string }
  | { t: 'req'; id: number; method: string; params?: unknown }
  | { t: 'rpc-res'; id: number; result?: unknown; error?: string };

export type ServerMessage =
  | { t: 'welcome'; clientId: string; serverVersion: string; protocol: number; mcpUrl: string }
  | { t: 'res'; id: number; result?: unknown; error?: string }
  | { t: 'patch'; fileId: string; version: number; patch: Patch; actor: ActorInfo; label: string }
  | { t: 'presence'; fileId: string; agents: AgentPresence[] }
  | { t: 'activity'; fileId: string; entry: ActivityEntry }
  | { t: 'resources'; resources: ResourceInfo[] }
  | { t: 'navigate'; fileId: string; pageId?: string | null; nodeId?: string | null }
  /** An MCP agent opened a file (editors may offer to show it). */
  | { t: 'agent-opened'; fileId: string; pageId: string | null; agentName: string }
  /** Built-in agent progress for a chat (`fileId` is the chat key: a file id, or `site:<id>` for a live site). */
  | { t: 'agent'; fileId: string; event: AgentEvent }
  /** Local speech-to-text engine status (download progress, ready). */
  | { t: 'speech'; status: SpeechStatus }
  | { t: 'rpc'; id: number; method: string; params?: unknown };

/** Built-in design agent (chat panel). `target` names what the user pointed at when they sent it. */
export type AgentChatItem =
  | { kind: 'user'; id: string; text: string; target?: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'done' | 'error'; summary: string }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string };

export type AgentEvent =
  | { type: 'item'; item: AgentChatItem }
  | { type: 'delta'; id: string; text?: string; thinking?: string }
  | { type: 'tool'; id: string; status: 'running' | 'done' | 'error'; summary?: string }
  | { type: 'status'; running: boolean; usage?: AgentUsage }
  | { type: 'reset' };

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentConfigInfo {
  /** What runs the agent: the Anthropic API with a key, or the user's own Claude Code install and sign-in. */
  runner: 'api' | 'claude-code';
  /** Where the API key comes from (null = not configured). */
  keySource: 'settings' | 'environment' | 'profile' | null;
  /** The local Claude Code install (null = not found). */
  claudeCode: { version: string; loggedIn: boolean; plan: string | null } | null;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  models: Array<{ id: string; label: string }>;
}

/** An element the user clicked on a live site (reported by the inspector the site proxy injects). */
export interface SiteElementInfo {
  /** Unique-ish CSS path. */
  selector: string;
  tag: string;
  id?: string;
  classes: string[];
  text: string;
  /** outerHTML, truncated. */
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  attributes: Record<string, string>;
  /** A few computed styles (color, font-size, padding…). */
  styles: Record<string, string>;
  /** Nearest first. */
  ancestors: Array<{ tag: string; id?: string; classes: string[] }>;
  /** Source location from the framework's dev-mode metadata, when exposed. */
  source?: { file: string; line?: number; column?: number };
  /** Owning components, innermost first. */
  components?: string[];
  framework?: string;
}

/** What a message to the agent is about: layers on the canvas, or elements on a live site. */
export interface AgentTarget {
  /** Short name for the chat bubble ("Card", "button “Get started”"). */
  label: string;
  nodeIds?: string[];
  elements?: SiteElementInfo[];
}

/** A user's own running website opened in OpenPaper, with the project folder the agent edits. */
export interface SiteInfo {
  id: string;
  name: string;
  url: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export type SpeechState = 'unavailable' | 'not-installed' | 'downloading' | 'loading' | 'ready' | 'error';

/** The local speech-to-text engine behind the mic buttons. */
export interface SpeechStatus {
  /** Human label, e.g. "Parakeet TDT 0.6B v3". */
  engine: string;
  state: SpeechState;
  /** Size of the one-time model download. */
  sizeBytes: number;
  downloadedBytes: number;
  error?: string;
}

/** Response to `file.open`. */
export interface OpenFileResult {
  doc: PaperDocument;
  version: number;
  agents: AgentPresence[];
  activity: ActivityEntry[];
}

/** Server → editor RPCs (the editor implements these). */
export interface EditorRpc {
  /** Measure layout of a page after rendering `version` (or newer). */
  measure(params: { fileId: string; pageId: string; version: number }): Promise<LayoutMap>;
  /** Rasterize a node in the editor (fallback when no headless browser is available). */
  screenshot(params: { fileId: string; nodeId: string; scale: number; format: 'png' | 'jpeg' }): Promise<{
    data: string;
    mimeType: string;
    width: number;
    height: number;
  }>;
}
