/**
 * Pass 2 of Auto Trim: weigh the evidence, return a verdict. Measure nothing.
 *
 * The governing rule, and the reason this file is separate from analysis.ts:
 * **no single signal may authorise a cut.** Every one of them has a failure
 * mode that fires confidently on correct speech —
 *
 *   lexicon match       "matlab" and "ante" are ordinary words meaning "that is"
 *   long pause after    a dramatic beat mid-sentence
 *   low ASR confidence  any accented or code-switched word
 *   short duration      most function words
 *   elongation          a sung or emphasised syllable
 *
 * Requiring agreement between independent signals is what turns a list lookup
 * into a decision. "Independent" is doing real work here: the measured quiet
 * from the waveform and the gap between ASR words are NOT independent — they
 * describe the same silence — so they count once, not twice.
 *
 * Three outcomes, never two. `review-required` exists because the honest answer
 * to "should this go?" is often "a human should look". Collapsing that into
 * either keep or cut is how a trimmer earns its reputation for eating words.
 */

import type { FillerEvidence } from './analysis.js';

export type CutDecision = 'keep' | 'propose-cut' | 'review-required';

/** One named piece of support for cutting, with the weight it carries. */
export interface Signal {
  name: string;
  weight: number;
  detail: string;
}

export interface FillerVerdict {
  evidence: FillerEvidence;
  decision: CutDecision;
  /** 0..1, derived from the signals below. Deterministic, not learned. */
  confidence: number;
  /** One sentence a reviewer can act on. */
  reason: string;
  signals: Signal[];
  /** Set when something structurally forbade the cut. */
  blockedBy?: string;
}

export interface DecideOptions {
  minFillerDurationSec: number;
  maxFillerDurationSec: number;
  /** Measured or ASR quiet at or above this corroborates hesitation. */
  pauseWindowSec: number;
  /** ASR confidence below this is weak evidence the token was not a real word. */
  lowConfidence: number;
  /** Verdicts below this confidence are downgraded from propose-cut to review. */
  minAutoCutConfidence: number;
}

export const DEFAULT_DECIDE_OPTIONS: DecideOptions = {
  minFillerDurationSec: 0.06,
  maxFillerDurationSec: 2.0,
  pauseWindowSec: 0.35,
  lowConfidence: 0.5,
  minAutoCutConfidence: 0.6,
};

/**
 * Confidence for an unambiguous (`always`-tier) filler.
 *
 * These numbers are NOT new. They are the scale this project already published
 * through `--min-cut-confidence`, the review UI's sort order, and the
 * evaluation harness. Pass 2 gates cuts and adds verdicts; it deliberately does
 * not renumber the scale underneath features that already depend on it.
 */
const ALWAYS_CONFIDENCE = 0.95;

/** Ambiguous filler: starts low, rises with corroborating pause, capped at 0.85. */
function ambiguousConfidence(pauseSec: number, windowSec: number): number {
  if (windowSec <= 0) return 0.6;
  const overshoot = Math.min(1, (pauseSec - windowSec) / windowSec);
  return Math.min(0.85, 0.55 + 0.3 * Math.max(0, overshoot));
}

/**
 * Elongated non-lexicon token ("aaa", "aaaaa") — the case Pass 1 exists for.
 *
 * Sits between the two established tiers: more certain than a real word cut on
 * pause evidence, less certain than a listed grunt, because the ASR invented
 * this spelling and we are inferring from its shape alone. Capped at 0.9.
 */
function elongatedConfidence(pauseSec: number, windowSec: number, stretched: boolean): number {
  let c = 0.7;
  if (windowSec > 0 && pauseSec >= windowSec) c += 0.12;
  if (stretched) c += 0.08;
  return Math.round(Math.min(0.9, c) * 1000) / 1000;
}

