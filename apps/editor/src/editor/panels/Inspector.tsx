import { useEffect, useMemo, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignJustify,
  ALargeSmall,
  ArrowDown,
  ArrowRight,
  Contrast,
  Move,
  MoveHorizontal,
  MoveVertical,
  RotateCw,
  Square,
  SquareDashed,
  SquareRoundCorner,
  UnfoldHorizontal,
  UnfoldVertical,
  WrapText,
} from 'lucide-react';
import {
  displayName,
  FREEFORM_DISPLAY,
  parentKindOf,
  parseInlineStyle,
  styleMapToCss,
  type NodeRecord,
  type StyleInput,
} from '@openpaper/core';
import { useEditor } from '../../state/store.ts';
import { ShaderInspector } from '../shaders/ShaderInspector.tsx';
import { client, command } from '../../sync/session.ts';
import { Select } from '../../ui/Select.tsx';

/** The untruncated name for tooltips (text layers are named after their first 20 characters). */
export function fullName(node: NodeRecord): string {
  const text = node.component === 'Text' && !node.labelIsModified ? node.textValue?.replace(/\s+/g, ' ').trim() : '';
  return text || displayName(node);
}

function useSelectedNodes(): NodeRecord[] {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  return useMemo(() => (doc ? selection.map((id) => doc.nodes[id]).filter((n): n is NodeRecord => !!n) : []), [doc, selection]);
}

function common(nodes: NodeRecord[], prop: string): string | undefined | null {
  const values = new Set(nodes.map((n) => n.styles[prop]));
  return values.size === 1 ? [...values][0] : null; // null = mixed
}

function apply(nodes: NodeRecord[], styles: StyleInput) {
  if (!nodes.length) return;
  void command({ type: 'updateStyles', updates: [{ nodeIds: nodes.map((n) => n.id), styles }] });
}

const LENGTH = /^-?\d*\.?\d+$/;

/** Text field bound to a style property (number → px for lengths). */
function StyleField({
  nodes,
  prop,
  label,
  hint,
  placeholder,
  unitless,
  width,
}: {
  nodes: NodeRecord[];
  prop: string;
  label?: React.ReactNode;
  /** Tooltip naming the property (for icon labels). */
  hint?: string;
  placeholder?: string;
  unitless?: boolean;
  width?: number;
}) {
  const value = common(nodes, prop);
  const shown = value === null ? '' : (value ?? '');
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const v = draft.trim();
    if (v === shown) return;
    apply(nodes, { [prop]: v === '' ? null : !unitless && LENGTH.test(v) ? `${v}px` : v });
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, width }}>
      {label && (
        <span className="op-field-icon" title={hint}>
          {label}
        </span>
      )}
      <input
        className="op-input"
        value={draft}
        placeholder={value === null ? 'Mixed' : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(shown);
        }}
      />
    </label>
  );
}

