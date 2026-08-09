import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  autoTrim, applyHandles, snapCutsToFrames, DEFAULT_TRIM_OPTIONS,
} from '../src/autotrim/index.js';
import { cutsArrayOf } from '../src/cli/run.js';
import type { Transcript, Cut } from '../src/types.js';

/**
 * Cut records must be self-describing.
 *
 * A reviewer looking at forty proposals needs to know, without opening the
 * transcript, what each cut removes and how sure the engine is about it.
 */

type W = [text: string, start: number, end: number, confidence?: number];

function tx(words: W[], language = 'en', duration?: number): Transcript {
  return {
    language,
    provider: 'test',
    duration: duration ?? (words[words.length - 1]?.[2] ?? 0) + 0.4,
    hasWordTimings: true,
    words: words.map(([text, start, end, confidence]) => ({
      text, start, end, confidence: confidence ?? 0.97, type: 'word' as const,
    })),
  } as unknown as Transcript;
}

/** Fluent, no pauses. */
function fluent(texts: string[]): W[] {
  return texts.map((t, i) => [t, 0.2 + i * 0.35, 0.5 + i * 0.35] as W);
}

/** One transcript that triggers all four detectors at once. */
function everyDetector(): Transcript {
  return tx([
    ['hello', 0.2, 0.6],
    ['um', 0.7, 1.0],                 // filler, always tier
    ['matlab', 1.9, 2.2],             // filler, ambiguous tier, pause before it
    ['I', 2.3, 2.5], ['said', 2.55, 2.9],
    ['I', 3.4, 3.6], ['said', 3.65, 4.0],   // false start, 0.5s seam
    ['mumble', 4.1, 4.4, 0.1],        // low confidence
    ['end', 7.0, 7.4],                // long silence before this
  ], 'hi', 8);
}

describe('every cut carries every field', () => {
  const trim = autoTrim(everyDetector(), {
    ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true,
  });

  test('all four detectors fired, so this covers all of them', () => {
    const reasons = new Set(trim.cuts.map((c) => c.reason));
    for (const r of ['silence', 'filler', 'false_start', 'low_confidence']) {
      assert.ok(reasons.has(r as Cut['reason']), `${r} did not fire — fixture no longer covers it`);
    }
  });

  test('confidence is a real number in [0,1]', () => {
    for (const c of trim.cuts) {
      assert.ok(Number.isFinite(c.confidence), `${c.id} confidence is not finite`);
      assert.ok(c.confidence >= 0 && c.confidence <= 1, `${c.id} confidence ${c.confidence} out of range`);
    }
  });

  test('category always equals reason', () => {
    for (const c of trim.cuts) assert.equal(c.category, c.reason, `${c.id} category drifted`);
  });

  test('sourceWords is present on every cut', () => {
    for (const c of trim.cuts) assert.ok(Array.isArray(c.sourceWords), `${c.id} has no sourceWords`);
  });

  test('a cut that removes words names them', () => {
    const filler = trim.cuts.find((c) => c.reason === 'filler')!;
    assert.ok(filler.sourceWords.length > 0);
  });

  test('a pure-silence cut removes no words, so its list is empty', () => {
    const silence = trim.cuts.find((c) => c.reason === 'silence' && c.wordIndices.length === 0);
    assert.ok(silence, 'expected a silence cut spanning no word entries');
    assert.deepEqual(silence!.sourceWords, []);
  });
});

describe('sourceWords matches wordIndices', () => {
  test('same length, same order, same text', () => {
    const t = everyDetector();
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true });
    for (const c of trim.cuts) {
      const expected = c.wordIndices.map((i) => t.words[i]!.text).filter((s) => s.trim() !== '');
      assert.deepEqual(c.sourceWords, expected, `${c.id}: sourceWords does not match wordIndices`);
    }
  });

  test('a multi-word false start lists its words in order', () => {
    const t = tx([
      ['I', 0.2, 0.4], ['think', 0.45, 0.8],
      ['I', 1.3, 1.5], ['think', 1.55, 1.9], ['so', 1.95, 2.2],
    ]);
    const cut = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS }).cuts
      .find((c) => c.reason === 'false_start')!;
    assert.deepEqual(cut.sourceWords, ['I', 'think']);
  });
});

