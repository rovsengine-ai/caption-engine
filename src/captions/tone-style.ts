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

/** Active-word appearance, overridable from the theme as well as the CLI. */
export interface ActiveOverrides {
  color?: string;
  scale?: number;
  bold?: boolean;
}

/**
 * Classifier thresholds, exposed so a theme can be retuned for a speaker or a
 * genre without a rebuild.
 *
 * Every value is expressed in the units the classifier actually compares:
 * semitones relative to the speaker's own median pitch, and energy in units of
 * the clip's own median-absolute-deviation. Fixed universal dB or Hz thresholds
 * were deliberately avoided — a threshold that works for a close-miked studio
 * voice is meaningless for a phone recorded across a room.
 */
export interface ClassifierThresholds {
  /** excited: pitch this many semitones above baseline AND energy above `excitedEnergy`. */
  excitedPitch: number;
  excitedEnergy: number;
  /** soft: pitch this far BELOW baseline AND energy below `softEnergy`. */
  softPitch: number;
  softEnergy: number;
  /** calm: pitch within this of baseline, spread under `calmPitchSpread`, rate under `calmRate`. */
  calmPitch: number;
  calmPitchSpread: number;
  calmRate: number;
  /** fast: words per second at or above this, with energy above `fastEnergy`. */
  fastRate: number;
  fastEnergy: number;
  /** emphatic: energy at or above this, or a pause followed by raised energy. */
  emphaticEnergy: number;
}

export const DEFAULT_THRESHOLDS: ClassifierThresholds = {
  excitedPitch: 2,
  excitedEnergy: 0.6,
  softPitch: -1.5,
  softEnergy: -0.4,
  calmPitch: 1,
  calmPitchSpread: 1.5,
  calmRate: 2.2,
  fastRate: 3.2,
  fastEnergy: 0.25,
  emphaticEnergy: 0.65,
};

export interface CaptionTheme {
  version: number;
  /** Below this classification confidence, a word or cue keeps the base style. */
  minConfidence: number;
  tones: Partial<Record<Tone, ToneStyle>>;
  /** Active-word appearance. CLI flags take precedence over these. */
  active?: ActiveOverrides;
  /** Classifier tuning. Merged over DEFAULT_THRESHOLDS. */
  thresholds: ClassifierThresholds;
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
  thresholds: DEFAULT_THRESHOLDS,
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

  // Active-word overrides. Validated with the same rules as tone styles, so a
  // typo here fails at load rather than halfway through a render.
  const activeIn = (obj.active ?? {}) as Record<string, unknown>;
  const active: ActiveOverrides = {};
  if (typeof activeIn.bold === 'boolean') active.bold = activeIn.bold;
  if (typeof activeIn.color === 'string') {
    if (!/^#[0-9a-f]{6}$/i.test(activeIn.color)) {
      throw new CaptionEngineError(
        `Caption theme ${source}: active colour "${activeIn.color}" is not #RRGGBB.`,
        'Colours must be #RRGGBB.',
      );
    }
    active.color = activeIn.color;
  }
  if (typeof activeIn.scale === 'number') {
    if (!Number.isFinite(activeIn.scale) || activeIn.scale < MIN_SCALE || activeIn.scale > MAX_SCALE) {
      throw new CaptionEngineError(
        `Caption theme ${source}: active scale ${activeIn.scale} is out of range.`,
        `Scale must be between ${MIN_SCALE} and ${MAX_SCALE}.`,
      );
    }
    active.scale = activeIn.scale;
  }

  // Thresholds are merged over the defaults, so a theme can retune one rule
  // without having to restate the other nine.
  const thresholdsIn = (obj.thresholds ?? {}) as Record<string, unknown>;
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(thresholdsIn)) {
    if (!(key in DEFAULT_THRESHOLDS)) {
      throw new CaptionEngineError(
        `Caption theme ${source} has an unknown threshold "${key}".`,
        `Valid thresholds: ${Object.keys(DEFAULT_THRESHOLDS).join(', ')}.`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CaptionEngineError(
        `Caption theme ${source}: threshold "${key}" must be a finite number.`,
        `Got: ${JSON.stringify(value)}`,
      );
    }
    (thresholds as unknown as Record<string, number>)[key] = value;
  }

  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    minConfidence,
    tones,
    ...(Object.keys(active).length > 0 ? { active } : {}),
    thresholds,
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

/** The tone of a whole caption line, and how much of the line agreed. */
export interface CueTone {
  tone: Tone;
  /**
   * Share of the line's confident evidence that voted for this tone, 0..1.
   *
   * Used in place of a per-word confidence when gating, so a line whose words
   * disagree is treated exactly like a line nobody was confident about: it
   * keeps the base style.
   */
  share: number;
  /** How many words voted. */
  support: number;
}

/**
 * The dominant tone across a caption line.
 *
 * WHY THIS EXISTS. Classified per word, tone changes almost every word on real
 * speech — measured on a real clip, the sequence ran
 * `excited, neutral, emphatic, neutral, soft, soft, fast…`. Restyling every
 * ~200 ms reads as twitching, not expression: the viewer sees the captions
 * flicker rather than perceiving a mood.
 *
 * Holding one tone for a whole line is how short-form captions actually behave.
 * The LINE carries the mood; the ACTIVE WORD carries the beat. Those are
 * different jobs and giving them to the same signal is what made it flicker.
 *
 * Voting is confidence-weighted, so a single loud word cannot outvote four
 * confident quiet ones, and unconfident words are excluded entirely rather than
 * being counted as evidence for `neutral`.
 */
export function dominantTone(
  words: ReadonlyArray<{ tone: Tone; confidence: number }>,
  opts: { minConfidence: number },
): CueTone | null {
  const voters = words.filter((w) => w.confidence >= opts.minConfidence);
  if (voters.length === 0) return null;

  const weight = new Map<Tone, number>();
  for (const w of voters) weight.set(w.tone, (weight.get(w.tone) ?? 0) + w.confidence);

  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  // Ties resolve in a FIXED order, never by Map insertion order, so the same
  // input always produces the same caption. A render that differed run to run
  // would be untestable and unreproducible.
  let best: Tone = 'neutral';
  let bestWeight = -1;
  for (const tone of VALID_TONES) {
    const w = weight.get(tone) ?? 0;
    if (w > bestWeight) { best = tone; bestWeight = w; }
  }
  return { tone: best, share: bestWeight / total, support: voters.length };
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
