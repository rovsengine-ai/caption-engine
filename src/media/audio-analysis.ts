/**
 * Measured audio evidence for Auto Trim.
 *
 * WHY THIS EXISTS
 * ---------------
 * Auto Trim used to infer silence from gaps between ASR words. An ASR gap is
 * not silence. The recogniser drops audio it cannot label — a breath, a cough,
 * room tone, a word it failed on — and every one of those becomes a "gap" that
 * looks exactly like dead air. The reverse is worse: a filler drawled straight
 * into the next word produces no gap at all, so the strongest evidence that
 * "aaa" was hesitation (200 ms of low-energy noise) was invisible.
 *
 * Everything here is measured from the waveform with local FFmpeg. No network,
 * no model download, no API key. The functions that parse FFmpeg output are
 * pure and exported separately from the ones that spawn it, so the parsing —
 * where the bugs actually live — is tested without any media at all.
 *
 * HONEST LIMITS, stated up front:
 *  - `voiced` here is an ENERGY threshold, not a trained voice-activity
 *    detector. Loud non-speech (music, keyboard, traffic) reads as voiced, and
 *    a whispered word below the noise floor reads as unvoiced. It is a useful
 *    corroborating signal and a bad sole authority, which is why no cut in
 *    decide.ts is ever made on this signal alone.
 *  - RMS is level, not intelligibility. It cannot tell you whether a sound was
 *    a word.
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION
 * ---------------------------------------------------------------------------
 * `parseSilenceDetect`, `parseVolumeDetect` and `suggestNoiseFloor` are
 * TypeScript reimplementations of the approach in ezsnippet's auto-cut-agent
 * (extension/js/core.js), used under the MIT licence:
 *
 *   MIT License. Copyright (c) 2026 ezsnippet
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 *   THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * See docs/THIRD-PARTY-NOTICES.md. The energy/voicing index below is our own.
 */

import { FFMPEG, run } from './ffmpeg.js';

/** A silence region measured from the waveform. `end === null` means run-to-EOF. */
export interface SilenceRange {
  start: number;
  /** null when FFmpeg logged no `silence_end` because the file ended first. */
  end: number | null;
}

export interface VolumeStats {
  meanDb: number | null;
  maxDb: number | null;
}

/** One fixed-width analysis window. `db` is RMS level; -91 is FFmpeg's floor. */
export interface EnergyWindow {
  t: number;
  db: number;
}

export interface AudioAnalysisSnapshot {
  silences: SilenceRange[];
  volume: VolumeStats;
  noiseDb: number;
  windows: EnergyWindow[];
  windowSec: number;
  duration: number;
  unavailableReason?: string;
}

export interface AudioAnalysisOptions {
  /** Silence threshold in dBFS. When omitted it is derived from the file itself. */
  noiseDb?: number;
  /** Shortest run FFmpeg will report as silence. */
  minSilenceSec: number;
  /** Width of an energy window, seconds. 25 ms is a conventional speech frame. */
  windowSec: number;
  /** Hard ceiling on FFmpeg wall-clock, per invocation. */
  timeoutMs: number;
}

export const DEFAULT_AUDIO_ANALYSIS_OPTIONS: AudioAnalysisOptions = {
  minSilenceSec: 0.12,
  windowSec: 0.025,
  timeoutMs: 300_000,
};

// ---------------------------------------------------------------------------
// Pure parsers — no IO, no FFmpeg, fully unit-testable
// ---------------------------------------------------------------------------

/**
 * Parse `silencedetect` stderr into ordered ranges.
 *
 * Two cases that a naive line-pair parser gets wrong, both real:
 *  - A silence that runs to end-of-file logs `silence_start` and never a
 *    matching `silence_end`. Dropping it loses the trailing dead air, which is
 *    the single most common thing a creator wants trimmed.
 *  - Two `silence_start` lines in a row (stream discontinuity, or a second
 *    audio stream leaking into the same stderr). The first silence never
 *    closed; emit it open rather than silently pairing mismatched numbers.
 */
export function parseSilenceDetect(stderrText: string): SilenceRange[] {
  const out: SilenceRange[] = [];
  let pending: number | null = null;

  for (const line of String(stderrText).split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start) {
      if (pending !== null) out.push({ start: pending, end: null });
      pending = Number.parseFloat(start[1]!);
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (end && pending !== null) {
      const e = Number.parseFloat(end[1]!);
      // Guard against a malformed pair where end precedes start.
      out.push({ start: pending, end: e >= pending ? e : null });
      pending = null;
    }
  }
  if (pending !== null) out.push({ start: pending, end: null });
  return out;
}

