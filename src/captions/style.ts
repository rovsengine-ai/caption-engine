import type { CaptionStyle } from '../types.js';
import { CaptionEngineError } from '../errors.js';

/**
 * Caption styles and output presets.
 *
 * Sizes are expressed relative to frame height where it matters, so a style
 * looks the same on a 1080x1920 reel and a 3840x2160 landscape export.
 */

export type AspectPreset = 'portrait' | 'landscape' | 'square' | 'original';

export interface OutputPreset {
  name: AspectPreset;
  width: number;
  height: number;
  aspect: number;
  description: string;
}

export const OUTPUT_PRESETS: Record<Exclude<AspectPreset, 'original'>, OutputPreset> = {
  portrait: {
    name: 'portrait', width: 1080, height: 1920, aspect: 9 / 16,
    description: 'Reels / Shorts / TikTok (9:16)',
  },
  landscape: {
    name: 'landscape', width: 1920, height: 1080, aspect: 16 / 9,
    description: 'YouTube / desktop (16:9)',
  },
  square: {
    name: 'square', width: 1080, height: 1080, aspect: 1,
    description: 'Feed posts (1:1)',
  },
};

export const DEFAULT_STYLE: CaptionStyle = {
  fontFamily: 'Noto Sans',
  fontSizePx: 72,
  primaryColor: '#FFFFFF',
  activeColor: '#FFD400',
  outlineColor: '#000000',
  outlineWidthPx: 6,
  // 0.72 keeps captions clear of Instagram's bottom UI (username, caption text,
  // action buttons) while still sitting below centre.
  positionY: 0.72,
  uppercase: false,
  maxWordsPerCue: 4,
  maxCharsPerLine: 22,
};

/**
 * Font size bounds, in pixels, at the reference 1920px frame height.
 *
 * Below MIN the outline swallows the glyph; above MAX a single word routinely
 * exceeds the frame width and the SVG/shaping pipeline is untested past this
 * point. Shared with the CLI's `--font-size` parser (src/cli/args.ts) so a
 * value that passes validation there cannot still be rejected — or silently
 * misbehave — one layer down.
 */
export const MIN_FONT_SIZE_PX = 8;
export const MAX_FONT_SIZE_PX = 400;

/** Named looks. Curated rather than infinitely configurable — each one is a real, reviewed design, not a slider default. */
export const STYLE_PRESETS: Record<string, Partial<CaptionStyle>> = {
  default: {},
  bold: {
    fontSizePx: 84, outlineWidthPx: 8, uppercase: true,
    primaryColor: '#FFFFFF', activeColor: '#FFD400', maxWordsPerCue: 3,
  },
  minimal: {
    fontSizePx: 60, outlineWidthPx: 3, activeColor: '#FFFFFF',
    primaryColor: '#FFFFFF', maxWordsPerCue: 5,
  },
  neon: {
    fontSizePx: 78, primaryColor: '#FFFFFF', activeColor: '#00E5FF',
    outlineColor: '#001018', outlineWidthPx: 7,
  },
  classic: {
    fontSizePx: 54, primaryColor: '#FFFFFF', activeColor: '#FFFFFF',
    outlineColor: '#000000', outlineWidthPx: 4, positionY: 0.88, maxWordsPerCue: 8,
    maxCharsPerLine: 42,
  },
  // ---- Added: broaden the preset library beyond the original five. ---------
  pop: {
    fontSizePx: 90, outlineWidthPx: 9, uppercase: true,
    primaryColor: '#FFFFFF', activeColor: '#FF3B7F', outlineColor: '#180018',
    maxWordsPerCue: 3,
  },
  soft: {
    fontSizePx: 64, outlineWidthPx: 2, primaryColor: '#FDF6EC',
    activeColor: '#FFB6A3', outlineColor: '#3A2E2A', positionY: 0.8,
    maxWordsPerCue: 5, maxCharsPerLine: 26,
  },
  highContrast: {
    fontSizePx: 80, outlineWidthPx: 10, uppercase: true,
    primaryColor: '#FFFFFF', activeColor: '#000000', outlineColor: '#000000',
    maxWordsPerCue: 4,
  },
  creator: {
    fontSizePx: 72, outlineWidthPx: 5, primaryColor: '#FFFFFF',
    activeColor: '#7C4DFF', outlineColor: '#0A0014', maxWordsPerCue: 4,
  },
  karaoke: {
    fontSizePx: 66, outlineWidthPx: 4, primaryColor: '#FFFFFF',
    activeColor: '#00E676', outlineColor: '#00120A', positionY: 0.82,
    maxWordsPerCue: 6, maxCharsPerLine: 32,
  },
  elegant: {
    fontSizePx: 50, outlineWidthPx: 2, primaryColor: '#FFFFFF',
    activeColor: '#F5D67B', outlineColor: '#000000', positionY: 0.85,
    maxWordsPerCue: 7, maxCharsPerLine: 36,
  },
  // ---- Kinetic-captions directions. Typography only — motion still needs
  // ---- --motion to be anything other than "none" (the default). ------------
  kinetic: {
    fontSizePx: 84, outlineWidthPx: 8, uppercase: true,
    primaryColor: '#FFFFFF', activeColor: '#FFD400', outlineColor: '#100800',
    maxWordsPerCue: 3,
  },
  cinematic: {
    fontSizePx: 56, outlineWidthPx: 2, primaryColor: '#F4F0E8',
    activeColor: '#F4F0E8', outlineColor: '#000000', positionY: 0.86,
    maxWordsPerCue: 6, maxCharsPerLine: 38,
  },
  comic: {
    fontSizePx: 92, outlineWidthPx: 11, uppercase: true,
    primaryColor: '#FFFFFF', activeColor: '#FFEA00', outlineColor: '#1A0A00',
    maxWordsPerCue: 3,
  },
  lyric: {
    fontSizePx: 68, outlineWidthPx: 4, primaryColor: '#FFFFFF',
    activeColor: '#B983FF', outlineColor: '#160021', positionY: 0.78,
    maxWordsPerCue: 5, maxCharsPerLine: 30,
  },
  editorial: {
    fontSizePx: 52, outlineWidthPx: 2, primaryColor: '#FFFFFF',
    activeColor: '#E8E1D3', outlineColor: '#000000', positionY: 0.88,
    maxWordsPerCue: 7, maxCharsPerLine: 40,
  },
};

