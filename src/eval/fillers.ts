import { autoTrim, DEFAULT_TRIM_OPTIONS, type TrimOptions } from '../autotrim/index.js';
import type { Transcript } from '../types.js';

/**
 * Filler detection precision and recall against a hand-labelled fixture.
 *
 * Precision and recall are reported separately and never averaged into an
 * F-score here, because the two failures are not equally bad for this product.
 *
 *   Recall miss     → a filler survives. The video is slightly less tight.
 *   Precision miss  → a real word is deleted. The sentence is broken and the
 *                     creator may not notice until it is published.
 *
 * Anything that trades precision for recall is the wrong trade, so the report
 * lists every false positive by name rather than folding it into a number.
 */

export interface LabelledWord {
  text: string;
  start: number;
  end: number;
  /** True when a human says this token should be cut. */
  isFiller: boolean;
  confidence?: number;
}

export interface FillerFixture {
  name: string;
  language: string;
  durationSec: number;
  words: LabelledWord[];
}

export interface FillerScore {
  fixture: string;
  language: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when nothing was proposed — precision is undefined, not 1. */
  precision: number | null;
  /** null when the fixture labels no fillers — recall is undefined, not 1. */
  recall: number | null;
  /** Real words that were cut. The list that matters most. */
  falsePositiveWords: string[];
  /** Fillers that survived. */
  missedWords: string[];
}

/**
 * Score one fixture.
 *
 * Only word-level cuts count. Silence cuts remove no labelled token and are
 * scored elsewhere; including them here would inflate precision with cuts the
 * fixture never had an opinion about.
 */
export function scoreFillerFixture(
  fixture: FillerFixture,
  options: Partial<TrimOptions> = {},
): FillerScore {
  const transcript = {
    language: fixture.language,
    provider: 'fixture',
    duration: fixture.durationSec,
    hasWordTimings: true,
    words: fixture.words.map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: w.confidence ?? 0.97,
      type: 'word' as const,
    })),
  } as unknown as Transcript;

  const trim = autoTrim(transcript, { ...DEFAULT_TRIM_OPTIONS, ...options });

  const cutIndices = new Set<number>();
  for (const c of trim.cuts) {
    if (c.restored) continue;
    // Silence cuts have no opinion about a labelled token.
    if (c.reason === 'silence') continue;
    for (const i of c.wordIndices) cutIndices.add(i);
  }

  let tp = 0, fp = 0, fn = 0;
  const falsePositiveWords: string[] = [];
  const missedWords: string[] = [];

  fixture.words.forEach((w, i) => {
    const cut = cutIndices.has(i);
    if (cut && w.isFiller) tp++;
    else if (cut && !w.isFiller) { fp++; falsePositiveWords.push(w.text); }
    else if (!cut && w.isFiller) { fn++; missedWords.push(w.text); }
  });

  const proposed = tp + fp;
  const labelled = tp + fn;
  return {
    fixture: fixture.name,
    language: fixture.language,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: proposed === 0 ? null : tp / proposed,
    recall: labelled === 0 ? null : tp / labelled,
    falsePositiveWords,
    missedWords,
  };
}

export interface AggregateFillerScore {
  fixtures: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  falsePositiveWords: string[];
  missedWords: string[];
  perFixture: FillerScore[];
}

/** Pool counts across fixtures. Micro-averaged, so a big fixture weighs more. */
export function aggregateFillerScores(scores: FillerScore[]): AggregateFillerScore {
  const tp = scores.reduce((n, s) => n + s.truePositives, 0);
  const fp = scores.reduce((n, s) => n + s.falsePositives, 0);
  const fn = scores.reduce((n, s) => n + s.falseNegatives, 0);
  return {
    fixtures: scores.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    falsePositiveWords: scores.flatMap((s) => s.falsePositiveWords),
    missedWords: scores.flatMap((s) => s.missedWords),
    perFixture: scores,
  };
}
