import { memo, useMemo, type CSSProperties } from 'react';
import { parentKindOf, renderSpec, scopeSvgIds, splitSvgMarkup, svgAttrToReact } from '@openpaper/core';
import { useEditor } from '../../state/store.ts';
import { renderContext } from './render-context.ts';
import { ShaderNode } from '../shaders/ShaderLayer.tsx';

const SvgNode = memo(function SvgNode({ markup, style, id }: { markup: string; style: CSSProperties; id: string }) {
  // Ids are scoped per node: many SVGs share the canvas DOM (same rule as headless renders).
  const { attrs, inner } = useMemo(() => splitSvgMarkup(scopeSvgIds(markup, `_${id}_`)), [markup, id]);
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' || k.toLowerCase().startsWith('on')) continue;
    props[svgAttrToReact(k)] = v;
  }
  if (!props.xmlns) props.xmlns = 'http://www.w3.org/2000/svg';
  return <svg {...props} style={style} data-op-id={id} dangerouslySetInnerHTML={{ __html: inner }} />;
});

/** Renders one design node (and its subtree) as real DOM. */
export const NodeView = memo(function NodeView({ id }: { id: string }) {
  const node = useEditor((s) => s.doc?.nodes[id]);
  // Only the parent's layout kind matters; selecting a primitive avoids re-rendering siblings.
  const parentKind = useEditor((s) => parentKindOf(node?.parentId ? s.doc?.nodes[node.parentId] : undefined));
  const transient = useEditor((s) => s.transient[id]);
  const editing = useEditor((s) => s.editingTextId === id);

  if (!node) return null;
  const spec = renderSpec(node, parentKind, renderContext);
  const style = (transient ? { ...spec.style, ...transient } : spec.style) as CSSProperties;

  if (spec.kind === 'svg') return <SvgNode markup={spec.svg!} style={style} id={node.id} />;
  if (spec.kind === 'shader') return <ShaderNode node={node} style={style} />;

  if (spec.kind === 'text') {
    return (
      <div data-op-id={node.id} style={editing ? { ...style, visibility: 'hidden' } : style}>
        {spec.runs
          ? spec.runs.map((r, i) =>
              Object.keys(r.style).length ? (
                <span key={i} style={r.style as CSSProperties}>
                  {r.text}
                </span>
              ) : (
                r.text
              )
            )
          : spec.text}
      </div>
    );
  }

  if (spec.tag === 'img') {
    return <img data-op-id={node.id} style={style} src={spec.attrs.src} alt={spec.attrs.alt ?? ''} draggable={false} />;
  }
  if (spec.tag === 'video') {
    return <video data-op-id={node.id} style={style} src={spec.attrs.src} muted loop autoPlay playsInline />;
  }

  return (
    <div data-op-id={node.id} style={style}>
      {node.children.map((childId) => (
        <NodeView key={childId} id={childId} />
      ))}
    </div>
  );
});
