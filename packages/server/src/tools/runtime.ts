import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseFileReference, tokensContentHash } from '@openpaper/core';
import type { LiveDocument } from '../hub.ts';
import type { McpRuntime, McpSession } from '../mcp/http.ts';
import { harnessLabel } from '../presence.ts';
import { VERSION } from '../version.ts';
import { getCommentThread, listCommentThreadAuthors, listCommentThreads, setCommentThreadStatus } from './comment-tools.ts';
import { ToolError, type Call, type HandlerResult, type ToolEnv } from './context.ts';
import { inputSchemaFor, mcpToolList, TOOLS_BY_NAME, type ToolScope } from './definitions.ts';
import { exportCombinedPdf, exportNodes } from './export-tools.ts';
import { arrangePages, createFile, createPage, getGuide, listResources, openFile, renameResource, updatePages } from './file-tools.ts';
import { SERVER_INSTRUCTIONS } from './guides.ts';
import {
  findNodes,
  getBasicInfo,
  getChildren,
  getComputedStyles,
  getFillImage,
  getFontFamilyInfo,
  getJsx,
  getNodeInfo,
  getScreenshot,
  getSelection,
  getTreeSummary,
} from './read-tools.ts';
import { createTokens, getTokens, setTokens } from './token-tools.ts';
import {
  createArtboard,
  deleteNodes,
  duplicateNodes,
  finishWorkingOnNodes,
  moveNodes,
  renameNodes,
  setTextContent,
  updateStyles,
  writeHtml,
} from './write-tools.ts';
import { updateShader } from './shader-tools.ts';

const TOOL_TIMEOUT_MS = 60_000;

const HANDLERS: Record<string, (call: Call) => Promise<HandlerResult>> = {
  get_basic_info: getBasicInfo,
  get_selection: getSelection,
  get_node_info: getNodeInfo,
  get_children: getChildren,
  get_screenshot: getScreenshot,
  get_jsx: getJsx,
  get_tree_summary: getTreeSummary,
  get_computed_styles: getComputedStyles,
  get_fill_image: getFillImage,
  find_nodes: findNodes,
  list_comment_threads: listCommentThreads,
  get_comment_thread: getCommentThread,
  list_comment_thread_authors: listCommentThreadAuthors,
  set_comment_thread_status: setCommentThreadStatus,
  get_font_family_info: getFontFamilyInfo,
  get_guide: getGuide,
  open_file: openFile,
  list_resources: listResources,
  create_file: createFile,
  rename_resource: renameResource,
  create_page: createPage,
  update_pages: updatePages,
  arrange_pages: arrangePages,
  write_html: writeHtml,
  create_artboard: createArtboard,
  delete_nodes: deleteNodes,
  set_text_content: setTextContent,
  update_shader: updateShader,
  rename_nodes: renameNodes,
  update_styles: updateStyles,
  duplicate_nodes: duplicateNodes,
  move_nodes: moveNodes,
  finish_working_on_nodes: finishWorkingOnNodes,
  export: exportNodes,
  export_combined_pdf: exportCombinedPdf,
  get_tokens: getTokens,
  create_tokens: createTokens,
  set_tokens: setTokens,
};

for (const name of TOOLS_BY_NAME.keys()) {
  if (!HANDLERS[name]) throw new Error(`MCP tool "${name}" has no handler`);
}

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function header(live: LiveDocument) {
  return {
    type: 'text' as const,
    text: JSON.stringify({ file: { id: live.id, name: live.doc.name }, contentHash: { tokens: tokensContentHash(live.doc.tokens) } }, null, 2),
  };
}

