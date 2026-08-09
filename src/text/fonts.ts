import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, delimiter as PATH_DELIMITER } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { ScriptName } from './script.js';
import { MissingFontError } from '../errors.js';

/**
 * Font registry: maps a script to a font file that actually covers it.
 *
 * Resolution order, most to least deterministic:
 *   1. Fonts vendored in assets/fonts/ (shipped with the repo → reproducible renders)
 *   2. FONT_DIR env override
 *   3. User/system font directories
 *   4. fontconfig (fc-match), where available
 *
 * Vendoring is deliberate: "it renders correctly on my machine" is not a
 * property you want your caption output to depend on.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Font filename stems we know cover each script, in preference order. */
const SCRIPT_FONTS: Record<ScriptName, string[]> = {
  Latin: ['NotoSans_400Regular', 'NotoSans-Regular', 'DejaVuSans', 'Arial'],
  Devanagari: ['NotoSansDevanagari_400Regular', 'NotoSansDevanagari-Regular', 'NotoSansDevanagari'],
  Telugu: ['NotoSansTelugu_400Regular', 'NotoSansTelugu-Regular', 'NotoSansTelugu'],
  Kannada: ['NotoSansKannada_400Regular', 'NotoSansKannada-Regular', 'NotoSansKannada'],
  Tamil: ['NotoSansTamil_400Regular', 'NotoSansTamil-Regular', 'NotoSansTamil'],
  Malayalam: ['NotoSansMalayalam_400Regular', 'NotoSansMalayalam-Regular', 'NotoSansMalayalam'],
  Bengali: ['NotoSansBengali_400Regular', 'NotoSansBengali-Regular', 'NotoSansBengali'],
  Gujarati: ['NotoSansGujarati_400Regular', 'NotoSansGujarati-Regular', 'NotoSansGujarati'],
  Gurmukhi: ['NotoSansGurmukhi_400Regular', 'NotoSansGurmukhi-Regular', 'NotoSansGurmukhi'],
  Oriya: ['NotoSansOriya_400Regular', 'NotoSansOriya-Regular', 'NotoSansOriya'],
  Arabic: ['NotoNastaliqUrdu_400Regular', 'NotoNastaliqUrdu-Regular', 'NotoSansArabic'],
  Common: ['NotoSans_400Regular', 'NotoSans-Regular', 'DejaVuSans'],
};

const BOLD_SUFFIX: Record<string, string> = {
  '400Regular': '700Bold',
  '-Regular': '-Bold',
};

function assetFontDir(): string {
  // dist/src/text/ → repo root, and src/text/ when run from source.
  for (const up of ['../../../assets/fonts', '../../assets/fonts', '../assets/fonts']) {
    const p = resolve(__dirname, up);
    if (existsSync(p)) return p;
  }
  return resolve(__dirname, '../../../assets/fonts');
}

/**
 * Split a FONT_DIR value into directories.
 *
 * The separator is the platform's PATH delimiter — `;` on Windows, `:` on
 * macOS/Linux — never a hardcoded `:`. Splitting `C:\fonts;D:\more` on `:`
 * yields `["C", "\fonts;D", "\more"]`, i.e. every Windows FONT_DIR silently
 * resolves to nothing and the user gets "no font found" with no clue why.
 *
 * `delim` is injectable so the Windows behaviour can be tested on any host.
 */
export function splitFontDirs(raw: string | undefined, delim: string = PATH_DELIMITER): string[] {
  if (!raw) return [];
  return raw
    .split(delim)
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * User/system font directories to scan, in addition to the vendored set.
 * `env` is injectable so platform behaviour can be tested on any host.
 */
export function systemFontDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = [];
  // HOME on POSIX, USERPROFILE on Windows.
  const home = env.HOME || env.USERPROFILE || '';
  if (home) {
    dirs.push(
      join(home, '.local', 'share', 'fonts'),
      join(home, '.fonts'),
      join(home, 'Library', 'Fonts'),
    );
  }
  dirs.push('/usr/share/fonts', '/usr/local/share/fonts', '/Library/Fonts', '/System/Library/Fonts');

  // Windows: per-user fonts (no admin rights needed) then the machine store.
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) dirs.push(join(localAppData, 'Microsoft', 'Windows', 'Fonts'));
  const winDir = env.SystemRoot || env.WINDIR;
  if (winDir) dirs.push(join(winDir, 'Fonts'));

  return dirs;
}

function candidateDirs(): string[] {
  const dirs: string[] = [
    // Vendored fonts always win: reproducible renders across machines.
    assetFontDir(),
    // Absolute-resolved so a relative FONT_DIR behaves the same as an absolute one.
    ...splitFontDirs(process.env.FONT_DIR).map((d) => resolve(d)),
    ...systemFontDirs(),
  ];
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const key = process.platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) return false;
    seen.add(key);
    try { return existsSync(d); } catch { return false; }
  });
}

