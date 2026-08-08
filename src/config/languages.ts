import type { ScriptName } from '../text/script.js';

/**
 * Language registry.
 *
 * `verified` states EXACTLY what has been checked in this repo, so nothing here
 * overstates support:
 *
 *   rendering  — glyphs shape correctly and there is an automated test for it.
 *                Verified by comparing HarfBuzz output against an independent
 *                rasteriser and by inspecting rendered frames.
 *   fillers    — a filler lexicon exists. `nativeReviewed: false` means it was
 *                assembled from reference sources, NOT confirmed by a native
 *                speaker. See docs/NATIVE_REVIEW.md.
 *   asr        — which providers document support. NOT a claim about accuracy
 *                on real creator audio; that must be measured per use case.
 */

export interface LanguageConfig {
  code: string;
  name: string;
  nativeName: string;
  script: ScriptName;
  /** Roman/transliterated output is a common request for these. */
  supportsRomanisation: boolean;
  /** Code-switching with English is routine in everyday speech. */
  commonlyCodeSwitched: boolean;
  asrProviders: string[];
  rendering: 'verified' | 'untested';
  fillers: 'present' | 'none';
  nativeReviewed: boolean;
  notes?: string;
}

export const LANGUAGES: Record<string, LanguageConfig> = {
  hi: {
    code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', script: 'Devanagari',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'deepgram', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
    notes: 'Hinglish (Hindi-English code-switching) is the primary target. Scribe v2 keeps English in Latin script.',
  },
  mr: {
    code: 'mr', name: 'Marathi', nativeName: 'मराठी', script: 'Devanagari',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
  },
  te: {
    code: 'te', name: 'Telugu', nativeName: 'తెలుగు', script: 'Telugu',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'deepgram', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
    notes: 'Deepgram added Telugu in Jan 2026.',
  },
  kn: {
    code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', script: 'Kannada',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'deepgram', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
    notes: 'Deepgram added Kannada in Jan 2026.',
  },
  ta: {
    code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', script: 'Tamil',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
    notes: 'Tall glyph stacks; line height is increased for this script.',
  },
  ml: {
    code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', script: 'Malayalam',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
  },
  bn: {
    code: 'bn', name: 'Bengali', nativeName: 'বাংলা', script: 'Bengali',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
    notes: 'Has pre-base matras requiring reordering, same class as Devanagari.',
  },
  gu: {
    code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', script: 'Gujarati',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
  },
  pa: {
    code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', script: 'Gurmukhi',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: false,
  },
  or: {
    code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', script: 'Oriya',
    supportsRomanisation: true, commonlyCodeSwitched: false,
    asrProviders: ['sarvam'],
    rendering: 'verified', fillers: 'none', nativeReviewed: false,
    notes: 'Rendering verified; no filler lexicon yet, so Auto Trim removes silence only.',
  },
  ur: {
    code: 'ur', name: 'Urdu', nativeName: 'اردو', script: 'Arabic',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs', 'sarvam'],
    rendering: 'untested', fillers: 'none', nativeReviewed: false,
    notes:
      'RIGHT-TO-LEFT. Run order is reversed, but bidi within a mixed Urdu/English line is NOT ' +
      'fully implemented (no UAX#9 bidi algorithm). Treat as experimental and inspect output.',
  },
  as: {
    code: 'as', name: 'Assamese', nativeName: 'অসমীয়া', script: 'Bengali',
    supportsRomanisation: true, commonlyCodeSwitched: false,
    asrProviders: ['sarvam'],
    rendering: 'verified', fillers: 'none', nativeReviewed: false,
    notes: 'Uses the Bengali script; rendering inherits from Bengali.',
  },
  ne: {
    code: 'ne', name: 'Nepali', nativeName: 'नेपाली', script: 'Devanagari',
    supportsRomanisation: true, commonlyCodeSwitched: true,
    asrProviders: ['elevenlabs'],
    rendering: 'verified', fillers: 'none', nativeReviewed: false,
  },
  en: {
    code: 'en', name: 'English', nativeName: 'English', script: 'Latin',
    supportsRomanisation: false, commonlyCodeSwitched: false,
    asrProviders: ['elevenlabs', 'deepgram', 'sarvam'],
    rendering: 'verified', fillers: 'present', nativeReviewed: true,
  },
};

export function getLanguage(code: string): LanguageConfig | undefined {
  return LANGUAGES[(code.split('-')[0] ?? '').toLowerCase()];
}

export function listLanguages(): LanguageConfig[] {
  return Object.values(LANGUAGES);
}

export function isSupportedLanguage(code: string): boolean {
  return getLanguage(code) !== undefined;
}

/** Human-readable support table for `--list-languages` and the docs. */
export function languageTable(): string {
  const rows = listLanguages().map((l) => {
    const flags = [
      l.rendering === 'verified' ? 'render:ok' : 'render:UNTESTED',
      l.fillers === 'present' ? 'fillers:yes' : 'fillers:no',
      l.nativeReviewed ? 'reviewed' : 'unreviewed',
    ].join(' ');
    return `  ${l.code.padEnd(4)} ${l.name.padEnd(11)} ${l.nativeName.padEnd(12)} ${flags}`;
  });
  return (
    `code name        native       status\n` +
    `${'-'.repeat(72)}\n` +
    rows.join('\n') +
    `\n\n"unreviewed" = filler word list not yet confirmed by a native speaker.\n` +
    `See docs/NATIVE_REVIEW.md for the review checklist.`
  );
}
