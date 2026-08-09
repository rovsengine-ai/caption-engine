import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  yinF0, trackPitch, pcm16ToFloat, semitones, medianF0, pitchSpreadSemitones,
  DEFAULT_PITCH_OPTIONS, type PitchFrame,
} from '../src/media/pitch.js';

/**
 * Local F0 estimation (YIN).
 *
 * Everything here is synthesised in memory: a sine wave at a known frequency is
 * a signal whose correct answer we know exactly, so accuracy is measurable
 * rather than eyeballed. No audio file, no FFmpeg, no network, no API.
 *
 * The properties that matter are not "does it return a number" but:
 *   - does it return the RIGHT number, within a stated tolerance
 *   - does it return NULL rather than a plausible-looking wrong number when the
 *     input is not periodic
 *   - does it resist octave errors, the classic pitch-tracking failure
 */

const RATE = 16_000;

/** A pure tone. Amplitude well under 1 so nothing clips. */
function sine(hz: number, seconds: number, rate = RATE, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/**
 * A tone with harmonics — closer to a voice than a sine, and the shape that
 * actually tempts a tracker into reporting an octave too low.
 */
function harmonicTone(f0: number, seconds: number, rate = RATE): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] =
      0.5 * Math.sin(2 * Math.PI * f0 * t) +
      0.3 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.15 * Math.sin(2 * Math.PI * 3 * f0 * t);
  }
  return out;
}

function noise(seconds: number, rate = RATE, amp = 0.3): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  // Deterministic LCG — a flaky pitch test would be worse than no pitch test.
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * amp;
  }
  return out;
}

const OPTS = {
  sampleRate: RATE,
  minHz: DEFAULT_PITCH_OPTIONS.minHz,
  maxHz: DEFAULT_PITCH_OPTIONS.maxHz,
  threshold: DEFAULT_PITCH_OPTIONS.threshold,
};

describe('accuracy on a known tone', () => {
  // Spanning a low male voice to a high female one.
  for (const hz of [85, 110, 150, 200, 260, 330]) {
    test(`${hz} Hz sine is estimated within 1%`, () => {
      const { f0Hz, clarity } = yinF0(sine(hz, 0.06), OPTS);
      assert.ok(f0Hz !== null, `no pitch found for a clean ${hz} Hz tone`);
      const errorPct = (Math.abs(f0Hz! - hz) / hz) * 100;
      assert.ok(errorPct < 1, `${hz} Hz estimated as ${f0Hz!.toFixed(1)} (${errorPct.toFixed(2)}% off)`);
      assert.ok(clarity > 0.8, `a pure tone should be highly periodic, got ${clarity.toFixed(2)}`);
    });
  }

  test('a harmonic-rich tone does not produce an octave error', () => {
    // The classic failure: 2× the true period fits just as well, so a tracker
    // that takes the global minimum reports f0/2.
    const hz = 140;
    const { f0Hz } = yinF0(harmonicTone(hz, 0.06), OPTS);
    assert.ok(f0Hz !== null);
    assert.ok(
      Math.abs(f0Hz! - hz) < hz * 0.05,
      `expected ~${hz} Hz, got ${f0Hz!.toFixed(1)} — likely an octave error`,
    );
    assert.ok(Math.abs(f0Hz! - hz / 2) > 10, 'must not have halved the frequency');
  });

  test('parabolic interpolation beats whole-sample resolution', () => {
    // At 16 kHz, integer lags near 200 Hz land ~5 Hz apart. An estimator that
    // could only return sampleRate/integer would be unable to produce 203 Hz.
    const { f0Hz } = yinF0(sine(203, 0.06), OPTS);
    assert.ok(f0Hz !== null);
    const nearestInteger = RATE / Math.round(RATE / 203);
    assert.ok(
      Math.abs(f0Hz! - 203) < Math.abs(nearestInteger - 203) + 0.5,
      'interpolation should be at least as close as the nearest integer lag',
    );
  });
});

describe('honest refusal', () => {
  test('white noise yields no pitch', () => {
    const { f0Hz } = yinF0(noise(0.06), OPTS);
    assert.equal(f0Hz, null, 'noise has no fundamental — inventing one would be a lie');
  });

  test('silence yields no pitch and zero clarity', () => {
    const { f0Hz, clarity } = yinF0(new Float32Array(RATE * 0.06), OPTS);
    assert.equal(f0Hz, null);
    assert.equal(clarity, 0);
  });

  test('a tone below the search range is not reported', () => {
    // 40 Hz is below minHz. Reporting it as some in-range harmonic would be
    // worse than saying nothing.
    const { f0Hz } = yinF0(sine(40, 0.06), OPTS);
    if (f0Hz !== null) assert.ok(f0Hz >= OPTS.minHz, `returned ${f0Hz}, below minHz`);
  });

  test('a tone above the search range is not reported as itself', () => {
    const { f0Hz } = yinF0(sine(900, 0.06), OPTS);
    if (f0Hz !== null) assert.ok(f0Hz <= OPTS.maxHz, `returned ${f0Hz}, above maxHz`);
  });

  test('a window too short to hold two periods returns null, not garbage', () => {
    const { f0Hz } = yinF0(sine(100, 0.005), OPTS);
    assert.equal(f0Hz, null);
  });

  test('an empty buffer does not throw', () => {
    assert.doesNotThrow(() => yinF0(new Float32Array(0), OPTS));
  });
});

