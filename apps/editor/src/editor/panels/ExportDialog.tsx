import { useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { displayName } from '@openpaper/core';
import { useEditor, setState, toast } from '../../state/store.ts';
import { client } from '../../sync/session.ts';
import { Select } from '../../ui/Select.tsx';

type Format = 'png' | 'jpg' | 'webp' | 'svg' | 'pdf';

const FORMATS: { value: Format; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpg', label: 'JPG' },
  { value: 'webp', label: 'WebP' },
  { value: 'svg', label: 'SVG (vector layers)' },
  { value: 'pdf', label: 'PDF' },
];
const SCALES = [0.5, 1, 2, 3, 4].map((s) => ({ value: String(s), label: `${s}x` }));

function download(base64: string, mimeType: string, name: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function ExportDialog() {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  const pageId = useEditor((s) => s.pageId);
  const [format, setFormat] = useState<Format>('png');
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  const page = pageId ? doc.pages[pageId] : undefined;
  const targets = selection.length ? selection : (page ? doc.nodes[page.rootId]?.children ?? [] : []);
  const close = () => setState({ showExport: false });

  const run = async () => {
    setBusy(true);
    try {
      for (const id of targets) {
        const node = doc.nodes[id];
        if (!node) continue;
        const result = await client.request<{ mimeType: string; data: string }>('export.render', { fileId: doc.id, nodeId: id, format, scale });
        const suffix = format === 'pdf' || format === 'svg' || scale === 1 ? '' : `@${scale}x`;
        download(result.data, result.mimeType, `${displayName(node)}${suffix}.${format}`);
      }
      toast(`Exported ${targets.length} file${targets.length === 1 ? '' : 's'}`);
      close();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="op-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="op-dialog" role="dialog" aria-label="Export" style={{ width: 380 }}>
        <header>
          <span>Export</span>
          <button className="op-icon-btn" title="Close" aria-label="Close" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="op-label">
            {selection.length ? `${selection.length} selected layer(s)` : `All ${targets.length} top-level layer(s) on this page`}
          </div>
          <div className="op-grid-2">
            <label className="op-field">
              <span className="op-label">Format</span>
              <Select value={format} options={FORMATS} onChange={setFormat} />
            </label>
            <label className="op-field">
              <span className="op-label">Scale</span>
              <Select value={String(scale)} options={SCALES} disabled={format === 'pdf' || format === 'svg'} onChange={(v) => setScale(Number(v))} />
            </label>
          </div>
          <button className="op-btn primary" style={{ marginTop: 4 }} disabled={busy || !targets.length} onClick={() => void run()}>
            {busy ? <Loader2 size={14} className="op-spin" /> : <Download size={14} />} {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
