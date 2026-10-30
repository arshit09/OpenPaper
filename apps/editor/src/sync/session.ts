import { flushSync } from 'react-dom';
import type {
  AgentChatItem,
  AgentConfigInfo,
  AgentTarget,
  AgentUsage,
  EditorCommand,
  OpenFileResult,
  PaperDocument,
  ResourceInfo,
  VcsCommit,
  VcsStatus,
  ViewState,
} from '@openpaper/core';
import { applyServerPatch, getState, isReadOnly, setDocument, setState, toast, useEditor } from '../state/store.ts';
import { applyLive, flushLive, noteAgentReads, planLive } from '../editor/canvas/live.ts';
import { SyncClient } from './client.ts';

export const client = new SyncClient();

client.onState((connection) => setState({ connection }));

client.subscribe((message) => {
  switch (message.t) {
    case 'patch': {
      // An older version is on screen: the live document underneath takes the change, nothing plays.
      if (getState().preview) {
        applyServerPatch(message.fileId, message.version, message.patch);
        break;
      }
      // Agent edits play back on the canvas: decide what to hide before the new layers render,
      // commit synchronously, then start the reveal before the browser paints.
      const plan = planLive(message.fileId, message.patch, message.actor, message.label);
      flushSync(() => applyServerPatch(message.fileId, message.version, message.patch));
      if (plan) applyLive(plan);
      break;
    }
    case 'presence':
      if (getState().doc?.id === message.fileId) {
        const prev = getState().agents;
        setState({ agents: message.agents });
        noteAgentReads(message.agents, prev);
      }
      break;
    case 'activity':
      if (getState().doc?.id === message.fileId) {
        setState((s) => ({ activity: [...s.activity.slice(-199), message.entry] }));
      }
      break;
    case 'resources':
      setState({ resources: message.resources });
      break;
    case 'navigate':
      void navigateTo(message.fileId, message.pageId ?? undefined, message.nodeId ?? undefined);
      break;
    case 'speech':
      setState({ speech: message.status });
      break;
    case 'vcs':
      if ((getState().preview?.live.doc.id ?? getState().doc?.id) !== message.fileId) break;
      setState((s) => ({ vcsEpoch: s.vcsEpoch + 1 }));
      if (message.notice) toast(message.notice, 5000);
      break;
    case 'agent': {
      if (getState().agentChat.key !== message.fileId) break;
      const e = message.event;
      setState((s) => {
        const chat = s.agentChat;
        switch (e.type) {
          case 'item':
            return { agentChat: { ...chat, items: [...chat.items.filter((i) => i.id !== e.item.id), e.item] } };
          case 'delta':
            return {
              agentChat: {
                ...chat,
                items: chat.items.map((i) =>
                  i.id === e.id && i.kind === 'assistant'
                    ? { ...i, text: i.text + (e.text ?? ''), thinking: i.thinking + (e.thinking ?? '') }
                    : i
                ),
              },
            };
          case 'tool':
            return {
              agentChat: {
                ...chat,
                items: chat.items.map((i) => (i.id === e.id && i.kind === 'tool' ? { ...i, status: e.status, summary: e.summary ?? i.summary } : i)),
              },
            };
          case 'status':
            return { agentChat: { ...chat, running: e.running, usage: e.usage ?? chat.usage } };
          case 'reset':
            return { agentChat: { ...chat, items: [], running: false, usage: null } };
        }
        return s;
      });
      break;
    }
    case 'agent-opened': {
      const s = getState();
      // Idle on the home screen: follow the agent. Otherwise offer to switch.
      if (!s.doc) location.hash = `#/file/${message.fileId}${message.pageId ? `/${message.pageId}` : ''}`;
      else if (s.doc.id !== message.fileId) setState({ agentOpened: { fileId: message.fileId, pageId: message.pageId, agentName: message.agentName } });
      break;
    }
  }
});

// ---- server → editor RPCs ----------------------------------------------------

/** Yield to the event loop without timers (not throttled in background tabs). */
function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

