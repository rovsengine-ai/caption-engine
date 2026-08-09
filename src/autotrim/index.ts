import type { Cut, CutReason, Transcript, TrimResult, Word } from '../types.js';
import { matchFiller, normaliseToken } from './fillers.js';
import type { AudioAnalysis } from '../media/audio-analysis.js';
import { analyseFillerCandidates } from './analysis.js';
import { decideFillers, type FillerVerdict } from './decide.js';

export * from './fillers.js';
export * from './analysis.js';
export * from './decide.js';

export interface TrimOptions {
  /** Gaps longer than this (seconds) are cut. 0.6-0.9 feels natural; below 0.4 sounds clipped. */
  maxSilenceSec: number;
  /** Leave this much silence in place around speech so cuts don't sound abrupt. */
  paddingSec: number;
  removeFillers: boolean;
  removeFalseStarts: boolean;
  /** Cut words the ASR was unsure about. Off by default — high false-positive rate. */
  removeLowConfidence: boolean;
  lowConfidenceThreshold: number;
  /** Cut ambiguous fillers ("matlab", "ante") only when flanked by a pause. */
  cutAmbiguousFillersOnlyNearPause: boolean;
  /** How close a pause must be to corroborate an ambiguous filler. */
  ambiguousPauseWindowSec: number;
  /**
   * Only treat a repeated run of words as a false start when the speaker
   * actually broke at the seam. Without this, deliberate repetition
   * ("thank you thank you", "बहुत बहुत धन्यवाद") is cut as a retake.
   */
  falseStartRequiresPause: boolean;
  /** Minimum gap at the seam between the two runs to count as a break. */
  falseStartSeamPauseSec: number;
  /**
   * Suppress proposals below this confidence, 0..1. 0 proposes everything.
   *
   * A suppressed cut is not "restored" — it is never proposed at all, so it
   * does not appear in the review list. Use `restored` to keep something the
   * engine did propose.
   */
  minCutConfidence: number;

  // ---- Two-pass filler analysis -------------------------------------------

  /**
   * Route fillers through analyse → decide instead of the lexicon-only path.
   *
   * Default true. The old path is retained (and still tested) because it is the
   * only thing that works when there is no audio to measure and no evidence to
   * weigh — a transcript-only run via `--transcript-in`, for instance.
   */
  twoPassFillers: boolean;
  /** Measured audio evidence. Null disables every waveform-derived signal. */
  audio: AudioAnalysis | null;
  /** Below this, a token is too brief to judge on timing. */
  minFillerDurationSec: number;
  /** Above this, a token is a word being spoken slowly, not a hesitation. */
  maxFillerDurationSec: number;
  /** Pass 2 verdicts below this are downgraded from propose-cut to review. */
  fillerConfidence: number;
}

/**
 * Default handle kept on each side of a speech cut.
 *
 * 40 ms is about one pitch period of a low male voice — enough to preserve a
 * final consonant release without letting an audible fragment of the removed
 * word survive.
 */
export const DEFAULT_CUT_HANDLE_SEC = 0.04;

export const DEFAULT_TRIM_OPTIONS: TrimOptions = {
  maxSilenceSec: 0.7,
  paddingSec: 0.12,
  removeFillers: true,
  removeFalseStarts: true,
  removeLowConfidence: false,
  lowConfidenceThreshold: 0.35,
  cutAmbiguousFillersOnlyNearPause: true,
  ambiguousPauseWindowSec: 0.35,
  falseStartRequiresPause: true,
  falseStartSeamPauseSec: 0.18,
  // Propose everything by default. The review step is the safety net, and
  // hiding a proposal is worse than showing one the user rejects in a click.
  minCutConfidence: 0,

  twoPassFillers: true,
  audio: null,
  minFillerDurationSec: 0.06,
  maxFillerDurationSec: 2.0,
  fillerConfidence: 0.6,
};

