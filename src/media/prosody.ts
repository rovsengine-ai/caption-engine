import type { Transcript, Word } from '../types.js';
import { AudioAnalysis, type AudioAnalysisSnapshot } from './audio-analysis.js';

/** Deterministic audio/prosody labels — deliberately not emotion recognition. */
export type Tone = 'neutral' | 'calm' | 'excited' | 'emphatic' | 'fast' | 'soft';

export interface ProsodyFeatures {
  rmsDb: number;
  energyVariationDb: number;
  energyRelative: number;
  speakingRate: number;
  pauseBefore: number;
  pauseAfter: number;
  voicedRatio: number;
  /**
   * Median fundamental frequency across the word, in Hz, measured locally by
   * the YIN estimator in src/media/pitch.ts. Absent when the word is unvoiced
   * or pitch analysis was not run — absent means "unknown", never "low".
   */
  f0Hz?: number;
  /** Interquartile F0 spread within the word, in semitones. */
  pitchVariation?: number;
  /**
   * How far this word's pitch sits from the speaker's own median, in semitones.
   * Positive is higher than usual. Relative, because absolute Hz describes the
   * speaker rather than the delivery.
   */
  pitchRelative?: number;
}

export interface ProsodyWord {
  index: number;
  start: number;
  end: number;
  features: ProsodyFeatures;
  tone: Tone;
  confidence: number;
}

