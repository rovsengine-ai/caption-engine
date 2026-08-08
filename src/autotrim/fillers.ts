/**
 * Filler-word lexicons, per language.
 *
 * ⚠️ ACTION REQUIRED BEFORE LAUNCH: these lists are a STARTING POINT assembled
 * from general knowledge, not from native-speaker review. Filler words are
 * dialect- and region-specific, and a wrong list is visible to users in the most
 * embarrassing way — either it misses obvious fillers, or it cuts real words.
 *
 * Budget one day per language with 2-3 native speakers: play them real creator
 * audio, have them mark what they'd cut. That's a day of work that makes the
 * difference between "this tool understands Telugu" and "this tool is English
 * software with Telugu bolted on."
 *
 * Notable traps already handled:
 *  - Hindi "matlab" (मतलब) and Telugu "ante" (అంటే) are BOTH fillers AND real
 *    words meaning "meaning/that is". Cutting every instance destroys sentences.
 *    See `ambiguous` — these are only cut with additional evidence (see index.ts).
 */

export interface FillerLexicon {
  /** Safe to cut whenever they appear standalone. */
  always: string[];
  /** Real words that are ALSO used as fillers. Require extra evidence to cut. */
  ambiguous: string[];
}

const EN: FillerLexicon = {
  always: ['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mmm', 'uhm'],
  ambiguous: ['like', 'so', 'basically', 'actually', 'literally', 'right', 'okay', 'you know', 'i mean'],
};

const HI: FillerLexicon = {
  always: ['हम्म', 'अं', 'अ', 'उम', 'एर', 'हूँ'],
  ambiguous: ['मतलब', 'यानी', 'वो', 'तो', 'बस', 'अच्छा', 'ठीक है', 'क्या बोलते हैं'],
};

/** Romanised Hindi — what Hinglish transcripts actually look like. */
const HI_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'uh', 'haan', 'arre'],
  ambiguous: ['matlab', 'yaani', 'yaar', 'toh', 'bas', 'accha', 'theek hai', 'kya bolte hain', 'woh'],
};

const TE: FillerLexicon = {
  always: ['హ్మ్', 'అమ్', 'ఆ', 'ఉమ్'],
  ambiguous: ['అంటే', 'ఏంటంటే', 'అది', 'కదా', 'మరి', 'సరే'],
};

const TE_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'aa', 'um'],
  ambiguous: ['ante', 'antey', 'entante', 'adi', 'kada', 'mari', 'sare'],
};

const KN: FillerLexicon = {
  always: ['ಹ್ಮ್', 'ಅಂ', 'ಆ', 'ಉಮ್'],
  ambiguous: ['ಅಂದರೆ', 'ಅದು', 'ಅಲ್ವಾ', 'ಸರಿ', 'ಮತ್ತೆ'],
};

const KN_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'aa', 'um'],
  ambiguous: ['andre', 'adu', 'alva', 'sari', 'matte'],
};

const TA: FillerLexicon = {
  always: ['ஹ்ம்', 'அம்', 'ஆ', 'உம்'],
  ambiguous: ['அப்புறம்', 'அது', 'இல்ல', 'சரி', 'என்னன்னா', 'அப்படி'],
};

const TA_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'aa'],
  ambiguous: ['appuram', 'adhu', 'illa', 'sari', 'ennanna', 'appadi'],
};

const ML: FillerLexicon = {
  always: ['ഹ്മ്', 'അം', 'ആ', 'ഉം'],
  ambiguous: ['അതായത്', 'അത്', 'എന്നുവച്ചാൽ', 'ശരി', 'പിന്നെ'],
};

const ML_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'aa'],
  ambiguous: ['athayath', 'athu', 'ennuvachal', 'sari', 'pinne'],
};

const BN: FillerLexicon = {
  always: ['হুম', 'উম', 'আহ', 'এ'],
  ambiguous: ['মানে', 'যেটা', 'তো', 'আচ্ছা', 'ঠিক আছে'],
};

const BN_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um', 'ah'],
  ambiguous: ['mane', 'jeta', 'toh', 'accha', 'thik ache'],
};

const GU: FillerLexicon = {
  always: ['હમ્મ', 'ઉમ', 'આ'],
  ambiguous: ['મતલબ', 'એટલે', 'પછી', 'સારું', 'તો'],
};

const GU_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['matlab', 'etle', 'pachhi', 'saru', 'toh'],
};

const PA: FillerLexicon = {
  always: ['ਹਮ੍ਮ', 'ਉਮ', 'ਆ'],
  ambiguous: ['ਮਤਲਬ', 'ਯਾਨੀ', 'ਫਿਰ', 'ਚੰਗਾ', 'ਤਾਂ'],
};

const PA_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['matlab', 'yaani', 'phir', 'changa', 'taan'],
};

const MR: FillerLexicon = {
  always: ['हम्म', 'अं', 'आ', 'उम'],
  ambiguous: ['म्हणजे', 'तर', 'बरं', 'असं', 'काय'],
};

const MR_ROMAN: FillerLexicon = {
  always: ['hmm', 'umm', 'um'],
  ambiguous: ['mhanje', 'tar', 'bara', 'asa', 'kay'],
};

/**
 * Language → lexicon sets, most specific first.
 *
 * Indic entries deliberately include the romanised set AND English, because
 * code-switched speech mixes all three inside a single sentence: a Hindi
 * transcript legitimately contains "matlab", "matlab" romanised, and "um".
 * Matching only the native-script list would miss most real fillers.
 */
const LEXICONS: Record<string, FillerLexicon[]> = {
  en: [EN],
  hi: [HI, HI_ROMAN, EN],
  mr: [MR, MR_ROMAN, EN],
  ne: [HI, HI_ROMAN, EN], // Nepali shares much Devanagari filler vocabulary
  te: [TE, TE_ROMAN, EN],
  kn: [KN, KN_ROMAN, EN],
  ta: [TA, TA_ROMAN, EN],
  ml: [ML, ML_ROMAN, EN],
  bn: [BN, BN_ROMAN, EN],
  as: [BN, BN_ROMAN, EN], // Assamese uses the Bengali script
  gu: [GU, GU_ROMAN, EN],
  pa: [PA, PA_ROMAN, EN],
};

/** Normalise for comparison: lowercase, strip punctuation, collapse repeats. */
export function normaliseToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'`।॥]/g, '') // includes Devanagari danda । ॥
    .trim();
}

export interface FillerMatch {
  isFiller: boolean;
  /** Ambiguous fillers need corroborating evidence before we cut them. */
  ambiguous: boolean;
}

/**
 * Is this token a filler in the given language context?
 * Falls back to English-only when the language is unknown — deliberately
 * conservative, since over-cutting is far worse than under-cutting.
 */
export function matchFiller(token: string, language = 'en'): FillerMatch {
  const base = (language.split('-')[0] ?? 'en').toLowerCase();
  const sets = LEXICONS[base] ?? [EN];
  const t = normaliseToken(token);
  if (!t) return { isFiller: false, ambiguous: false };

  for (const set of sets) {
    if (set.always.includes(t)) return { isFiller: true, ambiguous: false };
  }
  for (const set of sets) {
    if (set.ambiguous.includes(t)) return { isFiller: true, ambiguous: true };
  }
  return { isFiller: false, ambiguous: false };
}

export function supportedFillerLanguages(): string[] {
  return Object.keys(LEXICONS);
}
