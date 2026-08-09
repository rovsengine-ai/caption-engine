import type { CaptionCue, CaptionStyle } from '../types.js';

/**
 * Caption readability, measured against the style's own budget.
 *
 * These are not aesthetic judgements. They are the constraints the style
 * already declares — `maxCharsPerLine`, `maxWordsPerCue` — checked against what
 * the grouper actually emitted. A cue that overflows its own budget will either
 * wrap unexpectedly or run past the safe margin, and neither is visible in a
 * unit test that only asserts the text is correct.
 *
 * Reading rate is included because it is the one readability property that no
 * amount of layout fixes: a cue held for 0.3 s cannot be read regardless of how
 * neatly it is set. 20 characters/second is the widely used subtitling ceiling
 * (BBC and Netflix both sit near it); it is a guideline, not physics, so it is
 * reported rather than enforced.
 */

export const MAX_READING_RATE_CPS = 20;
/** Below this, a cue flashes past even if it is short. */
export const MIN_CUE_DURATION_SEC = 0.5;

export interface CueMetric {
  index: number;
  text: string;
  durationSec: number;
  chars: number;
  words: number;
  lines: number;
  longestLineChars: number;
  charsPerSecond: number;
  problems: string[];
}

export interface ReadabilityReport {
  cues: number;
  /** Cues with at least one problem. */
  flagged: number;
  meanCharsPerCue: number;
  meanWordsPerCue: number;
  meanCharsPerSecond: number;
  p95CharsPerSecond: number;
  overLineBudget: number;
  overWordBudget: number;
  tooFast: number;
  tooShort: number;
  worst: CueMetric[];
}

/**
 * Split a cue into rendered lines the same way the renderer would: greedy
 * wrapping at `maxCharsPerLine`. A word longer than the budget occupies its own
 * line rather than being broken, matching the renderer's behaviour.
 */
export function wrapLines(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (maxCharsPerLine <= 0) return [words.join(' ')];

  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur === '') { cur = w; continue; }
    if (cur.length + 1 + w.length <= maxCharsPerLine) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

export function measureCue(cue: CaptionCue, style: CaptionStyle, maxLines = 2): CueMetric {
  const text = cue.text.trim();
  const durationSec = Math.max(cue.end - cue.start, 0);
  const chars = Array.from(text).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = wrapLines(text, style.maxCharsPerLine);
  const longest = lines.reduce((n, l) => Math.max(n, Array.from(l).length), 0);
  const cps = durationSec > 0 ? chars / durationSec : Infinity;

  const problems: string[] = [];
  if (longest > style.maxCharsPerLine) {
    problems.push(`line of ${longest} chars exceeds maxCharsPerLine ${style.maxCharsPerLine}`);
  }
  if (lines.length > maxLines) problems.push(`${lines.length} lines exceeds ${maxLines}`);
  if (words > style.maxWordsPerCue) {
    problems.push(`${words} words exceeds maxWordsPerCue ${style.maxWordsPerCue}`);
  }
  if (Number.isFinite(cps) && cps > MAX_READING_RATE_CPS) {
    problems.push(`${cps.toFixed(1)} chars/sec exceeds ${MAX_READING_RATE_CPS}`);
  }
  if (durationSec > 0 && durationSec < MIN_CUE_DURATION_SEC) {
    problems.push(`on screen for ${durationSec.toFixed(2)}s`);
  }

  return {
    index: cue.index,
    text,
    durationSec: round3(durationSec),
    chars,
    words,
    lines: lines.length,
    longestLineChars: longest,
    charsPerSecond: Number.isFinite(cps) ? round3(cps) : 0,
    problems,
  };
}

export function measureReadability(
  cues: CaptionCue[],
  style: CaptionStyle,
  maxLines = 2,
): ReadabilityReport {
  const metrics = cues.map((c) => measureCue(c, style, maxLines));
  if (metrics.length === 0) {
    return {
      cues: 0, flagged: 0, meanCharsPerCue: 0, meanWordsPerCue: 0,
      meanCharsPerSecond: 0, p95CharsPerSecond: 0,
      overLineBudget: 0, overWordBudget: 0, tooFast: 0, tooShort: 0, worst: [],
    };
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rates = metrics.map((m) => m.charsPerSecond).sort((a, b) => a - b);
  // Nearest-rank p95; with few cues this is simply the slowest-but-one.
  const p95 = rates[Math.min(rates.length - 1, Math.ceil(0.95 * rates.length) - 1)] ?? 0;

  return {
    cues: metrics.length,
    flagged: metrics.filter((m) => m.problems.length > 0).length,
    meanCharsPerCue: round3(mean(metrics.map((m) => m.chars))),
    meanWordsPerCue: round3(mean(metrics.map((m) => m.words))),
    meanCharsPerSecond: round3(mean(metrics.map((m) => m.charsPerSecond))),
    p95CharsPerSecond: round3(p95),
    overLineBudget: metrics.filter((m) => m.longestLineChars > style.maxCharsPerLine).length,
    overWordBudget: metrics.filter((m) => m.words > style.maxWordsPerCue).length,
    tooFast: metrics.filter((m) => m.charsPerSecond > MAX_READING_RATE_CPS).length,
    tooShort: metrics.filter((m) => m.durationSec > 0 && m.durationSec < MIN_CUE_DURATION_SEC).length,
    worst: metrics.filter((m) => m.problems.length > 0)
      .sort((a, b) => b.problems.length - a.problems.length || b.charsPerSecond - a.charsPerSecond)
      .slice(0, 5),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