export function decideFiller(
  e: FillerEvidence,
  options: Partial<DecideOptions> = {},
): FillerVerdict {
  const opts = { ...DEFAULT_DECIDE_OPTIONS, ...options };
  const signals: Signal[] = [];

  // ---- Structural blocks. These end the decision; no evidence overrides. ----

  if (e.isProtectedWord) {
    return blocked(e, signals, `"${e.originalToken}" is in the never-cut list for ${e.language}`,
      'protected-word');
  }

  // "aaa" is elongated and collapses to "a"; a bare "a" is not elongated. That
  // one bit is the entire difference between a drawl and an English article,
  // and it is checked before anything else can build a case for a cut.
  if (!e.isElongated && e.lexicon === 'none') {
    return keep(e, signals, 'not in any filler lexicon and not elongated');
  }

  if (e.nearProperNoun) {
    return blocked(e, signals, `adjacent to a probable proper noun ("${e.prevWord ?? e.nextWord}")`,
      'near-proper-noun');
  }

  if (e.durationSec > opts.maxFillerDurationSec) {
    return blocked(e, signals,
      `held ${e.durationSec.toFixed(2)}s, longer than any hesitation should run`,
      'too-long');
  }

  // Deliberate repetition of a real word is emphasis ("bahut bahut dhanyavaad").
  // Repetition of a noise is stuttering, which IS a filler — so this only
  // blocks when the repeated token is not itself a non-word.
  if (e.repetitionRun > 1 && !e.isElongated && e.lexicon !== 'always') {
    return blocked(e, signals,
      `repeated ${e.repetitionRun}× with no elongation — reads as emphasis, not hesitation`,
      'intentional-repetition');
  }

  // NOT a block: whether the token appears mid-phrase ELSEWHERE says nothing
  // about this instance. "matlab" is a word in "iska matlab hai" and a
  // hesitation two sentences later; vetoing on the corpus count throws away the
  // hesitation to protect the word. Which instance is which is decided per
  // instance, by the pause test in Tier 3 below. `phraseOccurrences` stays on
  // the evidence record for diagnostics, where it is genuinely informative.
  if (e.phraseOccurrences > 0 && e.lexicon === 'ambiguous') {
    signals.push({
      name: 'used-as-word-elsewhere',
      weight: 0,
      detail: `also appears mid-phrase ${e.phraseOccurrences}× in this transcript`,
    });
  }

  // ---- Supporting signals, recorded for diagnostics on every verdict. ----

  if (e.lexicon === 'always') {
    signals.push({ name: 'lexicon-always', weight: 0.45, detail: 'listed as a non-word hesitation' });
  }
  if (e.lexicon === 'ambiguous') {
    signals.push({ name: 'lexicon-ambiguous', weight: 0.25, detail: 'a real word also used as a filler' });
  }
  if (e.isElongated) {
    signals.push({
      name: 'elongated',
      weight: 0.4,
      detail: `run of 3+ identical characters ("${e.originalToken}" → "${e.collapsedToken}")`,
    });
  }

  // Pause evidence. Measured audio and ASR gaps describe the SAME silence, so
  // they are one signal, not two — whichever is available, counted once.
  // Measured wins when present because an ASR gap is only the absence of a
  // label, which a breath or a failed recognition produces just as readily.
  const measuredPause = Math.max(e.measuredQuietBeforeSec, e.measuredQuietAfterSec);
  const asrPause = Math.max(e.gapBeforeSec, e.gapAfterSec);
  if (e.audioAvailable && measuredPause >= opts.pauseWindowSec) {
    signals.push({
      name: 'measured-pause',
      weight: 0.3,
      detail: `${measuredPause.toFixed(2)}s of measured silence adjacent`,
    });
  } else if (!e.audioAvailable && asrPause >= opts.pauseWindowSec) {
    signals.push({
      name: 'asr-gap',
      weight: 0.18, // weaker: an ASR gap is not a measurement
      detail: `${asrPause.toFixed(2)}s gap between ASR words (unmeasured)`,
    });
  }

  if (e.asrConfidence < opts.lowConfidence) {
    signals.push({
      name: 'low-asr-confidence',
      weight: 0.15,
      detail: `ASR ${(e.asrConfidence * 100).toFixed(0)}% — often means it was not a word`,
    });
  }

  if (e.isStretched) {
    signals.push({
      name: 'stretched',
      weight: 0.15,
      detail: `${e.stretchRatio.toFixed(1)}× the median word duration`,
    });
  }

  if (e.phraseOccurrences === 0 && e.totalOccurrences >= 2) {
    signals.push({
      name: 'never-in-phrase',
      weight: 0.12,
      detail: `occurs ${e.totalOccurrences}× and never inside a phrase`,
    });
  }

  // ---- Verdict --------------------------------------------------------------
  //
  // Three tiers, in descending order of how sure we can be about the TOKEN
  // ITSELF. Pause evidence only ever modulates confidence within a tier; it
  // never promotes a token between tiers, because how long the speaker paused
  // says nothing about whether what they said was a word.

  // Measured quiet is preferred over an ASR gap wherever it exists: an ASR gap
  // is the absence of a label, which a breath or a failed recognition produces
  // just as readily as real silence.
  const pause = e.audioAvailable
    ? Math.max(e.measuredQuietBeforeSec, e.measuredQuietAfterSec)
    : Math.max(e.gapBeforeSec, e.gapAfterSec);

  // Tier 1 — a listed non-word. Removing it cannot change meaning, which is the
  // rule that governs membership of `always` (see fillers.ts).
  if (e.lexicon === 'always') {
    if (e.durationSec > 0 && e.durationSec < opts.minFillerDurationSec) {
      return review(e, signals, ALWAYS_CONFIDENCE,
        `listed hesitation but only ${(e.durationSec * 1000).toFixed(0)}ms — may be a clipped word`);
    }
    return propose(e, signals, ALWAYS_CONFIDENCE, 'unambiguous hesitation noise');
  }

  // Tier 2 — elongation. The ASR wrote a run of 3+ identical characters, which
  // no word in any supported language does. This is the "aaa" case: it did not
  // exist before Pass 1, because no lexicon can enumerate every drawl spelling.
  if (e.isElongated) {
    const confidence = elongatedConfidence(pause, opts.pauseWindowSec, e.isStretched);
    if (confidence < opts.minAutoCutConfidence) {
      return review(e, signals, confidence,
        `elongated but weakly corroborated (${confidence.toFixed(2)})`);
    }
    return propose(e, signals, confidence,
      `elongated "${e.originalToken}" — a held sound, not the word "${e.collapsedToken}"`);
  }

  // Tier 3 — a real word also used as a filler. Cut ONLY on corroborating
  // pause, exactly as before this file existed. Without a pause the honest
  // answer is that it is being used as a word, so it is kept rather than
  // pushed into a review list nobody reads.
  if (e.lexicon === 'ambiguous') {
    if (pause < opts.pauseWindowSec) {
      return keep(e, signals,
        `used mid-flow with no pause (${pause.toFixed(2)}s) — reads as a word, not hesitation`);
    }
    const confidence = ambiguousConfidence(pause, opts.pauseWindowSec);
    // Measured silence is stronger evidence than an ASR gap, so an ambiguous
    // cut made without the audio pass is offered for review rather than applied
    // when its confidence is marginal.
    if (!e.audioAvailable && confidence < opts.minAutoCutConfidence) {
      return review(e, signals, confidence,
        'real word, unmeasured pause — rerun without --no-audio-analysis to decide');
    }
    return propose(e, signals, confidence,
      `real word preceded/followed by ${pause.toFixed(2)}s of ${e.audioAvailable ? 'measured ' : ''}pause`);
  }

  return keep(e, signals, 'no tier matched');
}