/** Parse `volumedetect` stderr. Either field is null when FFmpeg could not measure it. */
export function parseVolumeDetect(stderrText: string): VolumeStats {
  const text = String(stderrText);
  const mean = text.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
  const max = text.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
  const num = (m: RegExpMatchArray | null): number | null => {
    if (!m) return null;
    const v = Number.parseFloat(m[1]!);
    return Number.isFinite(v) ? v : null;
  };
  return { meanDb: num(mean), maxDb: num(max) };
}

/**
 * Derive a silence threshold from the file's own level.
 *
 * A fixed dB threshold is wrong for every recording: -35 dB is dead air on a
 * close-miked voiceover and mid-sentence on a phone recorded across a room.
 * `mean_volume` sits between the noise floor and speech level, so biasing a
 * little below it approximates "quieter than this is not speech".
 *
 * Clamped hard at both ends because a pathological measurement (a near-silent
 * file, a clipped one) would otherwise produce a threshold that cuts
 * everything or nothing. Never lands above `max_volume - 12`, which would
 * classify the loudest moment in the file as silence.
 */
export function suggestNoiseFloor(
  volume: VolumeStats,
  opts: { bias?: number; floor?: number; ceil?: number } = {},
): number | null {
  const bias = opts.bias ?? 6;
  const floor = opts.floor ?? -60;
  const ceil = opts.ceil ?? -20;
  if (volume.meanDb === null || !Number.isFinite(volume.meanDb)) return null;

  let suggested = volume.meanDb - bias;
  if (volume.maxDb !== null && Number.isFinite(volume.maxDb)) {
    suggested = Math.min(suggested, volume.maxDb - 12);
  }
  return Math.round(Math.max(floor, Math.min(ceil, suggested)));
}

/**
 * Parse `ametadata=print` output carrying `lavfi.astats.Overall.RMS_level`.
 *
 * FFmpeg emits a `pts_time` line followed by the metadata key/value. A window
 * of pure digital silence prints `-inf`, which becomes -91 dB (just below
 * FFmpeg's -90.31 dB 16-bit floor) so that downstream arithmetic stays finite.
 * Using -Infinity here poisons every average it touches.
 */
