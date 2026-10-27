import { flushSync } from 'react-dom';
import type { AgentChatItem, AgentTarget, AgentUsage, EditorCommand, OpenFileResult, ResourceInfo, ViewState } from '@openpaper/core';
import { applyServerPatch, getState, setDocument, setState, toast, useEditor } from '../state/store.ts';
import { applyLive, flushLive, noteAgentReads, planLive } from '../editor/canvas/live.ts';
import { SyncClient } from './client.ts';

export const client = new SyncClient();

client.onState((connection) => setState({ connection }));

client.subscribe((message) => {
  switch (message.t) {
    case 'patch': {
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

async function waitForVersion(fileId: string, version: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getState();
    if (s.doc?.id === fileId && s.version >= version) return true;
    await yieldMacrotask();
  }
  return false;
}

client.handleRpc('measure', async (params) => {
  const { fileId, pageId, version } = params as { fileId: string; pageId: string; version: number };
  const s = getState();
  if (s.doc?.id !== fileId || s.pageId !== pageId) throw new Error('Page not shown');
  if (!(await waitForVersion(fileId, version))) throw new Error('Editor is behind');
  await yieldMacrotask();
  await yieldMacrotask();
  const { measureRenderedPage } = await import('../editor/canvas/measure.ts');
  return measureRenderedPage();
});

client.handleRpc('screenshot', async (params) => {
  const { nodeId, scale } = params as { fileId: string; nodeId: string; scale: number };
  const { captureNode } = await import('../editor/canvas/measure.ts');
  return captureNode(nodeId, scale);
});

client.onOpen(() => {
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
    // A live site's chat (opened by its view before this runs) stays.
    agentChat: s.agentChat.key === doc?.id ? { ...s.agentChat, key: null, items: [], running: false, usage: null } : s.agentChat,
  }));
  pushView();
}

/** Route to a file (and optionally page/node) — used by the `open_file` tool and deep links. */
export async function navigateTo(fileId: string, pageId?: string, nodeId?: string): Promise<void> {
  const hash = `#/file/${fileId}${pageId ? `/${pageId}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  if (getState().doc?.id !== fileId) await openFile(fileId, { pageId });
  else if (pageId && getState().doc?.pages[pageId]) setState({ pageId });
  if (nodeId && getState().doc?.nodes[nodeId]) setState({ selection: [nodeId] });
}

/** Send a mutation for the open file. Resolves with the command's result. */
export async function command<T = unknown>(cmd: EditorCommand): Promise<T> {
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
  const label = await client.request<string | null>('file.undo', { fileId: doc.id });
  if (!label) toast('Nothing to undo');
}

export async function redo(): Promise<void> {
  const doc = getState().doc;
  if (!doc) return;
  const label = await client.request<string | null>('file.redo', { fileId: doc.id });
  if (!label) toast('Nothing to redo');
}

// ---- view state (what the user is looking at; MCP tools default to it) ----
let viewTimer: ReturnType<typeof setTimeout> | null = null;
let lastView = '';

export function pushView(): void {
  if (viewTimer) return;
  viewTimer = setTimeout(() => {
    // (camera changes are throttled by this same timer)
    viewTimer = null;
    const s = getState();
    const cam = s.pageId ? s.cameras[s.pageId] : undefined;
    const vp = document.querySelector('.op-canvas')?.getBoundingClientRect();
    const view: ViewState = {
      fileId: s.doc?.id ?? null,
      pageId: s.pageId,
      selection: s.selection,
      focused: document.visibilityState === 'visible' && document.hasFocus(),
      ...(cam && vp ? { viewport: { x: cam.x, y: cam.y, zoom: cam.zoom, width: vp.width, height: vp.height } } : {}),
    };
    const key = JSON.stringify(view);
    if (key === lastView) return;
    lastView = key;
    client.notify('view.update', view);
  }, 60);
}

// Report selection/page changes to the server (MCP tools default to the user's view).
useEditor.subscribe((s, prev) => {
  if (s.selection !== prev.selection || s.pageId !== prev.pageId) pushView();
});

for (const event of ['focus', 'blur', 'visibilitychange'] as const) {
  (event === 'visibilitychange' ? document : window).addEventListener(event, () => pushView());
}