describe('confidence reflects the evidence', () => {
  test('a longer silence is a surer cut', () => {
    const short = autoTrim(tx([['a', 0.2, 0.5], ['b', 1.3, 1.6]]), { ...DEFAULT_TRIM_OPTIONS });
    const long = autoTrim(tx([['a', 0.2, 0.5], ['b', 5.0, 5.3]]), { ...DEFAULT_TRIM_OPTIONS });
    const s = short.cuts.find((c) => c.reason === 'silence')!;
    const l = long.cuts.find((c) => c.reason === 'silence')!;
    assert.ok(l.confidence > s.confidence, `long ${l.confidence} should beat short ${s.confidence}`);
  });

  test('an unambiguous filler outscores a real word cut on pause evidence', () => {
    const um = autoTrim(tx(fluent(['the', 'um', 'point'])), { ...DEFAULT_TRIM_OPTIONS })
      .cuts.find((c) => c.reason === 'filler')!;
    const matlab = autoTrim(tx([
      ['the', 0.2, 0.4], ['point', 0.45, 0.8], ['matlab', 1.4, 1.7], ['yeh', 1.75, 2.0],
    ], 'hi'), { ...DEFAULT_TRIM_OPTIONS }).cuts.find((c) => c.reason === 'filler')!;

    assert.ok(
      um.confidence > matlab.confidence,
      `"um" (${um.confidence}) should be a surer cut than "matlab" (${matlab.confidence})`,
    );
  });

  test('a real word cut never reaches the unambiguous tier, however long the pause', () => {
    const huge = autoTrim(tx([
      ['the', 0.2, 0.4], ['point', 0.45, 0.8], ['matlab', 9.0, 9.3], ['yeh', 9.35, 9.6],
    ], 'hi', 10), { ...DEFAULT_TRIM_OPTIONS });
    const m = huge.cuts.find((c) => c.reason === 'filler')!;
    assert.ok(m.confidence <= 0.85, `ambiguous filler reached ${m.confidence}`);
  });

  test('a longer repeated run is a surer false start', () => {
    const two = autoTrim(tx([
      ['I', 0.2, 0.4], ['think', 0.45, 0.8],
      ['I', 1.3, 1.5], ['think', 1.55, 1.9], ['so', 1.95, 2.2],
    ]), { ...DEFAULT_TRIM_OPTIONS }).cuts.find((c) => c.reason === 'false_start')!;

    const four = autoTrim(tx([
      ['I', 0.2, 0.4], ['think', 0.45, 0.8], ['that', 0.85, 1.1], ['we', 1.15, 1.4],
      ['I', 1.9, 2.1], ['think', 2.15, 2.5], ['that', 2.55, 2.8], ['we', 2.85, 3.1],
      ['should', 3.15, 3.5],
    ]), { ...DEFAULT_TRIM_OPTIONS }).cuts.find((c) => c.reason === 'false_start')!;

    assert.ok(four.confidence > two.confidence);
  });

  test('low-confidence cuts invert the ASR score', () => {
    const t = tx([['clear', 0.2, 0.5, 0.99], ['mush', 0.6, 0.9, 0.1]]);
    const c = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true })
      .cuts.find((x) => x.reason === 'low_confidence')!;
    assert.ok(Math.abs(c.confidence - 0.9) < 1e-6, `expected ~0.9, got ${c.confidence}`);
  });

  test('no cut claims certainty', () => {
    for (const c of autoTrim(everyDetector(), { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true }).cuts) {
      assert.ok(c.confidence < 1, `${c.id} claims confidence 1.0`);
    }
  });
});

describe('merging combines the fields safely', () => {
  test('a merged cut takes the MINIMUM confidence of its parts', () => {
    // Overlapping silence (high) and low-confidence (low) on the same span.
    const t = tx([['a', 0.2, 0.5], ['mush', 0.6, 0.9, 0.05], ['b', 3.0, 3.3]], 'en', 4);
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true });
    for (const c of trim.cuts) {
      if (c.label.includes(' + ')) {
        assert.ok(c.confidence <= 0.95, 'merged cut inherited an optimistic score');
      }
    }
  });

  test('a merged cut unions its words, in transcript order, without duplicates', () => {
    const t = tx([
      ['one', 0.2, 0.5], ['um', 0.55, 0.8], ['uh', 0.85, 1.1], ['two', 1.15, 1.5],
    ]);
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    for (const c of trim.cuts) {
      assert.equal(new Set(c.wordIndices).size, c.wordIndices.length, 'duplicate indices');
      const sorted = [...c.wordIndices].sort((a, b) => a - b);
      assert.deepEqual(c.wordIndices, sorted, 'indices out of order');
      assert.equal(c.sourceWords.length, c.wordIndices.length);
    }
  });

  test('merging never drops category', () => {
    for (const c of autoTrim(everyDetector(), { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true }).cuts) {
      assert.equal(c.category, c.reason);
    }
  });
});

