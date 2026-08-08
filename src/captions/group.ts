import type { CaptionCue, CaptionStyle, Transcript, Word } from '../types.js';

export const DEFAULT_STYLE: CaptionStyle = {
  fontFamily: 'Poppins',
  fontSizePx: 72,
  primaryColor: '#FFFFFF',
  activeColor: '#FFD400',
  outlineColor: '#000000',
  outlineWidthPx: 6,
  // 0.72 keeps captions clear of Instagram's bottom UI (username, caption,
  // action buttons) while staying below centre. Reels safe-area, empirically.
  positionY: 0.72,
  uppercase: false,
  maxWordsPerCue: 4,
  maxCharsPerLine: 22,
};

export interface GroupOptions {
  maxWordsPerCue: number;
  maxCharsPerLine: number;
  /** Start a new cue when the gap between words exceeds this (seconds). */
  gapBreakSec: number;
  /** Start a new cue after sentence-ending punctuation. */
  breakOnSentenceEnd: boolean;
  /** Cues shorter than this get extended, so text doesn't flash unreadably. */
  minCueDurationSec: number;
}

export const DEFAULT_GROUP_OPTIONS: GroupOptions = {
  maxWordsPerCue: 4,
  maxCharsPerLine: 22,
  gapBreakSec: 0.45,
  breakOnSentenceEnd: true,
  minCueDurationSec: 0.4,
};

// Includes Devanagari danda (।॥) — a sentence break in Hindi/Marathi that plain
// /[.!?]/ misses entirely, producing run-on cues in Indic text.
const SENTENCE_END = /[.!?।॥]$/;

/**
 * Group word-timed transcript into on-screen caption cues.
 *
 * Short-form convention is 3-5 words at a time, not full sentences — the text
 * must be readable in a fast scroll. Breaks are placed at natural pauses and
 * sentence ends first, then forced by the word/char limits.
 */
export function groupIntoCues(
  transcript: Transcript,
  options: Partial<GroupOptions> = {},
): CaptionCue[] {
  const opts = { ...DEFAULT_GROUP_OPTIONS, ...options };

  const words = transcript.words.filter(
    (w) => w.type === 'word' && w.keep !== false && w.text.trim() !== '',
  );
  if (words.length === 0) return [];

  const cues: CaptionCue[] = [];
  let buf: Word[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    const start = buf[0]!.start;
    let end = buf[buf.length - 1]!.end;
    if (end - start < opts.minCueDurationSec) end = start + opts.minCueDurationSec;
    cues.push({
      index: cues.length,
      start,
      end,
      words: buf,
      text: buf.map((w) => w.text).join(' '),
    });
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    buf.push(w);

    const next = words[i + 1];
    if (!next) break;

    const gap = next.start - w.end;
    const wouldExceedWords = buf.length >= opts.maxWordsPerCue;
    const wouldExceedChars =
      buf.map((b) => b.text).join(' ').length + 1 + next.text.length > opts.maxCharsPerLine;
    const sentenceEnd = opts.breakOnSentenceEnd && SENTENCE_END.test(w.text.trim());

    if (gap >= opts.gapBreakSec || wouldExceedWords || wouldExceedChars || sentenceEnd) {
      flush();
    }
  }
  flush();

  // Prevent overlap: a cue extended by minCueDurationSec can run into the next.
  for (let i = 0; i < cues.length - 1; i++) {
    const cur = cues[i]!;
    const next = cues[i + 1]!;
    if (cur.end > next.start) cur.end = next.start;
  }

  return cues;
}

/** Wrap a cue's text to at most `maxLines` lines, balancing line lengths. */
export function wrapCueText(cue: CaptionCue, maxCharsPerLine: number, maxLines = 2): string[] {
  const words = cue.words.map((w) => w.text);
  const lines: string[] = [];
  let cur = '';

  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);

  // Overflow beyond maxLines gets folded into the last line rather than dropped —
  // silently losing words is far worse than a slightly long line.
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).join(' '));
    return head;
  }
  return lines;
}
