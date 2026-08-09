/**
 * Pass 1 of Auto Trim: gather evidence. Decide nothing.
 *
 * The old single-pass design asked "is this token in a filler list?" and cut on
 * the answer. That is why it removed the English article "a", and why a drawled
 * "aaa" delivered straight into the next word survived: the list said "a" was
 * not a filler, and nothing measured how long it was held.
 *
 * This pass produces a `FillerEvidence` record for every candidate and makes no
 * judgement at all. Pass 2 (decide.ts) weighs the record. Splitting them means
 * the evidence is inspectable — `--analyze-filler-candidates` prints exactly
 * this, so when a cut is wrong you can see which signal lied.
 *
 * Nothing here is learned. Every field is either measured from the waveform,
 * read off the transcript, or derived by a rule stated in a comment beside it.
 */

import type { Transcript, Word } from '../types.js';
import type { AudioAnalysis } from '../media/audio-analysis.js';
import { matchFiller, normaliseToken, matchNeverCut } from './fillers.js';

/** Which writing system a token uses. Mixed = Latin and Indic in one token. */
export type CandidateScript = 'latin' | 'indic' | 'mixed' | 'other';

export type CandidatePosition = 'start' | 'end' | 'middle';

/** Everything known about one filler candidate. Pass 2 reads only this. */
export interface FillerEvidence {
  /** Index into Transcript.words. */
  index: number;
  /** Exactly what the ASR returned, untouched. */
  originalToken: string;
  /** Lowercased, punctuation stripped. */
  normalizedToken: string;
  /** Elongation collapsed: "aaa" → "a", "ummm" → "um". */
  collapsedToken: string;
  language: string;
  script: CandidateScript;

  durationSec: number;
  asrConfidence: number;

  /** Gap to the neighbouring ASR word. A missing neighbour is 0, never Infinity. */
  gapBeforeSec: number;
  gapAfterSec: number;

  // ---- Measured from the waveform. Zeroed when audio analysis is off. ----
  audioAvailable: boolean;
  /** Silence actually measured before/after this token, not inferred from ASR. */
  measuredQuietBeforeSec: number;
  measuredQuietAfterSec: number;
  /** Mean RMS across the token itself. */
  energyDb: number;
  peakDb: number;
  /** Fraction of the token above the noise floor. NOT a trained VAD — see audio-analysis.ts. */
  voicedRatio: number;

  prevWord: string | null;
  nextWord: string | null;
  position: CandidatePosition;

  /**
   * The token holds a run of 3+ identical characters: "aaa", "ummm", "हम्म्म".
   * This is the signal that separates a drawled hesitation from the real word
   * it collapses to — "aaa" is a noise, "a" is an article.
   */
  isElongated: boolean;
  /** Duration relative to the median spoken word in this transcript. */
  stretchRatio: number;
  /** Held far longer than a word of its length should be. */
  isStretched: boolean;

  /** Adjacent identical tokens, e.g. "aa aa aa". 1 = no repetition. */
  repetitionRun: number;
  /**
   * How often this token appears anywhere in the transcript inside a phrase
   * (a neighbour on both sides, no big pause). A token that only ever appears
   * isolated behaves like a filler; one that appears mid-phrase is a word.
   * Corpus-internal, so it needs no dictionary and works for every language.
   */
  phraseOccurrences: number;
  totalOccurrences: number;

  /** In the explicit `never` tier: structurally required, never auto-cut. */
  isProtectedWord: boolean;
  /** Neighbour looks like a proper noun, so this may sit inside a name. */
  nearProperNoun: boolean;

  /** Which lexicon tier matched, if any. */
  lexicon: 'always' | 'ambiguous' | 'never' | 'none';
}

const DEVANAGARI_ETC =
  /[ऀ-ॿঀ-৿਀-੿઀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ]/;
const LATIN = /[A-Za-z]/;

export function detectTokenScript(token: string): CandidateScript {
  const hasIndic = DEVANAGARI_ETC.test(token);
  const hasLatin = LATIN.test(token);
  if (hasIndic && hasLatin) return 'mixed';
  if (hasIndic) return 'indic';
  if (hasLatin) return 'latin';
  return 'other';
}

/**
 * Collapse a run of 3+ identical characters to one.
 *
 * Three, not two: English doubles are ordinary ("book", "cool", "letter") and
 * collapsing them would corrupt real words. Three of the same character in a
 * row is essentially always elongation — "aaa", "ummm", "sooo".
 */
