import {
  formatKeyframes,
  KeyframesError,
  keyframesName,
  nodeAnimationNames,
  parseKeyframesInput,
  readerOf,
  renameAnimationValue,
  renameSvgAnimations,
  type KeyframesRecord,
  type PaperDocument,
} from '@openpaper/core';
import { doc, record, ToolError, type Call, type HandlerResult } from './context.ts';

/** OpenPaper extension: the file's `@keyframes` (animations layers play through `animation` styles). */

const USED_BY_LIMIT = 20;

/** Ids of the layers that play each keyframes rule. */
function usage(d: PaperDocument): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of readerOf(d).allNodes()) {
    for (const name of new Set(nodeAnimationNames(node))) {
      const list = out.get(name);
      if (list) list.push(node.id);
      else out.set(name, [node.id]);
    }
  }
  return out;
}

export async function getKeyframes(call: Call): Promise<HandlerResult> {
  const d = doc(call);
  const wanted = call.args.names as string[] | undefined;
  const used = usage(d);
  const list = (d.keyframes ?? []).filter((k) => !wanted?.length || wanted.includes(k.name));
  const missing = [...used.keys()].filter((name) => !(d.keyframes ?? []).some((k) => k.name === name));
  return {
    data: {
      keyframes: list.map((k) => {
        const ids = used.get(k.name) ?? [];
        return { name: k.name, css: formatKeyframes(k), usedBy: ids.slice(0, USED_BY_LIMIT), ...(ids.length > USED_BY_LIMIT ? { usedByCount: ids.length } : {}) };
      }),
      // Layers that name an animation the file doesn't define play nothing.
      ...(missing.length && !wanted?.length ? { undefinedAnimations: missing.map((name) => ({ name, usedBy: used.get(name)!.slice(0, USED_BY_LIMIT) })) } : {}),
    },
  };
}

interface KeyframesEdit {
  name: string;
  css?: string;
  newName?: string;
  delete?: boolean;
}

export async function setKeyframes(call: Call): Promise<HandlerResult> {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  const edits = call.args.keyframes as KeyframesEdit[];
  const results: Array<{ name: string; result: 'created' | 'updated' | 'renamed' | 'deleted' | 'error'; message?: string; layersUpdated?: number }> = [];
  const touched: string[] = [];
  call.live.transact(call.actor, 'set_keyframes', (tx) => {
    const list: KeyframesRecord[] = [...tx.getKeyframes()];
    let changed = false;
    for (const edit of edits) {
      // Stored under the name the file uses (`op-…` names live as `design-op-…`).
      const name = keyframesName(edit.name) ?? edit.name;
      const i = list.findIndex((k) => k.name === name);
      try {
        if (edit.delete) {
          if (i < 0) throw new KeyframesError(`No keyframes named "${edit.name}".`);
          list.splice(i, 1);
          changed = true;
          results.push({ name, result: 'deleted' });
          continue;
        }
        let rule = i >= 0 ? list[i]! : null;
        if (edit.css !== undefined) rule = parseKeyframesInput(edit.name, edit.css);
        if (!rule) throw new KeyframesError(`No keyframes named "${edit.name}". Give css to create them.`);
        let layersUpdated = 0;
        const to = edit.newName === undefined ? name : keyframesName(edit.newName);
        if (!to) throw new KeyframesError(`"${edit.newName}" is not a usable keyframes name.`);
        const renaming = to !== name;
        if (renaming) {
          if (list.some((k, j) => j !== i && k.name === to)) throw new KeyframesError(`Keyframes named "${to}" already exist.`);
          rule = { ...rule, name: to };
          // Layers that played the old name play the new one.
          const renames = new Map([[name, to]]);
          for (const node of [...tx.allNodes()]) {
            if (!nodeAnimationNames(node).includes(name)) continue;
            tx.updateNode(node.id, (n) => {
              for (const prop of ['animation', 'animationName'] as const) {
                const v = n.styles[prop];
                if (v) n.styles[prop] = renameAnimationValue(prop, v, renames);
              }
              if (n.svg) n.svg = renameSvgAnimations(n.svg, renames);
            });
            touched.push(node.id);
            layersUpdated++;
          }
        }
        if (i < 0 || list[i]!.name !== rule.name || list[i]!.css !== rule.css) changed = true;
        if (i >= 0) list[i] = rule;
        else list.push(rule);
        results.push({ name: rule.name, result: i < 0 ? 'created' : renaming ? 'renamed' : 'updated', ...(layersUpdated ? { layersUpdated } : {}) });
      } catch (error) {
        if (!(error instanceof KeyframesError)) throw error;
        results.push({ name: edit.name, result: 'error', message: error.message });
      }
    }
    // Nothing new (only errors, or the same rules again): no change, so no undo step.
    if (changed) tx.setKeyframes(list);
  });
  if (touched.length) record(call, touched, 'edit');
  return { data: { results } };
}
