import { create } from 'zustand';
import {
  applyPatch,
  type ActivityEntry,
  type AgentChatItem,
  type AgentPresence,
  type AgentUsage,
  type NodeRecord,
  type PaperDocument,
  type ResourceInfo,
} from '@openpaper/core';
import type { ConnectionState } from '../sync/client.ts';

export type Tool = 'select' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'text' | 'pencil' | 'comment';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type LeftTab = 'layers' | 'tokens';
export type RightTab = 'design' | 'code' | 'comments' | 'agents';

export interface Toast {
  id: number;
  text: string;
}

/** Live, uncommitted overrides while a gesture is in progress (drag, resize). */
export type TransientStyles = Record<string, Record<string, string>>;

export interface EditorState {
  connection: ConnectionState;
  resources: ResourceInfo[];

  doc: PaperDocument | null;
  version: number;
  pageId: string | null;
  selection: string[];
  hoverId: string | null;
  editingTextId: string | null;
  tool: Tool;
  cameras: Record<string, Camera>;
  transient: TransientStyles;

  agents: AgentPresence[];
  activity: ActivityEntry[];

  leftTab: LeftTab;
  rightTab: RightTab;
  showConnect: boolean;
  showExport: boolean;
  toasts: Toast[];
  focusedThreadId: string | null;
  /** An agent opened another file; the editor offers to switch to it. */
  agentOpened: { fileId: string; pageId: string | null; agentName: string } | null;
  /** Nodes an agent just created or changed (brief highlight on the canvas). */
  flashes: Array<{ id: string; color: string; at: number; kind: 'write' | 'edit' }>;
  /** A comment being written (placed with the comment tool). */
  pendingComment: { nodeId: string | null; world: { x: number; y: number } } | null;
  /** Built-in agent chat for the open file. */
  agentChat: { items: AgentChatItem[]; running: boolean; usage: AgentUsage | null; open: boolean };
}

export const useEditor = create<EditorState>(() => ({
  connection: 'connecting',
  resources: [],
  doc: null,
  version: 0,
  pageId: null,
  selection: [],
  hoverId: null,
  editingTextId: null,
  tool: 'select',
  cameras: {},
  transient: {},
  agents: [],
  activity: [],
  leftTab: 'layers',
  rightTab: 'design',
  showConnect: false,
  showExport: false,
  toasts: [],
  focusedThreadId: null,
  agentOpened: null,
  flashes: [],
  pendingComment: null,
  agentChat: { items: [], running: false, usage: null, open: false },
}));

export const getState = useEditor.getState;
export const setState = useEditor.setState;

export function getNode(id: string | null | undefined): NodeRecord | undefined {
  if (!id) return undefined;
  return getState().doc?.nodes[id];
}

export function camera(pageId: string | null = getState().pageId): Camera {
  return (pageId && getState().cameras[pageId]) || { x: 0, y: 0, zoom: 1 };
}

export function setCamera(next: Camera, pageId = getState().pageId) {
  if (!pageId) return;
  const zoom = Math.min(256, Math.max(0.02, next.zoom));
  setState((s) => ({ cameras: { ...s.cameras, [pageId]: { ...next, zoom } } }));
}

export function setDocument(doc: PaperDocument, version: number) {
  setState((s) => {
    const pageId =
      s.pageId && doc.pages[s.pageId] ? s.pageId : (doc.pageList.find((p) => p.type === 'page')?.id ?? null);
    const selection = s.doc?.id === doc.id ? s.selection.filter((id) => doc.nodes[id]) : [];
    return { doc, version, pageId, selection, transient: {}, editingTextId: null };
  });
}

/** Apply a server patch to the open document. */
export function applyServerPatch(fileId: string, version: number, patch: Parameters<typeof applyPatch>[1]) {
  setState((s) => {
    if (!s.doc || s.doc.id !== fileId) return s;
    const doc = applyPatch(s.doc, patch);
    const removed = new Set(patch.nodes?.remove ?? []);
    const selection = removed.size ? s.selection.filter((id) => !removed.has(id) && doc.nodes[id]) : s.selection;
    let pageId = s.pageId;
    if (pageId && !doc.pages[pageId]) pageId = doc.pageList.find((p) => p.type === 'page')?.id ?? null;
    // Drop transient overrides for nodes the server just confirmed.
    let transient = s.transient;
    if (patch.nodes?.upsert.length && Object.keys(transient).length) {
      transient = { ...transient };
      for (const n of patch.nodes.upsert) delete transient[n.id];
    }
    return {
      doc,
      version,
      selection,
      pageId,
      transient,
      editingTextId: s.editingTextId && doc.nodes[s.editingTextId] ? s.editingTextId : null,
      hoverId: s.hoverId && doc.nodes[s.hoverId] ? s.hoverId : null,
    };
  });
}

let toastId = 1;
export function toast(text: string, ms = 2600) {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
