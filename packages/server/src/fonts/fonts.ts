import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../fs-utils.ts';
import bundled from './google-fonts.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

interface GoogleFamily {
  f: string;
  c: string;
  w: number[];
  i: number[];
  v?: [number, number];
}

export interface FontStyleInfo {
  style: string;
  weight: number;
  isItalic: boolean;
  axes?: Record<string, { tag: string; min: number; max: number }>;
  coordinates?: Record<string, number>;
}

export interface LocalFontFace {
  family: string;
  style: string;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** Families every browser can render without downloads. */
const BUILT_IN: Record<string, number[]> = {
  'system-ui': [100, 200, 300, 400, 500, 600, 700, 800, 900],
  'sans-serif': [400, 700],
  serif: [400, 700],
  monospace: [400, 700],
  'ui-sans-serif': [400, 700],
  'ui-serif': [400, 700],
  'ui-monospace': [400, 700],
  Arial: [400, 700],
  'Arial Black': [900],
  Verdana: [400, 700],
  'Trebuchet MS': [400, 700],
  Georgia: [400, 700],
  'Times New Roman': [400, 700],
  'Courier New': [400, 700],
  'Comic Sans MS': [400, 700],
  Tahoma: [400, 700],
  Impact: [400],
  Helvetica: [400, 700],
};

function styleName(weight: number, italic: boolean): string {
  const base = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return base;
  return weight === 400 ? 'Italic' : `${base} Italic`;
}

const STYLE_WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

function weightFromStyle(style: string): number {
  for (const [re, w] of STYLE_WEIGHTS) if (re.test(style)) return w;
  return 400;
}

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export class FontService {
  private google = new Map<string, GoogleFamily>();
  private localCache: { at: number; faces: LocalFontFace[] } | null = null;
  private localLoader: (() => Promise<LocalFontFace[]>) | null = null;

  constructor(private readonly cacheDir: string) {
    this.load((bundled as { families: GoogleFamily[] }).families);
  }

  private load(families: GoogleFamily[]) {
    this.google = new Map(families.map((f) => [f.f.toLowerCase(), f]));
  }

  /** Use a fresher Google Fonts list from cache / network when available. */
  async refresh(): Promise<void> {
    const cacheFile = join(this.cacheDir, 'google-fonts.json');
    try {
      const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as { at: number; families: GoogleFamily[] };
      if (cached.families?.length) this.load(cached.families);
      if (Date.now() - cached.at < REFRESH_MS) return;
    } catch {
      // no cache yet
    }
    try {
      const res = await fetch('https://fonts.google.com/metadata/fonts', { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      let text = await res.text();
      if (text.startsWith(")]}'")) text = text.slice(4);
      const meta = JSON.parse(text) as {
        familyMetadataList: Array<{ family: string; category?: string; fonts: Record<string, unknown>; axes?: Array<{ tag: string; min: number; max: number }> }>;
      };
      const families: GoogleFamily[] = meta.familyMetadataList.map((fam) => {
        const w = new Set<number>();
        const i = new Set<number>();
        for (const key of Object.keys(fam.fonts ?? {})) {
          if (key.endsWith('i')) i.add(Number(key.slice(0, -1)));
          else w.add(Number(key));
        }
        const wght = fam.axes?.find((a) => a.tag === 'wght');
        return { f: fam.family, c: fam.category ?? 'Other', w: [...w].sort((a, b) => a - b), i: [...i].sort((a, b) => a - b), ...(wght ? { v: [wght.min, wght.max] as [number, number] } : {}) };
      });
      if (families.length > 500) {
        this.load(families);
        await writeFileAtomic(cacheFile, JSON.stringify({ at: Date.now(), families }));
      }
    } catch {
      // offline: keep the bundled list
    }
  }

  setLocalFontLoader(loader: () => Promise<LocalFontFace[]>) {
    this.localLoader = loader;
  }

  isGoogleFamily(name: string): boolean {
    return this.google.has(name.toLowerCase());
  }

  googleFamilies(): string[] {
    return [...this.google.values()].map((f) => f.f);
  }

  /** Google Fonts stylesheet URLs covering the given families (unknown names are skipped). */
  cssUrls(families: Iterable<string>): string[] {
    const specs: string[] = [];
    const seen = new Set<string>();
    for (const raw of families) {
      const fam = this.google.get(raw.trim().replace(/^["']|["']$/g, '').toLowerCase());
      if (!fam || seen.has(fam.f)) continue;
      seen.add(fam.f);
      const name = fam.f.replace(/ /g, '+');
      if (fam.v) {
        const range = `${fam.v[0]}..${fam.v[1]}`;
        specs.push(fam.i.length ? `family=${name}:ital,wght@0,${range};1,${range}` : `family=${name}:wght@${range}`);
      } else {
        const tuples = [...fam.w.map((w) => `0,${w}`), ...fam.i.map((w) => `1,${w}`)];
        specs.push(fam.i.length ? `family=${name}:ital,wght@${tuples.join(';')}` : `family=${name}:wght@${fam.w.join(';')}`);
      }
    }
    const urls: string[] = [];
    for (let k = 0; k < specs.length; k += 20) {
      urls.push(`https://fonts.googleapis.com/css2?${specs.slice(k, k + 20).join('&')}&display=block`);
    }
    return urls;
  }

  private async localFaces(): Promise<{ faces: LocalFontFace[]; error?: string }> {
    if (this.localCache && Date.now() - this.localCache.at < 10 * 60 * 1000) return { faces: this.localCache.faces };
    let faces: LocalFontFace[] = [];
    let error: string | undefined;
    if (this.localLoader) {
      try {
        faces = await Promise.race([
          this.localLoader(),
          new Promise<LocalFontFace[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000)),
        ]);
      } catch (e) {
        error = e instanceof Error && e.message === 'timeout' ? 'timeout' : 'failed';
      }
    }
    if (!faces.length && process.platform === 'win32') faces = await windowsRegistryFonts();
    if (!faces.length && process.platform === 'linux') faces = await fcListFonts();
    if (faces.length) this.localCache = { at: Date.now(), faces };
    return { faces, error: faces.length ? undefined : error };
  }

  /** `get_font_family_info` payload. */
  async familyInfo(names: string[]): Promise<{ errors?: string[]; fontsPerFamily?: Record<string, FontStyleInfo[]> }> {
    const errors: string[] = [];
    const fontsPerFamily: Record<string, FontStyleInfo[]> = {};
    const { faces, error } = await this.localFaces();
    for (const name of [...new Set(names)]) {
      const trimmed = name.trim();
      const local = faces.filter((f) => f.family === trimmed);
      if (local.length) {
        const styles = new Map<string, FontStyleInfo>();
        for (const face of local) {
          const weight = weightFromStyle(face.style);
          const isItalic = /italic|oblique/i.test(face.style);
          styles.set(face.style, { style: face.style, weight, isItalic });
        }
        fontsPerFamily[trimmed] = [...styles.values()].sort((a, b) => Number(a.isItalic) - Number(b.isItalic) || a.weight - b.weight);
        continue;
      }
      const g = this.google.get(trimmed.toLowerCase());
      if (g && g.f === trimmed) {
        const axes = g.v ? { wght: { tag: 'wght', min: g.v[0], max: g.v[1] } } : undefined;
        const entries: FontStyleInfo[] = [];
        for (const w of g.w) entries.push({ style: styleName(w, false), weight: w, isItalic: false, ...(axes ? { axes, coordinates: { wght: w } } : {}) });
        for (const w of g.i) entries.push({ style: styleName(w, true), weight: w, isItalic: true, ...(axes ? { axes, coordinates: { wght: w } } : {}) });
        fontsPerFamily[trimmed] = entries;
        continue;
      }
      const builtIn = BUILT_IN[trimmed];
      if (builtIn) {
        fontsPerFamily[trimmed] = builtIn.flatMap((w) => [
          { style: styleName(w, false), weight: w, isItalic: false },
          { style: styleName(w, true), weight: w, isItalic: true },
        ]);
        continue;
      }
      let msg = `Font family "${trimmed}" is not available.`;
      if (!faces.length) {
        msg += ` If you expected it to be available as a local font, ${
          error === 'timeout' ? 'try again later: local font discovery timed out.' : 'try again later: local font discovery failed.'
        }`;
      }
      errors.push(msg);
    }
    const out: { errors?: string[]; fontsPerFamily?: Record<string, FontStyleInfo[]> } = {};
    if (errors.length) out.errors = errors;
    if (Object.keys(fontsPerFamily).length) out.fontsPerFamily = fontsPerFamily;
    return out;
  }
}

/** Windows: font names from the registry ("Segoe UI Semibold (TrueType)"). */
async function windowsRegistryFonts(): Promise<LocalFontFace[]> {
  const faces: LocalFontFace[] = [];
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s{4}(.+?)\s+REG_SZ\s+/.exec(line);
        if (!m) continue;
        const display = m[1]!.replace(/\s*\((TrueType|OpenType|All res|VGA res)\)\s*$/i, '');
        for (const part of display.split(' & ')) {
          const styleMatch = /\s+((?:Thin|ExtraLight|Extra Light|UltraLight|Light|SemiLight|Regular|Medium|SemiBold|Semibold|Demibold|Bold|ExtraBold|Extra Bold|Black|Heavy)(?:\s+(?:Italic|Oblique))?|Italic|Oblique)$/i.exec(part);
          const family = styleMatch ? part.slice(0, styleMatch.index) : part;
          faces.push({ family: family.trim(), style: styleMatch ? styleMatch[1]! : 'Regular' });
        }
      }
    } catch {
      // ignore
    }
  }
  return faces;
}

async function fcListFonts(): Promise<LocalFontFace[]> {
  try {
    const { stdout } = await execFileAsync('fc-list', ['--format', '%{family[0]}|%{style[0]}\n'], { maxBuffer: 8 * 1024 * 1024 });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [family, style] = l.split('|');
        return { family: family!.trim(), style: (style ?? 'Regular').trim() };
      });
  } catch {
    return [];
  }
}
