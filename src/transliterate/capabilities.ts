/**
 * Which transliteration backend can romanise which language.
 *
 * Declared as data, in one place, because the answer was previously scattered
 * across three `supports()` methods and a comment. A user asking "can I get
 * Roman Kannada?" should be able to get a straight answer from the CLI without
 * running a job and waiting for it to fail.
 *
 * The table is checked BEFORE any request goes out. Discovering that a provider
 * cannot handle the language after paying for ASR and uploading a batch is the
 * expensive way to find out.
 */

export type TransliteratorName = 'local' | 'local-llm' | 'sarvam' | 'http' | 'native';

export interface ProviderCapability {
  name: TransliteratorName;
  /** null = "depends on the configured service", not "all languages". */
  languages: string[] | null;
  offline: boolean;
  needs: string | null;
  description: string;
}

/**
 * Languages with a built-in offline engine.
 *
 * These are TWO separate engines, not one engine covering six scripts:
 * `devanagari.ts` implements Hindi schwa deletion and cannot be pointed at
 * another script, and `kannada.ts` implements Kannada, which keeps its inherent
 * vowel and therefore needs different rules entirely. `--transliterate local`
 * picks whichever one matches the language; there is no shared code path where
 * Kannada could end up in Devanagari rules.
 */
const LOCAL_LANGUAGES = ['hi', 'mr', 'ne', 'sa', 'kok', 'mai', 'kn'];

/**
 * Sarvam's documented set. Kept here rather than inferred, so an unsupported
 * language fails with a clear message instead of a 422 from the API.
 */
const SARVAM_LANGUAGES = ['hi', 'mr', 'ne', 'te', 'kn', 'ta', 'ml', 'bn', 'gu', 'pa', 'or', 'as'];

/** Same twelve languages, romanised by a local LLM instead of Sarvam's API. */
const LOCAL_LLM_LANGUAGES = SARVAM_LANGUAGES;

export const CAPABILITIES: Record<TransliteratorName, ProviderCapability> = {
  local: {
    name: 'local',
    languages: LOCAL_LANGUAGES,
    offline: true,
    needs: null,
    description: 'built-in rules, Devanagari + Kannada, deterministic and free',
  },
  'local-llm': {
    name: 'local-llm',
    languages: LOCAL_LLM_LANGUAGES,
    offline: true,
    needs: null,
    description: 'local LLM via Ollama, 12 Indic languages, no API key',
  },
  sarvam: {
    name: 'sarvam',
    languages: SARVAM_LANGUAGES,
    offline: false,
    needs: 'SARVAM_API_KEY',
    description: 'model-backed, 12 Indic languages, better on loanwords',
  },
  http: {
    name: 'http',
    // Unknown by construction: it is whatever you pointed it at.
    languages: null,
    offline: false,
    needs: 'TRANSLITERATE_URL',
    description: 'your own endpoint (IndicXlit, Bhashini, …)',
  },
  native: {
    name: 'native',
    // Not "supports everything" — supports nothing. It performs no
    // transliteration at all and exists only as an explicitly requested
    // fallback, so that keeping the original script is a decision the user
    // made rather than something that happened to them.
    languages: [],
    offline: true,
    needs: null,
    description: 'no transliteration — keep the original script (fallback only)',
  },
};

export function providerSupports(name: TransliteratorName, language: string): boolean {
  const cap = CAPABILITIES[name];
  if (!cap) return false;
  if (cap.languages === null) return true; // unknowable; the service decides
  const base = (language.split('-')[0] ?? '').toLowerCase();
  return cap.languages.includes(base);
}

/** Backends that can romanise this language, best-quality first. */
export function providersFor(language: string): TransliteratorName[] {
  return (['sarvam', 'local-llm', 'http', 'local'] as TransliteratorName[])
    .filter((n) => providerSupports(n, language));
}

export function listCapabilities(): ProviderCapability[] {
  return [
    CAPABILITIES.local,
    CAPABILITIES['local-llm'],
    CAPABILITIES.sarvam,
    CAPABILITIES.http,
    CAPABILITIES.native,
  ];
}

/**
 * A message that tells the user what to actually do, given a language no
 * configured backend covers.
 */
export function explainUnsupported(language: string, chosen: TransliteratorName): string {
  const alternatives = providersFor(language).filter((n) => n !== chosen);
  const lines: string[] = [
    `The "${chosen}" transliterator does not cover "${language}".`,
    '',
  ];
  if (alternatives.length > 0) {
    lines.push('Backends that do:');
    for (const a of alternatives) {
      const cap = CAPABILITIES[a];
      lines.push(
        `  --transliterate ${a.padEnd(10)} ${cap.description}` +
          (cap.needs ? `   (needs ${cap.needs})` : ''),
      );
    }
  } else {
    lines.push(`No configured backend covers "${language}".`);
  }
  lines.push(
    '',
    'Or keep the original script instead of romanising:',
    '  --roman-fallback native      continue in native script, reported not silent',
    '  (or drop --script roman entirely)',
  );
  return lines.join('\n');
}
