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

function AgentOpenedBanner() {
  const opened = useEditor((s) => s.agentOpened);
  const resources = useEditor((s) => s.resources);
  if (!opened) return null;
  const name = resources.find((r) => r.id === opened.fileId)?.name ?? 'another file';
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px 8px 14px',
        borderRadius: 10,
        background: 'var(--op-panel)',
        border: '1px solid var(--op-border)',
        boxShadow: 'var(--op-shadow)',
      }}
    >
      <span>
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
  const doc = useEditor((s) => s.doc);
  const showExport = useEditor((s) => s.showExport);
  useShortcuts();
  useClipboard();

  // Animated shaders resume where they were when the file is opened again.
  useEffect(() => {
    if (!doc?.id) return;
    window.addEventListener('pagehide', persistShaderFrames);
    return () => {
      window.removeEventListener('pagehide', persistShaderFrames);
      persistShaderFrames();
    };
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (doc) document.title = `${doc.name} — OpenPaper`;
    return () => {
      document.title = 'OpenPaper';
    };
  }, [doc?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--op-text-3)' }}>Opening file…</div>
    );
  }

  return (
    <div className="op-app">
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
    </div>
  );
}
