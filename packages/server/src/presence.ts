import { artboardOf, isAncestorOf, readerOf, type ActivityEntry, type AgentPresence, type PaperDocument } from '@openpaper/core';
import type { McpSession } from './mcp/http.ts';

/** How long a node stays "touched" by an agent after its last activity (Paper: 40 s). */
export const ACTIVITY_TTL_MS = 40_000;
const MAX_ACTIVITY_LOG = 200;

export type ActivityKind = 'read' | 'write' | 'edit' | 'delete';

const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  'local-agent-mode-Paper': 'Claude',
  'cursor-vscode': 'Cursor',
  cursor: 'Cursor',
  'github-copilot-developer': 'GitHub Copilot',
  'Visual Studio Code': 'VS Code',
  opencode: 'OpenCode',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  'antigravity-client': 'Antigravity',
  'gemini-cli-mcp-client': 'Gemini CLI',
  'windsurf-client': 'Windsurf',
  zed: 'Zed',
  'openpaper-agent': 'OpenPaper Agent',
  'mcp-inspector': 'MCP Inspector',
};

const COLORS = ['#8B5CF6', '#F97316', '#10B981', '#3B82F6', '#EC4899', '#EAB308', '#14B8A6', '#EF4444'];

/** Recognizable colors for well-known harnesses. */
const HARNESS_COLORS: Record<string, string> = {
  'claude-code': '#D97757',
  'claude-ai': '#D97757',
  'local-agent-mode-Paper': '#D97757',
  'openpaper-agent': '#D97757',
  'cursor-vscode': '#2563EB',
  cursor: '#2563EB',
  'codex-mcp-client': '#10A37F',
  codex: '#10A37F',
  'Visual Studio Code': '#0EA5E9',
  'github-copilot-developer': '#8957E5',
  'gemini-cli-mcp-client': '#4F46E5',
  'antigravity-client': '#4F46E5',
  'windsurf-client': '#14B8A6',
  opencode: '#F59E0B',
};

export function harnessLabel(info: { name: string; title?: string }): string {
  return HARNESS_LABELS[info.name] ?? info.title ?? (info.name === 'unknown' ? 'Agent' : info.name);
}

function colorFor(key: string): string {
  if (HARNESS_COLORS[key]) return HARNESS_COLORS[key]!;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

interface NodeActivity {
  kind: ActivityKind;
  at: number;
}

interface AgentState {
  sessionId: string;
  name: string;
  clientId: string;
  color: string;
  /** fileId → nodeId → activity */
  files: Map<string, Map<string, NodeActivity>>;
  lastTool: string | null;
  lastNodeId: string | null;
  lastActiveAt: number;
}

/** Live agent presence per file: who is working where, plus an activity log. */
export class PresenceService {
  private readonly agents = new Map<string, AgentState>();
  private readonly logs = new Map<string, ActivityEntry[]>();
  private sweepTimer: NodeJS.Timeout;
  private seq = 1;

  constructor(
    private readonly getDoc: (fileId: string) => PaperDocument | undefined,
    private readonly onPresence: (fileId: string, agents: AgentPresence[]) => void,
    private readonly onActivity: (fileId: string, entry: ActivityEntry) => void
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 2_000);
    this.sweepTimer.unref();
  }

  private agentFor(session: McpSession): AgentState {
    let agent = this.agents.get(session.id);
    if (!agent) {
      agent = {
        sessionId: session.id,
        name: harnessLabel(session.clientInfo),
        clientId: session.clientInfo.name,
        color: colorFor(session.clientInfo.name),
        files: new Map(),
        lastTool: null,
        lastNodeId: null,
        lastActiveAt: Date.now(),
      };
      this.agents.set(session.id, agent);
    } else {
      agent.name = harnessLabel(session.clientInfo);
      agent.clientId = session.clientInfo.name;
    }
    return agent;
  }

  /** Record that an agent read or changed nodes. */
  record(session: McpSession, fileId: string, nodeIds: string[], kind: ActivityKind, tool: string) {
    const agent = this.agentFor(session);
    const now = Date.now();
    agent.lastTool = tool;
    agent.lastActiveAt = now;
    if (nodeIds.length) agent.lastNodeId = nodeIds[nodeIds.length - 1]!;
    let nodes = agent.files.get(fileId);
    if (!nodes) {
      nodes = new Map();
      agent.files.set(fileId, nodes);
    }
    // A read refreshes the timestamp but never downgrades an earlier write/edit.
    for (const id of nodeIds) nodes.set(id, { kind: kind === 'read' ? (nodes.get(id)?.kind ?? 'read') : kind, at: now });
    this.publish(fileId);
  }

  /** finish_working_on_nodes: drop activity for nodes (and their descendants), or everything. */
  finish(session: McpSession, fileId: string, nodeIds?: string[]) {
    const agent = this.agents.get(session.id);
    if (!agent) return;
    const nodes = agent.files.get(fileId);
    if (!nodes) return;
    if (!nodeIds?.length) {
      agent.files.delete(fileId);
    } else {
      const doc = this.getDoc(fileId);
      const reader = doc ? readerOf(doc) : null;
      for (const id of [...nodes.keys()]) {
        if (nodeIds.includes(id) || (reader && nodeIds.some((root) => isAncestorOf(reader, root, id)))) nodes.delete(id);
      }
      if (!nodes.size) agent.files.delete(fileId);
    }
    this.publish(fileId);
  }

  /** The MCP session ended. */
  removeAgent(sessionId: string) {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    this.agents.delete(sessionId);
    for (const fileId of agent.files.keys()) this.publish(fileId);
  }

  log(fileId: string, entry: Omit<ActivityEntry, 'id'>) {
    const full: ActivityEntry = { id: String(this.seq++), ...entry };
    const list = this.logs.get(fileId) ?? [];
    list.push(full);
    if (list.length > MAX_ACTIVITY_LOG) list.shift();
    this.logs.set(fileId, list);
    this.onActivity(fileId, full);
  }

  activityFor(fileId: string): ActivityEntry[] {
    return this.logs.get(fileId) ?? [];
  }

  presenceFor(fileId: string): AgentPresence[] {
    const doc = this.getDoc(fileId);
    const reader = doc ? readerOf(doc) : null;
    const out: AgentPresence[] = [];
    for (const agent of this.agents.values()) {
      const nodes = agent.files.get(fileId);
      if (!nodes?.size) continue;
      const boards = new Set<string>();
      if (reader) {
        for (const id of nodes.keys()) {
          const board = artboardOf(reader, id);
          if (board) boards.add(board.id);
        }
      }
      out.push({
        sessionId: agent.sessionId,
        name: agent.name,
        clientId: agent.clientId,
        color: agent.color,
        workingOn: [...boards],
        lastNodeId: agent.lastNodeId,
        lastTool: agent.lastTool,
        lastActiveAt: agent.lastActiveAt,
      });
    }
    return out;
  }

  private publish(fileId: string) {
    this.onPresence(fileId, this.presenceFor(fileId));
  }

  private sweep() {
    const now = Date.now();
    const touched = new Set<string>();
    for (const agent of this.agents.values()) {
      for (const [fileId, nodes] of agent.files) {
        for (const [id, a] of nodes) {
          if (now - a.at > ACTIVITY_TTL_MS) {
            nodes.delete(id);
            touched.add(fileId);
          }
        }
        if (!nodes.size) agent.files.delete(fileId);
      }
    }
    for (const fileId of touched) this.publish(fileId);
  }

  close() {
    clearInterval(this.sweepTimer);
  }
}
