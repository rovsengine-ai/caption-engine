/**
 * THE core data structure. Every feature in this product reads from `Transcript`.
 *
 * Design rule: this schema is VENDOR-NEUTRAL. No ElevenLabs/Deepgram/Sarvam field
 * names leak in here. Swapping ASR provider must be an adapter change, not a rewrite.
 * See src/asr/* for the adapters that normalise into this shape.
 */

/** BCP-47-ish language tag we care about. Kept open — providers return many. */
export type LanguageCode =
  | 'hi' | 'te' | 'kn' | 'ta' | 'ml' | 'bn' | 'mr' | 'gu' | 'pa' | 'ur'
  | 'en' | string;

/** Which script the text is rendered in. `roman` = transliterated (Hinglish style). */
export type Script = 'native' | 'roman';

export type WordType =
  /** An actual spoken word. */
  | 'word'
  /** Silence/pause between words. Some providers emit these; we also synthesise them. */
  | 'spacing'
  /** Non-speech audio event (laughter, music). Provider-dependent. */
  | 'audio_event';

/**
 * A single word with millisecond-accurate timing.
 *
 * `start`/`end` are SECONDS (float), not ms — this matches every ASR provider's
 * output and FFmpeg, and avoids a class of unit-conversion bugs. Convert at the
 * edges (see src/utils/time.ts) rather than storing mixed units.
 */
export interface Word {
  /** Text as spoken, in whatever script the provider returned. */
  text: string;
  start: number;
  end: number;
  /** 0..1. Providers that don't return confidence should emit 1. */
  confidence: number;
  type: WordType;
  /** Diarisation label, when available. */
  speakerId?: string;
  /** Detected language of THIS word — critical for code-switched Hinglish audio. */
  language?: LanguageCode;

  // ---- Fields WE add downstream. Providers never set these. ----

  /** Romanised variant, filled by the transliteration pass. */
  roman?: string;
  /** Auto Trim marked this as a filler ("um", "matlab", "ante"). */
  isFiller?: boolean;
  /** Auto Trim marked this as part of a false start / abandoned take. */
  isFalseStart?: boolean;
  /** False after Auto Trim removes it. User can flip back to true (one-click restore). */
  keep?: boolean;
}

export interface Transcript {
  words: Word[];
  /** Dominant language detected across the file. */
  language: LanguageCode;
  /** Total audio duration in seconds. */
  duration: number;
  /** Which adapter produced this, for debugging and cost attribution. */
  provider: string;
  /** Provider model identifier, e.g. "scribe_v2". */
  model?: string;
  /** True when the provider gave real per-word timings (not interpolated). */
  hasWordTimings: boolean;
  /**
   * The language code EXACTLY as the provider returned it, before
   * ISO-639-3 → ISO-639-1 normalisation (e.g. "hin" when `language` is "hi").
   * Kept for diagnostics: normalising must never destroy what was detected.
   */
  detectedLanguageRaw?: string;
  /** Non-fatal problems worth surfacing in the UI. */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Auto Trim
// ---------------------------------------------------------------------------

export type CutReason = 'silence' | 'filler' | 'false_start' | 'low_confidence';

/** A proposed removal. Always reviewable — never applied silently. */
export interface Cut {
  id: string;
  start: number;
  end: number;
  reason: CutReason;
  /**
   * Alias of `reason`, always equal to it.
   *
   * Exists because "category" is what the field is called everywhere outside
   * this codebase, and a reviewer editing cuts.json by hand should not have to
   * learn our word for it. Kept in sync by construction — never set separately.
   */
  category: CutReason;
  /** What the user sees in the review list, e.g. "um, uh" or "2.4s silence". */
  label: string;
  /** Indices into Transcript.words that this cut covers. */
  wordIndices: number[];
  /**
   * The actual words this cut removes, in order.
   *
   * `wordIndices` alone forces a reviewer to open the transcript to see what a
   * cut does. Empty for a pure-silence cut, which removes no words.
   */
  sourceWords: string[];
  /**
   * How sure the engine is that this cut is correct, 0..1.
   *
   * Deterministic, not learned — see `cutConfidence` in autotrim/index.ts for
   * how each category derives it. A reviewer with forty proposals needs to know
   * which five to look at, and sorting by this is that answer.
   */
  confidence: number;
  /** User can restore any cut. Restored cuts are skipped at render time. */
  restored: boolean;

  // ---- Two-pass Auto Trim. Optional: cut files written before this existed
  // ---- still load, and detectors that do not run the two passes omit them.

  /**
   * The Pass 2 verdict.
   *
   * `review-required` cuts are emitted with `restored: true`, so they appear in
   * the review list and in --cuts-out but are NOT applied. That is the whole
   * point of the three-way verdict: the engine can say "I am not sure" without
   * either silently deleting the word or silently hiding the proposal. Flip
   * `restored` to false to accept one.
   */
  decision?: 'keep' | 'propose-cut' | 'review-required';
  /** Why, in one sentence a reviewer can act on. */
  decisionReason?: string;
  /**
   * The independent signals that supported this cut, with their weights.
   * Present so a wrong cut can be traced to the signal that lied, rather than
   * to an opaque score.
   */
  evidence?: {
    originalToken?: string;
    normalizedToken?: string;
    language?: string;
    script?: string;
    durationSec?: number;
    asrConfidence?: number;
    gapBeforeSec?: number;
    gapAfterSec?: number;
    measuredQuietBeforeSec?: number;
    measuredQuietAfterSec?: number;
    energyDb?: number;
    voicedRatio?: number;
    audioAvailable?: boolean;
    isElongated?: boolean;
    isStretched?: boolean;
    repetitionRun?: number;
    signals?: Array<{ name: string; weight: number; detail: string }>;
    blockedBy?: string;
  };
}

export interface TrimResult {
  cuts: Cut[];
  /** Seconds removed if every non-restored cut is applied. */
  secondsRemoved: number;
  originalDuration: number;
  trimmedDuration: number;
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

/** A group of words shown on screen together (one or two lines). */
export interface CaptionCue {
  index: number;
  start: number;
  end: number;
  words: Word[];
  /** Rendered text of the whole cue. */
  text: string;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSizePx: number;
  primaryColor: string;   // "#RRGGBB"
  activeColor: string;    // colour of the word currently being spoken
  outlineColor: string;
  outlineWidthPx: number;
  /** Vertical position as a fraction of frame height, 0 = top, 1 = bottom. */
  positionY: number;
  uppercase: boolean;
  /** Max words shown on screen at once. */
  maxWordsPerCue: number;
  /** Max characters per line before wrapping. */
  maxCharsPerLine: number;
}

// ---------------------------------------------------------------------------
// Clip finding (long-form → shorts)
// ---------------------------------------------------------------------------

export interface ClipCandidate {
  start: number;
  end: number;
  /** 0..100. LLM-assigned. See src/clips/score.ts for the caveats — this is the
   *  least trustworthy number in the system and must be validated per-language. */
  score: number;
  title: string;
  reason: string;
  transcriptExcerpt: string;
}

export interface VideoMeta {
  width: number;
  height: number;
  durationSec: number;
  fps: number;
  hasAudio: boolean;
}
