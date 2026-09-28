/**
 * Timeline waveform peaks for the web studio.
 *
 * Reuses the same FFmpeg energy path as Auto Trim (`aresample` → `asetnsamples`
 * → `astats` RMS) but targets a compact peak array suitable for canvas drawing
 * (roughly 100 peaks/sec, capped at 1k–4k total) so a 5-minute clip stays fast.
 */

import { measureEnergy, type EnergyWindow } from './audio-analysis.js';

export interface WaveformData {
  version: 1;
  /** Media duration used when sampling (seconds). */
  durationSec: number;
  /** Nominal peaks per second (peaks.length / durationSec). */
  peaksPerSecond: number;
  /** Window width used for each RMS sample (seconds). */
  windowSec: number;
  /** Normalized peak amplitudes in [0, 1], ordered by time. */
  peaks: number[];
}

export interface WaveformOptions {
  /** Ideal density. Long files are capped; short files may be denser. */
  idealPeaksPerSecond?: number;
  minPeaks?: number;
  maxPeaks?: number;
  /** dBFS floor mapped to amplitude 0. */
  floorDb?: number;
  timeoutMs?: number;
}

export const DEFAULT_WAVEFORM_OPTIONS: Required<WaveformOptions> = {
  idealPeaksPerSecond: 100,
  minPeaks: 200,
  maxPeaks: 4000,
  floorDb: -60,
  timeoutMs: 60_000,
};

/**
 * Choose a uniform window so the peak count stays in [min, max] while
 * preferring ~idealPeaksPerSecond on short/medium clips.
 */
export function chooseWaveformWindow(
  durationSec: number,
  options: Partial<WaveformOptions> = {},
): { windowSec: number; targetPeaks: number } {
  const opts = { ...DEFAULT_WAVEFORM_OPTIONS, ...options };
  const dur = Math.max(Number.isFinite(durationSec) ? durationSec : 0, 0.05);
  let target = Math.round(dur * opts.idealPeaksPerSecond);
  if (dur * opts.idealPeaksPerSecond < opts.minPeaks) {
    // Short clips: don't pad with empty windows — keep real density.
    target = Math.max(32, Math.round(dur * opts.idealPeaksPerSecond));
  } else {
    target = Math.max(opts.minPeaks, Math.min(opts.maxPeaks, target));
  }
  return {
    targetPeaks: target,
    windowSec: dur / target,
  };
}

/**
 * Convert one RMS dBFS sample to a linear amplitude in [0, 1].
 * Silence / -inf maps to 0; 0 dBFS maps near 1.
 */
export function dbToAmplitude(db: number, floorDb = DEFAULT_WAVEFORM_OPTIONS.floorDb): number {
  if (!Number.isFinite(db) || db <= floorDb) return 0;
  const lin = 10 ** (db / 20);
  const floorLin = 10 ** (floorDb / 20);
  const denom = 1 - floorLin;
  if (denom <= 0) return 0;
  return Math.min(1, Math.max(0, (lin - floorLin) / denom));
}

/**
 * Map energy windows → normalized peaks (max peak = 1 when any signal exists).
 */
export function windowsToPeaks(
  windows: EnergyWindow[],
  options: Partial<WaveformOptions> = {},
): number[] {
  const floorDb = options.floorDb ?? DEFAULT_WAVEFORM_OPTIONS.floorDb;
  if (windows.length === 0) return [];
  const raw = windows.map((w) => dbToAmplitude(w.db, floorDb));
  let max = 0;
  for (const v of raw) if (v > max) max = v;
  if (max <= 1e-6) return raw.map(() => 0);
  return raw.map((v) => Math.min(1, v / max));
}

/**
 * Measure waveform peaks from a media file (video or audio).
 * Fast path: single FFmpeg pass with fixed-size RMS windows.
 */
export async function computeWaveformPeaks(
  inputPath: string,
  durationSec: number,
  options: Partial<WaveformOptions> = {},
): Promise<WaveformData> {
  const opts = { ...DEFAULT_WAVEFORM_OPTIONS, ...options };
  const dur = Math.max(durationSec, 0.05);
  const { windowSec, targetPeaks } = chooseWaveformWindow(dur, opts);

  const windows = await measureEnergy(inputPath, windowSec, opts.timeoutMs);
  const peaks = windowsToPeaks(windows, opts);

  // If FFmpeg returned nothing (no audio), still return a valid empty envelope
  // so the UI can render a flat track without retrying forever.
  const finalPeaks = peaks.length > 0
    ? peaks
    : Array.from({ length: targetPeaks }, () => 0);

  return {
    version: 1,
    durationSec: dur,
    peaksPerSecond: finalPeaks.length / dur,
    windowSec,
    peaks: finalPeaks,
  };
}

/** Validate / coerce a cached waveform.json document. */
export function parseWaveformDoc(raw: unknown): WaveformData | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.peaks)) return null;
  const peaks = doc.peaks
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p))
    .map((p) => Math.min(1, Math.max(0, p)));
  if (peaks.length === 0) return null;
  const durationSec = Number(doc.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const windowSec = Number(doc.windowSec);
  const peaksPerSecond = Number(doc.peaksPerSecond);
  return {
    version: 1,
    durationSec,
    windowSec: Number.isFinite(windowSec) && windowSec > 0
      ? windowSec
      : durationSec / peaks.length,
    peaksPerSecond: Number.isFinite(peaksPerSecond) && peaksPerSecond > 0
      ? peaksPerSecond
      : peaks.length / durationSec,
    peaks,
  };
}
