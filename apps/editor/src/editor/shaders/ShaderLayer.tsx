import { memo, useMemo, type CSSProperties } from 'react';
import { SHADER_HOST_STYLE, shaderDef, shaderRenderProps, type NodeRecord, type ShaderProps, type TokenRecord } from '@openpaper/core';
import { useEditor } from '../../state/store.ts';
import { renderContext } from '../canvas/render-context.ts';
import { useShaderLibrary } from './library.ts';

/** Canvas pixels must stay readable for screenshots, exports and colour picking. */
export const SHADER_GL_ATTRS = { preserveDrawingBuffer: true };

const ShaderCanvas = memo(function ShaderCanvas({
  component,
  props,
  tokens,
}: {
  component: string;
  props: ShaderProps | undefined;
  tokens: readonly TokenRecord[] | undefined;
}) {
  const def = shaderDef(component);
  const library = useShaderLibrary();
  const renderProps = useMemo(
    () => (def ? shaderRenderProps(def, props, { tokens: tokens ?? [], resolveUrl: renderContext.resolveUrl }) : null),
    [def, props, tokens]
  );
  const Comp = def && library ? library[def.name] : undefined;
  if (!Comp || !renderProps) return null;
  return <Comp {...renderProps} style={SHADER_HOST_STYLE} webGlContextAttributes={SHADER_GL_ATTRS} />;
});

/** A shader layer on the canvas: the layer box (fill, radius, borders) with the effect's canvas inside. */
export function ShaderNode({ node, style }: { node: NodeRecord; style: CSSProperties }) {
  const tokens = useEditor((s) => s.doc?.tokens);
  const preview = useEditor((s) => s.shaderPreview[node.id]);
  return (
    <div data-op-id={node.id} style={style}>
      <ShaderCanvas component={node.component} props={preview ?? node.props} tokens={tokens} />
    </div>
  );
}

/** Animation time (ms) a mounted shader layer is showing right now. */
export function currentShaderFrame(nodeId: string): number | null {
  const host = document.querySelector(`[data-op-id="${CSS.escape(nodeId)}"] [data-paper-shader]`) as
    | (HTMLElement & { paperShaderMount?: { getCurrentFrame(): number } })
    | null;
  const frame = host?.paperShaderMount?.getCurrentFrame();
  return typeof frame === 'number' && Number.isFinite(frame) ? frame : null;
}
