import type { NewNode } from '../model/ops.ts';
import type { PageListItem, TokenRecord } from '../model/types.ts';

/** Style patch: `null` / `""` removes a property; numbers get `px` where CSS expects lengths. */
export type StyleInput = Record<string, string | number | null>;

/**
 * Mutations the editor UI sends to the server. MCP tools use the same underlying
 * operations, so user edits and agent edits behave identically.
 */
export type EditorCommand =
  | { type: 'createNodes'; parentId: string; index?: number; nodes: NewNode[] }
  | { type: 'insertHtml'; parentId: string; index?: number; html: string }
  | { type: 'updateStyles'; updates: Array<{ nodeIds: string[]; styles: StyleInput }> }
  | { type: 'setText'; nodeId: string; text: string }
  | { type: 'rename'; nodeId: string; name: string }
  | { type: 'delete'; nodeIds: string[] }
  | { type: 'move'; moves: Array<{ nodeId: string; parentId: string; index?: number; styles?: StyleInput }> }
  | { type: 'duplicate'; nodeIds: string[]; offset?: { x: number; y: number } }
  | { type: 'setFlags'; nodeIds: string[]; isVisible?: boolean; isLocked?: boolean }
  | { type: 'group'; nodeIds: string[] }
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