/**
 * Each preset's restrained default animation template, used only by
 * `--animation-template auto` and only when `--motion` is not `none`. Not
 * part of `STYLE_PRESETS`/`CaptionStyle` itself — a template name is a fact
 * about MOTION, not about the static typography a preset otherwise controls,
 * and keeping them separate means a preset without an opinion here (any name
 * absent from this map) just falls through to `resolveAnimationTemplateName`'s
 * own restrained default rather than needing an entry.
 */
export const STYLE_DEFAULT_ANIMATION_TEMPLATE: Record<string, string> = {
  kinetic: 'pop',
  cinematic: 'cinematic-fade',
  comic: 'comic-hit',
  lyric: 'lyric-flow',
  editorial: 'minimal-reveal',
  creator: 'dynamic-word-focus',
  karaoke: 'karaoke-sweep',
  neon: 'neon-pulse',
  bold: 'punch',
  minimal: 'minimal-reveal',
  classic: 'smooth-rise',
};

export function listStylePresets(): string[] {
  return Object.keys(STYLE_PRESETS);
}

/**
 * Validate a caller-supplied font size.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CLI'S `--font-size` PARSER.
 *
 * `resolveStyle` is the actual API surface — the CLI is only one caller of it.
 * Before this check, an invalid size (NaN, 0, negative, a string that slipped
 * through as `any`, or a value outside the range the shaper/rasteriser are
 * exercised at) reached `resolveStyle`'s override spread completely
 * unchecked, then flowed into HarfBuzz shaping and SVG path scaling, where it
 * surfaces many steps later as an opaque native-module failure instead of a
 * clear "your input was invalid" message. Validating here means every caller
 * — CLI, tests, or a future API — gets the same guarantee, not just the one
 * path that happens to run `num()` first.
 */
export function assertValidFontSize(px: number, flag = '--font-size'): void {
  if (!Number.isFinite(px)) {
    throw new CaptionEngineError(
      `${flag} must be a finite number, got ${JSON.stringify(px)}.`,
      `Choose a value between ${MIN_FONT_SIZE_PX} and ${MAX_FONT_SIZE_PX}px, ` +
        `or omit ${flag} to use the style preset's own size.`,
    );
  }
  if (px < MIN_FONT_SIZE_PX || px > MAX_FONT_SIZE_PX) {
    throw new CaptionEngineError(
      `${flag} must be between ${MIN_FONT_SIZE_PX} and ${MAX_FONT_SIZE_PX}px, got ${px}.`,
      `Below ${MIN_FONT_SIZE_PX}px the outline swallows the glyph; above ${MAX_FONT_SIZE_PX}px ` +
        `words routinely overflow the frame. Pick a value in range, or omit ${flag} ` +
        `to use the style preset's own size.`,
    );
  }
}

/**
 * Build a concrete style, scaling size and outline to the output height so a
 * preset designed at 1080p stays proportionate at 4K.
 */
export function resolveStyle(
  presetName: string,
  frameHeight: number,
  overrides: Partial<CaptionStyle> = {},
): CaptionStyle {
  const preset = STYLE_PRESETS[presetName];
  if (!preset) {
    throw new CaptionEngineError(
      `Unknown style preset "${presetName}".`,
      `Available styles: ${listStylePresets().join(', ')}\n` +
        `Example:  --style bold`,
    );
  }
  if (overrides.fontSizePx !== undefined) {
    assertValidFontSize(overrides.fontSizePx);
  }
  const base = { ...DEFAULT_STYLE, ...preset };
  const scale = frameHeight / 1920;
  return {
    ...base,
    fontSizePx: Math.round(base.fontSizePx * scale),
    outlineWidthPx: Math.max(1, Math.round(base.outlineWidthPx * scale)),
    ...overrides,
  };
}

/** Resolve `--aspect`, using the source dimensions for 'original'. */
export function resolveOutput(
  aspect: AspectPreset,
  source: { width?: number; height?: number },
): { width: number; height: number } {
  if (aspect === 'original') {
    const w = source.width ?? OUTPUT_PRESETS.portrait.width;
    const h = source.height ?? OUTPUT_PRESETS.portrait.height;
    // H.264 requires even dimensions; odd input would fail at encode time.
    return { width: w - (w % 2), height: h - (h % 2) };
  }
  const p = OUTPUT_PRESETS[aspect];
  return { width: p.width, height: p.height };
}
