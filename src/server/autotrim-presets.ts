/**
 * Auto Trim aggression presets for the web editor / Spaces UI.
 *
 * Maps UX toggles + a Light→Max slider onto the engine's TrimOptions /
 * CliOptions knobs (silence gap, filler confidence, false starts).
 */

export type TrimAggression = 'light' | 'balanced' | 'strong' | 'max';

export interface AutoTrimUiControls {
  /** Master switch — when false, Auto Trim does not run. */
  enabled: boolean;
  aggression: TrimAggression;
  removeSilences: boolean;
  removeFillers: boolean;
  /** False starts / repeated takes. */
  removeRepetitions: boolean;
  /**
   * Off-topic / unusable footage via Vision AI (`--analyze-video`).
   * Requires ANTHROPIC_API_KEY; ignored when the key is absent.
   */
  removeOffTopic: boolean;
}

export interface AggressionPreset {
  /** Gaps longer than this (seconds) are proposed as silence cuts. */
  trimSilence: number;
  /** Pass-2 filler auto-cut confidence floor. */
  fillerConfidence: number;
  /** Suppress proposals below this confidence. */
  minCutConfidence: number;
  label: string;
  blurb: string;
}

export const AGGRESSION_PRESETS: Record<TrimAggression, AggressionPreset> = {
  light: {
    trimSilence: 0.9,
    fillerConfidence: 0.75,
    minCutConfidence: 0.55,
    label: 'Light',
    blurb: 'Only long silences and obvious fillers. Natural pauses kept.',
  },
  balanced: {
    trimSilence: 0.6,
    fillerConfidence: 0.6,
    minCutConfidence: 0,
    label: 'Balanced',
    blurb: 'Natural pacing. Trims clear um/uh/matlab and false starts.',
  },
  strong: {
    trimSilence: 0.4,
    fillerConfidence: 0.5,
    minCutConfidence: 0,
    label: 'Strong',
    blurb: 'Rapid pacing. Tighter silence and filler cuts.',
  },
  max: {
    trimSilence: 0.25,
    fillerConfidence: 0.4,
    minCutConfidence: 0,
    label: 'Max',
    blurb: 'Jump-cut dense. Shortest silences and aggressive filler trim.',
  },
};

export const DEFAULT_AUTOTRIM: AutoTrimUiControls = {
  enabled: false,
  aggression: 'balanced',
  removeSilences: true,
  removeFillers: true,
  removeRepetitions: true,
  removeOffTopic: false,
};

export function parseAggression(raw: unknown): TrimAggression {
  const v = String(raw ?? 'balanced').toLowerCase();
  if (v === 'light' || v === 'balanced' || v === 'strong' || v === 'max') return v;
  return 'balanced';
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Read Auto Trim controls from multipart / JSON form fields. */
export function parseAutoTrimControls(body: Record<string, unknown>): AutoTrimUiControls {
  const enabled = parseBool(body.autoTrim ?? body.auto_trim, false);
  return {
    enabled,
    aggression: parseAggression(body.trimAggression ?? body.aggression ?? body.trim_aggression),
    removeSilences: parseBool(body.removeSilences ?? body.remove_silences, true),
    removeFillers: parseBool(body.removeFillers ?? body.remove_fillers, true),
    removeRepetitions: parseBool(
      body.removeRepetitions ?? body.remove_repetitions ?? body.removeFalseStarts,
      true,
    ),
    removeOffTopic: parseBool(body.removeOffTopic ?? body.remove_off_topic, false),
  };
}

/**
 * Map UI controls → CliOptions fragment for runPipeline.
 *
 * Silence removal off → absurdly high threshold so silence detector never fires.
 * Filler/repetition off → keepFillers / removeFalseStarts accordingly.
 */
export function autoTrimToCliFragment(controls: AutoTrimUiControls): {
  autoTrim: boolean;
  trimSilence: number;
  keepFillers: boolean;
  removeFalseStarts: boolean;
  fillerConfidence: number;
  minCutConfidence: number;
  analyzeVideo: boolean;
} {
  if (!controls.enabled) {
    return {
      autoTrim: false,
      trimSilence: 0.7,
      keepFillers: true,
      removeFalseStarts: false,
      fillerConfidence: AGGRESSION_PRESETS.balanced.fillerConfidence,
      minCutConfidence: 0,
      analyzeVideo: false,
    };
  }

  const preset = AGGRESSION_PRESETS[controls.aggression];
  return {
    autoTrim: true,
    trimSilence: controls.removeSilences ? preset.trimSilence : 999,
    keepFillers: !controls.removeFillers,
    removeFalseStarts: controls.removeRepetitions,
    fillerConfidence: preset.fillerConfidence,
    minCutConfidence: preset.minCutConfidence,
    analyzeVideo: controls.removeOffTopic,
  };
}

export function publicAutoTrimMeta() {
  return {
    default: DEFAULT_AUTOTRIM,
    aggression: Object.entries(AGGRESSION_PRESETS).map(([value, p]) => ({
      value,
      label: p.label,
      blurb: p.blurb,
      trimSilence: p.trimSilence,
    })),
    toggles: [
      { key: 'removeSilences', label: 'Remove Silences' },
      { key: 'removeFillers', label: 'Remove Filler Words' },
      { key: 'removeRepetitions', label: 'Remove Repetitions' },
      { key: 'removeOffTopic', label: 'Remove Off-topic' },
    ],
  };
}
