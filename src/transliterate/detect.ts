import { primaryScript, type ScriptName } from '../text/script.js';
import { toIso6391 } from '../config/language-codes.js';
import type { Transcript, Word } from '../types.js';

/**
 * Which language to romanise, decided from the transcript rather than from the
 * user's memory.
 *
 * The honest limit, stated up front: **script is not language.** Devanagari is
 * written by Hindi, Marathi, Nepali, Sanskrit, Konkani and Maithili; Bengali
 * script by Bengali and Assamese. Counting glyphs can narrow the field to a
 * script, never to a language within it. So detection here is:
 *
 *   1. the ASR's own language tag, when it gave one — that is a real acoustic
 *      judgement, and it is the only signal that can tell hi from mr;
 *   2. the dominant script across tokens, as corroboration and as the fallback
 *      when the provider said nothing.
 *
 * When those disagree, or when the script maps to several languages, the result
 * says so and names the alternatives. It never picks one silently.
 */

/** Script → the languages that write it, most common first. */
const SCRIPT_LANGUAGES: Partial<Record<ScriptName, string[]>> = {
  Devanagari: ['hi', 'mr', 'ne', 'sa', 'kok', 'mai'],
  Bengali: ['bn', 'as'],
  Telugu: ['te'],
  Kannada: ['kn'],
  Tamil: ['ta'],
  Malayalam: ['ml'],
  Gujarati: ['gu'],
  Gurmukhi: ['pa'],
  Oriya: ['or'],
  Arabic: ['ur'],
  Latin: ['en'],
};

export interface TokenScript {
  index: number;
  text: string;
  script: ScriptName;
  /** True for Latin-script tokens, which must survive untouched. */
  isLatin: boolean;
}

export interface LanguageDetection {
  /** The language to use. Empty string when nothing could be determined. */
  language: string;
  /** Where the answer came from. */
  source: 'explicit' | 'asr' | 'script' | 'unknown';
  /**
   * 0..1. Not a probability — a coverage figure: the share of script-bearing
   * tokens belonging to the dominant script. Reported, never used as a gate.
   */
  confidence: number;
  /** Dominant non-Latin script, when there is one. */
  script: ScriptName | null;
  /**
   * Other languages that write the same script and are therefore equally
   * consistent with the evidence. Non-empty means "we guessed".
   */
  alternatives: string[];
  /** Per-script token counts, for diagnostics. */
  scriptCounts: Record<string, number>;
  indicTokens: number;
  latinTokens: number;
  /** True when the transcript mixes Latin and an Indic script. */
  codeSwitched: boolean;
  /** Human-readable cautions. Empty when the answer is solid. */
  warnings: string[];
}

/** Classify every token by script. Cheap, and drives everything else. */
export function classifyTokens(words: Word[]): TokenScript[] {
  const out: TokenScript[] = [];
  words.forEach((w, index) => {
    if (w.type !== 'word') return;
    const text = w.text ?? '';
    if (text.trim() === '') return;
    const script = primaryScript(text);
    out.push({ index, text, script, isLatin: script === 'Latin' });
  });
  return out;
}

/**
 * Decide the language for romanisation.
 *
 * `explicit` always wins. That is the contract: a user who typed `--language kn`
 * has told us something we cannot outrank, and quietly overriding them with a
 * detector would be the worst possible behaviour.
 */
