import { useRef, useState } from 'react';
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
  Keyboard,
  CirclePause,
  CirclePlay,
  GitBranch,
} from 'lucide-react';
import { useEditor, setAnimationsPaused, setState, type Tool } from '../state/store.ts';
import { command, redo, undo } from '../sync/session.ts';
import { zoomBy, zoomToFit } from './canvas/Canvas.tsx';
import { Logo } from '../ui/Logo.tsx';
import { insertImageFiles, PLACEABLE_FILES } from './clipboard.ts';
import { MAC } from './shortcuts.ts';
import { bindingLabel } from './hotkeys.ts';

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
  const paused = useEditor((s) => s.animationsPaused);
  // An older version on screen can be looked through, not changed.
  const readOnly = useEditor((s) => !!s.preview);
  const vcs = useEditor((s) => (s.vcs?.tracked ? s.vcs : null));
  const vcsChanges = vcs?.changes?.length ?? 0;
  const [editingName, setEditingName] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);

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
          <button className="op-btn op-filename" onDoubleClick={() => !readOnly && setEditingName(true)} title={readOnly ? doc.name : `${doc.name}\nDouble-click to rename`}>
            <span>{doc.name}</span>
          </button>
        )}
        {vcs && (
          <button
            className="op-btn op-branch-chip"
            title={`On branch ${vcs.branch ?? '(no branch)'}${vcsChanges ? `, ${vcsChanges} change${vcsChanges === 1 ? '' : 's'} not committed` : ''}\nOpen version control`}
            onClick={() => setState({ rightTab: 'version', panelsCollapsed: false })}
          >
            <GitBranch size={13} />
            <span>{vcs.branch ?? 'detached'}</span>
            {vcsChanges > 0 && <span className="op-branch-dot" aria-label="Changes not committed" />}
          </button>
        )}
        {connection !== 'open' && (
          <span className="op-badge" style={{ color: 'var(--op-danger)', flexShrink: 0 }}>
            Reconnecting…
          </span>
        )}
      </div>

      <div className="op-toolbar">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`op-icon-btn${tool === t.id ? ' active' : ''}`}
            title={`${t.label} (${t.key})`}
            disabled={readOnly && t.id !== 'select' && t.id !== 'hand'}
            onClick={() => setState({ tool: t.id })}
          >
            <t.icon size={16} />
          </button>
        ))}
        <button className={`op-icon-btn${showShaders ? ' active' : ''}`} title="Shaders (S)" disabled={readOnly} onClick={() => setState({ showShaders: !showShaders })}>
          <Blend size={16} />
        </button>
        {/* A button, not a <label> around the input: labels can't take keyboard focus. */}
        <button className="op-icon-btn" title={`Image (${bindingLabel('Mod+Shift+K', MAC)})`} disabled={readOnly} onClick={() => imageInput.current?.click()}>
          <ImagePlus size={16} />
        </button>
        <input
          ref={imageInput}
          type="file"
          accept={PLACEABLE_FILES}
          multiple
          hidden
          onChange={(e) => {
            if (e.currentTarget.files?.length) void insertImageFiles([...e.currentTarget.files]);
            e.currentTarget.value = '';
          }}
        />
      </div>

      <div className="right">
        {agents.length > 0 && (
          <div className="op-avatars">
            {agents.slice(0, MAX_AVATARS).map((a) => (
              <span
                key={a.sessionId}
                className="op-avatar"
                title={`${a.name}${a.lastTool ? ` — ${a.lastTool.replace(/_/g, ' ')}` : ''}`}
                style={{ background: a.color }}
              >
                {initials(a.name)}
              </span>
            ))}
            {agents.length > MAX_AVATARS && (
              <span className="op-avatar" title={agents.slice(MAX_AVATARS).map((a) => a.name).join(', ')} style={{ background: 'var(--op-text-3)' }}>
                +{agents.length - MAX_AVATARS}
              </span>
            )}
          </div>
        )}
        <button className="op-icon-btn op-topbar-optional" title={`Undo (${bindingLabel('Mod+Z', MAC)})`} disabled={readOnly} onClick={() => void undo()}>
          <Undo2 size={16} />
        </button>
        <button className="op-icon-btn op-topbar-optional" title={`Redo (${bindingLabel('Mod+Shift+Z', MAC)})`} disabled={readOnly} onClick={() => void redo()}>
          <Redo2 size={16} />
        </button>
        <button className="op-btn op-topbar-optional" title={`Zoom (${bindingLabel('Shift+1', MAC)} fit, ${bindingLabel('Shift+0', MAC)} 100%)`} onClick={() => zoomToFit()} onContextMenu={(e) => (e.preventDefault(), zoomBy(1))}>
          <span className="op-zoom">{Math.round(zoom * 100)}%</span>
        </button>
        <button
          className={`op-icon-btn${paused ? ' active' : ''}`}
          title={`${paused ? 'Play animations' : 'Pause animations'} (${bindingLabel('Alt+P', MAC)})\nShift+click or ${bindingLabel('Alt+Shift+P', MAC)} to replay`}
          aria-pressed={paused}
          onClick={(e) => (e.shiftKey && !paused ? setAnimationsPaused(false) : setAnimationsPaused(!paused))}
        >
          {paused ? <CirclePlay size={16} /> : <CirclePause size={16} />}
        </button>
        <button className="op-icon-btn" title={readOnly ? 'Export works on the current version: go back to it first' : 'Export'} disabled={readOnly} onClick={() => setState({ showExport: true })}>
          <Download size={16} />
        </button>
        <button className="op-icon-btn op-topbar-optional" title={`Keyboard shortcuts (${bindingLabel('Mod+/', MAC)})`} onClick={() => setState({ showShortcuts: true })}>
          <Keyboard size={16} />
        </button>
        <button className="op-btn primary" title="Connect agent" onClick={() => setState({ showConnect: true })}>
          <Plug size={14} /> <span className="op-connect-label">Connect agent</span>
        </button>
      </div>
    </div>
  );
}

const MAX_AVATARS = 3;

/** "Claude Code" → "CC", "Cursor" → "C": tells agents apart when their names share a first letter. */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0]?.[0] ?? '?')).toUpperCase();
}