/** Wait until the editor shows `version` of the file (patches and measure requests race). */
function waitForVersion(fileId: string, version: number, timeoutMs = 3000): Promise<boolean> {
  const ready = () => {
    const s = getState();
    return s.doc?.id === fileId && s.version >= version;
  };
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(ok);
    };
    const unsubscribe = useEditor.subscribe(() => {
      if (ready()) done(true);
    });
    const timer = setTimeout(() => done(ready()), timeoutMs);
  });
}

client.handleRpc('measure', async (params) => {
  const { fileId, pageId, version } = params as { fileId: string; pageId: string; version: number };
  const s = getState();
  // An older version on screen isn't what the server asks about.
  if (s.doc?.id !== fileId || s.pageId !== pageId || s.preview) throw new Error('Page not shown');
  if (!(await waitForVersion(fileId, version))) throw new Error('Editor is behind');
  await yieldMacrotask();
  await yieldMacrotask();
  const { measureRenderedPage } = await import('../editor/canvas/measure.ts');
  return measureRenderedPage();
});

client.handleRpc('screenshot', async (params) => {
  const { nodeId, scale } = params as { fileId: string; nodeId: string; scale: number };
  if (getState().preview) throw new Error('An older version is shown');
  const { captureNode } = await import('../editor/canvas/measure.ts');
  return captureNode(nodeId, scale);
});

client.onOpen(() => {
  // A restarted server knows nothing of this editor's view: send it again even if unchanged.
  lastView = '';
  void refreshResources();
  const doc = getState().doc;
  if (doc) void openFile(doc.id, { keepView: true });
});

export async function refreshResources(): Promise<ResourceInfo[]> {
  const resources = await client.request<ResourceInfo[]>('resources.list');
  setState({ resources });
  return resources;
}

export async function openFile(fileId: string, opts: { keepView?: boolean; pageId?: string } = {}): Promise<void> {
  const result = await client.request<OpenFileResult>('file.open', { fileId });
  flushLive();
  const preview = getState().preview;
  if (preview?.live.doc.id === fileId) {
    // Reopened (e.g. after a reconnect) while an older version is shown: that stays on screen.
    setState({ preview: { ...preview, live: { doc: result.doc, version: result.version } }, agents: result.agents, activity: result.activity });
    pushView();
    return;
  }
  if (getState().doc?.id !== fileId) setState({ preview: null, vcs: null });
  if (!opts.keepView) setState({ selection: [], pageId: opts.pageId ?? null, hoverId: null });
  else if (opts.pageId) setState({ pageId: opts.pageId });
  setDocument(result.doc, result.version);
  setState({ agents: result.agents, activity: result.activity });
  pushView();
  openChat(fileId);
}

/** Show the agent conversation for a file id, or `site:<id>` for a live site (null: none). */
export function openChat(key: string | null): void {
  const same = getState().agentChat.key === key;
  setState((s) => ({ agentChat: same ? s.agentChat : { ...s.agentChat, key, items: [], running: false, usage: null } }));
  if (!key) return;
  client
    .request<{ items: AgentChatItem[]; running: boolean; usage: AgentUsage }>('agent.history', { fileId: key })
    .then((h) => {
      if (getState().agentChat.key !== key) return;
      setState((s) => ({ agentChat: { ...s.agentChat, items: h.items, running: h.running, usage: h.usage } }));
    })
    .catch(() => {});
}

/** Ask the server what runs the agent and which coding agents are installed (the dock and the selection prompt share it). */
export async function loadAgentConfig(): Promise<AgentConfigInfo> {
  const config = await client.request<AgentConfigInfo>('agent.config.get');
  setState({ agentConfig: config });
  return config;
}