/**
 * Build a Cut.
 *
 * The single construction point for cuts, so `category` cannot drift from
 * `reason` and no detector can forget `confidence` or `sourceWords` — the
 * compiler makes those a required argument rather than an easy omission.
 */
function mkCut(a: {
  id: string;
  start: number;
  end: number;
  reason: CutReason;
  label: string;
  wordIndices: number[];
  sourceWords: string[];
  confidence: number;
}): Cut {
  return {
    id: a.id,
    start: round3(a.start),
    end: round3(a.end),
    reason: a.reason,
    category: a.reason,
    label: a.label,
    wordIndices: a.wordIndices,
    sourceWords: a.sourceWords,
    confidence: clamp01(a.confidence),
    restored: false,
  };
}

/** Flatten a Pass 2 verdict into the serialisable evidence block on a Cut. */
function evidenceRecord(v: FillerVerdict): NonNullable<Cut['evidence']> {
  const e = v.evidence;
  return {
    originalToken: e.originalToken,
    normalizedToken: e.normalizedToken,
    language: e.language,
    script: e.script,
    durationSec: e.durationSec,
    asrConfidence: e.asrConfidence,
    gapBeforeSec: e.gapBeforeSec,
    gapAfterSec: e.gapAfterSec,
    measuredQuietBeforeSec: e.measuredQuietBeforeSec,
    measuredQuietAfterSec: e.measuredQuietAfterSec,
    energyDb: e.energyDb,
    voicedRatio: e.voicedRatio,
    audioAvailable: e.audioAvailable,
    isElongated: e.isElongated,
    isStretched: e.isStretched,
    repetitionRun: e.repetitionRun,
    signals: v.signals.map((s) => ({ name: s.name, weight: s.weight, detail: s.detail })),
    ...(v.blockedBy ? { blockedBy: v.blockedBy } : {}),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

/**
 * Auto Trim: read the transcript, propose what a human editor would cut.
 *
 * Design principle, and the thing FluxoCut gets right: NOTHING is applied
 * silently. Every cut is returned as a reviewable `Cut` with a human-readable
 * label, and `restored` flips it off. Users forgive a tool that suggests a bad
 * cut; they abandon one that silently deletes a good take.
 */
export function autoTrim(
  transcript: Transcript,
  options: Partial<TrimOptions> = {},
): TrimResult {
  const opts = { ...DEFAULT_TRIM_OPTIONS, ...options };
  const words = transcript.words;
  const cuts: Cut[] = [];
  let seq = 0;
  const nextId = (r: CutReason) => `${r}-${seq++}`;

  const spoken = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.type === 'word' && normaliseToken(w.text) !== '');

  // ---- 1. Silence / dead air -------------------------------------------------
  // Gaps BETWEEN spoken words, plus lead-in before the first word and tail after
  // the last. Leading/trailing dead air is the most common complaint in raw takes.
  if (spoken.length > 0) {
    const first = spoken[0]!;
    if (first.w.start > opts.maxSilenceSec) {
      cuts.push(mkSilenceCut(
        nextId('silence'), 0, first.w.start - opts.paddingSec, [], [],
        silenceConfidence(first.w.start, opts.maxSilenceSec),
      ));
    }

    for (let k = 1; k < spoken.length; k++) {
      const prev = spoken[k - 1]!;
      const cur = spoken[k]!;
      const gap = cur.w.start - prev.w.end;
      if (gap > opts.maxSilenceSec) {
        const start = prev.w.end + opts.paddingSec;
        const end = cur.w.start - opts.paddingSec;
        if (end > start) {
          // Any 'spacing' word entries inside the gap belong to this cut.
          const covered: number[] = [];
          for (let j = prev.i + 1; j < cur.i; j++) covered.push(j);
          cuts.push(mkSilenceCut(
            nextId('silence'), start, end, covered,
            covered.map((j) => words[j]!.text),
            silenceConfidence(gap, opts.maxSilenceSec),
          ));
        }
      }
    }

    const last = spoken[spoken.length - 1]!;
    const tail = transcript.duration - last.w.end;
    if (tail > opts.maxSilenceSec) {
      cuts.push(mkSilenceCut(
        nextId('silence'), last.w.end + opts.paddingSec, transcript.duration, [], [],
        silenceConfidence(tail, opts.maxSilenceSec),
      ));
    }
  }

  // ---- 2. Filler words -------------------------------------------------------
  // Two-pass: gather evidence (analysis.ts), then weigh it (decide.ts).
  // A `review-required` verdict becomes a cut with restored:true — visible in
  // --cuts-out and the review list, but not applied. See Cut.decision.
  if (opts.removeFillers && opts.twoPassFillers) {
    const evidence = analyseFillerCandidates(transcript, opts.audio, {
      minFillerDurationSec: opts.minFillerDurationSec,
      maxFillerDurationSec: opts.maxFillerDurationSec,
    });
    const verdicts = decideFillers(evidence, {
      minFillerDurationSec: opts.minFillerDurationSec,
      maxFillerDurationSec: opts.maxFillerDurationSec,
      pauseWindowSec: opts.ambiguousPauseWindowSec,
      lowConfidence: opts.lowConfidenceThreshold,
      minAutoCutConfidence: opts.fillerConfidence,
    });

    for (const v of verdicts) {
      if (v.decision === 'keep') continue;
      const w = words[v.evidence.index]!;
      cuts.push({
        ...mkCut({
          id: nextId('filler'),
          start: w.start,
          end: w.end,
          reason: 'filler',
          label: v.decision === 'review-required'
            ? `review: "${w.text}" — ${v.reason}`
            : `filler: "${w.text}"`,
          wordIndices: [v.evidence.index],
          sourceWords: [w.text],
          confidence: v.confidence,
        }),
        restored: v.decision === 'review-required',
        decision: v.decision,
        decisionReason: v.reason,
        evidence: evidenceRecord(v),
      });
    }
  }

  if (opts.removeFillers && !opts.twoPassFillers) {
    for (let k = 0; k < spoken.length; k++) {
      const { w, i } = spoken[k]!;
      const lang = w.language ?? transcript.language;
      const m = matchFiller(w.text, lang);
      if (!m.isFiller) continue;

      // How much corroborating pause there is. Computed for every filler, not
      // just ambiguous ones, because it is what the confidence score is built
      // from — an "um" surrounded by a long pause is a surer cut than one
      // delivered mid-flow.
      const prevW = spoken[k - 1];
      const nextW = spoken[k + 1];
      const pauseEvidence = Math.max(
        prevW ? w.start - prevW.w.end : 0,
        nextW ? nextW.w.start - w.end : 0,
      );

      // "matlab" / "ante" are real words too. Only cut them when a pause on either
      // side suggests hesitation rather than meaning. Without this guard you
      // silently destroy sentences, which is worse than leaving a filler in.
      if (m.ambiguous && opts.cutAmbiguousFillersOnlyNearPause) {
        const prev = prevW;
        const next = nextW;

        // A MISSING neighbour is not a pause, and neither is clip-boundary air.
        //
        // Treating it as Infinity made the guard trivially true for the first
        // and last word of every transcript, so any ambiguous filler at either
        // edge was cut unconditionally — "so um the point is" lost its "so".
        //
        // Leading and trailing dead air is an artefact of how the file was
        // recorded and trimmed; it is present in almost every clip and says
        // nothing about whether the speaker hesitated. Hesitation shows up as a
        // pause *between* words. With no neighbour there is no evidence, so the
        // gap counts as zero and the word survives.
        const gapBefore = prev ? w.start - prev.w.end : 0;
        const gapAfter = next ? next.w.start - w.end : 0;

        const nearPause =
          gapBefore >= opts.ambiguousPauseWindowSec || gapAfter >= opts.ambiguousPauseWindowSec;
        if (!nearPause) continue;
      }

      cuts.push(mkCut({
        id: nextId('filler'),
        start: w.start,
        end: w.end,
        reason: 'filler',
        label: `filler: "${w.text}"`,
        wordIndices: [i],
        sourceWords: [w.text],
        confidence: fillerConfidence(m.ambiguous, pauseEvidence, opts.ambiguousPauseWindowSec),
      }));
    }
  }

  // ---- 3. False starts / repeated takes --------------------------------------
  if (opts.removeFalseStarts) {
    cuts.push(...detectFalseStarts(spoken, nextId, opts));
  }

  // ---- 4. Low confidence (opt-in) --------------------------------------------
  if (opts.removeLowConfidence) {
    for (const { w, i } of spoken) {
      if (w.confidence < opts.lowConfidenceThreshold) {
        cuts.push(mkCut({
          id: nextId('low_confidence'),
          start: w.start,
          end: w.end,
          reason: 'low_confidence',
          label: `unclear: "${w.text}" (${Math.round(w.confidence * 100)}%)`,
          wordIndices: [i],
          sourceWords: [w.text],
          // Our certainty that the cut is right is the ASR's uncertainty that
          // the word is right — the one place the two invert cleanly.
          confidence: 1 - w.confidence,
        }));
      }
    }
  }

  cuts.sort((a, b) => a.start - b.start);
  // Filter BEFORE merging. Merging takes the minimum confidence of its parts,
  // so a suppressed low-confidence cut that had already been absorbed into a
  // neighbour would drag that neighbour below the threshold too — suppressing
  // a cut the user asked to keep.
  const filtered = opts.minCutConfidence > 0
    ? cuts.filter((c) => c.confidence >= opts.minCutConfidence)
    : cuts;
  const merged = mergeOverlapping(filtered);
  // Only cuts that will actually be applied count towards the saving. Before
  // the three-way verdict every cut here was active, so the filter was a no-op
  // and its absence went unnoticed; `review-required` cuts made it load-bearing.
  const removed = merged
    .filter((c) => !c.restored)
    .reduce((n, c) => n + (c.end - c.start), 0);

  return {
    cuts: merged,
    secondsRemoved: round3(removed),
    originalDuration: round3(transcript.duration),
    trimmedDuration: round3(Math.max(transcript.duration - removed, 0)),
  };
}

/**
 * Confidence for a silence cut.
 *
 * Scales with how far past the threshold the gap runs: a gap exactly at the
 * threshold is a judgement call, twice the threshold is unambiguous dead air.
 * Capped at 0.99 — silence detection is the most reliable signal here, but
 * nothing in this file earns a 1.0.
 */
function silenceConfidence(gapSec: number, thresholdSec: number): number {
  if (thresholdSec <= 0) return 0.9;
  return Math.min(0.99, 0.5 + 0.5 * ((gapSec - thresholdSec) / thresholdSec));
}

/**
 * Confidence for a filler cut.
 *
 * The `always` tier is, by the rule in fillers.ts, restricted to tokens that
 * are not words in the language — removing one cannot change meaning, so it
 * scores high regardless of context. The `ambiguous` tier is a real word that
 * happened to sit next to a pause; that is genuine but weaker evidence, so it
 * starts low and rises with the length of the corroborating pause. It is
 * deliberately capped below the `always` tier: no amount of pause makes
 * deleting a real word as safe as deleting a grunt.
 */
function fillerConfidence(ambiguous: boolean, pauseSec: number, windowSec: number): number {
  if (!ambiguous) return 0.95;
  if (windowSec <= 0) return 0.6;
  const overshoot = Math.min(1, (pauseSec - windowSec) / windowSec);
  return Math.min(0.85, 0.55 + 0.3 * Math.max(0, overshoot));
}

function mkSilenceCut(
  id: string,
  start: number,
  end: number,
  wordIndices: number[],
  sourceWords: string[],
  confidence: number,
): Cut {
  return mkCut({
    id,
    start,
    end,
    reason: 'silence',
    label: `${(end - start).toFixed(1)}s silence`,
    wordIndices,
    sourceWords,
    confidence,
  });
}

/**
 * False-start detection.
 *
 * The pattern we look for: a short run of words that is immediately repeated.
 * "I think that— I think that we should" → the first "I think that" is a retake.
 * Real editors cut the FIRST attempt and keep the second (the good take).
 *
 * Deliberately conservative: runs of 2-5 words, must match exactly after
 * normalisation, must be adjacent. Fuzzy matching here produces confident,
 * wrong cuts — the worst failure mode for this feature.
 *
 * A repeated run is NOT enough on its own. Deliberate repetition is fluent —
 * "thank you thank you", "बहुत बहुत धन्यवाद" — and a genuine retake is not: the
 * speaker breaks off, pauses, and restarts. So the seam between the two runs
 * must contain a real gap (`falseStartSeamPauseSec`). Without that check this
 * detector removes emphasis and calls it a correction.
 */
/**
 * Confidence for a false start.
 *
 * Two independent signals. A longer repeated run is far less likely to recur by
 * chance — two identical words happens constantly, five in a row essentially
 * never. And a longer break at the seam is stronger evidence the speaker
 * actually stopped rather than repeated for effect. Capped at 0.9: this
 * detector removes real, fluent speech when it is wrong, so it should never
 * present itself as certain.
 */
function falseStartConfidence(runLength: number, seamGapSec: number, seamThresholdSec: number): number {
  const lengthTerm = Math.min(0.4, (runLength - 1) * 0.12); // 2 words → 0.12, 5 → 0.4
  const gapTerm = seamThresholdSec > 0
    ? Math.min(0.35, 0.35 * (seamGapSec / (seamThresholdSec * 3)))
    : 0;
  return Math.min(0.9, 0.3 + lengthTerm + gapTerm);
}

function detectFalseStarts(
  spoken: Array<{ w: Word; i: number }>,
  nextId: (r: CutReason) => string,
  opts: Pick<TrimOptions, 'falseStartRequiresPause' | 'falseStartSeamPauseSec'>,
): Cut[] {
  const cuts: Cut[] = [];
  const tokens = spoken.map(({ w }) => normaliseToken(w.text));
  const consumed = new Set<number>();

  for (let n = 5; n >= 2; n--) {
    for (let k = 0; k + 2 * n <= spoken.length; k++) {
      if (consumed.has(k)) continue;

      const a = tokens.slice(k, k + n);
      const b = tokens.slice(k + n, k + 2 * n);
      if (a.some((t) => !t)) continue;
      if (a.join(' ') !== b.join(' ')) continue;

      // Require an audible break at the seam — see the note above.
      if (opts.falseStartRequiresPause) {
        const lastOfFirst = spoken[k + n - 1]!;
        const firstOfSecond = spoken[k + n]!;
        const seamGap = firstOfSecond.w.start - lastOfFirst.w.end;
        if (seamGap < opts.falseStartSeamPauseSec) continue;
      }

      // Mark the first occurrence for removal, keep the second.
      const startWord = spoken[k]!;
      const endWord = spoken[k + n - 1]!;
      const indices: number[] = [];
      const texts: string[] = [];
      for (let j = 0; j < n; j++) {
        indices.push(spoken[k + j]!.i);
        texts.push(spoken[k + j]!.w.text);
        consumed.add(k + j);
      }

      const seamGap = spoken[k + n]!.w.start - spoken[k + n - 1]!.w.end;

      cuts.push(mkCut({
        id: nextId('false_start'),
        start: startWord.w.start,
        end: endWord.w.end,
        reason: 'false_start',
        label: `repeated take: "${a.join(' ')}"`,
        wordIndices: indices,
        sourceWords: texts,
        confidence: falseStartConfidence(n, seamGap, opts.falseStartSeamPauseSec),
      }));
    }
  }
  return cuts;
}

/**
 * Overlapping cuts would double-count removed time and confuse the review UI.
 *
 * A merged cut takes the **minimum** confidence of its parts. Merging enlarges
 * what gets removed, so the combined proposal can only be as trustworthy as its
 * weakest component — averaging would let a certain silence cut launder a
 * doubtful filler cut into looking safe.
 */
function mergeOverlapping(cuts: Cut[]): Cut[] {
  if (cuts.length === 0) return [];
  const clone = (c: Cut): Cut => ({
    ...c,
    wordIndices: [...c.wordIndices],
    sourceWords: [...c.sourceWords],
  });
  const out: Cut[] = [clone(cuts[0]!)];

  for (let k = 1; k < cuts.length; k++) {
    const cur = cuts[k]!;
    const last = out[out.length - 1]!;
    // Never merge across the applied/not-applied boundary. A `review-required`
    // cut carries restored:true; absorbing it into an overlapping active cut
    // would apply it without anyone deciding to, which is precisely the failure
    // the three-way verdict exists to prevent. The reverse is just as bad: an
    // active cut swallowed by a restored one silently stops being applied.
    if (cur.start <= last.end && cur.restored === last.restored) {
      last.end = Math.max(last.end, cur.end);
      // Union by index, then re-derive the word list from the index order so
      // sourceWords stays in transcript order rather than merge order.
      const idx = [...new Set([...last.wordIndices, ...cur.wordIndices])].sort((a, b) => a - b);
      const textByIndex = new Map<number, string>();
      last.wordIndices.forEach((i, n) => textByIndex.set(i, last.sourceWords[n] ?? ''));
      cur.wordIndices.forEach((i, n) => textByIndex.set(i, cur.sourceWords[n] ?? ''));
      last.wordIndices = idx;
      last.sourceWords = idx.map((i) => textByIndex.get(i) ?? '').filter(Boolean);
      last.confidence = Math.min(last.confidence, cur.confidence);
      if (cur.reason !== last.reason) {
        last.label = `${last.label} + ${cur.label}`;
      }
    } else {
      out.push(clone(cur));
    }
  }
  return out;
}

/**
 * Apply a trim to the transcript: mark cut words `keep: false` and re-time the
 * survivors onto the trimmed timeline. Captions must use the NEW timings or
 * they'll drift out of sync with the trimmed video — a bug that looks like the
 * captions are broken when actually the trim is.
 */
export function applyTrim(transcript: Transcript, trim: TrimResult): Transcript {
  const active = trim.cuts.filter((c) => !c.restored).sort((a, b) => a.start - b.start);
  const cutIdx = new Set<number>();
  for (const c of active) for (const i of c.wordIndices) cutIdx.add(i);

  const words: Word[] = [];
  for (let i = 0; i < transcript.words.length; i++) {
    const w = transcript.words[i]!;
    const inCutRange = active.some((c) => w.start >= c.start && w.end <= c.end);
    if (cutIdx.has(i) || inCutRange) {
      words.push({ ...w, keep: false });
      continue;
    }
    words.push({
      ...w,
      keep: true,
      start: round3(shiftTime(w.start, active)),
      end: round3(shiftTime(w.end, active)),
    });
  }

  return {
    ...transcript,
    words,
    duration: trim.trimmedDuration,
    warnings: transcript.warnings,
  };
}

/** Map a timestamp on the original timeline to the trimmed timeline. */
function shiftTime(t: number, cuts: Cut[]): number {
  let shift = 0;
  for (const c of cuts) {
    if (c.end <= t) shift += c.end - c.start;
    else if (c.start < t && t < c.end) shift += t - c.start; // inside a cut
  }
  return Math.max(t - shift, 0);
}

/**
 * Widen every kept segment by shrinking each cut inward by `handleSec`.
 *
 * ASR word boundaries are estimates. Cutting exactly at `word.end` routinely
 * clips the release of the final consonant, which is the difference between a
 * cut you don't notice and one that sounds chopped. A handle gives the audio
 * room to breathe on both sides.
 *
 * This runs on the cut list **before** `applyTrim` and `keepSegments`, so the
 * caption timeline and the rendered timeline are derived from the same numbers.
 * Applying handles later — at render time only — would shift the audio without
 * shifting the captions, and desynchronise everything.
 *
 * It only ever removes LESS than was proposed, so it cannot introduce a
 * mid-word cut. Silence cuts already carry `paddingSec`; the handle is applied
 * to speech cuts, where the boundary came from the ASR rather than from a
 * measured gap.
 */
export function applyHandles(trim: TrimResult, handleSec: number): TrimResult {
  if (handleSec <= 0) return trim;

  const cuts: Cut[] = [];
  for (const c of trim.cuts) {
    if (c.reason === 'silence') {
      cuts.push(c); // already padded by paddingSec against real silence
      continue;
    }
    const start = c.start + handleSec;
    const end = c.end - handleSec;
    // A cut narrower than two handles is not worth making: what is left after
    // shrinking is shorter than the artefact the handle exists to avoid.
    if (end - start < 0.04) continue;
    cuts.push({ ...c, start: round3(start), end: round3(end) });
  }

  const removed = cuts
    .filter((c) => !c.restored)
    .reduce((n, c) => n + (c.end - c.start), 0);

  return {
    ...trim,
    cuts,
    secondsRemoved: round3(removed),
    trimmedDuration: round3(Math.max(trim.originalDuration - removed, 0)),
  };
}

/**
 * Snap cut boundaries to the video frame grid.
 *
 * `trim` selects whole frames; `atrim` slices audio to the sample. Cutting at
 * an arbitrary float time therefore quantises the video segment but not the
 * audio one, and times a caption to a moment the video never displays.
 * Snapping makes all three agree: video, audio and caption times are derived
 * from the same frame-aligned boundaries.
 *
 * What this does NOT fix, measured rather than assumed: rendered files show the
 * video stream running ~70 ms longer than the audio stream. That delta is
 * present with Auto Trim disabled entirely and stays constant from 1 to 8 cuts,
 * so it is an encoder tail, not cut-induced drift. Cuts do not accumulate A/V
 * error — `concat` re-times each segment and the streams stay locked.
 *
 * Direction is deliberate — start rounds UP, end rounds DOWN, so snapping only
 * ever removes LESS than proposed and can never eat into a neighbouring word.
 */
export function snapCutsToFrames(trim: TrimResult, fps: number | undefined): TrimResult {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return trim;
  const frame = 1 / fps;

  const cuts: Cut[] = [];
  for (const c of trim.cuts) {
    const start = Math.ceil(c.start / frame) * frame;
    const end = Math.floor(c.end / frame) * frame;
    if (end - start < frame) continue; // less than one frame left: not worth cutting
    cuts.push({ ...c, start: round3(start), end: round3(end) });
  }

  const removed = cuts
    .filter((c) => !c.restored)
    .reduce((n, c) => n + (c.end - c.start), 0);

  return {
    ...trim,
    cuts,
    secondsRemoved: round3(removed),
    trimmedDuration: round3(Math.max(trim.originalDuration - removed, 0)),
  };
}

/** Segments of the ORIGINAL timeline to keep — what FFmpeg needs to build the cut. */
export function keepSegments(trim: TrimResult): Array<{ start: number; end: number }> {
  const active = trim.cuts.filter((c) => !c.restored).sort((a, b) => a.start - b.start);
  const segs: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of active) {
    if (c.start > cursor) segs.push({ start: round3(cursor), end: round3(c.start) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < trim.originalDuration) {
    segs.push({ start: round3(cursor), end: round3(trim.originalDuration) });
  }
  return segs.filter((s) => s.end - s.start > 0.01);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
