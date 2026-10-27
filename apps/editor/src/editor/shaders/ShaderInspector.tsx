import { useEffect, useRef, useState } from 'react';
import { Minus, Pause, Play, Plus, X } from 'lucide-react';
import {
  isGroupOn,
  shaderColorToHex,
  shaderDef,
  shaderPresets,
  type NodeRecord,
  type ShaderDef,
  type ShaderParam,
  type ShaderProps,
} from '@openpaper/core';
import { getState, setState, toast, useEditor } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import { Select } from '../../ui/Select.tsx';
import { currentShaderFrame } from './ShaderLayer.tsx';

type Patch = Record<string, unknown>;

function useCommitter(nodes: NodeRecord[]) {
  const ids = nodes.map((n) => n.id);
  /** Show params immediately without committing (slider drags). */
  const preview = (patch: Patch) =>
    setState((s) => {
      const next = { ...s.shaderPreview };
      for (const n of nodes) next[n.id] = { ...(s.shaderPreview[n.id] ?? n.props ?? {}), ...(patch as ShaderProps) };
      return { shaderPreview: next };
    });
  const clearPreview = () =>
    setState((s) => {
      const next = { ...s.shaderPreview };
      for (const id of ids) delete next[id];
      return { shaderPreview: next };
    });
  const commit = async (patch: Patch, preset?: string) => {
    try {
      await command({ type: 'setShaderProps', nodeIds: ids, patch, ...(preset ? { preset } : {}) });
    } finally {
      clearPreview();
    }
  };
  return { preview, commit, clearPreview };
}

function formatValue(p: Extract<ShaderParam, { kind: 'number' }>, v: number): string {
  if (p.format === 'percent') return `${Math.round(v * 1000) / 10}%`;
  if (p.format === 'degrees') return `${Math.round(v * 10) / 10}°`;
  return String(Math.round(v * 100) / 100);
}