function toHex(color: string | undefined | null): string {
  if (!color) return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${color.slice(1).split('').map((c) => c + c).join('')}`;
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  const v = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
}

function ColorField({ nodes, prop, label }: { nodes: NodeRecord[]; prop: string; label: string }) {
  const value = common(nodes, prop);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  return (
    <div className="op-row">
      <span className="op-label op-prop-label">
        {label}
      </span>
      <label className="op-swatch" style={{ cursor: 'pointer' }}>
        <span style={{ background: value ?? 'transparent' }} />
        <input
          type="color"
          value={toHex(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => apply(nodes, { [prop]: e.currentTarget.value.toUpperCase() })}
          style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
        />
      </label>
      <input
        className="op-input"
        value={draft}
        placeholder={value === null ? 'Mixed' : 'none'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== (value ?? '') && apply(nodes, { [prop]: draft.trim() || null })}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="op-section">
      <div className="op-section-title">
        <span>{title}</span>
        {right}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T | null; options: Array<{ id: T; icon?: React.ReactNode; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="op-toolbar" style={{ padding: 2 }}>
      {options.map((o) => (
        <button
          key={o.id}
          title={o.label}
          className={`op-icon-btn small${value === o.id ? ' active' : ''}`}
          style={{ width: o.icon ? 26 : 'auto', padding: o.icon ? 0 : '0 6px', fontSize: 11 }}
          onClick={() => onChange(o.id)}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </div>
  );
}

type SizeMode = 'fixed' | 'hug' | 'fill';

const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'hug', label: 'Hug' },
  { value: 'fill', label: 'Fill' },
];
function sizeMode(v: string | undefined, flexGrow: string | undefined, axisIsMain: boolean): SizeMode {
  if (v === 'fit-content' || v === 'max-content' || v === 'auto' || (!v && !(axisIsMain && flexGrow))) return 'hug';
  if (v === '100%' || v === 'stretch' || (axisIsMain && flexGrow && flexGrow !== '0')) return 'fill';
  return 'fixed';
}

function SizeRow({ nodes, prop }: { nodes: NodeRecord[]; prop: 'width' | 'height' }) {
  const doc = useEditor((s) => s.doc);
  const first = nodes[0]!;
  const parent = first.parentId ? doc?.nodes[first.parentId] : undefined;
  const parentDir = parent?.styles.flexDirection ?? 'row';
  const parentFlex = String(parent?.styles.display ?? '').includes('flex');
  const isMain = parentFlex && (prop === 'width' ? parentDir.startsWith('row') : parentDir.startsWith('column'));
  const mode = sizeMode(first.styles[prop], first.styles.flexGrow, isMain);
  const el = document.querySelector(`[data-op-id="${CSS.escape(first.id)}"]`) as HTMLElement | null;
  const measured = el ? Math.round(prop === 'width' ? el.offsetWidth : el.offsetHeight) : 100;
  const setMode = (m: SizeMode) => {
    if (m === 'fixed') apply(nodes, { [prop]: `${measured}px`, ...(isMain ? { flexGrow: null } : {}) });
    else if (m === 'hug') apply(nodes, { [prop]: 'fit-content', ...(isMain ? { flexGrow: null } : {}) });
    else apply(nodes, isMain ? { flexGrow: '1', flexBasis: '0px', [prop]: null } : { [prop]: '100%' });
  };
  return (
    <div className="op-row">
      <StyleField nodes={nodes} prop={prop} label={prop === 'width' ? 'W' : 'H'} hint={prop === 'width' ? 'Width' : 'Height'} placeholder={`${measured}`} />
      <Select style={{ width: 70, flex: 'none' }} value={mode} options={SIZE_MODES} onChange={setMode} />
    </div>
  );
}

const SHADOWS: Record<string, string | null> = {
  None: null,
  Small: '0px 1px 2px rgba(0, 0, 0, 0.08), 0px 1px 3px rgba(0, 0, 0, 0.06)',
  Medium: '0px 4px 12px rgba(0, 0, 0, 0.10)',
  Large: '0px 12px 32px rgba(0, 0, 0, 0.14)',
};

const SHADOW_OPTIONS = [...Object.keys(SHADOWS), 'Custom'].map((k) => ({ value: k, label: k }));
const WEIGHTS = ['100', '200', '300', '400', '500', '600', '700', '800', '900'].map((w) => ({ value: w, label: w }));
const ALIGN_ITEMS = [
  { value: '', label: 'Align: stretch' },
  { value: 'flex-start', label: 'Align: start' },
  { value: 'center', label: 'Align: center' },
  { value: 'flex-end', label: 'Align: end' },
  { value: 'baseline', label: 'Align: baseline' },
];
const JUSTIFY_CONTENT = [
  { value: '', label: 'Justify: start' },
  { value: 'center', label: 'Justify: center' },
  { value: 'flex-end', label: 'Justify: end' },
  { value: 'space-between', label: 'Space between' },
  { value: 'space-around', label: 'Space around' },
];
const BACKGROUND_SIZES = [
  { value: 'cover', label: 'Fill (cover)' },
  { value: 'contain', label: 'Fit (contain)' },
  { value: '100% 100%', label: 'Stretch' },
  { value: 'auto', label: 'Original size' },
];
const TEXT_TRANSFORMS = [
  { value: '', label: 'Aa' },
  { value: 'uppercase', label: 'AA' },
  { value: 'lowercase', label: 'aa' },
  { value: 'capitalize', label: 'Aa Bb' },
];

let fontListPromise: Promise<string[]> | null = null;
function useFontList(): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    fontListPromise ??= client.request<string[]>('fonts.list').catch(() => []);
    void fontListPromise.then(setList);
  }, []);
  return list;
}

function CssEditor({ nodes }: { nodes: NodeRecord[] }) {
  const node = nodes[0]!;
  const css = styleMapToCss(node.styles, '\n');
  const [draft, setDraft] = useState(css);
  useEffect(() => setDraft(css), [css]);
  return (
    <textarea
      className="op-input op-code"
      style={{ minHeight: 140, fontSize: 11 }}
      spellCheck={false}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === css) return;
        const next = parseInlineStyle(draft.replace(/\n/g, ' '));
        const patch: StyleInput = {};
        for (const k of Object.keys(node.styles)) if (!(k in next)) patch[k] = null;
        Object.assign(patch, next);
        apply([node], patch);
      }}
    />
  );
}

function PageSettings() {
  const doc = useEditor((s) => s.doc)!;
  const pageId = useEditor((s) => s.pageId);
  const page = pageId ? doc.pages[pageId] : undefined;
  if (!page) return null;
  return (
    <Section title="Page">
      <div className="op-row">
        <span className="op-label op-prop-label">
          Canvas
        </span>
        <label className="op-swatch" style={{ cursor: 'pointer' }}>
          <span style={{ background: page.canvasColor ?? 'var(--op-canvas)' }} />
          <input
            type="color"
            value={toHex(page.canvasColor ?? '#eeeeee')}
            onChange={(e) => void command({ type: 'updatePage', pageId: page.id, canvasColor: e.target.value })}
            style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
          />
        </label>
        <button className="op-btn" onClick={() => void command({ type: 'updatePage', pageId: page.id, canvasColor: null })}>
          Reset
        </button>
      </div>
      <p className="op-label" style={{ margin: 0, lineHeight: 1.5 }}>
        Select a layer to edit its styles. Press F to draw a frame, T for text, P to sketch.
      </p>
    </Section>
  );
}

export function Inspector() {
  const nodes = useSelectedNodes();
  const doc = useEditor((s) => s.doc);
  const fonts = useFontList();
  if (!doc) return null;
  if (!nodes.length) return <PageSettings />;
  const first = nodes[0]!;
  const parent = first.parentId ? doc.nodes[first.parentId] : undefined;
  const pk = parentKindOf(parent);
  const positioned = pk === 'root' || pk === 'freeform' || first.styles.position === 'absolute';
  const allFrames = nodes.every((n) => n.component === 'Frame');
  const allSameShader = first.component.startsWith('Shader') && nodes.every((n) => n.component === first.component);
  const anyText = nodes.some((n) => n.component === 'Text');
  const display = common(nodes, 'display');
  const dir = common(nodes, 'flexDirection');
  const wrap = common(nodes, 'flexWrap');
  const layout: 'free' | 'column' | 'row' | 'wrap' | null =
    display === null ? null : display === FREEFORM_DISPLAY ? 'free' : String(display ?? '').includes('flex') ? (wrap === 'wrap' ? 'wrap' : String(dir ?? 'row').startsWith('column') ? 'column' : 'row') : null;

  return (
    <div>
      <div className="op-section" style={{ paddingBottom: 8 }}>
        <div className="op-truncate" style={{ fontWeight: 600 }} title={nodes.length === 1 ? fullName(first) : undefined}>
          {nodes.length === 1 ? displayName(first) : `${nodes.length} layers`}
        </div>
        <div className="op-label op-truncate">{nodes.length === 1 ? first.component : 'Mixed selection'}</div>
      </div>

      <Section title={positioned ? 'Position & size' : 'Size'}>
        {positioned && (
          <div className="op-grid-2">
            <StyleField nodes={nodes} prop="left" label="X" hint="X position" />
            <StyleField nodes={nodes} prop="top" label="Y" hint="Y position" />
          </div>
        )}
        <SizeRow nodes={nodes} prop="width" />
        <SizeRow nodes={nodes} prop="height" />
        <div className="op-grid-2">
          <StyleField nodes={nodes} prop="rotate" label={<RotateCw size={12} />} hint="Rotation" placeholder="0deg" unitless />
          <StyleField nodes={nodes} prop="zIndex" label="Z" hint="Z-index" placeholder="auto" unitless />
        </div>
      </Section>

      {allSameShader && <ShaderInspector nodes={nodes} />}

      {allFrames && (
        <Section
          title="Layout"
          right={
            <Segmented
              value={layout}
              options={[
                { id: 'free', icon: <Move size={13} />, label: 'Freeform (absolute children)' },
                { id: 'column', icon: <ArrowDown size={13} />, label: 'Column' },
                { id: 'row', icon: <ArrowRight size={13} />, label: 'Row' },
                { id: 'wrap', icon: <WrapText size={13} />, label: 'Wrap' },
              ]}
              onChange={(v) =>
                apply(
                  nodes,
                  v === 'free'
                    ? { display: FREEFORM_DISPLAY, flexDirection: null, flexWrap: null, gap: null, alignItems: null, justifyContent: null }
                    : { display: 'flex', flexDirection: v === 'column' ? 'column' : 'row', flexWrap: v === 'wrap' ? 'wrap' : null }
                )
              }
            />
          }
        >
          {layout && layout !== 'free' && (
            <>
              <div className="op-grid-2">
                <StyleField
                  nodes={nodes}
                  prop="gap"
                  label={layout === 'column' ? <UnfoldVertical size={12} /> : <UnfoldHorizontal size={12} />}
                  hint="Gap"
                  placeholder="0"
                />
                <StyleField nodes={nodes} prop="padding" label={<SquareDashed size={12} />} hint="Padding" placeholder="0" />
              </div>
              <div className="op-grid-2">
                <Select value={common(nodes, 'alignItems') ?? ''} options={ALIGN_ITEMS} onChange={(v) => apply(nodes, { alignItems: v || null })} />
                <Select value={common(nodes, 'justifyContent') ?? ''} options={JUSTIFY_CONTENT} onChange={(v) => apply(nodes, { justifyContent: v || null })} />
              </div>
            </>
          )}
          {layout !== 'column' && layout !== 'row' && layout !== 'wrap' && (
            <StyleField nodes={nodes} prop="padding" label={<SquareDashed size={12} />} hint="Padding" placeholder="0" />
          )}
          <label className="op-row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={common(nodes, 'overflow') === 'clip'} onChange={(e) => apply(nodes, { overflow: e.target.checked ? 'clip' : null })} />
            Clip content
          </label>
        </Section>
      )}

      <Section title="Appearance">
        <ColorField nodes={nodes} prop="backgroundColor" label="Fill" />
        {common(nodes, 'backgroundImage') && (
          <div className="op-row">
            <span className="op-label op-prop-label">
              Image
            </span>
            <Select value={common(nodes, 'backgroundSize') ?? 'cover'} options={BACKGROUND_SIZES} onChange={(v) => apply(nodes, { backgroundSize: v })} />
            <button className="op-btn" onClick={() => apply(nodes, { backgroundImage: null, backgroundSize: null, backgroundPosition: null, backgroundRepeat: null })}>
              Remove
            </button>
          </div>
        )}
        <div className="op-grid-2">
          <StyleField nodes={nodes} prop="opacity" label={<Contrast size={12} />} hint="Opacity" placeholder="1" unitless />
          <StyleField nodes={nodes} prop="borderRadius" label={<SquareRoundCorner size={12} />} hint="Corner radius" placeholder="0" />
        </div>
        <StyleField nodes={nodes} prop="border" label={<Square size={12} />} hint="Border" placeholder="1px solid #E5E5E5" />
        <div className="op-row">
          <span className="op-label op-prop-label">
            Shadow
          </span>
          <Select
            value={Object.entries(SHADOWS).find(([, v]) => v === (common(nodes, 'boxShadow') ?? null))?.[0] ?? 'Custom'}
            options={SHADOW_OPTIONS}
            onChange={(v) => v !== 'Custom' && apply(nodes, { boxShadow: SHADOWS[v] ?? null })}
          />
        </div>
      </Section>

      {anyText && (
        <Section title="Typography">
          <label className="op-row">
            <input
              className="op-input"
              list="op-font-families"
              defaultValue={common(nodes, 'fontFamily') ?? ''}
              key={common(nodes, 'fontFamily') ?? 'mixed'}
              placeholder="Font family"
              onBlur={(e) => e.currentTarget.value.trim() && apply(nodes, { fontFamily: e.currentTarget.value.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
            <datalist id="op-font-families">
              {['system-ui, sans-serif', ...fonts].map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </label>
          <div className="op-grid-2">
            <StyleField nodes={nodes} prop="fontSize" label={<ALargeSmall size={13} />} hint="Font size" placeholder="16px" />
            <Select value={common(nodes, 'fontWeight') ?? '400'} options={WEIGHTS} onChange={(v) => apply(nodes, { fontWeight: v })} />
          </div>
          <div className="op-grid-2">
            <StyleField nodes={nodes} prop="lineHeight" label={<MoveVertical size={12} />} hint="Line height" placeholder="normal" unitless />
            <StyleField nodes={nodes} prop="letterSpacing" label={<MoveHorizontal size={12} />} hint="Letter spacing" placeholder="0em" unitless />
          </div>
          <ColorField nodes={nodes} prop="color" label="Color" />
          <div className="op-row">
            <Segmented
              value={(common(nodes, 'textAlign') ?? 'left') as 'left'}
              options={[
                { id: 'left', icon: <AlignLeft size={13} />, label: 'Left' },
                { id: 'center', icon: <AlignCenter size={13} />, label: 'Center' },
                { id: 'right', icon: <AlignRight size={13} />, label: 'Right' },
                { id: 'justify', icon: <AlignJustify size={13} />, label: 'Justify' },
              ]}
              onChange={(v) => apply(nodes, { textAlign: v === 'left' ? null : v })}
            />
            <Select value={common(nodes, 'textTransform') ?? ''} options={TEXT_TRANSFORMS} onChange={(v) => apply(nodes, { textTransform: v || null })} />
          </div>
        </Section>
      )}

      {nodes.length === 1 && (
        <Section title="CSS">
          <CssEditor nodes={nodes} />
        </Section>
      )}
    </div>
  );
}