/** Change the agent's runner, model, effort or API key. A runner change shows at once; the server's answer replaces it. */
export async function setAgentConfig(patch: { runner?: AgentConfigInfo['runner']; model?: string; effort?: AgentConfigInfo['effort']; apiKey?: string | null }): Promise<AgentConfigInfo> {
  const before = getState().agentConfig;
  if (before && patch.runner) setState({ agentConfig: { ...before, runner: patch.runner } });
  try {
    const config = await client.request<AgentConfigInfo>('agent.config.set', patch);
    setState({ agentConfig: config });
    return config;
  } catch (error) {
    setState({ agentConfig: before });
    toast(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Let Antigravity run OpenPaper's design tools (the server adds one allow rule to agy's settings). */
export async function allowAgy(): Promise<void> {
  try {
    setState({ agentConfig: await client.request<AgentConfigInfo>('agent.agy.allow') });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
}

/** Send a message to the open agent chat. `target` is what the user pointed at; `page` the live-site page. */
export async function sendToAgent(text: string, extra: { target?: AgentTarget; page?: string } = {}): Promise<void> {
  const key = getState().agentChat.key;
  if (!key) return;
  try {
    await client.request('agent.send', { fileId: key, text, ...extra });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function closeFile(): void {
  const doc = getState().doc;
  if (doc) client.notify('file.close', { fileId: doc.id });
  flushLive();
  setState((s) => ({
    doc: null,
    pageId: null,
    selection: [],
    agents: [],
    activity: [],
    preview: null,
    vcs: null,
    // A live site's chat (opened by its view before this runs) stays.
    agentChat: s.agentChat.key === doc?.id ? { ...s.agentChat, key: null, items: [], running: false, usage: null } : s.agentChat,
  }));
  pushView();
}

/** Route to a file (and optionally page/node) — used by the `open_file` tool and deep links. */
export async function navigateTo(fileId: string, pageId?: string, nodeId?: string): Promise<void> {
  const hash = `#/file/${fileId}${pageId ? `/${pageId}` : ''}`;
  // An older version's address (#/file/<id>/version/<commit>) stays as it is.
  if (location.hash !== hash && !location.hash.startsWith(`#/file/${fileId}/version/`)) history.replaceState(null, '', hash);
  if (getState().doc?.id !== fileId) await openFile(fileId, { pageId });
  else if (pageId && getState().doc?.pages[pageId]) setState({ pageId });
  if (nodeId && getState().doc?.nodes[nodeId]) setState({ selection: [nodeId] });
}

const READ_ONLY = 'This is an older version. Restore it to change it, or go back to the current version.';
let readOnlyToldAt = 0;

/** Say (not too often) that an older version can't be changed. */
export function refuseReadOnly(): Error {
  if (Date.now() - readOnlyToldAt > 2000) toast(READ_ONLY, 3500);
  readOnlyToldAt = Date.now();
  return new Error(READ_ONLY);
}

/** Send a mutation for the open file. Resolves with the command's result. */
export function command<T = unknown>(cmd: EditorCommand): Promise<T> {
  if (isReadOnly()) {
    // Refused with a toast. Callers that don't wait for the answer leave no unhandled rejection behind.
    const refused = Promise.reject<T>(refuseReadOnly());
    refused.catch(() => {});
    return refused;
  }
  return send<T>(cmd);
}

async function send<T>(cmd: EditorCommand): Promise<T> {
  const doc = getState().doc;
  if (!doc) throw new Error('No file is open');
  try {
    return await client.request<T>('file.command', { fileId: doc.id, command: cmd });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function undo(): Promise<void> {
  const doc = getState().doc;
  if (!doc) return;
  if (isReadOnly()) return void refuseReadOnly();
  const label = await historyStep('file.undo', doc.id);
  if (label === null) toast('Nothing to undo');
}

export async function redo(): Promise<void> {
  const doc = getState().doc;
  if (!doc) return;
  if (isReadOnly()) return void refuseReadOnly();
  const label = await historyStep('file.redo', doc.id);
  if (label === null) toast('Nothing to redo');
}

/** Undo or redo on the server; failures (no connection) are shown, then reported as `undefined`. */
async function historyStep(method: 'file.undo' | 'file.redo', fileId: string): Promise<string | null | undefined> {
  try {
    return await client.request<string | null>(method, { fileId });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

// ---- version control ----------------------------------------------------------

/** Ask for the open file's version control status (the tab and the panel share it). */
export async function refreshVcs(): Promise<VcsStatus | null> {
  const fileId = getState().preview?.live.doc.id ?? getState().doc?.id;
  if (!fileId) return null;
  const status = await client.request<VcsStatus>('vcs.status', { fileId });
  if ((getState().preview?.live.doc.id ?? getState().doc?.id) === fileId) setState({ vcs: status });
  return status;
}

/** Show an older version of a file, read-only, in place of the live one (the address says which). */
export async function showVersion(fileId: string, commit: string): Promise<void> {
  if (getState().doc?.id !== fileId) await openFile(fileId);
  const snap = await client.request<{ doc: PaperDocument; commit: VcsCommit }>('vcs.snapshot', { fileId, commit });
  const s = getState();
  if (s.doc?.id !== fileId) return;
  flushLive();
  const live = s.preview?.live ?? { doc: s.doc, version: s.version };
  const firstPage = snap.doc.pageList.find((p) => p.type === 'page' && snap.doc.pages[p.id])?.id ?? null;
  setState({
    preview: { commit: snap.commit, live },
    doc: snap.doc,
    pageId: s.pageId && snap.doc.pages[s.pageId] ? s.pageId : firstPage,
    selection: [],
    hoverId: null,
    editingTextId: null,
    transient: {},
    tool: 'select',
    pendingComment: null,
    selectionPrompt: false,
    showShaders: false,
  });
  pushView();
}

/** Back from an older version to the live document. */
export function exitVersion(): void {
  const preview = getState().preview;
  if (!preview) return;
  flushLive();
  const doc = preview.live.doc;
  setState((s) => ({
    preview: null,
    doc,
    version: preview.live.version,
    pageId: s.pageId && doc.pages[s.pageId] ? s.pageId : (doc.pageList.find((p) => p.type === 'page' && doc.pages[p.id])?.id ?? null),
    selection: s.selection.filter((id) => doc.nodes[id]),
    hoverId: null,
    transient: {},
  }));
  pushView();
}

// ---- view state (what the user is looking at; MCP tools default to it) ----
let viewTimer: ReturnType<typeof setTimeout> | null = null;
let viewDue = 0;
let lastView = '';
/** The server keeps this many selected ids per view; sending more is wasted. */
const MAX_VIEW_SELECTION = 1000;

/**
 * Report the view to the server, throttled: at most once per `delayMs` (camera moves pass a
 * longer delay than selection changes; the sooner one wins).
 */
export function pushView(delayMs = 60): void {
  const due = Date.now() + delayMs;
  if (viewTimer) {
    if (due >= viewDue) return;
    clearTimeout(viewTimer);
  }
  viewDue = due;
  viewTimer = setTimeout(() => {
    viewTimer = null;
    const s = getState();
    const cam = s.pageId ? s.cameras[s.pageId] : undefined;
    const vp = document.querySelector('.op-canvas')?.getBoundingClientRect();
    const view: ViewState = {
      fileId: s.doc?.id ?? null,
      pageId: s.pageId,
      // An older version's layers aren't what agents should act on.
      selection: s.preview ? [] : s.selection.length > MAX_VIEW_SELECTION ? s.selection.slice(0, MAX_VIEW_SELECTION) : s.selection,
      focused: document.visibilityState === 'visible' && document.hasFocus(),
      ...(cam && vp ? { viewport: { x: cam.x, y: cam.y, zoom: cam.zoom, width: vp.width, height: vp.height } } : {}),
    };
    const key = JSON.stringify(view);
    if (key === lastView) return;
    lastView = key;
    client.notify('view.update', view);
  }, delayMs);
}

// Report selection/page changes to the server (MCP tools default to the user's view).
useEditor.subscribe((s, prev) => {
  if (s.selection !== prev.selection || s.pageId !== prev.pageId) pushView();
});

for (const event of ['focus', 'blur', 'visibilitychange'] as const) {
  (event === 'visibilitychange' ? document : window).addEventListener(event, () => pushView());
}
