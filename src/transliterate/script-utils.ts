/** Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam. */
const INDIC_RANGE =
  /[ऀ-ॿঀ-৿਀-੿઀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ]/;

export function isIndicScript(s: string): boolean {
  return INDIC_RANGE.test(s);
}

/** True if the token is already Latin — English words in code-switched audio. */
export function isAlreadyRoman(s: string): boolean {
  return !INDIC_RANGE.test(s);
}
