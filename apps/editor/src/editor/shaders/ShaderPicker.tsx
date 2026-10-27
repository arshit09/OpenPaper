import { useEffect } from 'react';
import { X } from 'lucide-react';
import {
  findFreeSpot,
  FREEFORM_DISPLAY,
  readerOf,
  SHADER_DEFAULT_SIZE,
  SHADERS,
  shaderPresetProps,
  topLevelBoxes,
  type ShaderCategory,
  type ShaderDef,
} from '@openpaper/core';
import { getState, setState, useEditor } from '../../state/store.ts';
import { command } from '../../sync/session.ts';
import { clientToWorld, viewportRect, worldRectOf } from '../canvas/geometry.ts';
import { zoomToFit } from '../canvas/Canvas.tsx';
import { useShaderThumbnail } from './thumbnails.ts';

const CATEGORIES: Array<{ id: ShaderCategory; title: string }> = [
  { id: 'effect', title: 'Effects' },
  { id: 'image', title: 'Image filters' },
  { id: 'logo', title: 'Logo animations' },
];

/** Add a shader layer: into the selected frame, or at a free spot near the middle of the viewport. */
export async function insertShader(def: ShaderDef): Promise<void> {
  const s = getState();
  const doc = s.doc;
  const page = doc && s.pageId ? doc.pages[s.pageId] : undefined;
  if (!doc || !page) return;
  const { props, background } = shaderPresetProps(def);
  const sel = s.selection.length === 1 ? doc.nodes[s.selection[0]!] : undefined;
  let parentId = page.rootId;
  let w = SHADER_DEFAULT_SIZE.width;
  let h = SHADER_DEFAULT_SIZE.height;
  const styles: Record<string, string> = {};
  if (sel?.component === 'Frame' && sel.isVisible) {
    parentId = sel.id;
    const r = worldRectOf(sel.id);
    if (r) {
      w = Math.max(40, Math.min(w, Math.round(r.width)));
      h = Math.max(40, Math.min(h, Math.round(r.height)));
    }
    if (sel.styles.display === FREEFORM_DISPLAY) Object.assign(styles, { left: '0px', top: '0px' });
  } else {
    const vr = viewportRect();
    const a = clientToWorld(vr.left, vr.top);
    const b = clientToWorld(vr.right, vr.bottom);
    const root = doc.nodes[page.rootId]!;
    const spot = findFreeSpot(topLevelBoxes(readerOf(doc), root, null), w, h, {
      viewport: { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y },
    });
    Object.assign(styles, { left: `${spot.x}px`, top: `${spot.y}px` });
  }
  Object.assign(styles, { width: `${w}px`, height: `${h}px` });
  if (background) styles.backgroundColor = background;
  const result = await command<{ ids: string[] }>({
    type: 'createNodes',
    parentId,
    nodes: [{ component: def.component, label: def.label, styles, props }],
  });
  const id = result.ids?.[0];
  if (!id) return;
  setState({ selection: [id], tool: 'select', showShaders: false });
  if (parentId === page.rootId) requestAnimationFrame(() => zoomToFit([id], 120));
}

function Tile({ def }: { def: ShaderDef }) {
  const thumb = useShaderThumbnail(def);
  return (
    <button className="op-shader-tile" title={`${def.label} — ${def.description}`} onClick={() => void insertShader(def)}>
      <span className="op-shader-thumb" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined} />
      <span className="op-shader-name">{def.label}</span>
    </button>
  );
}

/** The Shaders popup (toolbar button, S). */
export function ShaderPicker() {
  const open = useEditor((s) => s.showShaders);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ showShaders: false });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="op-shader-picker" role="dialog" aria-label="Shaders" data-op-overlay-ui onPointerDown={(e) => e.stopPropagation()}>
      <div className="op-row" style={{ padding: '8px 8px 4px 12px', minHeight: 40 }}>
        <b style={{ flex: 1 }}>Shaders</b>
        <span className="op-label">Click to add</span>
        <button className="op-icon-btn small" title="Close (Esc)" aria-label="Close" onClick={() => setState({ showShaders: false })}>
          <X size={13} />
        </button>
      </div>
      <div className="op-scroll" style={{ padding: '0 12px 12px', maxHeight: 'min(70vh, 640px)' }}>
        {CATEGORIES.map((c) => (
          <div key={c.id}>
            <div className="op-section-title" style={{ margin: '10px 0 6px' }}>
              <span>{c.title}</span>
            </div>
            <div className="op-shader-grid">
              {SHADERS.filter((s) => s.category === c.id).map((def) => (
                <Tile key={def.component} def={def} />
              ))}
            </div>
          </div>
        ))}
        <div className="op-label" style={{ marginTop: 12, lineHeight: 1.5 }}>
          Powered by Paper Shaders (Apache-2.0) — shaders.paper.design
        </div>
      </div>
    </div>
  );
}
