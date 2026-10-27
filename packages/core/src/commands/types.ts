import type { NewNode } from '../model/ops.ts';
import type { PageListItem, TextRun, TokenRecord } from '../model/types.ts';

/** Style patch: `null` / `""` removes a property; numbers get `px` where CSS expects lengths. */
export type StyleInput = Record<string, string | number | null>;

/**
 * Mutations the editor UI sends to the server. MCP tools use the same underlying
 * operations, so user edits and agent edits behave identically.
 */
export type EditorCommand =
  | { type: 'createNodes'; parentId: string; index?: number; nodes: NewNode[] }
  /**
   * keepLayout: pasting onto the canvas keeps the layers' relative positions (left/top) as one group.
   * at: put the pasted layers at this position in the parent (paste on top of a selection).
   * replaceIds: each of these layers is replaced by a copy of the pasted layers, in its place.
   */
  | {
      type: 'insertHtml';
      parentId: string;
      index?: number;
      html: string;
      keepLayout?: boolean;
      at?: { x: number; y: number };
      replaceIds?: string[];
    }
  | { type: 'updateStyles'; updates: Array<{ nodeIds: string[]; styles: StyleInput }> }
  /** Shader layers: apply a preset (its background becomes the fill) and/or patch params (null removes). */
  | { type: 'setShaderProps'; nodeIds: string[]; preset?: string; patch?: Record<string, unknown> }
  /** Remember the animation time a shader is showing (not undoable). */
  | { type: 'setShaderFrame'; frames: Record<string, number> }
  /** runs: rich text (text runs with inline styles); without them the node becomes plain text. */
  | { type: 'setText'; nodeId: string; text: string; runs?: TextRun[] }
  | { type: 'rename'; nodeId: string; name: string }
  | { type: 'delete'; nodeIds: string[] }
  | { type: 'move'; moves: Array<{ nodeId: string; parentId: string; index?: number; styles?: StyleInput }> }
  /** place: per source id, where its copy goes (child index, styles such as a drop position) instead of the default spot. */
  | {
      type: 'duplicate';
      nodeIds: string[];
      offset?: { x: number; y: number };
      place?: Record<string, { index?: number; styles?: StyleInput }>;
    }
  | { type: 'setFlags'; nodeIds: string[]; isVisible?: boolean; isLocked?: boolean }
  /** Wrap layers in a new frame. styles are applied to the frame; ordered keeps nodeIds order inside it (else layer order). */
  | { type: 'group'; nodeIds: string[]; label?: string; styles?: StyleInput; ordered?: boolean }
  | { type: 'ungroup'; nodeIds: string[] }
  | { type: 'createPage'; name?: string }
  | { type: 'updatePage'; pageId: string; name?: string; icon?: string | null; canvasColor?: string | null }
  | { type: 'deletePage'; pageId: string }
  | { type: 'duplicatePage'; pageId: string }
  | { type: 'arrangePages'; order: PageListItem[] }
  | { type: 'addDivider'; afterId?: string }
  | { type: 'setTokens'; tokens: TokenRecord[] }
  | { type: 'renameFile'; name: string }
  | { type: 'createComment'; pageId: string; nodeId: string | null; position: { x: number; y: number }; text: string }
  | { type: 'replyComment'; threadId: string; text: string }
  | { type: 'setCommentStatus'; threadId: string; status: 'open' | 'resolved' }
  | { type: 'deleteComment'; threadId: string };

export type CommandType = EditorCommand['type'];

export interface CommandResult {
  ids?: string[];
  idMap?: Record<string, string>;
  pageId?: string;
  threadId?: string;
  warnings?: string[];
}