export interface ProsodyAnalysis {
  version: 1;
  available: boolean;
  reason?: string;
  words: ProsodyWord[];
  /** Captured so local measurements can be reused by Auto Trim without a second pass. */
  audio: AudioAnalysisSnapshot;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function rateAround(words: Word[], index: number, radiusSec = 1.25): number {
  const word = words[index]!;
  const start = word.start - radiusSec;
  const end = word.end + radiusSec;
  const count = words.filter((w) => w.type === 'word' && w.start >= start && w.end <= end).length;
  return count / Math.max(0.2, end - start);
}

/**
 * Pure deterministic classification. Low evidence always produces neutral.
 *
 * WHAT THIS IS. A description of DELIVERY — loudness relative to the speaker's
 * own median, pitch relative to their own median, speaking rate, pauses. It is
 * emphatically NOT emotion recognition: a "excited" label means "louder and
 * higher than this speaker usually is", which correlates with excitement and
 * also with a passing truck, a laugh, and a badly placed microphone.
 *
 * Pitch is what makes the labels worth anything. Loudness alone cannot separate
 * a speaker who leans into the mic from one who raises their voice, and it
 * calls every close-miked whisper "soft" regardless of intent. F0 relative to
 * the speaker's own baseline is a genuinely independent axis, so the two
 * together are much harder to fool than either alone.
 *
 * Ordering is deliberate: the cheapest disqualifiers run first, then the
 * two-signal rules (energy AND pitch), then the single-signal ones. A rule that
 * needs two agreeing signals should win over one that needs a single signal,
 * because it is less likely to be an artefact.
 */
export function classifyProsody(features: ProsodyFeatures): { tone: Tone; confidence: number } {
  const hasPitch = features.f0Hz !== undefined && features.f0Hz > 0;
  const pitchRel = features.pitchRelative ?? 0;
  const pitchVar = features.pitchVariation ?? 0;

  // Evidence is a coverage figure, not a probability: how many independent
  // signals actually produced a reading for this word.
  const signals = [
    features.voicedRatio > 0.25,
    Number.isFinite(features.rmsDb),
    features.speakingRate > 0,
    hasPitch,
  ];
  const evidence = signals.filter(Boolean).length / signals.length;

  // Strength of what those signals say. Pitch contributes only when measured,
  // so a file where F0 could not be found scores lower rather than being
  // silently treated as flat-pitched.
  const strength = Math.min(
    0.45,
    Math.abs(features.energyRelative) / 4 +
      features.energyVariationDb / 24 +
      (hasPitch ? Math.min(0.2, Math.abs(pitchRel) / 12 + pitchVar / 24) : 0),
  );
  const confidence = round(Math.min(0.95, evidence * (0.45 + strength)));

  if (confidence < 0.45) return { tone: 'neutral', confidence };
  if (features.rmsDb < -80 || features.voicedRatio < 0.3) {
    return { tone: 'neutral', confidence: round(Math.min(confidence, 0.44)) };
  }

  // Two-signal rules: energy and pitch agreeing.
  if (hasPitch && pitchRel >= 2 && features.energyRelative >= 0.6) {
    return { tone: 'excited', confidence };
  }
  if (hasPitch && pitchRel <= -1.5 && features.energyRelative <= -0.4) {
    return { tone: 'soft', confidence };
  }
  if (hasPitch && Math.abs(pitchRel) < 1 && pitchVar < 1.5 && features.speakingRate <= 2.2) {
    return { tone: 'calm', confidence };
  }

  // Single-signal rules, unchanged in spirit from the energy-only classifier.
  if (features.speakingRate >= 3.2 && features.energyRelative > 0.25) {
    return { tone: 'fast', confidence };
  }
  if (features.energyRelative >= 1.1 && features.energyVariationDb >= 3) {
    return { tone: 'excited', confidence };
  }
  if (
    features.energyRelative >= 0.65 ||
    (features.pauseBefore >= 0.25 && features.energyRelative >= 0.3)
  ) {
    return { tone: 'emphatic', confidence };
  }
  if (features.energyRelative <= -0.75) return { tone: 'soft', confidence };
  if (features.energyRelative <= -0.25 && features.speakingRate <= 2) {
    return { tone: 'calm', confidence };
  }
  return { tone: 'neutral', confidence };
}

/** Analyze an already-local audio measurement once, normalized to this clip. */
export function analyzeProsody(transcript: Transcript, audio: AudioAnalysis): ProsodyAnalysis {
  const words = transcript.words.filter((word) => word.type === 'word' && word.keep !== false);
  if (!audio.available) {
    return { version: 1, available: false, reason: audio.unavailableReason, words: [], audio: audio.snapshot() };
  }
  const levels = words.map((word) => audio.energyDb(word.start, word.end)).filter((db) => db > -90);
  const baseline = median(levels);
  const spread = Math.max(1, median(levels.map((db) => Math.abs(db - baseline))));
  const features = words.map((word, index) => {
    const rmsDb = audio.energyDb(word.start, word.end);
    const energyVariationDb = Math.max(0, audio.peakDb(word.start, word.end) - rmsDb);
    const f0 = audio.hasPitch ? audio.f0Hz(word.start, word.end) : null;
    const item: ProsodyFeatures = {
      rmsDb: round(rmsDb),
      energyVariationDb: round(energyVariationDb),
      energyRelative: round((rmsDb - baseline) / spread),
      speakingRate: round(rateAround(words, index)),
      pauseBefore: audio.quietBefore(word.start),
      pauseAfter: audio.quietAfter(word.end),
      voicedRatio: round(audio.voicedRatio(word.start, word.end)),
      // Omitted rather than zeroed when unmeasured: the classifier must be able
      // to tell "no pitch reading" from "pitch at the baseline".
      ...(f0 !== null
        ? {
            f0Hz: round(f0),
            pitchVariation: round(audio.pitchSpread(word.start, word.end)),
            pitchRelative: round(audio.pitchRelative(word.start, word.end)),
          }
        : {}),
    };
    const classified = classifyProsody(item);
    return { index, start: word.start, end: word.end, features: item, ...classified };
  });
  return { version: 1, available: true, words: features, audio: audio.snapshot() };
}

export function audioFromProsody(analysis: ProsodyAnalysis): AudioAnalysis {
  return AudioAnalysis.fromSnapshot(analysis.audio);
}
