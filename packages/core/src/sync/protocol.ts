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
  /**
   * A file's version control changed (an edit reached its folder, a commit, a branch switch): editors
   * showing it ask for `vcs.status` again. `notice` is said once, e.g. when the folder was changed outside OpenPaper.
   */
  | { t: 'vcs'; fileId: string; notice?: string }
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

/**
 * What runs the built-in agent: the Anthropic API with a key, or a coding agent the user installed and
 * signed in to themselves (Claude Code, OpenAI's Codex CLI, Google's Antigravity CLI `agy`).
 */
export type AgentRunner = 'api' | 'claude-code' | 'codex' | 'agy';

export interface AgentConfigInfo {
  runner: AgentRunner;
  /** Where the API key comes from (null = not configured). */
  keySource: 'settings' | 'environment' | 'profile' | null;
  /** The local Claude Code install (null = not found). */
  claudeCode: { version: string; loggedIn: boolean; plan: string | null } | null;
  /** The local Codex CLI (null = not found). `plan` is how it signs in ("ChatGPT", "API key"). */
  codex: { version: string; loggedIn: boolean; plan: string | null } | null;
  /**
   * The local Antigravity CLI (null = not found). `allowed`: its settings let OpenPaper's design tools run
   * (headless agy refuses MCP tools without an allow rule).
   */
  agy: { version: string; allowed: boolean } | null;
  /** The current runner's model ("" = the runner's own default). */
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Models the current runner offers. */
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

// ---- version control: a design kept as a folder in a Git repository ----

/** A GitHub account signed in on this computer, through the GitHub CLI (`gh`) or Git's credential manager. */
export interface VcsAccount {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  source: 'gh' | 'git';
  /** The GitHub CLI's active account. */
  active: boolean;
}

/** What version control can use on this computer. */
export interface VcsSetup {
  accounts: VcsAccount[];
  /** Git's version (null: Git isn't installed). */
  git: string | null;
  /** The GitHub CLI is installed. */
  gh: boolean;
  /** Folder repositories are cloned into unless the user picks another. */
  defaultRoot: string;
}

export interface VcsRepo {
  /** `owner/name`. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
  /** No commits yet. */
  empty: boolean;
}

/** The folders of a repository's default branch, to choose where a design goes. */
export interface VcsRepoTree {
  /** Folder paths ('/'-separated, no leading slash). */
  dirs: string[];
  /** Folders that already hold a design (an openpaper.json). */
  designs: string[];
  /** GitHub listed only part of a very large repository. */
  truncated: boolean;
}

/** What a folder on this computer holds, when choosing where a repository lives. */
export interface VcsLocalFolder {
  path: string;
  /** `repo`: the top of a Git repository; `in-repo`: inside one; `files`: holds other things. */
  state: 'missing' | 'empty' | 'repo' | 'in-repo' | 'files';
  repoRoot?: string;
  /** The repository's `origin`, if it has one. */
  remoteUrl?: string | null;
  /** `origin` is the GitHub repository asked about. */
  matches?: boolean;
}

/** Where to keep a design that starts being tracked. */
export type VcsTrackPlan =
  | {
      kind: 'github';
      account: string;
      /** A repository of the account, or a new one to create. */
      repo: { fullName: string } | { create: { name: string; private: boolean } };
      /** The repository's folder on this computer (cloned there when it isn't yet). */
      local: string;
      /** The design's folder inside the repository ('' = the repository is the design folder). */
      path: string;
    }
  /** A folder on this computer only: inside a repository it joins it, else it becomes one. */
  | { kind: 'local'; dir: string };

export interface VcsChange {
  /** Path inside the design folder. */
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  /** What changed, in the design's terms: `Page “Home”`, `Tokens`, `Image`. */
  label: string;
}

export interface VcsStatus {
  tracked: boolean;
  /** The design folder. */
  dir?: string;
  repoRoot?: string;
  /** The design folder inside the repository ('' = the repository root). */
  path?: string;
  /** Current branch (null: detached HEAD). */
  branch?: string | null;
  /** Remote branch it follows, e.g. `origin/main` (null: never pushed). */
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  remote?: { url: string; fullName: string | null; webUrl: string | null } | null;
  account?: string | null;
  changes?: VcsChange[];
  /** Latest commit (null: none yet). */
  head?: string | null;
  /** Something stops version control (the folder is gone, Git isn't installed); shown instead of the controls. */
  problem?: string;
}

export interface VcsCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** ISO date. */
  date: string;
  /** Already on the remote branch. */
  pushed: boolean;
  /** The commit's page on GitHub (null: not on GitHub, or not pushed). */
  url: string | null;
}

export interface VcsBranch {
  name: string;
  current: boolean;
  /** On this computer / on the remote. */
  local: boolean;
  remote: boolean;
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