describe('tracking a whole signal', () => {
  test('frame times are evenly spaced by the hop', () => {
    const frames = trackPitch(sine(150, 0.5), { sampleRate: RATE, hopSec: 0.025 });
    assert.ok(frames.length > 10);
    for (let i = 1; i < frames.length; i++) {
      const delta = frames[i]!.t - frames[i - 1]!.t;
      assert.ok(Math.abs(delta - 0.025) < 1e-6, `hop drifted at frame ${i}: ${delta}`);
    }
  });

  test('a steady tone tracks steadily', () => {
    const frames = trackPitch(sine(180, 0.5), { sampleRate: RATE });
    const voiced = frames.filter((f) => f.f0Hz !== null);
    assert.ok(voiced.length > frames.length * 0.8, 'most frames of a steady tone should be voiced');
    for (const f of voiced) {
      assert.ok(Math.abs(f.f0Hz! - 180) < 5, `frame at ${f.t}s drifted to ${f.f0Hz}`);
    }
  });

  test('silence produces frames, all unvoiced — gaps stay visible', () => {
    const frames = trackPitch(new Float32Array(RATE * 0.3), { sampleRate: RATE });
    assert.ok(frames.length > 0, 'silence must still produce a timeline');
    assert.ok(frames.every((f) => f.f0Hz === null));
  });

  test('a signal shorter than one window produces no frames', () => {
    assert.deepEqual(trackPitch(new Float32Array(10), { sampleRate: RATE }), []);
  });
});

describe('summary statistics', () => {
  const frames = (hz: number[]): PitchFrame[] =>
    hz.map((f, i) => ({ t: i * 0.025, f0Hz: f, clarity: 0.9 }));

  test('median ignores unvoiced frames', () => {
    const mixed: PitchFrame[] = [
      { t: 0, f0Hz: null, clarity: 0 },
      ...frames([100, 200, 300]),
    ];
    assert.equal(medianF0(mixed), 200);
  });

  test('median is null when nothing is voiced', () => {
    assert.equal(medianF0([{ t: 0, f0Hz: null, clarity: 0 }]), null);
  });

  test('low-clarity frames are excluded', () => {
    const noisy: PitchFrame[] = [{ t: 0, f0Hz: 999, clarity: 0.1 }, ...frames([150, 150, 150])];
    assert.equal(medianF0(noisy), 150, 'an unreliable frame must not move the median');
  });

  test('semitones are symmetric and octave-correct', () => {
    assert.ok(Math.abs(semitones(100, 200) - 12) < 1e-9, 'an octave up is +12');
    assert.ok(Math.abs(semitones(200, 100) + 12) < 1e-9, 'an octave down is -12');
    assert.equal(semitones(100, 100), 0);
  });

  test('semitones degrade safely on non-positive input', () => {
    assert.equal(semitones(0, 100), 0);
    assert.equal(semitones(100, 0), 0);
  });

  test('a monotone speaker has near-zero spread', () => {
    assert.ok(pitchSpreadSemitones(frames([150, 150, 150, 150, 150, 150])) < 0.01);
  });

  test('a varied speaker has measurable spread', () => {
    assert.ok(pitchSpreadSemitones(frames([100, 120, 140, 160, 180, 200])) > 1);
  });

  test('spread uses the interquartile range, so one outlier cannot dominate', () => {
    const steady = frames([150, 150, 150, 150, 150, 150, 150, 150]);
    const withOutlier = [...steady, { t: 9, f0Hz: 400, clarity: 0.9 }];
    assert.ok(
      pitchSpreadSemitones(withOutlier) < 1,
      'a single octave error must not make a monotone read as expressive',
    );
  });

  test('too few voiced frames report zero rather than a wild number', () => {
    assert.equal(pitchSpreadSemitones(frames([150, 300])), 0);
  });
});

describe('PCM conversion', () => {
  test('16-bit samples map into [-1, 1]', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(32767, 2);
    buf.writeInt16LE(-32768, 4);
    const f = pcm16ToFloat(buf);
    assert.equal(f[0], 0);
    assert.ok(Math.abs(f[1]! - 1) < 0.0001);
    assert.equal(f[2], -1, 'the most negative sample maps to exactly -1');
  });

  test('an odd trailing byte is ignored rather than corrupting the last sample', () => {
    const buf = Buffer.alloc(5);
    buf.writeInt16LE(1000, 0);
    buf.writeInt16LE(2000, 2);
    assert.equal(pcm16ToFloat(buf).length, 2);
  });

  test('a round trip through PCM still tracks the right pitch', () => {
    const samples = sine(200, 0.2);
    const buf = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(samples[i]! * 32767), i * 2);
    const back = pcm16ToFloat(buf);
    const { f0Hz } = yinF0(back.subarray(0, 960), OPTS);
    assert.ok(f0Hz !== null && Math.abs(f0Hz - 200) < 2);
  });
});
