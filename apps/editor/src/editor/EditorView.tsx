import { useEffect } from 'react';
import { useEditor, setState } from '../state/store.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { TopBar } from './TopBar.tsx';
import { LeftPanel } from './panels/LeftPanel.tsx';
import { RightPanel } from './panels/RightPanel.tsx';
import { useShortcuts } from './shortcuts.ts';
import { useClipboard } from './clipboard.ts';
import { ExportDialog } from './panels/ExportDialog.tsx';
import { AgentDock } from './AgentDock.tsx';
import { ShaderPicker } from './shaders/ShaderPicker.tsx';
import { FigmaTokenDialog } from './figma/FigmaTokenDialog.tsx';
import { persistShaderFrames } from './shaders/ShaderInspector.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';

function AgentOpenedBanner() {
  const opened = useEditor((s) => s.agentOpened);
  const resources = useEditor((s) => s.resources);
  if (!opened) return null;
  const name = resources.find((r) => r.id === opened.fileId)?.name ?? 'another file';
  return (
    <div className="op-banner" role="status">
      <span title={`${opened.agentName} is working in “${name}”`}>
        <b>{opened.agentName}</b> is working in “{name}”
      </span>
      <button
        className="op-btn primary"
        onClick={() => {
          location.hash = `#/file/${opened.fileId}${opened.pageId ? `/${opened.pageId}` : ''}`;
          setState({ agentOpened: null });
        }}
      >
        Open
      </button>
      <button className="op-btn" onClick={() => setState({ agentOpened: null })}>
        Dismiss
      </button>
    </div>
  );
}

export function EditorView() {
  // Only what the shell needs: selecting the document itself would re-render every panel on each patch.
  const docId = useEditor((s) => s.doc?.id);
  const docName = useEditor((s) => s.doc?.name);
  const showExport = useEditor((s) => s.showExport);
  const viewClass = useEditor((s) => `${s.uiHidden ? ' op-ui-hidden' : ''}${s.panelsCollapsed ? ' op-panels-collapsed' : ''}`);
  useShortcuts();
  useClipboard();

  // Animated shaders resume where they were when the file is opened again.
  useEffect(() => {
    if (!docId) return;
    window.addEventListener('pagehide', persistShaderFrames);
    return () => {
      window.removeEventListener('pagehide', persistShaderFrames);
      persistShaderFrames();
    };
  }, [docId]);

  useEffect(() => {
    if (docName !== undefined) document.title = `${docName} — OpenPaper`;
    return () => {
      document.title = 'OpenPaper';
    };
  }, [docName]);

  if (!docId) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--op-text-3)' }}>Opening file…</div>
    );
  }

  return (
    <div className={`op-app${viewClass}`}>
      <TopBar />
      <div className="op-main">
        <LeftPanel />
        <div style={{ position: 'relative', minWidth: 0, minHeight: 0, display: 'grid' }}>
          <Canvas />
          <AgentOpenedBanner />
          <ShaderPicker />
          <AgentDock />
        </div>
        <RightPanel />
      </div>
      {showExport && <ExportDialog />}
      <FigmaTokenDialog />
      <ShortcutsDialog />
    </div>
  );
}