function parseValue(p: Extract<ShaderParam, { kind: 'number' }>, text: string): number | null {
  const n = Number.parseFloat(text.replace(/[%°\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return p.format === 'percent' ? n / 100 : n;
}

function ParamLabel({ text }: { text: string }) {
  return (
    <span className="op-label op-truncate" style={{ width: 84, flexShrink: 0 }} title={text}>
      {text}
    </span>
  );
}

function NumberControl({ p, value, onPreview, onCommit }: { p: Extract<ShaderParam, { kind: 'number' }>; value: number; onPreview: (v: number) => void; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(formatValue(p, value));
  const pending = useRef<number | null>(null);
  useEffect(() => setDraft(formatValue(p, value)), [p, value]);
  const finish = () => {
    if (pending.current !== null) onCommit(pending.current);
    pending.current = null;
  };
  return (
    <div className="op-row">
      <ParamLabel text={p.label} />
      <input
        className="op-slider"
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={value}
        list={p.snaps ? `snaps-${p.name}` : undefined}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          pending.current = v;
          setDraft(formatValue(p, v));
          onPreview(v);
        }}
        onPointerUp={finish}
        onKeyUp={finish}
        onBlur={finish}
      />
      {p.snaps && (
        <datalist id={`snaps-${p.name}`}>
          {p.snaps.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      <input
        className="op-input"
        style={{ width: 58, flexShrink: 0, textAlign: 'right' }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = parseValue(p, draft);
          if (v === null) setDraft(formatValue(p, value));
          else if (v !== value) onCommit(Math.min(p.max, Math.max(p.min, v)));
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </div>
  );
}

function ColorInput({ value, onCommit, onRemove }: { value: string; onCommit: (v: string) => void; onRemove?: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const hex = shaderColorToHex(value).slice(0, 7);
  return (
    <div className="op-row">
      <label className="op-swatch" style={{ cursor: 'pointer' }}>
        <span style={{ background: value }} />
        <input
          type="color"
          value={hex}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => e.currentTarget.value !== hex && onCommit(e.currentTarget.value)}
          style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
        />
      </label>
      <input
        className="op-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && draft.trim() !== value && onCommit(draft.trim())}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {onRemove && (
        <button className="op-icon-btn small" title="Remove color" onClick={onRemove}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ImageControl({ value, label, onCommit }: { value: string | undefined; label: string; onCommit: (v: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const name = value ? decodeURIComponent(value.split('/').pop() ?? value).slice(0, 40) : 'Sample image';
  return (
    <div className="op-row">
      <ParamLabel text={label} />
      <span className="op-label op-truncate" style={{ flex: 1 }} title={value}>
        {name}
      </span>
      <label className="op-btn outline compact" style={{ cursor: 'pointer', height: 26 }}>
        {busy ? 'Uploading…' : 'Choose…'}
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!file) return;
            setBusy(true);
            try {
              const res = await fetch('/api/upload', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
              if (!res.ok) throw new Error(`Upload failed (${res.status})`);
              onCommit(((await res.json()) as { url: string }).url);
            } catch (error) {
              toast(error instanceof Error ? error.message : 'Upload failed');
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {value && (
        <button className="op-icon-btn small" title="Remove image" onClick={() => onCommit(null)}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function ParamControl({ p, props, nodes }: { p: ShaderParam; props: ShaderProps; nodes: NodeRecord[] }) {
  const { preview, commit } = useCommitter(nodes);
  const value = props[p.name];
  switch (p.kind) {
    case 'number':
      return (
        <NumberControl
          p={p}
          value={typeof value === 'number' ? value : 0}
          onPreview={(v) => preview({ [p.name]: v })}
          onCommit={(v) => void commit({ [p.name]: v })}
        />
      );
    case 'enum':
    case 'boolean': {
      const options = p.kind === 'boolean' ? ['false', 'true'] : p.options;
      const current = String(value ?? (p.kind === 'boolean' ? 'false' : ''));
      const label = (o: string) => (p.kind === 'boolean' ? (o === 'true' ? 'On' : 'Off') : o);
      return (
        <div className="op-row">
          <ParamLabel text={p.label} />
          {p.kind === 'enum' && p.control === 'select' ? (
            <Select value={current} options={options.map((o) => ({ value: o, label: o }))} onChange={(v) => void commit({ [p.name]: v })} />
          ) : (
            <div className="op-toolbar" style={{ padding: 2, flexWrap: 'wrap' }}>
              {options.map((o) => (
                <button
                  key={o}
                  className={`op-icon-btn small${current === o ? ' active' : ''}`}
                  style={{ width: 'auto', padding: '0 6px', fontSize: 11 }}
                  onClick={() => void commit({ [p.name]: p.kind === 'boolean' ? o === 'true' : o })}
                >
                  {label(o)}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    case 'color':
      return (
        <div className="op-row">
          <ParamLabel text={p.label} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <ColorInput value={typeof value === 'string' ? value : '#000000'} onCommit={(v) => void commit({ [p.name]: v })} />
          </div>
        </div>
      );
    case 'colors': {
      const list = Array.isArray(value) ? value : [];
      return (
        <>
          <span className="op-label">{p.label}</span>
          {list.map((c, i) => (
            <ColorInput
              key={i}
              value={c}
              onCommit={(v) => void commit({ colors: list.map((x, j) => (j === i ? v : x)) })}
              onRemove={list.length > 1 ? () => void commit({ colors: list.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
          {list.length < p.max && (
            <button className="op-btn" style={{ alignSelf: 'flex-start' }} onClick={() => void commit({ colors: [...list, list[list.length - 1] ?? '#ffffff'] })}>
              <Plus size={12} /> Add color
            </button>
          )}
        </>
      );
    }
    case 'image':
      return <ImageControl label={p.label} value={typeof value === 'string' ? value : undefined} onCommit={(v) => void commit({ image: v })} />;
  }
}

function GroupSection({ def, groupId, props, nodes }: { def: ShaderDef; groupId: string; props: ShaderProps; nodes: NodeRecord[] }) {
  const group = def.groups.find((g) => g.id === groupId)!;
  const params = def.params.filter((p) => p.group === groupId);
  const { commit } = useCommitter(nodes);
  const on = !group.optional || isGroupOn(def, groupId, props);
  return (
    <div className="op-section">
      <div className="op-section-title">
        <span style={{ opacity: on ? 1 : 0.5 }}>{group.label}</span>
        {group.optional && (
          <button
            className="op-icon-btn small"
            title={on ? `Turn ${group.label.toLowerCase()} off` : `Add ${group.label.toLowerCase()}`}
            onClick={() => void commit(on ? Object.fromEntries(Object.keys(group.enable ?? {}).map((k) => [k, null])) : { ...group.enable })}
          >
            {on ? <Minus size={13} /> : <Plus size={13} />}
          </button>
        )}
      </div>
      {on && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {params.map((p) => (
            <ParamControl key={p.name} p={p} props={props} nodes={nodes} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Inspector sections for shader layers (all selected layers must be the same effect). */
export function ShaderInspector({ nodes }: { nodes: NodeRecord[] }) {
  const def = shaderDef(nodes[0]!.component);
  const preview = useEditor((s) => s.shaderPreview[nodes[0]!.id]);
  const { commit } = useCommitter(nodes);
  if (!def || nodes.some((n) => n.component !== def.component)) return null;
  const props = preview ?? nodes[0]!.props ?? {};
  const main = def.params.filter((p) => !p.group);
  const speed = typeof props.speed === 'number' ? props.speed : 0;
  const lastSpeed = rememberSpeed(nodes[0]!.id, speed);

  return (
    <>
      <div className="op-section">
        <div className="op-section-title">
          <span>{def.label}</span>
          {def.animated && (
            <button
              className="op-icon-btn small"
              title={speed ? 'Pause animation' : 'Play animation'}
              onClick={() => {
                if (speed) {
                  const frames = Object.fromEntries(nodes.map((n) => [n.id, currentShaderFrame(n.id) ?? 0]));
                  void commit({ speed: 0, frame: frames[nodes[0]!.id] ?? 0 });
                } else void commit({ speed: lastSpeed || 1 });
              }}
            >
              {speed ? <Pause size={13} /> : <Play size={13} />}
            </button>
          )}
        </div>
        <div className="op-label" style={{ lineHeight: 1.45, marginBottom: 8 }}>
          {def.description}
        </div>
        <div className="op-grid-2">
          {shaderPresets(def).map((preset) => (
            <button key={preset.name} className="op-btn outline" style={{ minWidth: 0 }} title={`Apply the ${preset.name} preset`} onClick={() => void commit({}, preset.name)}>
              <span className="op-truncate">{preset.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="op-section">
        <div className="op-section-title">
          <span>Parameters</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {main.map((p) => (
            <ParamControl key={p.name} p={p} props={props} nodes={nodes} />
          ))}
        </div>
      </div>
      {def.groups.map((g) => (
        <GroupSection key={g.id} def={def} groupId={g.id} props={props} nodes={nodes} />
      ))}
    </>
  );
}

const lastSpeeds = new Map<string, number>();
function rememberSpeed(id: string, speed: number): number {
  if (speed) lastSpeeds.set(id, speed);
  return lastSpeeds.get(id) ?? 1;
}

/** Remember what each animated shader is showing when the editor closes the file (not undoable). */
export function persistShaderFrames(): void {
  const doc = getState().doc;
  if (!doc) return;
  const frames: Record<string, number> = {};
  for (const n of Object.values(doc.nodes)) {
    if (!shaderDef(n.component)?.animated || !n.props?.speed) continue;
    const f = currentShaderFrame(n.id);
    if (f !== null) frames[n.id] = f;
  }
  if (Object.keys(frames).length) void command({ type: 'setShaderFrame', frames }).catch(() => {});
}
