import {
  applyShaderPropsPatch,
  displayName,
  SHADERS,
  shaderDef,
  shaderPresetProps,
  shaderPresets,
  type ShaderDef,
  type ShaderParam,
  type ShaderProps,
} from '@openpaper/core';
import { record, ToolError, type Call, type HandlerResult } from './context.ts';

type ShaderUpdate = { nodeId: string; preset?: string; params?: Record<string, unknown> };

const isRemoteOrData = (u: string) => /^(https?:|data:)/i.test(u);

/** update_shader (OpenPaper extension): apply a preset and/or change params of shader layers. */
export async function updateShader(call: Call): Promise<HandlerResult> {
  if (!call.live) throw new ToolError('Open an OpenPaper file to use this tool.');
  const items = call.args.updates as ShaderUpdate[];
  if (!items.length) throw new ToolError('No updates provided');

  // Remote / data-URI images are imported into the media store first (like write_html images).
  const imageUrls = items.map((u) => u.params?.image).filter((u): u is string => typeof u === 'string' && isRemoteOrData(u));
  const resolved = imageUrls.length ? await call.env.assets.resolveAll(imageUrls) : new Map();

  const updates: Array<{ nodeId: string; type: string; props: ShaderProps }> = [];
  const errors: Array<{ nodeId: string; error: string }> = [];
  call.live.transact(call.actor, 'update_shader', (tx) => {
    for (const item of items) {
      const node = tx.getNode(item.nodeId);
      const shader = node && shaderDef(node.component);
      if (!node) {
        errors.push({ nodeId: item.nodeId, error: `Node not found: ${item.nodeId}` });
        continue;
      }
      if (!shader) {
        errors.push({ nodeId: item.nodeId, error: `Node "${displayName(node)}" is a ${node.component}, not a shader layer` });
        continue;
      }
      try {
        let props: ShaderProps = { ...(node.props ?? {}) };
        let background: string | null | undefined;
        if (item.preset !== undefined) {
          const preset = shaderPresets(shader).find((p) => p.name.toLowerCase() === item.preset!.toLowerCase());
          if (!preset) throw new Error(`${shader.label} has no preset "${item.preset}". Presets: ${shaderPresets(shader).map((p) => p.name).join(', ')}.`);
          const applied = shaderPresetProps(shader, preset.name);
          props = { ...applied.props, ...(props.image ? { image: props.image } : {}), ...(props.frame !== undefined ? { frame: props.frame } : {}) };
          background = applied.background;
        }
        const params = { ...(item.params ?? {}) };
        if (typeof params.image === 'string' && isRemoteOrData(params.image)) {
          const r = resolved.get(params.image);
          if (!r) throw new Error(`Could not load the image: ${params.image.slice(0, 120)}`);
          params.image = r.url;
        }
        props = applyShaderPropsPatch(shader, props, params);
        tx.updateNode(node.id, (n) => {
          n.props = props;
          if (background !== undefined) {
            if (background) n.styles.backgroundColor = background;
            else delete n.styles.backgroundColor;
          }
        });
        updates.push({ nodeId: node.id, type: shader.name, props });
      } catch (error) {
        errors.push({ nodeId: node.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  record(
    call,
    updates.map((u) => u.nodeId),
    'edit'
  );
  return { data: { updates, ...(errors.length ? { errors } : {}) } };
}

// ---- guide -----------------------------------------------------------------------

function describeParam(p: ShaderParam): string {
  switch (p.kind) {
    case 'number': {
      const unit = p.format === 'degrees' ? '°' : '';
      return `${p.name} (${p.min}–${p.max}${unit})`;
    }
    case 'enum':
      return `${p.name} (${p.options.join(' | ')})`;
    case 'boolean':
      return `${p.name} (true | false)`;
    case 'color':
      return `${p.name} (color)`;
    case 'colors':
      return `colors (list of up to ${p.max})`;
    case 'image':
      return 'image (URL or paper-asset:// path)';
  }
}

function describeShader(s: ShaderDef): string {
  const { props, background } = shaderPresetProps(s);
  const defaults = Object.entries(props)
    .filter(([k]) => k !== 'frame')
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(' ') : v}`)
    .join(', ');
  return [
    `#### ${s.name} — ${s.label}${s.animated ? ' (animated)' : ''}`,
    s.description,
    `- Params: ${s.params.map(describeParam).join(', ')}`,
    `- Defaults: ${defaults}${background ? `; background ${background}` : ''}`,
    `- Presets: ${shaderPresets(s)
      .map((p) => p.name)
      .join(', ')}`,
  ].join('\n');
}

export function shaderGuide(): string {
  const section = (category: ShaderDef['category'], title: string) =>
    `### ${title}\n\n${SHADERS.filter((s) => s.category === category).map(describeShader).join('\n\n')}`;
  return `## Shader layers (OpenPaper extension)

Shader layers are GPU effects — mesh gradients, grain, dithering, noise, glows, image filters — rendered live on the canvas with @paper-design/shaders. Each is a leaf layer (it cannot contain children) whose box (size, radius, opacity, borders, background) is ordinary CSS.

### Creating

Use the \`<x-shader>\` tag in write_html:

\`\`\`html
<x-shader type="MeshGradient" layer-name="Hero glow" colors="#0b1d51 #725ac1 #f6bd60" distortion="0.9" speed="0.4" style="width: 1440px; height: 900px"></x-shader>
\`\`\`

- \`type\`: an effect name from the list below (MeshGradient, mesh-gradient and "Mesh Gradient" all work).
- \`preset="Name"\`: start from one of the effect's presets instead of the defaults.
- Every parameter is an attribute; colour lists are space-separated. Omitted parameters keep their defaults.
- Without width/height the layer is 800×600px. The layer's background colour shows through transparent parts of the effect; presets with a background set it for you.
- To put content on top of a shader, make the shader an absolutely positioned child (\`position: absolute; inset: 0\`) of the Frame that holds the content, as its first child.
- Image filters take \`image="https://…"\` (or paper-asset://); without one they show a sample picture. Heatmap, Liquid Metal and Gem Smoke use \`image\` as the logo shape.

### Reading and editing

- get_node_info returns \`shader: { type, props }\` for shader layers.
- update_shader changes params (\`null\` removes one) and applies presets. Use update_styles for size, radius, opacity and background.
- get_jsx exports a \`@paper-design/shaders-react\` component with the same params.
- Screenshots and exports show the effect at its stored frame; animated effects play on the canvas.

### Guidance

- Shaders are best as backgrounds, hero visuals, cards and accents. One strong shader per screen usually beats several.
- Keep animated effects slow (speed 0.2–0.6) behind text, and check text contrast with get_screenshot.
- Each shader uses a WebGL context; keep it to a handful per page.

${section('effect', 'Effects')}

${section('image', 'Image filters')}

${section('logo', 'Logo animations')}
`;
}
