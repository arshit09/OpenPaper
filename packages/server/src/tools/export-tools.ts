import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { displayName, primaryImageUrl, readerOf, resolveTokenValue, subtreeOf, type NodeRecord } from '@openpaper/core';
import { doc, layoutFor, nodeNotFoundLong, pageIdOfNodeIn, record, ToolError, type Call, type HandlerResult } from './context.ts';

interface ExportEntry {
  format: 'avif' | 'jpg' | 'mp4' | 'pdf' | 'png' | 'svg' | 'webm' | 'webp';
  scale: string;
}

function safeFileName(name: string): string {
  const cleaned = name
    .replace(/^\.+/, '')
    .replace(/[/\\]/g, '_')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .trim();
  return cleaned || 'Untitled';
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  let candidate = join(dir, `${base}.${ext}`);
  for (let n = 1; existsSync(candidate); n++) candidate = join(dir, `${base} (${n}).${ext}`);
  return candidate;
}

function pixelRatio(scale: string, width: number, height: number): number {
  const m = /^(\d+(?:\.\d+)?)(x|w|h|p)$/.exec(scale);
  if (!m) return 1;
  const v = Number(m[1]);
  switch (m[2]) {
    case 'x':
      return v || 1;
    case 'w':
      return width ? v / width : 1;
    case 'h':
      return height ? v / height : 1;
    case 'p':
      return Math.min(width, height) ? v / Math.min(width, height) : 1;
  }
  return 1;
}

function generatingNote(call: Call, ids: string[]): string | undefined {
  const d = doc(call);
  let count = 0;
  for (const id of ids) for (const n of subtreeOf(readerOf(d), id)) if (n.imageGeneration?.status === 'processing') count++;
  return count ? `${count} image(s) are still generating; the export may show placeholders. Poll get_node_info and retry once they are ready.` : undefined;
}

async function svgMarkupFor(call: Call, node: NodeRecord): Promise<string | null> {
  const d = doc(call);
  if (node.component === 'SVG' && node.svg) {
    // Resolve token variables to literal values so the file stands alone.
    return node.svg.replace(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^)]*)?\)/g, (m) => resolveTokenValue(m, d.tokens));
  }
  const url = primaryImageUrl(node);
  if (url && /\.svg($|[?#])/i.test(url) && url.startsWith('/media/')) {
    const path = call.env.media.pathFor(url);
    if (path) return readFile(path, 'utf8');
  }
  return null;
}

async function exportOne(call: Call, node: NodeRecord, entry: ExportEntry): Promise<string> {
  const d = doc(call);
  const suffix = entry.scale === '1x' ? '' : `@${entry.scale}`;
  const base = safeFileName(`${displayName(node)}${suffix}`);
  const dir = call.env.paths.exports;
  switch (entry.format) {
    case 'png':
    case 'jpg':
    case 'webp': {
      const size = await call.env.render.nodeSize(d, node.id);
      if (!size) throw new Error(`No rendered element found for node ${node.id}`);
      const ratio = pixelRatio(entry.scale, size.width, size.height);
      const data = await call.env.render.exportRaster(d, node.id, entry.format, ratio);
      const path = await uniquePath(dir, base, entry.format);
      await writeFile(path, data);
      return path;
    }
    case 'pdf': {
      const data = await call.env.render.exportPdf(d, node.id);
      const path = await uniquePath(dir, base, 'pdf');
      await writeFile(path, data);
      return path;
    }
    case 'svg': {
      const markup = await svgMarkupFor(call, node);
      if (!markup) throw new Error('SVG export is not supported for this node, try a raster format instead.');
      const path = await uniquePath(dir, base, 'svg');
      await writeFile(path, markup);
      return path;
    }
    case 'avif':
      throw new Error('AVIF export is not supported yet. Use png, jpg or webp instead.');
    default:
      throw new Error('Video export is not supported in OpenPaper yet.');
  }
}

export async function exportNodes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const nodesArg = call.args.nodes as 'nodes-with-exports-only' | Record<string, ExportEntry[]>;
  const type = (call.args.type as string | undefined) ?? 'image';
  if (nodesArg === 'nodes-with-exports-only') {
    throw new ToolError('Nothing found to export. Add export settings to nodes first or ask the agent to export specific elements.');
  }
  const jobs: Array<{ node: NodeRecord; entry: ExportEntry }> = [];
  for (const [id, entries] of Object.entries(nodesArg)) {
    const node = d.nodes[id];
    if (!node) throw new ToolError(nodeNotFoundLong(id));
    const list = entries.length ? entries : [{ format: type === 'video' ? 'mp4' : 'png', scale: '2x' } as ExportEntry];
    for (const entry of list) jobs.push({ node, entry: entry.format === 'pdf' && !entries.length ? { ...entry, scale: '1x' } : entry });
  }
  record(
    call,
    jobs.map((j) => j.node.id),
    'read'
  );
  const note = generatingNote(
    call,
    jobs.map((j) => j.node.id)
  );
  const exports: Array<{ nodeId: string; filePath: string }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  for (const job of jobs) {
    try {
      exports.push({ nodeId: job.node.id, filePath: await exportOne(call, job.node, job.entry) });
    } catch (error) {
      errors.push({ nodeId: job.node.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { data: { ...(note ? { note } : {}), exports, ...(errors.length ? { errors } : {}) } };
}

export async function exportCombinedPdf(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const ids = call.args.nodeIds as string[];
  const nodes: NodeRecord[] = [];
  for (const id of ids) {
    const n = d.nodes[id];
    if (!n) throw new ToolError(nodeNotFoundLong(id));
    nodes.push(n);
  }
  record(call, ids, 'read');
  const layout = await layoutFor(call, pageIdOfNodeIn(d, nodes[0]!));
  const boxes = nodes
    .map((n) => ({ n, b: layout?.[n.id] }))
    .filter((x) => !x.b || (x.b.width > 0 && x.b.height > 0))
    .map((x) => ({ n: x.n, y: x.b?.worldY ?? 0, x: x.b?.worldX ?? 0, h: x.b?.height ?? 1 }));
  boxes.sort((a, b) => a.y - b.y);
  // Group into rows: a node joins a row when it overlaps the row's first node by ≥15% of the smaller height.
  const rows: Array<typeof boxes> = [];
  for (const box of boxes) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (first) {
      const overlap = Math.min(first.y + first.h, box.y + box.h) - Math.max(first.y, box.y);
      if (overlap >= 0.15 * Math.min(first.h, box.h)) {
        row.push(box);
        continue;
      }
    }
    rows.push([box]);
  }
  const ordered = rows.flatMap((row) => row.sort((a, b) => a.x - b.x)).map((b) => b.n);
  try {
    const parts: Buffer[] = [];
    for (const n of ordered) parts.push(await call.env.render.exportPdf(d, n.id));
    const data = await call.env.render.combinePdfs(parts);
    const base = ordered.length === 1 ? safeFileName(displayName(ordered[0]!)) : 'Combined';
    const path = await uniquePath(call.env.paths.exports, base, 'pdf');
    await writeFile(path, data);
    const note = generatingNote(call, ids);
    return { data: { ...(note ? { note } : {}), exports: ordered.map((n) => ({ nodeId: n.id, filePath: path })) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: { exports: ordered.map((n) => ({ nodeId: n.id, error: message.startsWith('Error assembling') ? message : `Error assembling PDF page for "${displayName(n)}"` })) } };
  }
}

export function extOf(path: string): string {
  return extname(path).slice(1);
}