function keep(e: FillerEvidence, signals: Signal[], reason: string): FillerVerdict {
  return { evidence: e, decision: 'keep', confidence: 0, reason, signals };
}

function blocked(e: FillerEvidence, signals: Signal[], reason: string, blockedBy: string): FillerVerdict {
  return { evidence: e, decision: 'keep', confidence: 0, reason, signals, blockedBy };
}

function review(e: FillerEvidence, signals: Signal[], confidence: number, reason: string): FillerVerdict {
  return { evidence: e, decision: 'review-required', confidence, reason, signals };
}

function propose(e: FillerEvidence, signals: Signal[], confidence: number, reason: string): FillerVerdict {
  return { evidence: e, decision: 'propose-cut', confidence, reason, signals };
}

/** Decide every candidate. */
export function decideFillers(
  evidence: FillerEvidence[],
  options: Partial<DecideOptions> = {},
): FillerVerdict[] {
  return evidence.map((e) => decideFiller(e, options));
}

export interface VerdictSummary {
  total: number;
  keep: number;
  proposeCut: number;
  reviewRequired: number;
}

export function summariseVerdicts(verdicts: FillerVerdict[]): VerdictSummary {
  return {
    total: verdicts.length,
    keep: verdicts.filter((v) => v.decision === 'keep').length,
    proposeCut: verdicts.filter((v) => v.decision === 'propose-cut').length,
    reviewRequired: verdicts.filter((v) => v.decision === 'review-required').length,
  };
}
