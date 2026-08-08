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

/** Named looks. Deliberately few and opinionated rather than infinitely configurable. */
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
};

export function listStylePresets(): string[] {
  return Object.keys(STYLE_PRESETS);
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
