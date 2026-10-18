import { describe, expect, it } from 'vitest';
import { createDocument } from '../model/document.ts';
import { Transaction, readerOf } from '../model/transaction.ts';
import { pageRootIdFor } from '../model/ids.ts';
import { importHtml } from '../html/import.ts';
import { insertImported } from '../editing/insert.ts';
import { nodesToHtml } from '../export/html.ts';
import { generateJsx } from '../export/jsx.ts';
import { renderNodeHtml } from '../render/to-html.ts';
import { identityUrls } from '../render/render-spec.ts';
import {
  SHADERS,
  SHADER_COMPONENTS,
  findShader,
  shaderDef,
  shaderPresets,
} from './registry.ts';
import { applyShaderPropsPatch, shaderColorToHex, shaderPresetProps, shaderRenderProps, splitColorList } from './props.ts';

describe('shader registry', () => {
  it('covers all 30 library effects with presets', () => {
    expect(SHADERS).toHaveLength(30);
    expect(new Set(SHADERS.map((s) => s.component)).size).toBe(30);
    expect(SHADERS.map((s) => s.component)).toEqual([...SHADER_COMPONENTS]);
    for (const s of SHADERS) expect(shaderPresets(s).length, s.name).toBeGreaterThan(0);
  });

  it('only declares parameters the library knows', () => {
    for (const s of SHADERS) {
      const known = new Set(shaderPresets(s).flatMap((p) => Object.keys(p.params)));
      for (const p of s.params) {
        if (p.kind === 'image') continue;
        expect(known.has(p.name), `${s.name}.${p.name}`).toBe(true);
      }
    }
  });

  it('keeps default values inside the declared ranges and options', () => {
    for (const s of SHADERS) {
      const { props } = shaderPresetProps(s);
      for (const p of s.params) {
        const v = props[p.name];
        if (v === undefined) continue;
        if (p.kind === 'number') {
          expect(v, `${s.name}.${p.name}`).toBeGreaterThanOrEqual(p.min);
          expect(v, `${s.name}.${p.name}`).toBeLessThanOrEqual(p.max);
        }
        if (p.kind === 'enum') expect(p.options, `${s.name}.${p.name}`).toContain(v);
      }
    }
  });

  it('finds shaders by any name', () => {
    expect(findShader('mesh-gradient')?.component).toBe('ShaderMeshGradient');
    expect(findShader('MeshGradient')?.component).toBe('ShaderMeshGradient');
    expect(findShader('ShaderMetaBalls')?.name).toBe('Metaballs');
    expect(findShader('god rays')?.name).toBe('GodRays');
    expect(findShader('nope')).toBeUndefined();
  });
});

describe('shader props', () => {
  const mesh = shaderDef('ShaderMeshGradient')!;

  it('switches optional groups off when the preset leaves them at 0', () => {
    const { props, background } = shaderPresetProps(mesh);
    expect(props.grainMixer).toBeUndefined();
    expect(props.colors).toEqual(['#e0eaff', '#241d9a', '#f75092', '#9f50d3']);
    expect(props.speed).toBe(1);
    expect(background).toBeNull();
    // Rendering fills unset group params with 0.
    expect(shaderRenderProps(mesh, props).grainMixer).toBe(0);
  });

  it('turns a preset background into the layer fill', () => {
    const dots = shaderDef('ShaderDotGrid')!;
    expect(shaderPresetProps(dots).background).toBe('#000000');
    expect(shaderRenderProps(dots, shaderPresetProps(dots).props).colorBack).toBe('#00000000');
  });

  it('validates patches', () => {
    const next = applyShaderPropsPatch(mesh, {}, { distortion: '2', colors: '#f00 rgb(0 128 255)', speed: 0 });
    expect(next).toEqual({ distortion: 1, colors: ['#f00', 'rgb(0 128 255)'], speed: 0 });
    expect(() => applyShaderPropsPatch(mesh, {}, { wobble: 1 })).toThrow(/no parameter "wobble"/);
    expect(() => applyShaderPropsPatch(mesh, {}, { colors: 'notacolor' })).toThrow(/invalid color/);
    expect(applyShaderPropsPatch(mesh, { swirl: 0.3 }, { swirl: null })).toEqual({});
  });

  it('resolves colours to hex for the GPU', () => {
    expect(shaderColorToHex('rgb(255 0 0)')).toBe('#ff0000');
    expect(shaderColorToHex('#ff000080')).toBe('#ff000080');
    expect(shaderColorToHex('var(--brand)', [{ id: 't', type: 'color', name: '--brand', value: '#123456' }])).toBe('#123456');
    expect(splitColorList('#fff, rgb(0, 0, 0) hsl(0 50% 50%)')).toEqual(['#fff', 'rgb(0, 0, 0)', 'hsl(0 50% 50%)']);
  });
});

