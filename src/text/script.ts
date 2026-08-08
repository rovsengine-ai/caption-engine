/**
 * Unicode script detection.
 *
 * Needed because a single caption line in Hinglish/Tenglish routinely mixes
 * Latin and an Indic script, and each run needs a font that actually covers it.
 * Picking one font for the whole line produces tofu on half of it.
 */

export type ScriptName =
  | 'Latin'
  | 'Devanagari'
  | 'Telugu'
  | 'Kannada'
  | 'Tamil'
  | 'Malayalam'
  | 'Bengali'
  | 'Gujarati'
  | 'Gurmukhi'
  | 'Oriya'
  | 'Arabic'
  | 'Common';

interface Range {
  lo: number;
  hi: number;
  script: ScriptName;
}

// Ordered by how often we expect to hit them; lookup is a linear scan over ~12
// entries per char, which is irrelevant next to the cost of shaping.
const RANGES: Range[] = [
  { lo: 0x0900, hi: 0x097f, script: 'Devanagari' },
  { lo: 0xa8e0, hi: 0xa8ff, script: 'Devanagari' }, // Devanagari Extended
  { lo: 0x1cd0, hi: 0x1cff, script: 'Devanagari' }, // Vedic Extensions
  { lo: 0x0980, hi: 0x09ff, script: 'Bengali' },
  { lo: 0x0a00, hi: 0x0a7f, script: 'Gurmukhi' },
  { lo: 0x0a80, hi: 0x0aff, script: 'Gujarati' },
  { lo: 0x0b00, hi: 0x0b7f, script: 'Oriya' },
  { lo: 0x0b80, hi: 0x0bff, script: 'Tamil' },
  { lo: 0x0c00, hi: 0x0c7f, script: 'Telugu' },
  { lo: 0x0c80, hi: 0x0cff, script: 'Kannada' },
  { lo: 0x0d00, hi: 0x0d7f, script: 'Malayalam' },
  { lo: 0x0600, hi: 0x06ff, script: 'Arabic' }, // Urdu
  { lo: 0x0750, hi: 0x077f, script: 'Arabic' },
  { lo: 0xfb50, hi: 0xfdff, script: 'Arabic' },
  { lo: 0xfe70, hi: 0xfeff, script: 'Arabic' },
  { lo: 0x0041, hi: 0x024f, script: 'Latin' },
];

/** Characters that belong to whatever run surrounds them (spaces, digits, punctuation). */
function isCommon(cp: number): boolean {
  return (
    cp <= 0x0040 || // space, digits, ASCII punctuation
    (cp >= 0x005b && cp <= 0x0060) ||
    (cp >= 0x007b && cp <= 0x00bf) ||
    cp === 0x2018 || cp === 0x2019 || cp === 0x201c || cp === 0x201d ||
    cp === 0x2013 || cp === 0x2014 || cp === 0x2026 ||
    cp === 0x200c || cp === 0x200d // ZWNJ/ZWJ — must stay inside the Indic run
  );
}

export function scriptOf(ch: string): ScriptName {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 'Common';
  if (cp === 0x200c || cp === 0x200d) return 'Common';
  if (isCommon(cp)) return 'Common';
  for (const r of RANGES) {
    if (cp >= r.lo && cp <= r.hi) return r.script;
  }
  return 'Common';
}

export interface ScriptRun {
  text: string;
  script: ScriptName;
}

/**
 * Split text into runs of a single script.
 *
 * ZWJ/ZWNJ and combining marks are absorbed into the preceding run — splitting
 * on them would break conjunct formation, which is the whole point.
 */
export function splitScriptRuns(text: string): ScriptRun[] {
  if (!text) return [];
  const runs: ScriptRun[] = [];
  let cur = '';
  let curScript: ScriptName | null = null;

  for (const ch of text) {
    const s = scriptOf(ch);
    if (s === 'Common') {
      cur += ch; // stays with whatever run we're in
      continue;
    }
    if (curScript === null || s === curScript) {
      curScript = s;
      cur += ch;
    } else {
      runs.push({ text: cur, script: curScript });
      cur = ch;
      curScript = s;
    }
  }
  if (cur) runs.push({ text: cur, script: curScript ?? 'Latin' });
  return runs;
}

/** The dominant non-Common script in a string, for font selection at line level. */
export function primaryScript(text: string): ScriptName {
  const counts = new Map<ScriptName, number>();
  for (const ch of text) {
    const s = scriptOf(ch);
    if (s === 'Common') continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best: ScriptName = 'Latin';
  let n = 0;
  for (const [s, c] of counts) {
    if (c > n) {
      best = s;
      n = c;
    }
  }
  return best;
}

/**
 * Scripts requiring complex shaping (reordering, conjuncts, contextual forms).
 * Text in these scripts must NOT be rendered by a naive per-character path.
 */
const COMPLEX: ReadonlySet<ScriptName> = new Set<ScriptName>([
  'Devanagari', 'Telugu', 'Kannada', 'Tamil', 'Malayalam',
  'Bengali', 'Gujarati', 'Gurmukhi', 'Oriya', 'Arabic',
]);

export function isComplexScript(s: ScriptName): boolean {
  return COMPLEX.has(s);
}

export function containsComplexScript(text: string): boolean {
  for (const ch of text) {
    if (isComplexScript(scriptOf(ch))) return true;
  }
  return false;
}

/** BCP-47 language tag → the script it is normally written in. */
export function scriptForLanguage(lang: string): ScriptName {
  const base = (lang.split('-')[0] ?? '').toLowerCase();
  switch (base) {
    case 'hi': case 'mr': case 'ne': case 'sa': case 'kok': case 'mai':
      return 'Devanagari';
    case 'te': return 'Telugu';
    case 'kn': return 'Kannada';
    case 'ta': return 'Tamil';
    case 'ml': return 'Malayalam';
    case 'bn': case 'as': return 'Bengali';
    case 'gu': return 'Gujarati';
    case 'pa': return 'Gurmukhi';
    case 'or': return 'Oriya';
    case 'ur': case 'ar': case 'fa': return 'Arabic';
    default: return 'Latin';
  }
}

/** Right-to-left scripts need reversed run order at the line level. */
export function isRtlScript(s: ScriptName): boolean {
  return s === 'Arabic';
}
