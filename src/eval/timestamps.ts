import type { Transcript, TrimResult } from '../types.js';

/**
 * Timestamp drift introduced by our own pipeline.
 *
 * This deliberately does NOT measure ASR timestamp accuracy. That needs
 * human-aligned word boundaries, which no amount of engineering can
 * manufacture — see docs/EVALUATION.md.
 *
 * What it measures is narrower and fully checkable: given a transcript, does
 * each of our stages move a word off the time the ASR put it at? For
 * transliteration the answer must be exactly zero — same audio, same
 * boundaries, only spelling. For Auto Trim the answer must match the
 * analytically predicted shift, to the millisecond.
 *
 * A caption that is 200 ms late looks like a broken captioner to a viewer. It
 * is usually a trim-arithmetic bug, and this is what catches it.
 */

export interface DriftReport {
  /** Words compared. */
  count: number;
  /** Largest absolute difference, seconds. */
  maxAbsSec: number;
  /** Mean absolute difference, seconds. */
  meanAbsSec: number;
  /** Words whose start or end moved at all. */
  moved: number;
  /** Worst offenders, for the report. */
  worst: Array<{ index: number; text: string; deltaStartSec: number; deltaEndSec: number }>;
}

const EMPTY: DriftReport = { count: 0, maxAbsSec: 0, meanAbsSec: 0, moved: 0, worst: [] };

/**
 * Compare two transcripts word-for-word.
 *
 * Requires equal word counts: a stage that changes the number of words has
 * broken the alignment invariant outright, which is a different and larger
 * failure than drift, so it throws rather than silently scoring something.
 */
export function measureDrift(before: Transcript, after: Transcript): DriftReport {
  if (before.words.length !== after.words.length) {
    throw new Error(
      `Word count changed (${before.words.length} → ${after.words.length}); ` +
        `timings cannot be compared. This is an alignment failure, not drift.`,
    );
  }
  if (before.words.length === 0) return EMPTY;

  let sum = 0;
  let max = 0;
  let moved = 0;
  const deltas: Array<{ index: number; text: string; deltaStartSec: number; deltaEndSec: number }> = [];

  for (let i = 0; i < before.words.length; i++) {
    const a = before.words[i]!;
    const b = after.words[i]!;
    const ds = b.start - a.start;
    const de = b.end - a.end;
    const worst = Math.max(Math.abs(ds), Math.abs(de));
    sum += worst;
    if (worst > max) max = worst;
    if (worst > 1e-9) {
      moved++;
      deltas.push({ index: i, text: b.text, deltaStartSec: round4(ds), deltaEndSec: round4(de) });
    }
  }

  deltas.sort((x, y) => Math.abs(y.deltaStartSec) - Math.abs(x.deltaStartSec));
  return {
    count: before.words.length,
    maxAbsSec: round4(max),
    meanAbsSec: round4(sum / before.words.length),
    moved,
    worst: deltas.slice(0, 5),
  };
}

export interface TrimDriftReport extends DriftReport {
  /** Words the trim kept and therefore re-timed. */
  keptWords: number;
  /** Words where the observed shift differs from the predicted shift. */
  mispredicted: number;
}

/**
 * Verify Auto Trim's re-timing against the arithmetic it should follow.
 *
 * A surviving word must move back by exactly the total duration of the active
 * cuts that end before it. Anything else is a bug in `shiftTime`, and it shows
 * up as captions drifting further out of sync the further into the video you
 * get — the failure that is hardest to notice while developing and most
 * obvious to a viewer.
 */
export function measureTrimDrift(
  original: Transcript,
  trimmed: Transcript,
  trim: TrimResult,
): TrimDriftReport {
  if (original.words.length !== trimmed.words.length) {
    throw new Error(
      `Word count changed (${original.words.length} → ${trimmed.words.length}). ` +
        `applyTrim must mark words keep:false, never remove them.`,
    );
  }

  const active = trim.cuts.filter((c) => !c.restored).sort((a, b) => a.start - b.start);
  const expectedShift = (t: number): number => {
    let shift = 0;
    for (const c of active) {
      if (c.end <= t) shift += c.end - c.start;
      else if (c.start < t && t < c.end) shift += t - c.start;
    }
    return shift;
  };

  let kept = 0, mispredicted = 0, sum = 0, max = 0;
  const worst: TrimDriftReport['worst'] = [];

  for (let i = 0; i < original.words.length; i++) {
    const o = original.words[i]!;
    const t = trimmed.words[i]!;
    if (t.keep === false) continue;
    kept++;

    const predictedStart = Math.max(o.start - expectedShift(o.start), 0);
    const predictedEnd = Math.max(o.end - expectedShift(o.end), 0);
    // 1 ms tolerance: timings are rounded to milliseconds on the way through.
    const ds = t.start - predictedStart;
    const de = t.end - predictedEnd;
    const err = Math.max(Math.abs(ds), Math.abs(de));

    sum += err;
    if (err > max) max = err;
    if (err > 0.0011) {
      mispredicted++;
      worst.push({ index: i, text: t.text, deltaStartSec: round4(ds), deltaEndSec: round4(de) });
    }
  }

  worst.sort((x, y) => Math.abs(y.deltaStartSec) - Math.abs(x.deltaStartSec));
  return {
    count: original.words.length,
    keptWords: kept,
    mispredicted,
    maxAbsSec: round4(max),
    meanAbsSec: kept === 0 ? 0 : round4(sum / kept),
    moved: mispredicted,
    worst: worst.slice(0, 5),
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