export function parseEnergyWindows(text: string): EnergyWindow[] {
  const out: EnergyWindow[] = [];
  let t: number | null = null;

  for (const line of String(text).split('\n')) {
    const pts = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (pts) {
      const v = Number.parseFloat(pts[1]!);
      t = Number.isFinite(v) ? v : null;
      continue;
    }
    const rms = line.match(/RMS_level=\s*(-?[\d.]+|-?inf|nan)/i);
    if (rms && t !== null) {
      const raw = rms[1]!.toLowerCase();
      const db = raw.includes('inf') || raw === 'nan' ? -91 : Number.parseFloat(raw);
      out.push({ t, db: Number.isFinite(db) ? db : -91 });
      t = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The queryable result
// ---------------------------------------------------------------------------

/**
 * Measured audio, queryable by time span.
 *
 * Every method is total: querying outside the measured range returns a
 * conservative answer rather than throwing, because a cut decision must never
 * fail because a timestamp sat 3 ms past the last window.
 */
export class AudioAnalysis {
  readonly silences: SilenceRange[];
  readonly volume: VolumeStats;
  readonly noiseDb: number;
  readonly windowSec: number;
  /** Set when measurement was skipped or failed; consumers must degrade, not guess. */
  readonly unavailableReason?: string;

  private readonly windows: EnergyWindow[];
  private readonly duration: number;

  constructor(a: {
    silences: SilenceRange[];
    volume: VolumeStats;
    noiseDb: number;
    windows: EnergyWindow[];
    windowSec: number;
    duration: number;
    unavailableReason?: string;
  }) {
    this.silences = a.silences;
    this.volume = a.volume;
    this.noiseDb = a.noiseDb;
    this.windows = a.windows;
    this.windowSec = a.windowSec;
    this.duration = a.duration;
    this.unavailableReason = a.unavailableReason;
  }

  /** True when nothing was measured — callers must not treat absence as silence. */
  get available(): boolean {
    return !this.unavailableReason && this.windows.length > 0;
  }

  /** Serializable local measurement cache; contains no media bytes or secrets. */
  snapshot(): AudioAnalysisSnapshot {
    return {
      silences: this.silences,
      volume: this.volume,
      noiseDb: this.noiseDb,
      windows: this.windows,
      windowSec: this.windowSec,
      duration: this.duration,
      unavailableReason: this.unavailableReason,
    };
  }

  static fromSnapshot(snapshot: AudioAnalysisSnapshot): AudioAnalysis {
    return new AudioAnalysis(snapshot);
  }

  /** Mean RMS dB across [start, end). -91 when unmeasured. */
  energyDb(start: number, end: number): number {
    const w = this.windowsIn(start, end);
    if (w.length === 0) return -91;
    return w.reduce((n, x) => n + x.db, 0) / w.length;
  }

  /** Loudest window in [start, end). Distinguishes a click from sustained sound. */
  peakDb(start: number, end: number): number {
    const w = this.windowsIn(start, end);
    if (w.length === 0) return -91;
    return w.reduce((n, x) => Math.max(n, x.db), -91);
  }

  /**
   * Fraction of [start, end) whose energy sits above the noise floor, 0..1.
   *
   * This is the closest thing here to voice activity, and it is deliberately
   * not called that: it cannot distinguish speech from any other sound at the
   * same level. See the limits note at the top of this file.
   */
  voicedRatio(start: number, end: number): number {
    const w = this.windowsIn(start, end);
    if (w.length === 0) return 0;
    return w.filter((x) => x.db > this.noiseDb).length / w.length;
  }

  /** Fraction of [start, end) that FFmpeg's silencedetect marked silent, 0..1. */
  silentRatio(start: number, end: number): number {
    const span = end - start;
    if (span <= 0) return 0;
    let covered = 0;
    for (const s of this.silences) {
      const e = s.end ?? this.duration;
      covered += Math.max(0, Math.min(end, e) - Math.max(start, s.start));
    }
    return Math.min(1, covered / span);
  }

  /**
   * Measured quiet immediately before `t`, in seconds, capped at `maxLook`.
   *
   * This is the honest replacement for "gap to the previous ASR word". It
   * answers "was the speaker actually quiet here", which is the question the
   * cut decision needs, and it is defined at the very start of a file where an
   * ASR-gap has no previous neighbour to measure against.
   */
  quietBefore(t: number, maxLook = 1.5): number {
    if (!this.available) return 0;
    // Walk whole windows that end at or before `t`. Scanning at arbitrary
    // offsets instead would make the first window straddle the boundary: it
    // still contains the tail of the word, reads as loud, and reports zero
    // quiet at exactly the moment we most need the measurement.
    const step = this.windowSec;
    const usable = this.windows.filter((w) => w.t + step <= t + 1e-6);
    let quiet = 0;
    let skipped = false;
    for (let k = usable.length - 1; k >= 0; k--) {
      const w = usable[k]!;
      if (w.db > this.noiseDb) {
        // Tolerate exactly ONE loud window at the boundary. The window that
        // contains `t` almost always holds the tail of the adjacent word, and
        // the codebase already treats ASR boundaries as estimates (see
        // DEFAULT_CUT_HANDLE_SEC). Without this, a single 25 ms straddle
        // reports zero quiet where two seconds were actually measured. Only
        // one window is forgiven, so real speech can never be read as silence.
        if (!skipped) { skipped = true; continue; }
        break;
      }
      quiet += step;
      if (quiet >= maxLook) break;
    }
    return Math.round(Math.min(quiet, maxLook) * 1000) / 1000;
  }

  /** Measured quiet immediately after `t`, in seconds, capped at `maxLook`. */
  quietAfter(t: number, maxLook = 1.5): number {
    if (!this.available) return 0;
    // Whole windows starting at or after `t`, same one-window boundary
    // tolerance as quietBefore.
    const step = this.windowSec;
    let quiet = 0;
    let skipped = false;
    for (const w of this.windows) {
      if (w.t + 1e-6 < t) continue;
      if (w.db > this.noiseDb) {
        if (!skipped) { skipped = true; continue; }
        break;
      }
      quiet += step;
      if (quiet >= maxLook) break;
    }
    return Math.round(Math.min(quiet, maxLook) * 1000) / 1000;
  }

  private windowsIn(start: number, end: number): EnergyWindow[] {
    if (!(end > start) || this.windows.length === 0) return [];
    return this.windows.filter((w) => w.t + this.windowSec > start && w.t < end);
  }
}

/** An analysis object that reports nothing, for when measurement is off or impossible. */
export function unavailableAudioAnalysis(reason: string): AudioAnalysis {
  return new AudioAnalysis({
    silences: [],
    volume: { meanDb: null, maxDb: null },
    noiseDb: -35,
    windows: [],
    windowSec: DEFAULT_AUDIO_ANALYSIS_OPTIONS.windowSec,
    duration: 0,
    unavailableReason: reason,
  });
}

// ---------------------------------------------------------------------------
// FFmpeg invocations
// ---------------------------------------------------------------------------

/** Measure mean/max level over the whole file. One pass, no output written. */
export async function measureVolume(input: string, timeoutMs: number): Promise<VolumeStats> {
  const res = await run(
    FFMPEG,
    ['-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { timeoutMs },
  );
  return parseVolumeDetect(res.stderr);
}

/** Measure silence regions at a given threshold. */
export async function measureSilence(
  input: string,
  noiseDb: number,
  minSilenceSec: number,
  timeoutMs: number,
): Promise<SilenceRange[]> {
  const res = await run(
    FFMPEG,
    [
      '-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0',
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
      '-f', 'null', '-',
    ],
    { timeoutMs },
  );
  return parseSilenceDetect(res.stderr);
}

/**
 * Measure per-window RMS across the file.
 *
 * `asetnsamples` fixes the window to an exact sample count so windows are
 * uniform and their index maps to time by multiplication. Relying on
 * `astats reset=N` instead would make the window depend on the decoder's frame
 * size, which varies by codec — the same file in two containers would produce
 * two different energy timelines.
 *
 * Downmixed to 16 kHz mono first: it is the cheapest representation that still
 * carries the whole speech band, and it makes the window arithmetic exact.
 */
export async function measureEnergy(
  input: string,
  windowSec: number,
  timeoutMs: number,
): Promise<EnergyWindow[]> {
  const rate = 16_000;
  const samples = Math.max(1, Math.round(rate * windowSec));
  const res = await run(
    FFMPEG,
    [
      '-hide_banner', '-nostdin', '-i', input, '-map', '0:a:0',
      '-af', [
        `aresample=${rate}`,
        'aformat=channel_layouts=mono',
        `asetnsamples=n=${samples}:p=0`,
        'astats=metadata=1:reset=1',
        'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      ].join(','),
      '-f', 'null', '-',
    ],
    { timeoutMs },
  );
  // ametadata writes to stdout via file=-; some builds interleave into stderr.
  const parsed = parseEnergyWindows(res.stdout);
  return parsed.length > 0 ? parsed : parseEnergyWindows(res.stderr);
}

/**
 * Full local audio analysis: level, adaptive threshold, silence, energy.
 *
 * Three FFmpeg passes. On a 60-minute file that is real wall-clock time, which
 * is why the caller can switch it off. It never throws: a failure downgrades to
 * an unavailable analysis carrying the reason, because losing measured evidence
 * should weaken Auto Trim's confidence, not abort the user's render.
 */
export async function analyzeAudio(
  input: string,
  durationSec: number,
  options: Partial<AudioAnalysisOptions> = {},
): Promise<AudioAnalysis> {
  const opts = { ...DEFAULT_AUDIO_ANALYSIS_OPTIONS, ...options };
  try {
    const volume = await measureVolume(input, opts.timeoutMs);
    const noiseDb = opts.noiseDb ?? suggestNoiseFloor(volume) ?? -35;
    const [silences, windows] = await Promise.all([
      measureSilence(input, noiseDb, opts.minSilenceSec, opts.timeoutMs),
      measureEnergy(input, opts.windowSec, opts.timeoutMs),
    ]);
    if (windows.length === 0) {
      return unavailableAudioAnalysis('FFmpeg returned no RMS windows (no audio stream?)');
    }
    return new AudioAnalysis({
      silences, volume, noiseDb, windows,
      windowSec: opts.windowSec,
      duration: durationSec,
    });
  } catch (err) {
    return unavailableAudioAnalysis(
      `audio analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
