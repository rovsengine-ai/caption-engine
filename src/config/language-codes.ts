/**
 * Language-code normalisation.
 *
 * WHY — a real interoperability bug.
 *
 * ASR providers do not agree on which ISO standard to return. ElevenLabs Scribe
 * returns ISO-639-3 ("hin", "eng", "tam"); this project keys everything —
 * filler lexicons, font selection, transliterator support, the language
 * registry — on ISO-639-1 ("hi", "en", "ta").
 *
 * With no normalisation, a Hindi video came back tagged "hin", every lookup
 * missed, and the user had to pass `--language hi` by hand to get a result they
 * should have got automatically. Worse, it failed QUIETLY: unknown code meant
 * "no filler lexicon" and "unsupported for transliteration", so Auto Trim
 * silently did less and Roman output silently refused.
 *
 * Normalisation happens at the ADAPTER BOUNDARY, so nothing downstream ever
 * sees a 639-3 code. The original is preserved on the transcript as
 * `detectedLanguageRaw` for diagnostics — normalising should never destroy
 * evidence of what the provider actually said.
 */

/** ISO-639-3 (and common 639-2/B) → ISO-639-1. */
const THREE_TO_TWO: Record<string, string> = {
  // Indic — the ones this project cares most about
  hin: 'hi', eng: 'en', tam: 'ta', tel: 'te', kan: 'kn', mal: 'ml',
  ben: 'bn', mar: 'mr', guj: 'gu', pan: 'pa', nep: 'ne',
  ori: 'or', ory: 'or', asm: 'as', urd: 'ur', san: 'sa',
  kok: 'kok', mai: 'mai', snd: 'sd', kas: 'ks', doi: 'doi',
  mni: 'mni', sat: 'sat', bod: 'bo', tib: 'bo',

  // Widely-seen others, so a non-Indic video is not mislabelled either
  spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de',
  ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', kor: 'ko',
  zho: 'zh', chi: 'zh', ara: 'ar', tur: 'tr', vie: 'vi',
  tha: 'th', ind: 'id', msa: 'ms', may: 'ms', nld: 'nl', dut: 'nl',
  pol: 'pl', ukr: 'uk', ron: 'ro', rum: 'ro', ell: 'el', gre: 'el',
  heb: 'he', fas: 'fa', per: 'fa', swa: 'sw', tgl: 'tl', fil: 'tl',
  ces: 'cs', cze: 'cs', swe: 'sv', dan: 'da', fin: 'fi', nor: 'no',
  hun: 'hu', bul: 'bg', hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk',
};

export interface NormalisedLanguage {
  /** ISO-639-1 where one exists, otherwise the lower-cased input. */
  code: string;
  /** Exactly what the provider returned, untouched. */
  raw: string;
  /** Region/script subtag, e.g. "IN" from "hi-IN". */
  region?: string;
  /** True when a 639-3 → 639-1 mapping was applied. */
  wasMapped: boolean;
}

/**
 * Normalise a provider language code to the project's internal form.
 *
 * Handles: "hin" → "hi", "hin-IN" → "hi" (region kept separately),
 * "HI" → "hi", "hi_IN" → "hi", "" → "" (unknown).
 * An unrecognised code is passed through lower-cased rather than discarded —
 * losing it would be worse than carrying something we cannot interpret.
 */
export function normaliseLanguageCode(input: string | undefined | null): NormalisedLanguage {
  const raw = (input ?? '').trim();
  if (!raw) return { code: '', raw, wasMapped: false };

  const parts = raw.toLowerCase().split(/[-_]/);
  const primary = parts[0] ?? '';
  const region = parts.length > 1 ? parts.slice(1).join('-').toUpperCase() : undefined;

  const mapped = THREE_TO_TWO[primary];
  if (mapped) {
    return { code: mapped, raw, region, wasMapped: mapped !== primary };
  }
  // Already 2-letter, or something we do not recognise.
  return { code: primary, raw, region, wasMapped: false };
}

/** Convenience: just the normalised code. */
export function toIso6391(input: string | undefined | null): string {
  return normaliseLanguageCode(input).code;
}

/** Is this a 3-letter code we can map? */
export function isIso6393(code: string): boolean {
  return Object.hasOwn(THREE_TO_TWO, code.toLowerCase());
}

/** The full mapping table, for tests and documentation. */
export function languageCodeMappings(): Readonly<Record<string, string>> {
  return THREE_TO_TWO;
}
