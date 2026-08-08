import type { Transcript, LanguageCode } from '../types.js';

export interface TranscribeOptions {
  /**
   * Force a language. Omit to let the provider auto-detect.
   *
   * IMPORTANT for code-switched audio: forcing a language can make the provider
   * transliterate English INTO the target script — "cheat day" comes back as
   * "चीट डे", which no downstream romaniser can undo (चीट is equally
   * cheet/chit/cheat). Prefer auto-detect, or use `codeSwitching` below.
   */
  language?: LanguageCode;

  /**
   * Tell the provider to expect Hindi-English (or other Indic-English) mixing
   * and to keep English words in Latin script.
   *
   * This is the single highest-leverage setting for Hinglish captions: fixing it
   * at the ASR is far better than trying to repair it afterwards.
   */
  codeSwitching?: boolean;

  /**
   * Domain vocabulary — names, brands, product terms, jargon.
   *
   * Providers that support keyterm prompting bias recognition towards these, so
   * "cheat day" is more likely to come back as English rather than being spelled
   * out phonetically in Devanagari.
   */
  keyterms?: string[];

  /** Ask for diarisation where supported. */
  diarize?: boolean;

  /** Provider-specific escape hatch. Avoid using this in shared code paths. */
  extra?: Record<string, unknown>;
}

export interface AsrProvider {
  readonly name: string;
  /**
   * True if this provider returns REAL per-word timestamps.
   *
   * This is not a nicety — word-timed captions and transcript-driven Auto Trim
   * are impossible without it. Providers returning only sentence/chunk timings
   * cannot back this product. Guarded at runtime in each adapter.
   */
  readonly supportsWordTimestamps: boolean;
  /** Approximate USD per hour of audio, for cost attribution. Verify before trusting. */
  readonly approxUsdPerAudioHour: number;
  transcribe(audio: Buffer | Uint8Array, opts?: TranscribeOptions): Promise<Transcript>;
}

export class AsrError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}
