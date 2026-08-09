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
  /** F0 is intentionally absent unless a future local extractor can measure it. */
  f0Hz?: number;
  pitchVariation?: number;
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

/** Pure deterministic classification. Low evidence always produces neutral. */
export function classifyProsody(features: ProsodyFeatures): { tone: Tone; confidence: number } {
  const evidence = [features.voicedRatio > 0.25, Number.isFinite(features.rmsDb), features.speakingRate > 0]
    .filter(Boolean).length / 3;
  const confidence = round(Math.min(0.9, evidence * (0.45 + Math.min(0.45, Math.abs(features.energyRelative) / 4 + features.energyVariationDb / 24))));
  if (confidence < 0.45) return { tone: 'neutral', confidence };
  if (features.rmsDb < -80 || features.voicedRatio < 0.3) return { tone: 'neutral', confidence: round(Math.min(confidence, 0.44)) };
  if (features.speakingRate >= 3.2 && features.energyRelative > 0.25) return { tone: 'fast', confidence };
  if (features.energyRelative >= 1.1 && features.energyVariationDb >= 3) return { tone: 'excited', confidence };
  if (features.energyRelative >= 0.65 || (features.pauseBefore >= 0.25 && features.energyRelative >= 0.3)) return { tone: 'emphatic', confidence };
  if (features.energyRelative <= -0.75) return { tone: 'soft', confidence };
  if (features.energyRelative <= -0.25 && features.speakingRate <= 2) return { tone: 'calm', confidence };
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
    const item: ProsodyFeatures = {
      rmsDb: round(rmsDb),
      energyVariationDb: round(energyVariationDb),
      energyRelative: round((rmsDb - baseline) / spread),
      speakingRate: round(rateAround(words, index)),
      pauseBefore: audio.quietBefore(word.start),
      pauseAfter: audio.quietAfter(word.end),
      voicedRatio: round(audio.voicedRatio(word.start, word.end)),
    };
    const classified = classifyProsody(item);
    return { index, start: word.start, end: word.end, features: item, ...classified };
  });
  return { version: 1, available: true, words: features, audio: audio.snapshot() };
}

export function audioFromProsody(analysis: ProsodyAnalysis): AudioAnalysis {
  return AudioAnalysis.fromSnapshot(analysis.audio);
}