export function collapseElongation(token: string): string {
  return token.replace(/(.)\1{2,}/gu, '$1');
}

/** Longest run of one identical character, in code points. */
function longestRun(token: string): number {
  const cps = [...token];
  let best = 0;
  let run = 0;
  for (let k = 0; k < cps.length; k++) {
    run = k > 0 && cps[k] === cps[k - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Is this token a DRAWL — a held sound — rather than a word that merely
 * contains a repeated letter?
 *
 * Containing a 3-run is not enough. "zzzznotafiller" holds a run of four and is
 * plainly not a hesitation; treating it as one produced a confident cut on a
 * 14-character word. A drawl is *constituted* by its repetition, so either the
 * token collapses to something tiny ("aaa" → "a", "ummm" → "um") or the run
 * dominates the token.
 */
export function isElongatedToken(token: string): boolean {
  if (!/(.)\1{2,}/u.test(token)) return false;
  const collapsedLength = [...collapseElongation(token)].length;
  if (collapsedLength <= 3) return true;
  return longestRun(token) / [...token].length >= 0.6;
}

/**
 * A crude proper-noun signal: initial capital in a Latin token that is not the
 * first word of the sentence. Deliberately weak — it only ever *blocks* a cut,
 * so a false positive costs a filler left in, and a false negative costs
 * nothing that the other signals do not already catch.
 */
function looksProperNoun(token: string | null): boolean {
  if (!token) return false;
  return /^[A-Z][a-z]{1,}$/.test(token.trim());
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface AnalyseOptions {
  /** Candidates shorter than this are too brief to be a held hesitation. */
  minFillerDurationSec: number;
  /** Candidates longer than this are almost certainly a real word, not a noise. */
  maxFillerDurationSec: number;
  /** Held this many times the median word duration counts as stretched. */
  stretchRatioThreshold: number;
}

export const DEFAULT_ANALYSE_OPTIONS: AnalyseOptions = {
  minFillerDurationSec: 0.06,
  maxFillerDurationSec: 2.0,
  stretchRatioThreshold: 1.8,
};

/**
 * Build the evidence record for every filler candidate in the transcript.
 *
 * A "candidate" is any token that matches a filler lexicon at any tier, plus
 * any elongated token, because elongation is itself evidence and the lexicon
 * cannot enumerate every spelling an ASR invents for a drawl ("aaaa", "aaaaa").
 */
export function analyseFillerCandidates(
  transcript: Transcript,
  audio: AudioAnalysis | null,
  options: Partial<AnalyseOptions> = {},
): FillerEvidence[] {
  const opts = { ...DEFAULT_ANALYSE_OPTIONS, ...options };
  const words = transcript.words;

  const spoken = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.type === 'word' && normaliseToken(w.text) !== '');

  const medianDuration = median(
    spoken.map(({ w }) => w.end - w.start).filter((d) => d > 0),
  ) || 0.3;

  // Corpus-internal word/filler signal, computed once for the whole transcript.
  const total = new Map<string, number>();
  const inPhrase = new Map<string, number>();
  for (let k = 0; k < spoken.length; k++) {
    const t = normaliseToken(spoken[k]!.w.text);
    if (!t) continue;
    total.set(t, (total.get(t) ?? 0) + 1);
    const prev = spoken[k - 1];
    const next = spoken[k + 1];
    // "Inside a phrase" = has a neighbour on both sides with no real pause at
    // either seam. That is how a word behaves; a filler sits in the gaps.
    const tight =
      !!prev && !!next &&
      spoken[k]!.w.start - prev.w.end < 0.25 &&
      next.w.start - spoken[k]!.w.end < 0.25;
    if (tight) inPhrase.set(t, (inPhrase.get(t) ?? 0) + 1);
  }

  const out: FillerEvidence[] = [];

  for (let k = 0; k < spoken.length; k++) {
    const { w, i } = spoken[k]!;
    const language = w.language ?? transcript.language ?? 'en';
    const normalized = normaliseToken(w.text);
    const elongated = isElongatedToken(normalized);
    const collapsed = collapseElongation(normalized);

    const match = matchFiller(w.text, language);
    const never = matchNeverCut(w.text, language);
    // An elongated token is a candidate even when no lexicon lists it: no list
    // can enumerate "aaaa" vs "aaaaa". Its collapsed form is checked too, so
    // "ummm" is caught by the "um" entry.
    const collapsedMatch = elongated ? matchFiller(collapsed, language) : null;

    const isCandidate = match.isFiller || never || elongated || !!collapsedMatch?.isFiller;
    if (!isCandidate) continue;

    const prev = spoken[k - 1];
    const next = spoken[k + 1];
    const gapBefore = prev ? Math.max(0, w.start - prev.w.end) : 0;
    const gapAfter = next ? Math.max(0, next.w.start - w.end) : 0;

    const duration = Math.max(0, w.end - w.start);
    const stretchRatio = medianDuration > 0 ? duration / medianDuration : 1;

    // Adjacent identical tokens, scanned both directions.
    let run = 1;
    for (let j = k - 1; j >= 0 && normaliseToken(spoken[j]!.w.text) === normalized; j--) run++;
    for (let j = k + 1; j < spoken.length && normaliseToken(spoken[j]!.w.text) === normalized; j++) run++;

    const audioOk = !!audio?.available;

    const lexicon: FillerEvidence['lexicon'] = never
      ? 'never'
      : match.isFiller
        ? (match.ambiguous ? 'ambiguous' : 'always')
        : collapsedMatch?.isFiller
          ? (collapsedMatch.ambiguous ? 'ambiguous' : 'always')
          : 'none';

    out.push({
      index: i,
      originalToken: w.text,
      normalizedToken: normalized,
      collapsedToken: collapsed,
      language,
      script: detectTokenScript(w.text),

      durationSec: round3(duration),
      asrConfidence: w.confidence,

      gapBeforeSec: round3(gapBefore),
      gapAfterSec: round3(gapAfter),

      audioAvailable: audioOk,
      measuredQuietBeforeSec: audioOk ? audio!.quietBefore(w.start) : 0,
      measuredQuietAfterSec: audioOk ? audio!.quietAfter(w.end) : 0,
      energyDb: audioOk ? round3(audio!.energyDb(w.start, w.end)) : 0,
      peakDb: audioOk ? round3(audio!.peakDb(w.start, w.end)) : 0,
      voicedRatio: audioOk ? round3(audio!.voicedRatio(w.start, w.end)) : 0,

      prevWord: prev?.w.text ?? null,
      nextWord: next?.w.text ?? null,
      position: !prev ? 'start' : !next ? 'end' : 'middle',

      isElongated: elongated,
      stretchRatio: round3(stretchRatio),
      isStretched:
        stretchRatio >= opts.stretchRatioThreshold && duration >= opts.minFillerDurationSec,

      repetitionRun: run,
      phraseOccurrences: inPhrase.get(normalized) ?? 0,
      totalOccurrences: total.get(normalized) ?? 0,

      isProtectedWord: never,
      nearProperNoun: looksProperNoun(prev?.w.text ?? null) || looksProperNoun(next?.w.text ?? null),

      lexicon,
    });
  }

  return out;
}

function round3(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

/** Human-readable evidence dump for `--analyze-filler-candidates`. */
export function formatEvidenceTable(rows: FillerEvidence[]): string {
  if (rows.length === 0) return 'No filler candidates found.';
  const head = [
    'idx', 'token', 'lex', 'dur', 'conf', 'gapB', 'gapA', 'qB', 'qA', 'voiced', 'elong', 'run', 'phrase/total', 'pos',
  ];
  const body = rows.map((r) => [
    String(r.index),
    r.originalToken,
    r.lexicon,
    r.durationSec.toFixed(2),
    r.asrConfidence.toFixed(2),
    r.gapBeforeSec.toFixed(2),
    r.gapAfterSec.toFixed(2),
    r.audioAvailable ? r.measuredQuietBeforeSec.toFixed(2) : '-',
    r.audioAvailable ? r.measuredQuietAfterSec.toFixed(2) : '-',
    r.audioAvailable ? r.voicedRatio.toFixed(2) : '-',
    r.isElongated ? 'yes' : '',
    String(r.repetitionRun),
    `${r.phraseOccurrences}/${r.totalOccurrences}`,
    r.position,
  ]);
  const widths = head.map((h, c) =>
    Math.max(h.length, ...body.map((row) => [...row[c]!].length)));
  const line = (cells: string[]) =>
    cells.map((c, n) => c.padEnd(widths[n]!)).join('  ').trimEnd();
  return [line(head), line(widths.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}
