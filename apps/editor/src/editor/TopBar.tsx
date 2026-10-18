import { useState } from 'react';
import {
  MousePointer2,
  Hand,
  Frame,
  Square,
  Circle,
  Type,
  PenLine,
  MessageCircle,
  ImagePlus,
  Undo2,
  Redo2,
  Download,
  Plug,
  ChevronLeft,
  Blend,
} from 'lucide-react';
import { useEditor, setState, type Tool } from '../state/store.ts';
import { command, redo, undo } from '../sync/session.ts';
import { zoomBy, zoomToFit } from './canvas/Canvas.tsx';
import { Logo } from '../ui/Logo.tsx';
import { insertImageFiles } from './clipboard.ts';

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: typeof Frame }> = [
  { id: 'select', label: 'Move', key: 'V', icon: MousePointer2 },
  { id: 'hand', label: 'Hand', key: 'H', icon: Hand },
  { id: 'frame', label: 'Frame', key: 'F', icon: Frame },
  { id: 'rectangle', label: 'Rectangle', key: 'R', icon: Square },
  { id: 'ellipse', label: 'Ellipse', key: 'O', icon: Circle },
  { id: 'text', label: 'Text', key: 'T', icon: Type },
  { id: 'pencil', label: 'Pencil', key: 'P', icon: PenLine },
  { id: 'comment', label: 'Comment', key: 'C', icon: MessageCircle },
];

export function TopBar() {
  const doc = useEditor((s) => s.doc)!;
  const tool = useEditor((s) => s.tool);
  const showShaders = useEditor((s) => s.showShaders);
  const agents = useEditor((s) => s.agents);
  const zoom = useEditor((s) => (s.pageId && s.cameras[s.pageId]?.zoom) || 1);
  const connection = useEditor((s) => s.connection);
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="op-topbar">
      <div className="left">
        <a href="#/" className="op-icon-btn" title="All files">
          <ChevronLeft size={16} />
        </a>
        <Logo withText={false} size={20} />
        {editingName ? (
          <input
            className="op-input"
            autoFocus
            defaultValue={doc.name}
            style={{ maxWidth: 240, fontWeight: 600 }}
            onBlur={(e) => {
              setEditingName(false);
              const name = e.currentTarget.value.trim();
              if (name && name !== doc.name) void command({ type: 'renameFile', name });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingName(false);
            }}
          />
        ) : (
          <button className="op-btn" style={{ fontWeight: 600, maxWidth: 260, overflow: 'hidden' }} onDoubleClick={() => setEditingName(true)} title="Double-click to rename">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.name}</span>
          </button>
        )}
        {connection !== 'open' && <span className="op-badge" style={{ color: 'var(--op-danger)' }}>Reconnecting…</span>}
      </div>

      <div className="op-toolbar">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`op-icon-btn${tool === t.id ? ' active' : ''}`}
            title={`${t.label} (${t.key})`}
            onClick={() => setState({ tool: t.id })}
          >
            <t.icon size={16} />
          </button>
        ))}
        <button className={`op-icon-btn${showShaders ? ' active' : ''}`} title="Shaders (S)" onClick={() => setState({ showShaders: !showShaders })}>
          <Blend size={16} />
        </button>
        <label className="op-icon-btn" title="Image">
          <ImagePlus size={16} />
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files?.length) void insertImageFiles([...e.currentTarget.files]);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </div>

      <div className="right">
        <div style={{ display: 'flex', marginRight: 6 }}>
          {agents.slice(0, 4).map((a) => (
            <span
              key={a.sessionId}
              title={`${a.name}${a.lastTool ? ` — ${a.lastTool.replace(/_/g, ' ')}` : ''}`}
              style={{
                width: 26,
                height: 26,
                borderRadius: 13,
                marginLeft: -6,
                border: '2px solid var(--op-panel)',
                background: a.color,
                color: '#fff',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {a.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
        <button className="op-icon-btn" title="Undo (Ctrl+Z)" onClick={() => void undo()}>
          <Undo2 size={16} />
        </button>
        <button className="op-icon-btn" title="Redo (Ctrl+Shift+Z)" onClick={() => void redo()}>
          <Redo2 size={16} />
        </button>
        <button className="op-btn" title="Zoom (Shift+1 fit, Shift+0 100%)" onClick={() => zoomToFit()} onContextMenu={(e) => (e.preventDefault(), zoomBy(1))}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="op-icon-btn" title="Export" onClick={() => setState({ showExport: true })}>
          <Download size={16} />
        </button>
        <button className="op-btn primary" onClick={() => setState({ showConnect: true })}>
          <Plug size={14} /> Connect agent
        </button>
      </div>
    </div>
  );
}
