import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, Unlock, Frame as FrameIcon, Type, Square, Shapes, Plus, FileText, Copy, Trash2, Minus, Blend } from 'lucide-react';
import { displayName, isAncestorOf, readerOf, type NodeRecord } from '@openpaper/core';
import { useEditor, setState, getState } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import { TokensPanel } from './TokensPanel.tsx';

function iconFor(n: NodeRecord) {
  switch (n.component) {
    case 'Text':
      return <Type size={13} />;
    case 'SVG':
      return <Shapes size={13} />;
    case 'Rectangle':
      return <Square size={13} />;
    default:
      return n.component.startsWith('Shader') ? <Blend size={13} /> : <FrameIcon size={13} />;
  }
}

function PagesSection() {
  const doc = useEditor((s) => s.doc)!;
  const pageId = useEditor((s) => s.pageId);
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div style={{ borderBottom: '1px solid var(--op-border)', padding: '6px 6px 8px' }}>
      <div className="op-row" style={{ padding: '0 4px 4px 6px', minHeight: 28 }}>
        <button className="op-icon-btn small" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span style={{ fontWeight: 600, flex: 1 }}>Pages</span>
        <button
          className="op-icon-btn small"
          title="Add page"
          onClick={async () => {
            const r = await command<{ pageId?: string }>({ type: 'createPage' });
            if (r.pageId) setState({ pageId: r.pageId, selection: [] });
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {open && (
        <div className="op-scroll" style={{ maxHeight: 200 }}>
          {doc.pageList.map((item) => {
            if (item.type === 'divider') {
              return (
                <div key={item.id} className="op-tree-row" style={{ height: 14, paddingLeft: 10 }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--op-border-strong)' }} />
                  <span className="actions">
                    <button className="op-icon-btn small" title="Remove divider" onClick={() => void command({ type: 'deletePage', pageId: item.id })}>
                      <Minus size={12} />
                    </button>
                  </span>
                </div>
              );
            }
            const page = doc.pages[item.id];
            if (!page) return null;
            return (
              <div
                key={item.id}
                className={`op-tree-row${item.id === pageId ? ' selected' : ''}`}
                style={{ paddingLeft: 10 }}
                onClick={() => setState({ pageId: item.id, selection: [], hoverId: null })}
                onDoubleClick={() => setRenaming(item.id)}
              >
                <FileText size={13} style={{ color: 'var(--op-text-3)', flexShrink: 0 }} />
                {renaming === item.id ? (
                  <input
                    className="op-input"
                    autoFocus
                    defaultValue={page.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      setRenaming(null);
                      const name = e.currentTarget.value.trim();
                      if (name && name !== page.name) void command({ type: 'updatePage', pageId: page.id, name });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="name">{page.name}</span>
                )}
                <span className="actions">
                  <button
                    className="op-icon-btn small"
                    title="Duplicate page"
                    onClick={(e) => {
                      e.stopPropagation();
                      void command({ type: 'duplicatePage', pageId: page.id });
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    className="op-icon-btn small"
                    title="Add divider below"
                    onClick={(e) => {
                      e.stopPropagation();
                      void command({ type: 'addDivider', afterId: page.id });
                    }}
                  >
                    <Minus size={12} />
                  </button>
                  <button
                    className="op-icon-btn small"
                    title="Delete page"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete page "${page.name}"?`)) void command({ type: 'deletePage', pageId: page.id });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type DropPos = 'before' | 'after' | 'inside';
let dragIds: string[] = [];

function LayerRow({ id, depth, expanded, toggle }: { id: string; depth: number; expanded: Set<string>; toggle: (id: string) => void }) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  const selected = useEditor((s) => s.selection.includes(id));
  const hovered = useEditor((s) => s.hoverId === id);
  const agentColor = useEditor((s) => s.agents.find((a) => a.lastNodeId === id)?.color);
  const [renaming, setRenaming] = useState(false);
  const [drop, setDrop] = useState<DropPos | null>(null);
  if (!node) return null;
  const isOpen = expanded.has(id);
  const hasKids = node.children.length > 0;

  const onDrop = (pos: DropPos) => {
    const s = getState();
    const doc = s.doc!;
    const reader = readerOf(doc);
    const ids = dragIds.filter((d) => d !== id && !isAncestorOf(reader, d, id));
    if (!ids.length) return;
    let parentId: string;
    let index: number;
    if (pos === 'inside' && node.component === 'Frame') {
      parentId = id;
      index = node.children.length;
    } else {
      parentId = node.parentId!;
      const siblings = doc.nodes[parentId]!.children.filter((c) => !ids.includes(c));
      index = siblings.indexOf(id) + (pos === 'after' ? 1 : 0);
    }
    void command({ type: 'move', moves: ids.map((nodeId, i) => ({ nodeId, parentId, index: index + i })) });
  };

  return (
    <>
      <div
        className={`op-tree-row${selected ? ' selected' : ''}${!node.isVisible ? ' dim' : ''}${drop ? ` drop-${drop}` : ''}`}
        style={{ paddingLeft: 6 + depth * 14, background: hovered && !selected ? 'var(--op-hover)' : undefined }}
        draggable
        onDragStart={(e) => {
          dragIds = getState().selection.includes(id) ? getState().selection : [id];
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const y = e.clientY - r.top;
          const pos: DropPos = node.component === 'Frame' && y > r.height * 0.3 && y < r.height * 0.7 ? 'inside' : y < r.height / 2 ? 'before' : 'after';
          setDrop(pos);
        }}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          const pos = drop;
          setDrop(null);
          if (pos) onDrop(pos);
        }}
        onMouseEnter={() => setState({ hoverId: id })}
        onMouseLeave={() => getState().hoverId === id && setState({ hoverId: null })}
        onClick={(e) => {
          const s = getState();
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            setState({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] });
          } else setState({ selection: [id] });
        }}
        onDoubleClick={() => setRenaming(true)}
      >
        <button
          className="op-icon-btn small"
          style={{ visibility: hasKids ? 'visible' : 'hidden', width: 16 }}
          onClick={(e) => {
            e.stopPropagation();
            toggle(id);
          }}
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span style={{ color: agentColor ?? 'var(--op-text-3)', display: 'flex', flexShrink: 0 }}>{iconFor(node)}</span>
        {renaming ? (
          <input
            className="op-input"
            autoFocus
            defaultValue={node.label}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false);
              const name = e.currentTarget.value.trim();
              if (name && name !== node.label) void command({ type: 'rename', nodeId: id, name });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <span className="name">{displayName(node)}</span>
        )}
        <span className={`actions${!node.isVisible || node.isLocked ? ' pinned' : ''}`}>
          <button
            className="op-icon-btn small"
            title={node.isLocked ? 'Unlock' : 'Lock'}
            onClick={(e) => {
              e.stopPropagation();
              void command({ type: 'setFlags', nodeIds: [id], isLocked: !node.isLocked });
            }}
          >
            {node.isLocked ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
          <button
            className="op-icon-btn small"
            title={node.isVisible ? 'Hide' : 'Show'}
            onClick={(e) => {
              e.stopPropagation();
              void command({ type: 'setFlags', nodeIds: [id], isVisible: !node.isVisible });
            }}
          >
            {node.isVisible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </span>
      </div>
      {isOpen && node.children.map((c) => <LayerRow key={c} id={c} depth={depth + 1} expanded={expanded} toggle={toggle} />)}
    </>
  );
}

function LayersSection() {
  const rootChildren = useEditor((s) => {
    const page = s.doc && s.pageId ? s.doc.pages[s.pageId] : undefined;
    return page ? s.doc!.nodes[page.rootId]?.children ?? [] : [];
  });
  const selection = useEditor((s) => s.selection);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Reveal the selection in the tree.
  useEffect(() => {
    const doc = getState().doc;
    if (!doc || !selection.length) return;
    const add: string[] = [];
    for (const id of selection) {
      let n = doc.nodes[id];
      while (n?.parentId) {
        const p = doc.nodes[n.parentId];
        if (!p || p.component === 'PageRoot') break;
        add.push(p.id);
        n = p;
      }
    }
    if (add.some((id) => !expanded.has(id))) setExpanded((prev) => new Set([...prev, ...add]));
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  const empty = useMemo(() => rootChildren.length === 0, [rootChildren]);
  return (
    <div className="op-scroll" style={{ flex: 1, padding: '6px 6px 24px' }}>
      <div className="op-label" style={{ padding: '4px 8px 6px' }}>
        Layers
      </div>
      {empty ? (
        <div className="op-empty">
          Draw a frame (F) or ask an agent to design something.
        </div>
      ) : (
        rootChildren.map((id) => <LayerRow key={id} id={id} depth={0} expanded={expanded} toggle={toggle} />)
      )}
    </div>
  );
}

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  return (
    <div className="op-panel left">
      <div className="op-tabs">
        <button className={`op-tab${tab === 'layers' ? ' active' : ''}`} onClick={() => setState({ leftTab: 'layers' })}>
          Layers
        </button>
        <button className={`op-tab${tab === 'tokens' ? ' active' : ''}`} onClick={() => setState({ leftTab: 'tokens' })}>
          Tokens
        </button>
      </div>
      {tab === 'layers' ? (
        <>
          <PagesSection />
          <LayersSection />
        </>
      ) : (
        <TokensPanel />
      )}
    </div>
  );
}
