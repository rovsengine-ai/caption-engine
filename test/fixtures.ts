import type { Transcript, Word } from '../src/types.js';

/** Build a word with sane defaults. */
export function w(
  text: string,
  start: number,
  end: number,
  extra: Partial<Word> = {},
): Word {
  return { text, start, end, confidence: 0.95, type: 'word', keep: true, ...extra };
}

/**
 * Hinglish fixture — code-switched Hindi/English, the actual target case.
 * Contains, deliberately:
 *  - "matlab" used as a FILLER (after a pause) and as a REAL WORD (mid-sentence)
 *  - an English filler "um"
 *  - a false start ("aaj main" repeated)
 *  - a long silence in the middle
 */
export const hinglishTranscript: Transcript = {
  provider: 'fixture',
  model: 'test',
  hasWordTimings: true,
  language: 'hi',
  duration: 16.0,
  words: [
    w('aaj', 0.50, 0.80),
    w('main', 0.80, 1.10),
    w('aaj', 1.30, 1.60),   // false start: "aaj main" repeated
    w('main', 1.60, 1.90),
    w('aapko', 1.90, 2.30),
    w('ek', 2.30, 2.50),
    w('important', 2.50, 3.10),   // English inside Hindi — must survive
    w('cheez', 3.10, 3.50),
    w('batata', 3.50, 3.90),
    w('hoon.', 3.90, 4.30),
    // pause, then "matlab" as hesitation filler → SHOULD be cut
    w('matlab', 5.00, 5.40),
    w('um', 5.60, 5.80),          // always-filler → SHOULD be cut
    w('ye', 6.00, 6.20),
    w('bahut', 6.20, 6.60),
    w('khaas', 6.60, 7.00),
    w('hai.', 7.00, 7.30),
    // 3s silence here → SHOULD be cut
    w('iska', 10.30, 10.70),
    w('matlab', 10.70, 11.10),    // REAL word ("meaning") mid-flow → must NOT be cut
    w('hai', 11.10, 11.40),
    w('success.', 11.40, 12.00),
  ],
};

/** Telugu fixture — native script, tests Indic filler matching and ASS escaping. */
export const teluguTranscript: Transcript = {
  provider: 'fixture',
  hasWordTimings: true,
  language: 'te',
  duration: 8.0,
  words: [
    w('నేను', 0.20, 0.60),
    w('ఈరోజు', 0.60, 1.10),
    w('అంటే', 1.60, 2.00),   // ambiguous filler after a pause → cut
    w('మీకు', 2.10, 2.50),
    w('చెప్తాను', 2.50, 3.10),
    w('అంటే', 3.10, 3.50),   // mid-flow, no pause → must NOT be cut
    w('ఏంటి', 3.50, 3.90),
  ],
};

/** No speech at all — Auto Trim must degrade gracefully, not crash. */
export const silentTranscript: Transcript = {
  provider: 'fixture',
  hasWordTimings: true,
  language: 'hi',
  duration: 5.0,
  words: [],
};