describe('handles and frame snapping preserve the fields', () => {
  const trim = autoTrim(everyDetector(), { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true });

  test('applyHandles keeps confidence, category and sourceWords', () => {
    for (const c of applyHandles(trim, 0.04).cuts) {
      assert.ok(c.confidence > 0);
      assert.equal(c.category, c.reason);
      assert.ok(Array.isArray(c.sourceWords));
    }
  });

  test('snapCutsToFrames keeps confidence, category and sourceWords', () => {
    for (const c of snapCutsToFrames(applyHandles(trim, 0.04), 30).cuts) {
      assert.ok(c.confidence > 0);
      assert.equal(c.category, c.reason);
      assert.ok(Array.isArray(c.sourceWords));
    }
  });

  test('shaping does not change any confidence value', () => {
    const shaped = snapCutsToFrames(applyHandles(trim, 0.04), 30);
    for (const c of shaped.cuts) {
      const original = trim.cuts.find((o) => o.id === c.id)!;
      assert.equal(c.confidence, original.confidence, `${c.id} confidence changed during shaping`);
    }
  });
});

describe('--min-cut-confidence', () => {
  test('0 proposes everything', () => {
    const all = autoTrim(everyDetector(), { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true, minCutConfidence: 0 });
    assert.ok(all.cuts.length > 0);
  });

  test('a high threshold drops the ambiguous filler and keeps the unambiguous one', () => {
    const t = tx([
      ['the', 0.2, 0.4], ['um', 0.45, 0.7], ['point', 0.75, 1.1],
      ['matlab', 1.7, 2.0], ['yeh', 2.05, 2.3],
    ], 'hi');
    const strict = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, minCutConfidence: 0.9 });
    const words = strict.cuts.flatMap((c) => c.sourceWords);
    assert.ok(words.includes('um'), '"um" (0.95) should survive a 0.9 threshold');
    assert.ok(!words.includes('matlab'), '"matlab" (<0.9) should be suppressed');
  });

  test('a threshold of 1 suppresses everything — nothing claims certainty', () => {
    const none = autoTrim(everyDetector(), { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true, minCutConfidence: 1 });
    assert.equal(none.cuts.length, 0);
    assert.equal(none.secondsRemoved, 0);
    assert.equal(none.trimmedDuration, none.originalDuration);
  });

  test('suppressed cuts do not distort the reported duration', () => {
    const t = everyDetector();
    const strict = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, minCutConfidence: 0.9 });
    const sum = strict.cuts.reduce((n, c) => n + (c.end - c.start), 0);
    assert.ok(Math.abs(sum - strict.secondsRemoved) < 0.01);
    assert.ok(Math.abs(strict.trimmedDuration - (strict.originalDuration - sum)) < 0.01);
  });

  test('raising the threshold never increases the number of cuts', () => {
    const t = everyDetector();
    let previous = Infinity;
    for (const threshold of [0, 0.5, 0.7, 0.9, 1]) {
      const n = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, removeLowConfidence: true, minCutConfidence: threshold }).cuts.length;
      assert.ok(n <= previous, `threshold ${threshold} produced more cuts than the previous one`);
      previous = n;
    }
  });
});

describe('backwards compatibility with older cut files', () => {
  test('a bare array without the new fields still parses', () => {
    const legacy = [{ id: 'filler-1', start: 1, end: 2, reason: 'filler', label: 'x', wordIndices: [1], restored: true }];
    assert.deepEqual(cutsArrayOf(legacy), legacy);
  });

  test('a stamped document without the new fields still parses', () => {
    const doc = { _engine: { v: 1 }, cuts: [{ id: 'filler-1', restored: true }] };
    assert.equal(cutsArrayOf(doc).length, 1);
  });

  test('a review from an older version still restores by id', () => {
    // The only fields a review file needs are id and restored — everything else
    // is recomputed. That is what makes old files safe to read.
    const t = everyDetector();
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    const legacy = trim.cuts.map((c) => ({ id: c.id, restored: true }));

    const byId = new Map(cutsArrayOf(legacy).map((c) => [c.id, Boolean(c.restored)]));
    for (const c of trim.cuts) {
      const r = byId.get(c.id);
      if (r !== undefined) c.restored = r;
    }
    assert.ok(trim.cuts.every((c) => c.restored));
  });

  test('a garbage document is rejected with a usable message', () => {
    assert.throws(() => cutsArrayOf({ nope: true }), /array of cuts/);
    assert.throws(() => cutsArrayOf('string'), /array of cuts/);
  });
});
