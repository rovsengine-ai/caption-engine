/**
 * Local fundamental-frequency (F0) estimation — YIN, in pure TypeScript.
 *
 * WHY THIS EXISTS.
 *
 * The prosody classifier previously keyed almost entirely on loudness relative
 * to the clip. That makes "excited" a synonym for "louder than this speaker's
 * median", which is a thin signal: a speaker who raises their pitch without
 * raising their volume looks identical to one who is simply closer to the mic.
 * Pitch is the other half of the picture, and it is measurable locally from the
 * 16 kHz mono PCM we already extract — no service, no key, no upload.
 *
 * THE ALGORITHM.
 *
 * YIN (de Cheveigné & Kawahara, 2002), the standard four steps:
 *
 *   1. difference function      d(τ) = Σ (x[j] - x[j+τ])²
 *   2. cumulative mean normalisation, which removes the trivial d(0)=0 minimum
 *      that plain autocorrelation trips over and is what makes YIN robust
 *      against octave errors
 *   3. absolute threshold — the FIRST dip below it, not the global minimum.
 *      Taking the global minimum is the classic way to land an octave too low,
 *      because a perfect period is also a perfect double-period
 *   4. parabolic interpolation around the chosen lag, so resolution is not
 *      limited to whole samples (at 16 kHz, integer lags alone quantise a 200 Hz
 *      voice into ~5 Hz steps — audible as jitter in any downstream statistic)
 *
 * Implemented directly rather than pulled from a library: the whole point of
 * this feature is that it runs locally with no new runtime dependency, and the
 * algorithm is ~60 lines.
 *
 * WHAT IT IS NOT.
 *
 * F0 is the rate at which the vocal folds vibrate. It is not emotion, not
 * meaning, and not speaker identity. Unvoiced sounds (s, f, sh, stops) have no
 * F0 at all, which is why every frame carries a `clarity` value and why frames
 * below the threshold report `null` rather than a plausible-looking number.
 * Music, overlapping speakers and heavy noise all produce confident-looking
 * garbage, so callers must treat low clarity as "unknown", never as "low pitch".
 */

/** One analysis frame. `f0Hz` is null when the frame is unvoiced or unclear. */
export interface PitchFrame {
  /** Frame start time in seconds. */
  t: number;
  f0Hz: number | null;
  /** 0..1 — how periodic the frame is. Derived from the YIN minimum. */
  clarity: number;
}

export interface PitchOptions {
  sampleRate: number;
  /** Analysis window, seconds. Must hold at least two periods of the lowest F0. */
  windowSec: number;
  /** Step between frames, seconds. */
  hopSec: number;
  /** Lowest F0 to look for. 65 Hz is below a typical adult male speaking voice. */
  minHz: number;
  /** Highest F0 to look for. 400 Hz covers adult speech with headroom. */
  maxHz: number;
  /**
   * YIN's absolute threshold. 0.15 is the paper's value and errs toward
   * reporting "unvoiced" rather than inventing a pitch.
   */
  threshold: number;
}

export const DEFAULT_PITCH_OPTIONS: PitchOptions = {
  sampleRate: 16_000,
  // 40 ms holds two full periods at 65 Hz (the low end of what we search for).
  // Shorter windows cannot resolve a low male voice; much longer ones smear
  // across syllable boundaries and blunt exactly the variation we want.
  windowSec: 0.04,
  hopSec: 0.025,
  minHz: 65,
  maxHz: 400,
  threshold: 0.15,
};

/**
 * Estimate F0 for one buffer of mono samples in [-1, 1].
 *
 * Returns null when the frame is unvoiced, too quiet, or not periodic enough to
 * call. Saying "I don't know" is a first-class answer here.
 */
export function yinF0(
  samples: Float32Array,
  opts: Pick<PitchOptions, 'sampleRate' | 'minHz' | 'maxHz' | 'threshold'>,
): { f0Hz: number | null; clarity: number } {
  const { sampleRate, minHz, maxHz, threshold } = opts;
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  if (maxLag <= minLag) return { f0Hz: null, clarity: 0 };

  // Step 1: difference function.
  const diff = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const n = samples.length - lag;
    for (let j = 0; j < n; j++) {
      const delta = samples[j]! - samples[j + lag]!;
      sum += delta * delta;
    }
    diff[lag] = sum;
  }

  // Step 2: cumulative mean normalised difference. Without this, d(τ) falls
  // monotonically and the minimum is always at τ=0 — useless.
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    runningSum += diff[lag]!;
    cmnd[lag] = runningSum > 0 ? (diff[lag]! * (lag - minLag + 1)) / runningSum : 1;
  }

  // Step 3: first dip below the threshold, walking to the bottom of that dip.
  // "First", not "global": a true period τ makes 2τ equally good, so the global
  // minimum is a coin flip between the right answer and an octave below it.
  let chosen = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag]! < threshold) {
      let best = lag;
      while (best + 1 <= maxLag && cmnd[best + 1]! < cmnd[best]!) best++;
      chosen = best;
      break;
    }
  }
  if (chosen < 0) {
    // Nothing periodic enough. Report the best evidence we saw so a caller can
    // distinguish "quiet room" from "loud but aperiodic".
    let min = 1;
    for (let lag = minLag; lag <= maxLag; lag++) min = Math.min(min, cmnd[lag]!);
    return { f0Hz: null, clarity: clamp01(1 - min) };
  }

  // Step 4: parabolic interpolation around the chosen lag.
  const refined = parabolicMinimum(cmnd, chosen, minLag, maxLag);
  const f0 = sampleRate / refined;
  if (!Number.isFinite(f0) || f0 < minHz || f0 > maxHz) {
    return { f0Hz: null, clarity: clamp01(1 - cmnd[chosen]!) };
  }
  return { f0Hz: f0, clarity: clamp01(1 - cmnd[chosen]!) };
}