describe('shader layers in HTML and code', () => {
  function setup(html: string) {
    const doc = createDocument({ name: 'Shaders' });
    const tx = new Transaction(doc);
    const { roots, warnings } = importHtml(html);
    const pageRoot = pageRootIdFor(doc.pageList[0]!.id);
    const { topLevelIds } = insertImported(tx, roots, pageRoot, 'insert-children', { placeTopLevel: () => ({ x: 0, y: 0 }) });
    const { doc: next } = tx.commit();
    return { reader: readerOf(next), id: topLevelIds[0]!, warnings };
  }

  it('imports <x-shader> with params, preset background and default size', () => {
    const { reader, id, warnings } = setup('<x-shader type="dot-grid" layer-name="Dots" size="4" shape="diamond" bogus="1"></x-shader>');
    const node = reader.getNode(id)!;
    expect(node.component).toBe('ShaderDotGrid');
    expect(node.label).toBe('Dots');
    expect(node.props?.size).toBe(4);
    expect(node.props?.shape).toBe('diamond');
    expect(node.styles.width).toBe('800px');
    expect(node.styles.backgroundColor).toBe('#000000');
    expect(warnings.join(' ')).toMatch(/no parameter "bogus"/);
  });

  it('round-trips through copy-as-HTML', () => {
    const { reader, id } = setup('<x-shader type="MeshGradient" colors="#ff0000 #0000ff" swirl="0.5" style="width: 300px; height: 200px"></x-shader>');
    const html = nodesToHtml(reader, [id]);
    expect(html).toContain('<x-shader type="MeshGradient"');
    const again = setup(html);
    const node = again.reader.getNode(again.id)!;
    expect(node.component).toBe('ShaderMeshGradient');
    expect(node.props?.colors).toEqual(['#ff0000', '#0000ff']);
    expect(node.props?.swirl).toBe(0.5);
    expect(node.styles.width).toBe('300px');
  });

  it('exports JSX with the library import header', async () => {
    const { reader, id } = setup('<x-shader type="MeshGradient" colors="rgb(255 0 0) #00f" style="width: 300px; height: 200px"></x-shader>');
    const jsx = await generateJsx(reader, id, { format: 'inline-styles', includeNodeIds: false, includeRootPositioning: false });
    expect(jsx.split('\n')[0]).toBe('/** @paper-design/shaders-react@0.0.81 */');
    expect(jsx).toContain("import { MeshGradient } from '@paper-design/shaders-react';");
    expect(jsx).toContain("colors={['#ff0000', '#0000ff']}");
    expect(jsx).toContain('speed={1}');
    expect(jsx).not.toContain('boxSizing');
  });

  it('renders a mount point for headless renders', () => {
    const { reader, id } = setup('<x-shader type="MeshGradient"></x-shader>');
    const html = renderNodeHtml(reader, reader.getNode(id)!, identityUrls);
    expect(html).toContain('data-op-shader="MeshGradient"');
    expect(html).toContain('data-op-shader-props="{&quot;speed&quot;:1');
  });
});
