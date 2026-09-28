import type { ClipCandidate, Transcript, Word } from '../types.js';

/**
 * Long-form → shorts: find the moments worth clipping.
 *
 * ⚠️ THE BIGGEST UNVALIDATED ASSUMPTION IN THIS CODEBASE.
 *
 * "What makes a viral moment" is learned overwhelmingly from English-language
 * content. There is no good evidence it transfers to Hindi/Telugu/Kannada creator
 * content, where hook structure, humour, and pacing conventions differ. The score
 * this returns is a HYPOTHESIS until you validate it.
 *
 * How to validate, before you build UI on top of it:
 *   1. Take 20 long-form videos in your target languages.
 *   2. Have 2-3 native-speaker creators mark the moments THEY would clip.
 *   3. Run this. Measure overlap.
 *   4. If agreement is poor, the fix is usually the prompt (language-specific
 *      guidance, few-shot examples in-language), not the model.
 *
 * Ship the review UI regardless — users should always see candidates and pick,
 * never receive an auto-published clip. Same principle as Auto Trim.
 */

export interface ClipFinderOptions {
  minDurationSec: number;
  maxDurationSec: number;
  maxCandidates: number;
  /** Words per chunk sent to the LLM. Long transcripts must be chunked. */
  chunkWords: number;
  /** Overlap between chunks so a moment on a boundary isn't missed. */
  chunkOverlapWords: number;
  language?: string;
}

export const DEFAULT_CLIP_OPTIONS: ClipFinderOptions = {
  minDurationSec: 15,
  maxDurationSec: 90,
  maxCandidates: 8,
  chunkWords: 1200,
  chunkOverlapWords: 150,
};

/** Injected so this module has no hard dependency on any specific LLM vendor. */
export type LlmComplete = (prompt: string) => Promise<string>;

export interface TranscriptChunk {
  words: Word[];
  startIndex: number;
  start: number;
  end: number;
  /** Word-indexed text given to the LLM, so it can reference positions back to us. */
  numberedText: string;
}

/** Split a long transcript into overlapping chunks that fit an LLM context. */
export function chunkTranscript(
  transcript: Transcript,
  opts: Pick<ClipFinderOptions, 'chunkWords' | 'chunkOverlapWords'>,
): TranscriptChunk[] {
  const words = transcript.words.filter((w) => w.type === 'word' && w.keep !== false);
  if (words.length === 0) return [];

  const step = Math.max(1, opts.chunkWords - opts.chunkOverlapWords);
  const chunks: TranscriptChunk[] = [];

  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + opts.chunkWords);
    if (slice.length === 0) break;
    chunks.push({
      words: slice,
      startIndex: i,
      start: slice[0]!.start,
      end: slice[slice.length - 1]!.end,
      numberedText: slice.map((w, k) => `[${i + k}]${w.text}`).join(' '),
    });
    if (i + opts.chunkWords >= words.length) break;
  }
  return chunks;
}

export function buildClipPrompt(chunk: TranscriptChunk, opts: ClipFinderOptions): string {
  const lang = opts.language ?? 'the source language';
  return `You are helping a video editor find self-contained moments in a long-form video worth cutting into short vertical clips.

The transcript below is in ${lang}. Each word is prefixed with its index like [42]word.

RULES
- A good clip is SELF-CONTAINED: it makes sense to someone who has not seen the rest of the video.
- It must start at a natural beginning (a question, a claim, a story opening) — never mid-sentence.
- Duration must be between ${opts.minDurationSec} and ${opts.maxDurationSec} seconds.
- Judge by the conventions of ${lang} content, not English content. Do not assume English hook structure.
- Prefer moments with a clear hook, a strong opinion, a surprising fact, a story with a payoff, or a practical tip.
- If nothing in this section qualifies, return an empty array. Do NOT pad the list.

Return ONLY valid JSON, no prose, in this exact shape:
{"clips":[{"startIndex":<int>,"endIndex":<int>,"score":<0-100>,"title":"<short hook title in ${lang}>","reason":"<one sentence, why this works>"}]}

score: how likely this stands alone and holds attention. Be harsh — most sections are not clip-worthy. Reserve 80+ for genuinely strong moments.

TRANSCRIPT
${chunk.numberedText}`;
}

/** Parse the LLM response back into candidates with real timings. */
export function parseClipResponse(
  raw: string,
  transcript: Transcript,
  opts: ClipFinderOptions,
): ClipCandidate[] {
  const words = transcript.words.filter((w) => w.type === 'word' && w.keep !== false);

  // LLMs wrap JSON in prose or code fences no matter how firmly you ask.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed: { clips?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }

  const out: ClipCandidate[] = [];
  for (const c of parsed.clips ?? []) {
    const si = Number(c.startIndex);
    const ei = Number(c.endIndex);
    if (!Number.isFinite(si) || !Number.isFinite(ei)) continue;

    // Clamp indices before using them anywhere — Array.slice treats a negative
    // start as "from the end", so an out-of-range LLM index must never reach
    // .slice() unclamped, or the excerpt silently pulls text from the wrong
    // part of the transcript.
    const ai = Math.max(0, Math.min(si, words.length - 1));
    const bi = Math.max(0, Math.min(ei, words.length - 1));
    const a = words[ai];
    const b = words[bi];
    if (!a || !b || b.end <= a.start) continue;

    const dur = b.end - a.start;
    // Enforce duration bounds here rather than trusting the model — it will
    // return out-of-range clips regardless of what the prompt says.
    if (dur < opts.minDurationSec || dur > opts.maxDurationSec) continue;

    out.push({
      start: a.start,
      end: b.end,
      score: clampScore(Number(c.score)),
      title: String(c.title ?? '').slice(0, 120) || 'Untitled clip',
      reason: String(c.reason ?? '').slice(0, 400),
      transcriptExcerpt: words
        .slice(Math.min(ai, bi), Math.max(ai, bi) + 1)
        .map((w) => w.text)
        .join(' ')
        .slice(0, 600),
    });
  }
  return out;
}