export function detectLanguage(
  transcript: Transcript,
  opts: { explicit?: string } = {},
): LanguageDetection {
  const tokens = classifyTokens(transcript.words);

  const scriptCounts: Record<string, number> = {};
  let latinTokens = 0;
  let indicTokens = 0;
  for (const t of tokens) {
    // "Common" is punctuation and digits — it carries no language evidence.
    if (t.script === 'Common') continue;
    scriptCounts[t.script] = (scriptCounts[t.script] ?? 0) + 1;
    if (t.isLatin) latinTokens++;
    else indicTokens++;
  }

  const nonLatin = Object.entries(scriptCounts).filter(([s]) => s !== 'Latin' && s !== 'Common');
  nonLatin.sort((a, b) => b[1] - a[1]);
  const dominantScript = (nonLatin[0]?.[0] as ScriptName | undefined) ?? null;
  const dominantCount = nonLatin[0]?.[1] ?? 0;

  const codeSwitched = latinTokens > 0 && indicTokens > 0;
  const warnings: string[] = [];

  // ---- 1. Explicit wins, unconditionally ---------------------------------
  const explicit = (opts.explicit ?? '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') {
    const code = toIso6391(explicit);
    const scriptSaysOtherwise =
      dominantScript &&
      SCRIPT_LANGUAGES[dominantScript] &&
      !SCRIPT_LANGUAGES[dominantScript]!.includes(code);
    if (scriptSaysOtherwise) {
      warnings.push(
        `--language ${code} was given, but ${dominantCount} token(s) are in ${dominantScript} ` +
          `script, which ${code} does not use. Using ${code} as instructed — remove --language ` +
          `to detect automatically.`,
      );
    }
    return {
      language: code, source: 'explicit', confidence: 1, script: dominantScript,
      alternatives: [], scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
    };
  }

  // ---- 2. The ASR's own tag ----------------------------------------------
  const asrCode = toIso6391(transcript.language);
  const scriptCoverage = indicTokens > 0 ? dominantCount / indicTokens : 0;

  if (asrCode && asrCode !== 'en') {
    const family = dominantScript ? SCRIPT_LANGUAGES[dominantScript] : undefined;
    if (dominantScript && family && !family.includes(asrCode)) {
      warnings.push(
        `The ASR reported "${transcript.language}" but the text is mostly ${dominantScript} ` +
          `script, which that language does not use. Trusting the script: ` +
          `${family[0]}. Pass --language explicitly to override.`,
      );
      return {
        language: family[0]!, source: 'script',
        confidence: round2(scriptCoverage * 0.7),
        script: dominantScript,
        alternatives: family.slice(1),
        scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
      };
    }
    // Script agrees, or there is no script evidence either way.
    const alternatives = (family ?? []).filter((l) => l !== asrCode);
    if (indicTokens === 0) {
      warnings.push(
        `The ASR reported "${transcript.language}", but no Indic-script tokens were found. ` +
          `There may be nothing to romanise.`,
      );
    }
    return {
      language: asrCode, source: 'asr',
      confidence: indicTokens > 0 ? round2(0.6 + 0.4 * scriptCoverage) : 0.5,
      script: dominantScript, alternatives,
      scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
    };
  }

  // ---- 3. Script only -----------------------------------------------------
  if (dominantScript) {
    const family = SCRIPT_LANGUAGES[dominantScript] ?? [];
    const picked = family[0] ?? '';
    if (family.length > 1) {
      warnings.push(
        `${dominantScript} script is written by ${family.join(', ')}. ` +
          `Script alone cannot tell them apart; assuming ${picked}. ` +
          `Pass --language to be certain.`,
      );
    }
    if (asrCode === 'en') {
      warnings.push(
        `The ASR reported English but ${dominantCount} token(s) are in ${dominantScript} script.`,
      );
    }
    return {
      language: picked, source: 'script',
      // Script gives a script, not a language. Cap the confidence when several
      // languages share it, so the number never overstates what was learned.
      confidence: round2(scriptCoverage * (family.length > 1 ? 0.6 : 0.9)),
      script: dominantScript, alternatives: family.slice(1),
      scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
    };
  }

  // ---- 4. Nothing to go on -------------------------------------------------
  if (asrCode === 'en' || latinTokens > 0) {
    warnings.push(
      'No Indic-script tokens found. Roman output would be a no-op — the text is already Latin.',
    );
    return {
      language: asrCode || 'en', source: asrCode ? 'asr' : 'unknown',
      confidence: asrCode ? 0.5 : 0, script: null, alternatives: [],
      scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
    };
  }

  warnings.push('Could not determine a language: no language tag from the ASR and no script evidence.');
  return {
    language: '', source: 'unknown', confidence: 0, script: null, alternatives: [],
    scriptCounts, indicTokens, latinTokens, codeSwitched, warnings,
  };
}

/** Below this, the report says so out loud. */
export const LOW_CONFIDENCE = 0.65;

export function isLowConfidence(d: LanguageDetection): boolean {
  return d.source !== 'explicit' && d.confidence < LOW_CONFIDENCE;
}

function round2(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}