function walk(dir: string, depth = 4): string[] {
  const out: string[] = [];
  if (depth < 0) return out;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      const st = readdirSync(p, { withFileTypes: true });
      // It's a directory — recurse.
      void st;
      out.push(...walk(p, depth - 1));
    } catch {
      if (/\.(ttf|otf|ttc)$/i.test(e)) out.push(p);
    }
  }
  return out;
}

let fileCache: string[] | null = null;
function allFontFiles(): string[] {
  if (fileCache) return fileCache;
  const files: string[] = [];
  for (const d of candidateDirs()) files.push(...walk(d));
  fileCache = files;
  return files;
}

/**
 * Basename of a font path. Splits on BOTH separators rather than using
 * path.basename(), because a `C:\fonts\Noto.ttf` string must resolve the same
 * way when tests run on Linux as it does on the Windows host that produced it.
 */
export function fontBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function normStem(p: string): string {
  return fontBasename(p).replace(/\.(ttf|otf|ttc)$/i, '').toLowerCase().replace(/[-_ ]/g, '');
}

/**
 * Is `child` inside `parent`? Separator- and case-tolerant, so the "vendored"
 * label survives Windows drive-letter casing and mixed `/` vs `\`.
 */
export function isInside(child: string, parent: string): boolean {
  const norm = (s: string) => {
    const unified = s.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '/');
}

function findByStems(stems: string[]): string | null {
  const files = allFontFiles();
  for (const stem of stems) {
    const want = stem.toLowerCase().replace(/[-_ ]/g, '');
    const hit = files.find((f) => normStem(f) === want);
    if (hit) return hit;
  }
  // Looser: prefix match, so NotoSansDevanagari matches NotoSansDevanagari_400Regular.
  for (const stem of stems) {
    const want = stem.toLowerCase().replace(/[-_ ]/g, '');
    const hit = files.find((f) => normStem(f).startsWith(want));
    if (hit) return hit;
  }
  return null;
}

function fcMatch(family: string): string | null {
  try {
    const out = execFileSync('fc-match', ['-f', '%{file}', family], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

export interface ResolvedFont {
  path: string;
  script: ScriptName;
  bold: boolean;
  /** Where it came from, for diagnostics. */
  source: 'vendored' | 'system' | 'fontconfig';
}

const resolveCache = new Map<string, ResolvedFont>();

/**
 * Resolve a font file for a script.
 *
 * Throws MissingFontError rather than silently falling back to a font without
 * the right glyphs — a silent fallback is exactly how you ship tofu.
 */
export function resolveFont(
  script: ScriptName,
  opts: { bold?: boolean; override?: string } = {},
): ResolvedFont {
  const bold = opts.bold ?? false;
  const key = `${script}:${bold}:${opts.override ?? ''}`;
  const cached = resolveCache.get(key);
  if (cached) return cached;

  if (opts.override) {
    if (!existsSync(opts.override)) {
      throw new MissingFontError(
        `Font file not found: ${opts.override}`,
        script,
        [opts.override],
      );
    }
    const r: ResolvedFont = { path: opts.override, script, bold, source: 'system' };
    resolveCache.set(key, r);
    return r;
  }

  let stems = SCRIPT_FONTS[script] ?? SCRIPT_FONTS.Latin;
  if (bold) {
    const boldStems = stems.map((s) => {
      for (const [reg, bd] of Object.entries(BOLD_SUFFIX)) {
        if (s.includes(reg)) return s.replace(reg, bd);
      }
      return s;
    });
    stems = [...boldStems, ...stems]; // fall back to regular if no bold cut exists
  }

  const assetDir = assetFontDir();
  const found = findByStems(stems);
  if (found) {
    const r: ResolvedFont = {
      path: found,
      script,
      bold,
      source: isInside(found, assetDir) ? 'vendored' : 'system',
    };
    resolveCache.set(key, r);
    return r;
  }

  const family = script === 'Latin' ? 'Noto Sans' : `Noto Sans ${script}`;
  const fc = fcMatch(family);
  if (fc) {
    const r: ResolvedFont = { path: fc, script, bold, source: 'fontconfig' };
    resolveCache.set(key, r);
    return r;
  }

  throw new MissingFontError(
    `No font found covering ${script}. Install one of: ${stems.join(', ')}, ` +
      `or set FONT_DIR to a directory containing a suitable font ` +
      `(separate multiple directories with "${PATH_DELIMITER}" on this platform). ` +
      `Run "npm run fonts:install" to fetch the bundled Noto set.`,
    script,
    stems,
  );
}

export function fontDataFor(f: ResolvedFont): Buffer {
  return readFileSync(f.path);
}

/** Report coverage for every script. Used by `doctor` and tests. */
export function fontReport(): Array<{ script: ScriptName; ok: boolean; path?: string; source?: string; error?: string }> {
  const scripts = Object.keys(SCRIPT_FONTS) as ScriptName[];
  return scripts.map((script) => {
    try {
      const r = resolveFont(script);
      return { script, ok: true, path: r.path, source: r.source };
    } catch (e) {
      return { script, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** Test seam — font dirs are scanned once and cached. */
export function clearFontCache(): void {
  fileCache = null;
  resolveCache.clear();
}
