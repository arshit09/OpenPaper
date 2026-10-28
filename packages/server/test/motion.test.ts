import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { AssetResolver } from '../src/assets.ts';
import { embedDocument } from '../src/embed.ts';
import { imageSize, MediaStore, sniffMime } from '../src/media.ts';

const LOTTIE = { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 120, layers: [], assets: [] };

/** The smallest MP4 head the store reads: an ftyp box and a version-0 tkhd with a 320×180 track. */
function mp4(): Buffer {
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
  const tkhd = Buffer.alloc(92);
  tkhd.writeUInt32BE(92, 0);
  tkhd.write('tkhd', 4);
  tkhd.writeUInt32BE(320 * 65536, 84);
  tkhd.writeUInt32BE(180 * 65536, 88);
  return Buffer.concat([ftyp, tkhd]);
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'op-motion-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('motion media', () => {
  it('sniffs and sizes video and Lottie files', () => {
    expect(sniffMime(mp4())).toBe('video/mp4');
    expect(imageSize(mp4())).toEqual({ width: 320, height: 180 });
    expect(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('video/webm');
    expect(sniffMime(Buffer.from(JSON.stringify(LOTTIE)))).toBe('application/json');
    expect(imageSize(Buffer.from(JSON.stringify(LOTTIE)))).toEqual({ width: 200, height: 120 });
    expect(sniffMime(Buffer.from('{"name":"package"}'))).toBeNull();
  });

  it('stores video and Lottie, unpacks .lottie archives and serves .mp4 names', async () => {
    const media = new MediaStore(dir);
    const video = await media.put(mp4(), 'video/mp4');
    expect(video.url).toMatch(/\.mp4$/);
    expect(media.pathFor(video.url)).toBe(video.path);
    const archive = Buffer.from(
      zipSync({ 'manifest.json': strToU8(JSON.stringify({ animations: [{ id: 'a' }] })), 'animations/a.json': strToU8(JSON.stringify(LOTTIE)) })
    );
    const lottie = await media.put(archive, 'application/octet-stream');
    expect(lottie.mimeType).toBe('application/json');
    expect(JSON.parse(await readFile(lottie.path, 'utf8')).w).toBe(200);
    await expect(media.put(Buffer.from('{"not":"lottie"}'), 'application/json')).rejects.toThrow(/Lottie/);
  });

  it('resolves motion files only where motion is asked for', async () => {
    const assets = new AssetResolver(new MediaStore(dir));
    const file = join(dir, 'clip.mp4');
    await writeFile(file, mp4());
    const url = `paper-asset:///${file.replace(/\\/g, '/')}`;
    expect(await assets.resolveOne(url)).toBeNull();
    expect((await assets.resolveOne(url, 'motion'))?.url).toMatch(/^\/media\/[a-f0-9]{32}\.mp4$/);
    const data = `data:application/json;base64,${Buffer.from(JSON.stringify(LOTTIE)).toString('base64')}`;
    expect(await assets.resolveOne(data)).toBeNull();
    expect(await assets.resolveOne(data, 'motion')).toMatchObject({ width: 200, height: 120 });
  });
});

describe('embed documents', () => {
  it('puts the pause runtime before the page’s own scripts', () => {
    const fragment = embedDocument('<canvas></canvas><script>go()</script>');
    expect(fragment).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><script>\(\(\) => \{/);
    expect(fragment.indexOf('op-animations')).toBeLessThan(fragment.indexOf('go()'));
    const page = embedDocument('<!doctype html><html><head><title>x</title></head><body><script>go()</script></body></html>');
    expect(page.indexOf('<head><script>')).toBeGreaterThan(0);
    expect(page.indexOf('op-animations')).toBeLessThan(page.indexOf('go()'));
  });
});
