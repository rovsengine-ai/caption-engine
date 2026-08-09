import { getLanguage } from '../config/languages.js';
import { scriptForLanguage, type ScriptName } from '../text/script.js';

/**
 * What "Roman output" actually means for a given source language.
 *
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE.
 *
 * Roman output is not one mode. It is `sourceLanguage + roman script`, and the
 * source language is load-bearing: it decides which transliteration rules apply
 * and what the result should be called.
 *
 *   hi + roman  → Hinglish
 *   kn + roman  → Kannada in Roman letters
 *   te + roman  → Telugu in Roman letters
 *   ta + roman  → Tamil in Roman letters
 *   ml + roman  → Malayalam in Roman letters
 *   en + roman  → already Roman; nothing to do
 *
 * "Hinglish" is the name of ONE of those, not the name of the category. Calling
 * Kannada output Hinglish because it uses Latin letters is the same category
 * error as calling French "English" because it uses the same alphabet — and it
 * is exactly the sort of mislabelling that lets a genuine routing bug hide,
 * because the log looks the same whether the language was honoured or not.
 *
 * Nothing here transliterates. It only names things, so that the name can never
 * drift from the language actually being used.
 */

export interface RomanMode {
  /** ISO-639-1 source language. Never invented, never defaulted. */
  language: string;
  /** Human-readable language name, e.g. "Kannada". */
  languageName: string;
  /** The script that language is normally written in. */
  sourceScript: ScriptName;
  /** Short label for logs, e.g. "Kannada → Roman" or "Hinglish (Hindi → Roman)". */
  label: string;
  /**
   * True only for Hindi. Guarded deliberately: several places used to reach for
   * "Hinglish" as a synonym for "Roman output", and this is the single flag
   * that makes that claim checkable.
   */
  isHinglish: boolean;
  /**
   * True when the source is already in Latin script, so romanisation is a no-op
   * rather than a failure.
   */
  alreadyRoman: boolean;
}

/**
 * Colloquial names people actually use for these, kept because they are what
 * users type and search for. Deliberately NOT used as the primary label: the
 * unambiguous "Kannada → Roman" form is what the diagnostics print, with the
 * nickname alongside it, so nobody has to know the slang to read the output.
 */
const NICKNAMES: Record<string, string> = {
  hi: 'Hinglish',
  kn: 'Kannglish',
  te: 'Tenglish',
  ta: 'Tanglish',
  ml: 'Manglish',
  bn: 'Benglish',
};

/** The nickname for a language's Roman mode, when it has one. */
export function romanNickname(language: string): string | undefined {
  return NICKNAMES[base(language)];
}

/**
 * Describe the Roman mode for a source language.
 *
 * Takes the language it is given and never substitutes another one. An unknown
 * or empty language yields an empty `language` and a label that says so, rather
 * than quietly becoming Hindi — silently changing the detected source language
 * is the failure this module is guarding against.
 */
export function romanMode(language: string): RomanMode {
  const code = base(language);
  const languageName = getLanguage(code)?.name ?? (code || 'unknown');
  const sourceScript = code ? scriptForLanguage(code) : 'Latin';
  const alreadyRoman = code === 'en' || (code !== '' && sourceScript === 'Latin');
  const nickname = NICKNAMES[code];

  let label: string;
  if (!code) label = 'unknown language → Roman';
  else if (alreadyRoman) label = `${languageName} (already Roman — nothing to transliterate)`;
  else label = `${languageName} → Roman${nickname ? ` (${nickname})` : ''}`;

  return {
    language: code,
    languageName,
    sourceScript,
    label,
    isHinglish: code === 'hi',
    alreadyRoman,
  };
}

function base(language: string): string {
  return (language.split('-')[0] ?? '').trim().toLowerCase();
}