/**
 * Sub-sample minimum via a parabola through (lag-1, lag, lag+1).
 *
 * Falls back to the integer lag at the array edges, where there is no parabola
 * to fit, rather than reading out of bounds.
 */
function parabolicMinimum(v: Float32Array, lag: number, lo: number, hi: number): number {
  if (lag <= lo || lag >= hi) return lag;
  const a = v[lag - 1]!;
  const b = v[lag]!;
  const c = v[lag + 1]!;
  const denom = 2 * (2 * b - a - c);
  if (denom === 0) return lag;
  const shift = (a - c) / denom;
  // A well-formed parabola cannot move the minimum more than half a sample.
  return Math.abs(shift) <= 1 ? lag + shift : lag;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Convert interleaved 16-bit little-endian PCM to mono floats in [-1, 1]. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const count = Math.floor(buf.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // 32768 (not 32767) so the most negative sample maps to exactly -1.
    out[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Track F0 across a whole signal.
 *
 * Pure: it takes samples, not a filename, so every property below is testable
 * with a synthesised tone and no FFmpeg, no media file, and no network.
 */
export function trackPitch(
  samples: Float32Array,
  options: Partial<PitchOptions> = {},
): PitchFrame[] {
  const opts = { ...DEFAULT_PITCH_OPTIONS, ...options };
  const windowLen = Math.max(2, Math.round(opts.sampleRate * opts.windowSec));
  const hopLen = Math.max(1, Math.round(opts.sampleRate * opts.hopSec));
  const frames: PitchFrame[] = [];

  for (let start = 0; start + windowLen <= samples.length; start += hopLen) {
    const window = samples.subarray(start, start + windowLen);
    // Skip near-silence before doing the O(n²) work: YIN on a silent frame is
    // both meaningless and the single biggest waste of time on a long file.
    if (rms(window) < 1e-4) {
      frames.push({ t: start / opts.sampleRate, f0Hz: null, clarity: 0 });
      continue;
    }
    const { f0Hz, clarity } = yinF0(window, opts);
    frames.push({ t: start / opts.sampleRate, f0Hz, clarity });
  }
  return frames;
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / Math.max(1, x.length));
}

/**
 * Semitone distance between two frequencies.
 *
 * Pitch variation is expressed in semitones rather than Hz because Hz is not
 * perceptually linear: a 20 Hz move is dramatic for a 90 Hz voice and barely
 * audible for a 300 Hz one. Comparing speakers in Hz would make every
 * low-voiced speaker look monotone.
 */
export function semitones(from: number, to: number): number {
  if (from <= 0 || to <= 0) return 0;
  return 12 * Math.log2(to / from);
}

/** Median of the voiced frames in a span, or null when none are voiced. */
export function medianF0(frames: PitchFrame[], minClarity = 0.4): number | null {
  const voiced = frames
    .filter((f) => f.f0Hz !== null && f.clarity >= minClarity)
    .map((f) => f.f0Hz!)
    .sort((a, b) => a - b);
  if (voiced.length === 0) return null;
  const mid = Math.floor(voiced.length / 2);
  return voiced.length % 2 ? voiced[mid]! : (voiced[mid - 1]! + voiced[mid]!) / 2;
}

/**
 * Spread of F0 within a span, in semitones.
 *
 * Interquartile rather than min-max: a single octave-halving error at a frame
 * boundary would otherwise dominate the number and make a calm sentence look
 * wildly expressive.
 */
export function pitchSpreadSemitones(frames: PitchFrame[], minClarity = 0.4): number {
  const voiced = frames
    .filter((f) => f.f0Hz !== null && f.clarity >= minClarity)
    .map((f) => f.f0Hz!)
    .sort((a, b) => a - b);
  if (voiced.length < 4) return 0;
  const q = (p: number): number => voiced[Math.min(voiced.length - 1, Math.floor(p * voiced.length))]!;
  return Math.abs(semitones(q(0.25), q(0.75)));
}
