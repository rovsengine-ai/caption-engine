import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptionEngineError } from '../errors.js';
import type { Tone } from '../media/prosody.js';

/**
 * Tone → visual style, loaded from config/caption-theme.json.
 *
 * Kept as DATA rather than code so retuning the look is a text edit by whoever
 * is watching the output, not a rebuild by whoever wrote the classifier. Those
 * are rarely the same person and the feedback loop is much shorter this way.
 *
 * Everything here is optional by design: a tone with no entry inherits the base
 * caption style completely. That is what lets the whole feature default to
 * off — with no theme file and no --prosody, every word resolves exactly as it
 * did before this existed.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** A partial style. Absent fields inherit from the base caption style. */
export interface ToneStyle {
  fontFamily?: string;
  bold?: boolean;
  scale?: number;
  color?: string;
}

export interface CaptionTheme {
  version: number;
  /** Below this classification confidence, a word keeps the base style. */
  minConfidence: number;
  tones: Partial<Record<Tone, ToneStyle>>;
  /** Where it came from, for diagnostics. */
  source: string;
}

/**
 * Scale bounds.
 *
 * Tone scaling and active-word scaling multiply, so an unbounded tone scale can
 * silently blow past the width the layout reserved and push words off the line.
 * Rejecting at load time turns that into a clear error at startup instead of a
 * cosmetic bug discovered after a 20-minute render.
 */
const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

export const NEUTRAL_THEME: CaptionTheme = {
  version: 1,
  minConfidence: 1.1, // unreachable: nothing is ever styled
  tones: {},
  source: '(built-in neutral)',
};

function defaultThemePath(): string | null {
  for (const up of [
    '../../../config/caption-theme.json',
    '../../config/caption-theme.json',
    '../config/caption-theme.json',
  ]) {
    const p = resolve(__dirname, up);
    if (existsSync(p)) return p;
  }
  return null;
}

const VALID_TONES: Tone[] = ['neutral', 'calm', 'excited', 'emphatic', 'fast', 'soft'];

/** Parse and validate a theme. Rejects nonsense loudly rather than at render time. */
export function parseCaptionTheme(text: string, source: string): CaptionTheme {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CaptionEngineError(
      `Caption theme ${source} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      'Fix the syntax, or delete the file to fall back to the built-in neutral theme.',
    );
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const tonesIn = (obj.tones ?? {}) as Record<string, unknown>;

  const tones: Partial<Record<Tone, ToneStyle>> = {};
  for (const [name, value] of Object.entries(tonesIn)) {
    if (!VALID_TONES.includes(name as Tone)) {
      throw new CaptionEngineError(
        `Caption theme ${source} has an unknown tone "${name}".`,
        `Valid tones: ${VALID_TONES.join(', ')}.`,
      );
    }
    const s = (value ?? {}) as Record<string, unknown>;
    const style: ToneStyle = {};
    if (typeof s.fontFamily === 'string') style.fontFamily = s.fontFamily;
    if (typeof s.bold === 'boolean') style.bold = s.bold;
    if (typeof s.color === 'string') {
      if (!/^#[0-9a-f]{6}$/i.test(s.color)) {
        throw new CaptionEngineError(
          `Caption theme ${source}: tone "${name}" has colour "${s.color}".`,
          'Colours must be #RRGGBB.',
        );
      }
      style.color = s.color;
    }
    if (typeof s.scale === 'number') {
      if (!Number.isFinite(s.scale) || s.scale < MIN_SCALE || s.scale > MAX_SCALE) {
        throw new CaptionEngineError(
          `Caption theme ${source}: tone "${name}" has scale ${s.scale}.`,
          `Scale must be between ${MIN_SCALE} and ${MAX_SCALE}. Tone scale and ` +
            `--active-scale multiply, so large values push words off the line.`,
        );
      }
      style.scale = s.scale;
    }
    tones[name as Tone] = style;
  }

  const minConfidence = typeof obj.minConfidence === 'number' ? obj.minConfidence : 0.6;
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    minConfidence,
    tones,
    source,
  };
}

/**
 * Load a theme. An explicit path that does not exist is an error; a missing
 * DEFAULT theme is not, because the feature must work in a checkout that has
 * no config directory.
 */
export function loadCaptionTheme(path?: string): CaptionTheme {
  if (path) {
    if (!existsSync(path)) {
      throw new CaptionEngineError(
        `Caption theme file not found: ${path}`,
        'Point --caption-theme at a JSON file, or omit it to use config/caption-theme.json.',
      );
    }
    return parseCaptionTheme(readFileSync(path, 'utf8'), path);
  }
  const def = defaultThemePath();
  if (!def) return NEUTRAL_THEME;
  return parseCaptionTheme(readFileSync(def, 'utf8'), def);
}

/**
 * The style for a tone, or undefined when it should not be applied.
 *
 * Confidence gating lives here, in one place, so every consumer — renderer,
 * diagnostics, ASS export — agrees about which words were actually styled.
 * A diagnostics table that disagreed with the render would be worse than none.
 */
export function toneStyleFor(
  theme: CaptionTheme,
  tone: Tone | undefined,
  confidence: number,
): ToneStyle | undefined {
  if (!tone || confidence < theme.minConfidence) return undefined;
  const style = theme.tones[tone];
  if (!style || Object.keys(style).length === 0) return undefined;
  return style;
}

/** One row of the --diagnostics prosody table. */
export interface ProsodyDiagnosticRow {
  index: number;
  word: string;
  start: number;
  end: number;
  rmsDb: number;
  f0Hz: number | null;
  speakingRate: number;
  tone: string;
  confidence: number;
  font: string;
  bold: boolean;
  scale: number;
  color: string;
  /** True when the tone actually changed the style (cleared minConfidence). */
  styled: boolean;
}

/**
 * Render the prosody diagnostics as a fixed-width table.
 *
 * Contains measurements and style decisions only — no file paths beyond the
 * font family name, no environment, and no credentials. It is meant to be safe
 * to paste into a bug report.
 */
export function formatProsodyDiagnostics(rows: ProsodyDiagnosticRow[], limit = 40): string {
  const head =
    '  ' +
    'idx'.padStart(4) + '  ' +
    'word'.padEnd(18) +
    'start'.padStart(8) +
    'end'.padStart(8) +
    'rms dB'.padStart(9) +
    'F0 Hz'.padStart(8) +
    'rate'.padStart(7) +
    '  ' + 'tone'.padEnd(9) +
    'conf'.padStart(6) +
    '  ' + 'font'.padEnd(20) +
    'style';
  const lines = rows.slice(0, limit).map((r) =>
    '  ' +
    String(r.index).padStart(4) + '  ' +
    trunc(r.word, 18).padEnd(18) +
    r.start.toFixed(2).padStart(8) +
    r.end.toFixed(2).padStart(8) +
    r.rmsDb.toFixed(1).padStart(9) +
    (r.f0Hz === null ? '—' : r.f0Hz.toFixed(0)).padStart(8) +
    r.speakingRate.toFixed(2).padStart(7) +
    '  ' + r.tone.padEnd(9) +
    r.confidence.toFixed(2).padStart(6) +
    '  ' + trunc(r.font, 20).padEnd(20) +
    `${r.bold ? 'bold' : 'regular'} ${r.scale.toFixed(2)}x ${r.color}` +
    (r.styled ? ' [tone]' : ''),
  );
  if (rows.length > limit) lines.push(`  … and ${rows.length - limit} more`);
  return [head, ...lines].join('\n');
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
