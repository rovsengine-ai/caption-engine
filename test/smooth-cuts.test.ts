import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoTrim, applyTrim, applyHandles, snapCutsToFrames, keepSegments,
  DEFAULT_TRIM_OPTIONS, DEFAULT_CUT_HANDLE_SEC,
} from '../src/autotrim/index.js';
import { buildBaseArgs, DEFAULT_CUT_FADE_SEC } from '../src/render/pipeline.js';
import type { Transcript, TrimResult, Cut } from '../src/types.js';

function cut(over: Partial<Cut>): Cut {
  return {
    id: 'c1', start: 1.0, end: 2.0, reason: 'filler',
    label: 'filler', wordIndices: [1], restored: false, ...over,
  };
}

function trimOf(cuts: Cut[], originalDuration = 10): TrimResult {
  const removed = cuts.filter((c) => !c.restored).reduce((n, c) => n + (c.end - c.start), 0);
  return { cuts, secondsRemoved: removed, originalDuration, trimmedDuration: originalDuration - removed };
}

describe('audio handles', () => {
  test('a speech cut shrinks by the handle on both sides', () => {
    const r = applyHandles(trimOf([cut({ start: 1.0, end: 2.0 })]), 0.04);
    assert.equal(r.cuts[0]!.start, 1.04);
    assert.equal(r.cuts[0]!.end, 1.96);
  });

  test('handles only ever remove LESS, so they cannot create a mid-word cut', () => {
    const before = trimOf([cut({ start: 1.0, end: 2.0 })]);
    const after = applyHandles(before, 0.04);
    assert.ok(after.secondsRemoved < before.secondsRemoved);
    assert.ok(after.cuts[0]!.start >= before.cuts[0]!.start);
    assert.ok(after.cuts[0]!.end <= before.cuts[0]!.end);
  });

  test('silence cuts are left alone — they already carry padding', () => {
    const r = applyHandles(trimOf([cut({ reason: 'silence', start: 1, end: 3 })]), 0.04);
    assert.equal(r.cuts[0]!.start, 1);
    assert.equal(r.cuts[0]!.end, 3);
  });

  test('a cut narrower than two handles is dropped entirely', () => {
    const r = applyHandles(trimOf([cut({ start: 1.0, end: 1.05 })]), 0.04);
    assert.equal(r.cuts.length, 0);
    assert.equal(r.secondsRemoved, 0);
  });

  test('zero handles is an exact no-op', () => {
    const before = trimOf([cut({})]);
    assert.deepEqual(applyHandles(before, 0), before);
  });

  test('trimmedDuration is recomputed, not left stale', () => {
    const r = applyHandles(trimOf([cut({ start: 1, end: 2 })], 10), 0.04);
    assert.equal(r.trimmedDuration, 10 - r.secondsRemoved);
  });

  test('restored cuts do not contribute to the new duration', () => {
    const r = applyHandles(trimOf([cut({ restored: true, start: 1, end: 2 })], 10), 0.04);
    assert.equal(r.secondsRemoved, 0);
    assert.equal(r.trimmedDuration, 10);
  });
});

describe('handles keep captions and audio on the same timeline', () => {
  function tx(): Transcript {
    return {
      language: 'en', provider: 'test', duration: 6, hasWordTimings: true,
      words: [
        { text: 'one', start: 0.2, end: 0.6, confidence: 0.9, type: 'word' },
        { text: 'um', start: 1.0, end: 1.4, confidence: 0.9, type: 'word' },
        { text: 'two', start: 1.8, end: 2.2, confidence: 0.9, type: 'word' },
        { text: 'three', start: 2.5, end: 3.0, confidence: 0.9, type: 'word' },
      ],
    } as unknown as Transcript;
  }

  test('kept segments and the shifted caption times agree exactly', () => {
    const trim = autoTrim(tx(), { ...DEFAULT_TRIM_OPTIONS });
    const handled = applyHandles(trim, DEFAULT_CUT_HANDLE_SEC);

    const segs = keepSegments(handled);
    const shifted = applyTrim(tx(), handled);

    // Total kept audio must equal the trimmed transcript duration.
    const keptAudio = segs.reduce((n, s) => n + (s.end - s.start), 0);
    assert.ok(
      Math.abs(keptAudio - handled.trimmedDuration) < 0.01,
      `kept audio ${keptAudio}s vs trimmed duration ${handled.trimmedDuration}s`,
    );

    // Every surviving word must land inside the new duration, in order.
    const kept = shifted.words.filter((w) => w.keep !== false);
    let last = -1;
    for (const w of kept) {
      assert.ok(w.start >= last, 'word order or timing went backwards');
      assert.ok(w.end <= handled.trimmedDuration + 0.01, `${w.text} lands past the end`);
      last = w.start;
    }
  });

  test('restoring every cut reproduces the original duration exactly', () => {
    const trim = autoTrim(tx(), { ...DEFAULT_TRIM_OPTIONS });
    for (const c of trim.cuts) c.restored = true;
    const handled = applyHandles(trim, DEFAULT_CUT_HANDLE_SEC);
    assert.equal(handled.trimmedDuration, handled.originalDuration);
  });
});

