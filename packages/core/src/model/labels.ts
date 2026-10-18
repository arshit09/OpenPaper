import { cssUrls } from '../styles/css.ts';
import type { NodeRecord } from './types.ts';

const MAX_STORED_LABEL = 200;

/** First image URL of a node's fill (CSS background-image; the first layer is topmost). */
export function primaryImageUrl(node: NodeRecord): string | null {
  if (node.component === 'Image' && node.src) return node.src;
  const bg = node.styles.backgroundImage ?? node.styles.background;
  if (!bg) return null;
  return cssUrls(bg)[0] ?? null;
}

function fileNameFromUrl(url: string): string | null {
  if (url.startsWith('data:')) return null;
  try {
    const path = url.includes('://') ? new URL(url).pathname : url.split(/[?#]/)[0]!;
    const name = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    // Content-addressed media names are not meaningful to people.
    if (/^[a-f0-9]{32}\.[a-z0-9]+$/i.test(name)) return null;
    return name || null;
  } catch {
    return null;
  }
}

/**
 * The name shown for a layer. Renamed layers keep their label; Text layers are
 * named after their text; image-filled frames after their image.
 */
export function displayName(node: NodeRecord): string {
  if (node.component === 'PageRoot') return '(page root)';
  if (!node.labelIsModified) {
    if (node.component === 'Text') {
      const text = node.textValue ?? '';
      if (text.length > 20) return `${text.slice(0, 20)}…`;
      const collapsed = text.replace(/\s+/g, ' ').trim();
      if (collapsed) return collapsed;
    } else if (node.component === 'Frame' || node.component === 'Rectangle' || node.component === 'Image') {
      const image = primaryImageUrl(node);
      if (image) return fileNameFromUrl(image) ?? 'Image';
    }
  }
  return node.label.length > MAX_STORED_LABEL ? `${node.label.slice(0, MAX_STORED_LABEL)}…` : node.label;
}
