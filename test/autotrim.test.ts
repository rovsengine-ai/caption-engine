import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autoTrim, applyTrim, keepSegments, matchFiller } from '../src/autotrim/index.js';
import { hinglishTranscript, teluguTranscript, silentTranscript } from './fixtures.js';

describe('filler lexicon', () => {
  test('matches English always-fillers', () => {
    assert.equal(matchFiller('um', 'en').isFiller, true);
    assert.equal(matchFiller('um', 'en').ambiguous, false);
    assert.equal(matchFiller('Uh,', 'en').isFiller, true, 'strips punctuation and case');
  });

  test('treats "matlab" as ambiguous, not always-cut', () => {
    const m = matchFiller('matlab', 'hi');
    assert.equal(m.isFiller, true);
    assert.equal(m.ambiguous, true, 'matlab is also a real word meaning "meaning"');
  });

  test('matches Telugu "ante" in both scripts', () => {
    assert.equal(matchFiller('అంటే', 'te').ambiguous, true);
    assert.equal(matchFiller('ante', 'te').ambiguous, true);
  });

  test('Hindi context still catches English fillers (code-switching)', () => {
    assert.equal(matchFiller('um', 'hi').isFiller, true);
  });

  test('does not flag ordinary words', () => {
    assert.equal(matchFiller('important', 'hi').isFiller, false);
    assert.equal(matchFiller('success', 'en').isFiller, false);
  });
});

describe('autoTrim', () => {
  const trim = autoTrim(hinglishTranscript);

  test('finds the long mid-video silence', () => {
    const silences = trim.cuts.filter((c) => c.reason === 'silence');
    assert.ok(silences.length > 0, 'expected at least one silence cut');
    const big = silences.find((c) => c.start > 7 && c.end < 10.5);
    assert.ok(big, `expected a silence around 7.3-10.3s, got ${JSON.stringify(silences)}`);
  });

  test('cuts the always-filler "um"', () => {
    const cut = trim.cuts.find((c) => c.label.includes('um'));
    assert.ok(cut, 'expected "um" to be cut');
  });

  test('cuts "matlab" when it follows a pause (hesitation)', () => {
    const hit = trim.cuts.some(
      (c) => c.reason === 'filler' && c.start >= 4.9 && c.start <= 5.1,
    );
    assert.ok(hit, 'the 5.0s "matlab" follows a 0.7s pause and should be cut');
  });

  test('does NOT cut "matlab" used as a real word mid-sentence', () => {
    const wrong = trim.cuts.some(
      (c) => c.reason === 'filler' && c.start >= 10.6 && c.start <= 10.8,
    );
    assert.equal(wrong, false, 'the 10.7s "matlab" means "meaning" — cutting it breaks the sentence');
  });

  test('detects the repeated take "aaj main"', () => {
    const fs = trim.cuts.filter((c) => c.reason === 'false_start');
    assert.ok(fs.length > 0, 'expected a false-start cut');
    assert.ok(
      fs.some((c) => c.start < 1.3),
      'should cut the FIRST attempt and keep the second',
    );
  });

  test('reports a sane duration reduction', () => {
    assert.ok(trim.secondsRemoved > 0);
    assert.ok(
      trim.trimmedDuration < trim.originalDuration,
      'trimmed must be shorter than original',
    );
    assert.ok(trim.trimmedDuration > 0, 'must not trim everything away');
  });

  test('cuts never overlap after merging', () => {
    const sorted = [...trim.cuts].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i]!.start >= sorted[i - 1]!.end,
        `cut ${i} overlaps previous: ${JSON.stringify([sorted[i - 1], sorted[i]])}`,
      );
    }
  });

  test('every cut is reviewable and restorable', () => {
    for (const c of trim.cuts) {
      assert.equal(c.restored, false, 'cuts start un-restored');
      assert.ok(c.label.length > 0, 'every cut needs a human-readable label');
      assert.ok(c.id.length > 0);
    }
  });

  test('handles a transcript with no speech without crashing', () => {
    const t = autoTrim(silentTranscript);
    assert.equal(t.cuts.length, 0);
    assert.equal(t.secondsRemoved, 0);
  });

  test('Telugu: cuts "ante" after a pause but not mid-flow', () => {
    const t = autoTrim(teluguTranscript);
    const cutAt16 = t.cuts.some((c) => c.reason === 'filler' && c.start >= 1.5 && c.start <= 1.7);
    const cutAt31 = t.cuts.some((c) => c.reason === 'filler' && c.start >= 3.0 && c.start <= 3.2);
    assert.ok(cutAt16, 'the 1.6s "ante" follows a pause and should be cut');
    assert.equal(cutAt31, false, 'the 3.1s "ante" is mid-flow and should be kept');
  });
});

describe('restore', () => {
  test('restoring a cut removes it from the applied timeline', () => {
    const trim = autoTrim(hinglishTranscript);
    const before = keepSegments(trim).length;

    const target = trim.cuts.find((c) => c.reason === 'silence');
    assert.ok(target);
    target.restored = true;

    const after = keepSegments(trim).length;
    assert.ok(after < before, 'restoring a cut should merge segments back together');
  });
});

describe('applyTrim re-timing', () => {
  test('surviving words shift earlier onto the trimmed timeline', () => {
    const trim = autoTrim(hinglishTranscript);
    const applied = applyTrim(hinglishTranscript, trim);

    const original = hinglishTranscript.words.find((x) => x.text === 'success.')!;
    const shifted = applied.words.find((x) => x.text === 'success.')!;

    assert.equal(shifted.keep, true);
    assert.ok(
      shifted.start < original.start,
      `expected shift earlier: ${original.start} -> ${shifted.start}`,
    );
  });

  test('word order and duration are preserved for kept words', () => {
    const trim = autoTrim(hinglishTranscript);
    const applied = applyTrim(hinglishTranscript, trim);
    const kept = applied.words.filter((x) => x.keep);

    for (let i = 1; i < kept.length; i++) {
      assert.ok(
        kept[i]!.start >= kept[i - 1]!.start,
        'kept words must stay in chronological order',
      );
    }
    for (const k of kept) {
      assert.ok(k.end > k.start, `word "${k.text}" has non-positive duration`);
    }
  });

  test('cut words are marked keep:false, not deleted', () => {
    const trim = autoTrim(hinglishTranscript);
    const applied = applyTrim(hinglishTranscript, trim);
    assert.equal(
      applied.words.length,
      hinglishTranscript.words.length,
      'words are marked, never removed — restore depends on this',
    );
    assert.ok(applied.words.some((x) => x.keep === false));
  });
});

describe('keepSegments', () => {
  test('segments are ordered, non-overlapping and within bounds', () => {
    const trim = autoTrim(hinglishTranscript);
    const segs = keepSegments(trim);
    assert.ok(segs.length > 0);

    for (let i = 0; i < segs.length; i++) {
      assert.ok(segs[i]!.end > segs[i]!.start, 'segment must have positive length');
      assert.ok(segs[i]!.start >= 0);
      assert.ok(segs[i]!.end <= trim.originalDuration + 0.001);
      if (i > 0) assert.ok(segs[i]!.start >= segs[i - 1]!.end);
    }
  });

  test('total kept time matches the reported trimmed duration', () => {
    const trim = autoTrim(hinglishTranscript);
    const total = keepSegments(trim).reduce((n, s) => n + (s.end - s.start), 0);
    assert.ok(
      Math.abs(total - trim.trimmedDuration) < 0.05,
      `kept ${total.toFixed(3)}s vs reported ${trim.trimmedDuration}s`,
    );
  });
});