describe('frame snapping', () => {
  test('boundaries land on the frame grid', () => {
    const r = snapCutsToFrames(trimOf([cut({ start: 1.017, end: 1.983 })]), 30);
    const frame = 1 / 30;
    for (const v of [r.cuts[0]!.start, r.cuts[0]!.end]) {
      assert.ok(Math.abs(v / frame - Math.round(v / frame)) < 0.02, `${v} is not on the 30fps grid`);
    }
  });

  test('start rounds up and end rounds down, so it only ever cuts LESS', () => {
    const before = trimOf([cut({ start: 1.017, end: 1.983 })]);
    const after = snapCutsToFrames(before, 30);
    assert.ok(after.cuts[0]!.start >= before.cuts[0]!.start);
    assert.ok(after.cuts[0]!.end <= before.cuts[0]!.end);
  });

  test('a cut shorter than one frame is dropped', () => {
    const r = snapCutsToFrames(trimOf([cut({ start: 1.0, end: 1.01 })]), 30);
    assert.equal(r.cuts.length, 0);
  });

  test('unknown or invalid fps is a no-op rather than a crash', () => {
    const before = trimOf([cut({})]);
    assert.deepEqual(snapCutsToFrames(before, undefined), before);
    assert.deepEqual(snapCutsToFrames(before, 0), before);
    assert.deepEqual(snapCutsToFrames(before, NaN), before);
  });

  test('handles then snapping compose without ever cutting more', () => {
    const before = trimOf([cut({ start: 1.0, end: 2.0 })]);
    const after = snapCutsToFrames(applyHandles(before, 0.04), 30);
    assert.ok(after.secondsRemoved <= before.secondsRemoved);
    assert.ok(after.cuts[0]!.start >= before.cuts[0]!.start);
    assert.ok(after.cuts[0]!.end <= before.cuts[0]!.end);
  });
});

describe('cut fades in the filter graph', () => {
  const job = {
    inputPath: 'in.mp4', outputPath: 'out.mp4', width: 1080, height: 1920, durationSec: 10,
    segments: [
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ],
  };

  test('internal joins get a fade out and a fade in', () => {
    const g = buildBaseArgs(job as never, 'out.mp4').join(' ');
    assert.match(g, /afade=t=out/, 'no fade-out at an internal join');
    assert.match(g, /afade=t=in/, 'no fade-in at an internal join');
  });

  test('the clip does not fade up at its own start or down at its own end', () => {
    const parts = buildBaseArgs(job as never, 'out.mp4')
      .join(' ')
      .split(';')
      .filter((p) => p.includes('atrim'));
    assert.equal(parts.length, 3);
    assert.ok(!parts[0]!.includes('afade=t=in'), 'first segment should not fade in');
    assert.ok(!parts[2]!.includes('afade=t=out'), 'last segment should not fade out');
    assert.ok(parts[1]!.includes('afade=t=in') && parts[1]!.includes('afade=t=out'));
  });

  test('a fade never overlaps itself on a very short segment', () => {
    const short = { ...job, segments: [{ start: 0, end: 2 }, { start: 3, end: 3.02 }, { start: 4, end: 6 }] };
    const g = buildBaseArgs(short as never, 'out.mp4');
    const seg = g.join(' ').split(';').filter((p) => p.includes('atrim'))[1]!;
    const d = Number(/afade=t=in:st=0:d=([\d.]+)/.exec(seg)?.[1]);
    assert.ok(d <= 0.02 / 3 + 1e-6, `fade ${d}s is too long for a 0.02s segment`);
  });

  test('cutFadeSec 0 emits no fades at all', () => {
    const g = buildBaseArgs({ ...job, cutFadeSec: 0 } as never, 'out.mp4').join(' ');
    assert.ok(!g.includes('afade'));
  });

  test('fades do not change any trim boundary', () => {
    // The whole safety argument: afade shapes level, it does not move time.
    const withFade = buildBaseArgs(job as never, 'out.mp4').join(' ');
    const without = buildBaseArgs({ ...job, cutFadeSec: 0 } as never, 'out.mp4').join(' ');
    const trims = (s: string) => s.match(/a?trim=start=[\d.]+:end=[\d.]+/g) ?? [];
    assert.deepEqual(trims(withFade), trims(without));
  });

  test('no segments means no fades and no trims', () => {
    const g = buildBaseArgs({ ...job, segments: [] } as never, 'out.mp4').join(' ');
    assert.ok(!g.includes('afade'));
    assert.ok(!g.includes('atrim'));
  });

  test('the default fade is short enough to be inaudible', () => {
    assert.ok(DEFAULT_CUT_FADE_SEC > 0 && DEFAULT_CUT_FADE_SEC <= 0.02);
  });
});
