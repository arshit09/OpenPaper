import { create } from 'zustand';
import {
  applyPatch,
  type ActivityEntry,
  type AgentChatItem,
  type AgentConfigInfo,
  type AgentPresence,
  type AgentUsage,
  type NodeRecord,
  type PaperDocument,
  type ResourceInfo,
  type ShaderProps,
  type SpeechStatus,
  type VcsCommit,
  type VcsStatus,
} from '@openpaper/core';
import type { ConnectionState } from '../sync/client.ts';

export type Tool = 'select' | 'hand' | 'frame' | 'rectangle' | 'ellipse' | 'text' | 'pencil' | 'comment';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type LeftTab = 'layers' | 'tokens';
export type RightTab = 'design' | 'code' | 'comments' | 'agents' | 'version';

export interface Toast {
  id: number;
  text: string;
}

/** An older version of the open file, shown read-only in place of the live one. */
export interface VersionPreview {
  commit: VcsCommit;
  /** The live document meanwhile: server patches keep it current for when the preview ends. */
  live: { doc: PaperDocument; version: number };
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
  /** A comment being written (placed with the comment tool). */
  pendingComment: { nodeId: string | null; world: { x: number; y: number } } | null;
  /** Built-in agent chat for the open file or live site (`key`: file id, or `site:<id>`). */
  agentChat: { key: string | null; items: AgentChatItem[]; running: boolean; usage: AgentUsage | null; open: boolean };
  /** What runs the built-in agent and what's installed (null until first asked). */
  agentConfig: AgentConfigInfo | null;
  /** The ask-the-agent prompt beside the canvas selection is expanded (Mod+K or its button). */
  selectionPrompt: boolean;
  /** Local speech-to-text engine (null until first asked). */
  speech: SpeechStatus | null;
  /** Shader picker popup. */
  showShaders: boolean;
  /** Uncommitted shader params while a control is being dragged (node id → props). */
  shaderPreview: Record<string, ShaderProps>;
  /** Pending question for a Figma paste with images and no Figma token. */
  figmaPrompt: { images: number; resolve: (choice: 'with-images' | 'without-images' | 'cancel') => void } | null;
  /** Keyboard shortcuts help dialog. */
  showShortcuts: boolean;
  /** Show/hide UI (`.` or Ctrl+\): only the canvas stays. */
  uiHidden: boolean;
  /** Side panels collapsed (Shift+\): the top bar stays. */
  panelsCollapsed: boolean;
  /** Comment pins hidden on the canvas (Shift+C). */
  commentsHidden: boolean;
  /** The design's own motion (CSS animations, video, Lottie, embeds, shaders) is held still (Alt+P). */
  animationsPaused: boolean;
  /** Bumped to play every animation again from its start. */
  animationEpoch: number;
  /** An older version shown read-only (`doc` is that version; nothing can be changed). */
  preview: VersionPreview | null;
  /** The open file's version control (null until asked). */
  vcs: VcsStatus | null;
  /** Bumped when the server says the open file's version control changed. */
  vcsEpoch: number;
}

const MOTION_KEY = 'openpaper.animations';

/** Saved choice, else still when the system asks for reduced motion. */
function initialPaused(): boolean {
  try {
    const saved = localStorage.getItem(MOTION_KEY);
    if (saved === 'paused' || saved === 'playing') return saved === 'paused';
  } catch {
    // storage unavailable
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  pendingComment: null,
  agentChat: { key: null, items: [], running: false, usage: null, open: false },
  agentConfig: null,
  selectionPrompt: false,
  speech: null,
  showShaders: false,
  shaderPreview: {},
  figmaPrompt: null,
  showShortcuts: false,
  uiHidden: false,
  panelsCollapsed: false,
  commentsHidden: false,
  animationsPaused: initialPaused(),
  animationEpoch: 0,
  preview: null,
  vcs: null,
  vcsEpoch: 0,
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

/** Showing an older version: nothing may change the document. */
export function isReadOnly(): boolean {
  return getState().preview !== null;
}

/** Apply a server patch to the open document. */
export function applyServerPatch(fileId: string, version: number, patch: Parameters<typeof applyPatch>[1]) {
  setState((s) => {
    if (!s.doc || s.doc.id !== fileId) return s;
    // An older version is on screen: the live document underneath takes the change.
    if (s.preview) return { preview: { ...s.preview, live: { doc: applyPatch(s.preview.live.doc, patch), version } } };
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

/** Pause or play the design's motion; playing starts every animation over. Remembered per browser. */
export function setAnimationsPaused(paused: boolean) {
  setState((s) => ({ animationsPaused: paused, animationEpoch: paused ? s.animationEpoch : s.animationEpoch + 1 }));
  try {
    localStorage.setItem(MOTION_KEY, paused ? 'paused' : 'playing');
  } catch {
    // storage unavailable
  }
}

/** Play every animation again from its start (and resume them when paused). */
export function replayAnimations() {
  if (getState().animationsPaused) setAnimationsPaused(false);
  else setState((s) => ({ animationEpoch: s.animationEpoch + 1 }));
}

let toastId = 1;
export function toast(text: string, ms = 2600) {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