function toToolResult(result: HandlerResult, scope: ToolScope, live: LiveDocument | null): CallToolResult {
  const prefix = scope !== 'app' && live ? [header(live)] : [];
  if ('content' in result) return { content: [...prefix, ...result.content], ...(result.isError ? { isError: true } : {}) };
  if ('error' in result) return { content: [...prefix, { type: 'text', text: result.error }], isError: true };
  const body = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  return { content: [...prefix, { type: 'text', text: body }] };
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One-line description of a call for the editor's activity feed. */
export function summarize(name: string, args: Record<string, any>): string {
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case 'write_html': {
      const t = strip(String(args.html ?? ''));
      return t ? `Wrote “${t.slice(0, 48)}${t.length > 48 ? '…' : ''}”` : 'Wrote HTML';
    }
    case 'create_artboard':
      return `Created artboard “${args.name}”`;
    case 'update_styles':
      // Runs on the model's input before validation, so any shape can arrive here.
      return `Restyled ${Array.isArray(args.updates) ? args.updates.reduce((s: number, u: { nodeIds?: unknown }) => s + n(u?.nodeIds), 0) : 0} layer(s)`;
    case 'set_text_content':
      return `Edited text in ${n(args.updates)} layer(s)`;
    case 'update_shader':
      return `Adjusted ${n(args.updates)} shader(s)`;
    case 'rename_nodes':
      return `Renamed ${n(args.updates)} layer(s)`;
    case 'delete_nodes':
      return `Deleted ${n(args.nodeIds)} layer(s)`;
    case 'duplicate_nodes':
      return `Duplicated ${n(args.nodes)} layer(s)`;
    case 'move_nodes':
      return `Moved ${n(args.moves)} layer(s)`;
    case 'get_screenshot':
      return 'Looked at the design';
    case 'get_jsx':
      return 'Read code';
    case 'get_tree_summary':
      return 'Read layer structure';
    case 'create_tokens':
      return `Created ${n(args.tokens)} token(s)`;
    case 'set_tokens':
      return `Updated ${n(args.tokens)} token(s)`;
    case 'finish_working_on_nodes':
      return 'Finished working';
    case 'export':
    case 'export_combined_pdf':
      return 'Exported files';
    default:
      return name.replace(/_/g, ' ');
  }
}

export class ToolRuntime implements McpRuntime {
  readonly serverName = 'openpaper';
  readonly serverVersion = VERSION;

  constructor(private readonly env: ToolEnv) {}

  instructions(): string {
    return SERVER_INSTRUCTIONS;
  }

  listTools() {
    return mcpToolList() as ReturnType<McpRuntime['listTools']>;
  }

  onSessionEnded(session: McpSession): void {
    this.env.presence.removeAgent(session.id);
  }

  async callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const def = TOOLS_BY_NAME.get(name);
    if (!def) return text(`Unknown tool: ${name}`, true);
    const parsed = inputSchemaFor(def).safeParse(args);
    if (!parsed.success) {
      return text(
        `Invalid arguments for tool ${name}: ${parsed.error.message}\n\nTry once more, and if it still fails, ask the user to restart their MCP connection to get the latest tool definitions.`,
        true
      );
    }
    const validated = parsed.data as Record<string, any>;
    const actor = { kind: 'agent' as const, id: session.id, name: harnessLabel(session.clientInfo) };

    let live: LiveDocument | null = null;
    if (def.scope !== 'app') {
      let fileId: string | null = null;
      if (validated.fileId !== undefined) {
        const ref = parseFileReference(validated.fileId);
        if (!ref) return text(`Invalid fileId "${String(validated.fileId)}". Expected an OpenPaper file id, /file/<id> route, or file URL.`, true);
        fileId = ref.fileId;
      } else {
        fileId = this.env.views.activeFileId();
      }
      if (!fileId) return text('Open a file in OpenPaper to use this tool, or pass fileId (call list_resources to find files).', true);
      if (!this.env.store.has(fileId)) return text(`File not found: "${fileId}". Use list_resources to find files.`, true);
      live = await this.env.hub.get(fileId);
    }

    const call: Call = { env: this.env, session, actor, def, args: validated, live };
    const started = Date.now();
    let result: HandlerResult;
    let timer: NodeJS.Timeout | undefined;
    try {
      result = await Promise.race([
        HANDLERS[name]!(call),
        new Promise<HandlerResult>((resolve) => {
          timer = setTimeout(() => resolve({ error: 'Tool call timed out. Please check your file then try again.' }), TOOL_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof ToolError) result = { error: error.message };
      else {
        console.error(`[openpaper] tool ${name} failed`, error);
        result = { error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      clearTimeout(timer);
    }
    const out = toToolResult(result, def.scope, live);
    const fileForLog = live?.id ?? (name === 'open_file' ? parseFileReference(validated.fileId)?.fileId : undefined);
    if (fileForLog) {
      this.env.presence.log(fileForLog, {
        at: started,
        actor,
        tool: name,
        summary: summarize(name, validated),
        isError: !!out.isError,
        durationMs: Date.now() - started,
      });
    }
    return out;
  }
}
