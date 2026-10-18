import { figmaToHtml, readFigmaClipboard } from '@openpaper/core';
import { getState, setState, toast } from '../../state/store.ts';
import { client, command } from '../../sync/session.ts';
import { zoomToFit } from '../canvas/Canvas.tsx';

export type FigmaTokenChoice = 'with-images' | 'without-images' | 'cancel';

/** Ask for a Figma token (only when the pasted layers contain images and none is configured). */
function askForToken(images: number): Promise<FigmaTokenChoice> {
  return new Promise((resolve) => setState({ figmaPrompt: { images, resolve } }));
}

/** Paste layers copied in Figma: decode the clipboard, convert to HTML layers and insert them. */
export async function pasteFigma(html: string, target: string): Promise<void> {
  const s = getState();
  const parent = s.doc?.nodes[target];
  if (!parent) return;
  const onCanvas = parent.component === 'PageRoot';
  let converted: ReturnType<typeof figmaToHtml>;
  try {
    const clip = readFigmaClipboard(html);
    if (!clip) return;
    converted = figmaToHtml(clip.message, { fileKey: clip.meta?.fileKey, keepPositions: onCanvas });
  } catch (error) {
    toast(`Could not read the Figma clipboard: ${error instanceof Error ? error.message : String(error)}`, 5000);
    return;
  }
  if (!converted.html.trim()) {
    toast('Nothing to paste from Figma');
    return;
  }
  let images = converted.images > 0;
  if (images) {
    const config = await client.request<{ tokenSource: string | null }>('figma.config.get').catch(() => ({ tokenSource: null }));
    if (!config.tokenSource) {
      const choice = await askForToken(converted.images);
      if (choice === 'cancel') return;
      images = choice === 'with-images';
    }
  }
  const busy = images ? setTimeout(() => toast('Fetching images from Figma…', 3000), 400) : null;
  try {
    const result = await command<{ ids: string[] }>({ type: 'insertHtml', parentId: target, html: converted.html, keepLayout: onCanvas });
    if (!result.ids?.length) return;
    setState({ selection: result.ids, tool: 'select' });
    if (onCanvas) requestAnimationFrame(() => zoomToFit(result.ids, 120));
    const n = converted.layers;
    const note = converted.warnings[0] ? ` ${converted.warnings[0]}` : '';
    toast(`Pasted ${n} layer${n === 1 ? '' : 's'} from Figma.${note}`, note ? 6000 : 2600);
  } finally {
    if (busy) clearTimeout(busy);
  }
}