/** Overlapping chunks produce duplicate candidates; keep the highest-scoring. */
export function dedupeCandidates(cands: ClipCandidate[], overlapTolerance = 0.5): ClipCandidate[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const kept: ClipCandidate[] = [];

  for (const c of sorted) {
    const clashes = kept.some((k) => {
      const overlap = Math.min(c.end, k.end) - Math.max(c.start, k.start);
      if (overlap <= 0) return false;
      const shorter = Math.min(c.end - c.start, k.end - k.start);
      return overlap / shorter > overlapTolerance;
    });
    if (!clashes) kept.push(c);
  }
  return kept;
}

/** Full pipeline: chunk → prompt → parse → dedupe → top N. */
export async function findClips(
  transcript: Transcript,
  complete: LlmComplete,
  options: Partial<ClipFinderOptions> = {},
): Promise<ClipCandidate[]> {
  const opts = { ...DEFAULT_CLIP_OPTIONS, ...options, language: options.language ?? transcript.language };
  const chunks = chunkTranscript(transcript, opts);

  const all: ClipCandidate[] = [];
  for (const chunk of chunks) {
    try {
      const raw = await complete(buildClipPrompt(chunk, opts));
      all.push(...parseClipResponse(raw, transcript, opts));
    } catch {
      // One bad chunk shouldn't sink the whole job — a partial clip list is
      // still useful to the user.
      continue;
    }
  }

  return dedupeCandidates(all)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxCandidates);
}

/**
 * Rule-based clip finder — used when no LLM API key is available.
 *
 * Scans the transcript for self-contained windows between natural pauses,
 * scores them with lightweight heuristics (hooks, questions, density), and
 * returns the top candidates. Not a substitute for LLM scoring, but far
 * better than an empty list when ANTHROPIC_API_KEY is unset.
 */
export function scoreTranscriptSegments(
  transcript: Transcript,
  options: Partial<ClipFinderOptions> = {},
): ClipCandidate[] {
  const opts = { ...DEFAULT_CLIP_OPTIONS, ...options };
  const words = transcript.words.filter((w) => w.type === 'word' && w.keep !== false);
  if (words.length < 8) return [];

  const HOOK_RE =
    /\b(how|why|secret|tip|never|always|mistake|truth|hack|learn|stop|start|best|worst|must|should|don't|dont|matlab|kaise|kyun|raaz|galati)\b/i;
  const QUESTION_RE = /[?？؟]$/;
  const EXCLAIM_RE = /[!！]$/;
  const SENTENCE_END = /[.!?।॥؟]$/;

  // Candidate windows: start at sentence boundaries / long gaps, grow until
  // duration hits max, then score.
  const starts: number[] = [0];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!;
    const cur = words[i]!;
    const gap = cur.start - prev.end;
    if (gap >= 0.55 || SENTENCE_END.test(prev.text.trim())) starts.push(i);
  }

  const cands: ClipCandidate[] = [];
  for (const si of starts) {
    const a = words[si]!;
    // Find the furthest end index still within maxDuration.
    let bi = si;
    for (let j = si; j < words.length; j++) {
      if (words[j]!.end - a.start > opts.maxDurationSec) break;
      bi = j;
    }
    const b = words[bi]!;
    const dur = b.end - a.start;
    if (dur < opts.minDurationSec) continue;

    // Prefer ending on a sentence boundary when possible.
    let endIdx = bi;
    for (let j = bi; j > si; j--) {
      if (SENTENCE_END.test(words[j]!.text.trim())) {
        if (words[j]!.end - a.start >= opts.minDurationSec) {
          endIdx = j;
          break;
        }
      }
    }
    const endWord = words[endIdx]!;
    const slice = words.slice(si, endIdx + 1);
    const text = slice.map((w) => w.text).join(' ');
    const lower = text.toLowerCase();

    let score = 40;
    if (HOOK_RE.test(lower)) score += 18;
    if (slice.some((w) => QUESTION_RE.test(w.text))) score += 14;
    if (slice.some((w) => EXCLAIM_RE.test(w.text))) score += 6;
    // Prefer mid-length clips (~30–55s).
    const ideal = 40;
    score += Math.max(0, 12 - Math.abs((endWord.end - a.start) - ideal) / 4);
    // Density: denser speech tends to hold attention better than sparse.
    const density = slice.length / Math.max(endWord.end - a.start, 1);
    if (density > 2.2) score += 8;
    if (density < 1.0) score -= 8;
    // Opening after a pause is a natural hook point.
    if (si > 0 && a.start - words[si - 1]!.end >= 0.7) score += 6;

    const title = slice
      .slice(0, 8)
      .map((w) => w.text)
      .join(' ')
      .slice(0, 80) || 'Untitled clip';

    cands.push({
      start: a.start,
      end: endWord.end,
      score: clampScore(score),
      title,
      reason: 'Rule-based candidate (no LLM key) — review before exporting.',
      transcriptExcerpt: text.slice(0, 600),
    });
  }

  return dedupeCandidates(cands)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxCandidates);
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}
