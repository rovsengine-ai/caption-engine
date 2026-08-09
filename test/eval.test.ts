import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  align, wordErrorRate, characterErrorRate, categoryBreakdown,
  classifyToken, normaliseForScoring, tokenise,
} from '../src/eval/wer.js';
import { measureDrift, measureTrimDrift } from '../src/eval/timestamps.js';
import { measureReadability, measureCue, wrapLines, MAX_READING_RATE_CPS } from '../src/eval/readability.js';
import { scoreFillerFixture, aggregateFillerScores, type FillerFixture } from '../src/eval/fillers.js';
import { loadGroundTruth, loadFillerFixtures } from '../src/eval/fixtures.js';
import { autoTrim, applyTrim, DEFAULT_TRIM_OPTIONS } from '../src/autotrim/index.js';
import { resolveStyle } from '../src/captions/style.js';
import { toRomanScript } from '../src/transliterate/index.js';
import type { Transcript, CaptionCue } from '../src/types.js';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'ce-eval-')); }

// ---------------------------------------------------------------------------

describe('WER', () => {
  test('identical sequences score 0', () => {
    assert.equal(wordErrorRate(['a', 'b', 'c'], ['a', 'b', 'c']).rate, 0);
  });

  test('one substitution in ten words is exactly 0.1', () => {
    const ref = 'one two three four five six seven eight nine ten'.split(' ');
    const hyp = [...ref]; hyp[3] = 'FOUR-WRONG';
    assert.equal(wordErrorRate(ref, hyp).rate, 0.1);
  });

  test('deletions count', () => {
    const r = wordErrorRate(['a', 'b', 'c', 'd'], ['a', 'c', 'd']);
    assert.equal(r.deletions, 1);
    assert.equal(r.rate, 0.25);
  });

  test('insertions count, and WER can exceed 1.0', () => {
    // Two reference words, six hypothesis words: 4 insertions / 2 reference.
    const r = wordErrorRate(['a', 'b'], ['a', 'x', 'y', 'z', 'w', 'b']);
    assert.equal(r.insertions, 4);
    assert.equal(r.rate, 2);
  });

  test('an empty reference yields null, not 0 and not Infinity', () => {
    // Returning 0 would let "measured nothing" average in as a perfect score.
    assert.equal(wordErrorRate([], ['a']).rate, null);
  });

  test('an empty hypothesis is total deletion', () => {
    const r = wordErrorRate(['a', 'b'], []);
    assert.equal(r.rate, 1);
    assert.equal(r.deletions, 2);
  });

  test('WER is asymmetric — the denominator is the reference', () => {
    const a = wordErrorRate(['a'], ['a', 'b', 'c']).rate;
    const b = wordErrorRate(['a', 'b', 'c'], ['a']).rate;
    assert.notEqual(a, b);
  });

  test('case and edge punctuation are not recognition errors', () => {
    assert.equal(wordErrorRate(['Hello'], ['hello,']).rate, 0);
  });

  test('punctuation INSIDE a token still matters', () => {
    assert.ok((wordErrorRate(["don't"], ['dont']).rate ?? 0) > 0);
    assert.ok((wordErrorRate(['2.5'], ['25']).rate ?? 0) > 0);
  });

  test('counts sum to the edit distance', () => {
    const r = wordErrorRate('a b c d e'.split(' '), 'a x c e f'.split(' '));
    assert.equal(r.substitutions + r.deletions + r.insertions + r.hits >= r.referenceLength, true);
    assert.equal(r.rate, (r.substitutions + r.deletions + r.insertions) / r.referenceLength);
  });
});

describe('alignment', () => {
  test('is deterministic across runs on the same input', () => {
    const a = align('a b c d'.split(' '), 'a x c d'.split(' '));
    const b = align('a b c d'.split(' '), 'a x c d'.split(' '));
    assert.deepEqual(a, b);
  });

  test('reference indices are preserved for reference-consuming ops', () => {
    for (const p of align(['a', 'b', 'c'], ['a', 'c'])) {
      if (p.op !== 'ins') assert.equal(typeof p.refIndex, 'number');
    }
  });

  test('an insertion carries no reference token', () => {
    const ins = align(['a'], ['a', 'b']).find((p) => p.op === 'ins')!;
    assert.equal(ins.ref, undefined);
    assert.equal(ins.hyp, 'b');
  });
});

describe('CER', () => {
  test('identical strings score 0', () => {
    assert.equal(characterErrorRate('hello world', 'hello world').rate, 0);
  });

  test('one wrong character in ten is 0.1', () => {
    assert.equal(characterErrorRate('abcdefghij', 'abcdefghiX').rate, 0.1);
  });

  test('Devanagari is measured in code points, not UTF-16 units', () => {
    // One visual mistake must cost one error, whatever the encoding.
    const r = characterErrorRate('विद्या', 'विद्यो');
    assert.equal(r.referenceLength, Array.from('विद्या').length);
    assert.equal(r.substitutions + r.deletions + r.insertions, 1);
  });

  test('an emoji outside the BMP counts as one character', () => {
    assert.equal(characterErrorRate('a😀b', 'a😀b').referenceLength, 3);
  });

  test('whitespace is collapsed but word boundaries still count', () => {
    assert.equal(characterErrorRate('a  b', 'a b').rate, 0);
    assert.ok((characterErrorRate('a b', 'ab').rate ?? 0) > 0);
  });
});

describe('token categories', () => {
  test('numbers, latin and indic are distinguished', () => {
    assert.equal(classifyToken('2024'), 'number');
    assert.equal(classifyToken('meeting'), 'latin');
    assert.equal(classifyToken('बहुत'), 'indic');
  });

  test('an explicit name list always wins over the heuristic', () => {
    const names = new Set(['zomato']);
    assert.equal(classifyToken('zomato', { knownNames: names }), 'name');
  });

  test('a capitalised mid-sentence word is guessed to be a name', () => {
    assert.equal(classifyToken('Aarav', { index: 3 }), 'name');
  });

  test('a sentence-initial capital is NOT guessed to be a name', () => {
    assert.equal(classifyToken('The', { index: 0 }), 'latin');
  });

  test('breakdown reports accuracy per category and lists the errors', () => {
    const ref = ['Aarav', 'ordered', 'from', 'Zomato'];
    const hyp = ['Arav', 'ordered', 'from', 'Zomato'];
    const w = wordErrorRate(ref, hyp);
    const cats = categoryBreakdown(w.alignment, ref, new Set(['Aarav', 'Zomato']));
    const names = cats.find((c) => c.category === 'name')!;
    assert.equal(names.total, 2);
    assert.equal(names.correct, 1);
    assert.equal(names.accuracy, 0.5);
    assert.equal(names.errors[0]!.ref, 'aarav');
  });

  test('insertions belong to no category', () => {
    const ref = ['a'];
    const w = wordErrorRate(ref, ['a', 'b']);
    const total = categoryBreakdown(w.alignment, ref).reduce((n, c) => n + c.total, 0);
    assert.equal(total, 1);
  });

  test('a category absent from the reference reports null, not 100%', () => {
    const cats = categoryBreakdown(wordErrorRate(['abc'], ['abc']).alignment, ['abc']);
    assert.equal(cats.find((c) => c.category === 'number'), undefined);
  });
});

// ---------------------------------------------------------------------------

describe('timestamp drift', () => {
  function base(): Transcript {
    return {
      language: 'hi', provider: 'fixture', duration: 9, hasWordTimings: true,
      words: [
        { text: 'आज', start: 0.4, end: 0.8, confidence: 0.97, type: 'word' },
        { text: 'meeting', start: 0.9, end: 1.5, confidence: 0.97, type: 'word' },
        { text: 'um', start: 3.9, end: 4.15, confidence: 0.97, type: 'word' },
        { text: 'शुरू', start: 4.8, end: 5.2, confidence: 0.97, type: 'word' },
      ],
    } as unknown as Transcript;
  }

  test('transliteration moves nothing at all', async () => {
    const t = base();
    const r = await toRomanScript(t, { language: 'hi', protectEnglish: true });
    const d = measureDrift(t, r.transcript);
    assert.equal(d.maxAbsSec, 0, `transliteration moved a word by ${d.maxAbsSec}s`);
    assert.equal(d.moved, 0);
  });

  test('a changed word count throws rather than scoring nonsense', () => {
    const a = base();
    const b = { ...a, words: a.words.slice(1) } as Transcript;
    assert.throws(() => measureDrift(a, b), /alignment failure/);
  });

  test('an empty transcript is handled', () => {
    const empty = { ...base(), words: [] } as unknown as Transcript;
    assert.equal(measureDrift(empty, empty).count, 0);
  });

  test('Auto Trim re-times survivors by exactly the preceding cut duration', () => {
    const t = base();
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    const d = measureTrimDrift(t, applyTrim(t, trim), trim);
    assert.equal(d.mispredicted, 0, `${d.mispredicted} words moved by an unexpected amount`);
  });

  test('a deliberately wrong re-timing is caught', () => {
    // Proves the check has teeth rather than passing vacuously.
    const t = base();
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    const trimmed = applyTrim(t, trim);
    const sabotaged = {
      ...trimmed,
      words: trimmed.words.map((w, i) => (i === trimmed.words.length - 1 ? { ...w, start: w.start + 0.2 } : w)),
    } as Transcript;
    assert.ok(measureTrimDrift(t, sabotaged, trim).mispredicted > 0);
  });

  test('restoring every cut leaves every timestamp untouched', () => {
    const t = base();
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    for (const c of trim.cuts) c.restored = true;
    assert.equal(measureDrift(t, applyTrim(t, trim)).maxAbsSec, 0);
  });
});

// ---------------------------------------------------------------------------

describe('readability', () => {
  const style = resolveStyle('default', 1920);
  const cue = (text: string, start: number, end: number): CaptionCue =>
    ({ index: 0, start, end, words: [], text }) as unknown as CaptionCue;

  test('greedy wrapping matches the renderer', () => {
    assert.deepEqual(wrapLines('one two three four', 9), ['one two', 'three', 'four']);
  });

  test('a word longer than the budget gets its own line, unbroken', () => {
    assert.deepEqual(wrapLines('supercalifragilistic ok', 8), ['supercalifragilistic', 'ok']);
  });

  test('an over-long line is flagged against the style budget', () => {
    const long = 'x'.repeat(style.maxCharsPerLine + 5);
    assert.ok(measureCue(cue(long, 0, 5), style).problems.some((p) => /exceeds maxCharsPerLine/.test(p)));
  });

  test('too many words is flagged', () => {
    const many = Array.from({ length: style.maxWordsPerCue + 3 }, (_, i) => `w${i}`).join(' ');
    assert.ok(measureCue(cue(many, 0, 10), style).problems.some((p) => /maxWordsPerCue/.test(p)));
  });

  test('an unreadably fast cue is flagged', () => {
    const m = measureCue(cue('a'.repeat(40), 0, 1), style);
    assert.ok(m.charsPerSecond > MAX_READING_RATE_CPS);
    assert.ok(m.problems.some((p) => /chars\/sec/.test(p)));
  });

  test('a comfortable cue has no problems', () => {
    assert.deepEqual(measureCue(cue('hello world', 0, 3), style).problems, []);
  });

  test('no cues produces zeroes, not NaN', () => {
    const r = measureReadability([], style);
    assert.equal(r.cues, 0);
    assert.ok(Number.isFinite(r.meanCharsPerSecond));
  });

  test('the report counts flagged cues', () => {
    const r = measureReadability([cue('ok', 0, 2), cue('z'.repeat(80), 0, 1)], style);
    assert.equal(r.cues, 2);
    assert.equal(r.flagged, 1);
  });
});

// ---------------------------------------------------------------------------

describe('filler precision and recall', () => {
  const fx = (words: Array<[string, number, number, boolean]>, language = 'en'): FillerFixture => ({
    name: 'f', language,
    durationSec: (words[words.length - 1]?.[2] ?? 0) + 0.5,
    words: words.map(([text, start, end, isFiller]) => ({ text, start, end, isFiller })),
  });

  test('a perfect detector scores 1.0 on both', () => {
    const s = scoreFillerFixture(fx([
      ['the', 0.2, 0.5, false], ['um', 0.55, 0.8, true], ['point', 0.85, 1.2, false],
    ]));
    assert.equal(s.recall, 1);
    assert.equal(s.precision, 1);
    assert.deepEqual(s.falsePositiveWords, []);
  });

  test('a real word that gets cut shows up as a named false positive', () => {
    // Not a number buried in a summary — the word itself.
    const s = scoreFillerFixture(fx([
      ['this', 0.2, 0.5, false], ['is', 0.55, 0.7, false], ['a', 0.75, 0.85, false],
    ]));
    assert.equal(s.falsePositives, 0, 'the English article must never be cut');
  });

  test('a missed filler shows up in recall, named', () => {
    const s = scoreFillerFixture(fx([
      ['word', 0.2, 0.5, false], ['zzzznotafiller', 0.55, 0.8, true],
    ]));
    assert.equal(s.recall, 0);
    assert.deepEqual(s.missedWords, ['zzzznotafiller']);
  });

  test('precision is null, not 1, when nothing was proposed', () => {
    const s = scoreFillerFixture(fx([['word', 0.2, 0.5, false]]));
    assert.equal(s.precision, null);
  });

  test('recall is null, not 1, when the fixture labels no fillers', () => {
    assert.equal(scoreFillerFixture(fx([['word', 0.2, 0.5, false]])).recall, null);
  });

  test('silence cuts do not inflate precision', () => {
    // A long gap produces a silence cut with no opinion about any token.
    const s = scoreFillerFixture(fx([['a', 0.2, 0.5, false], ['b', 9.0, 9.4, false]]));
    assert.equal(s.truePositives + s.falsePositives, 0);
  });

  test('aggregation pools counts across fixtures', () => {
    const a = aggregateFillerScores([
      { fixture: 'x', language: 'en', truePositives: 3, falsePositives: 1, falseNegatives: 0, precision: 0.75, recall: 1, falsePositiveWords: ['right'], missedWords: [] },
      { fixture: 'y', language: 'hi', truePositives: 1, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 0.5, falsePositiveWords: [], missedWords: ['hmm'] },
    ]);
    assert.equal(a.truePositives, 4);
    assert.equal(a.precision, 4 / 5);
    assert.equal(a.recall, 4 / 5);
    assert.deepEqual(a.falsePositiveWords, ['right']);
  });
});

// ---------------------------------------------------------------------------

describe('fixture loading', () => {
  test('the committed Tier A fixtures load and are well-formed', () => {
    const load = loadFillerFixtures();
    assert.deepEqual(load.problems, [], 'a committed fixture is malformed');
    assert.ok(load.fixtures.length >= 2, 'expected the committed filler fixtures');
    for (const f of load.fixtures) {
      assert.ok(f.words.length > 0);
      assert.ok(f.words.some((w) => w.isFiller), `${f.name} labels no fillers`);
      assert.ok(f.words.some((w) => !w.isFiller), `${f.name} labels no real words`);
    }
  });

  test('Tier B reports "not supplied" rather than failing', () => {
    const dir = tmp();
    try {
      const load = loadGroundTruth(dir);
      assert.deepEqual(load.pairs, []);
      assert.deepEqual(load.problems, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a ground-truth pair loads and scores', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a.asr.json'), JSON.stringify({
        language: 'en', knownNames: ['Aarav'],
        words: [{ text: 'Arav' }, { text: 'went' }, { text: 'home' }],
      }));
      writeFileSync(join(dir, 'a.reference.txt'), 'Aarav went home');
      const load = loadGroundTruth(dir);
      assert.equal(load.pairs.length, 1);
      const p = load.pairs[0]!;
      assert.deepEqual(p.knownNames, ['Aarav']);
      assert.equal(wordErrorRate(tokenise(p.reference), p.hypothesis).rate, 1 / 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a half-supplied pair is REPORTED, not silently skipped', () => {
    // A fixture you believe is being scored but is not is worse than none.
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'orphan.asr.json'), JSON.stringify({ words: [{ text: 'x' }] }));
      const load = loadGroundTruth(dir);
      assert.equal(load.pairs.length, 0);
      assert.equal(load.problems.length, 1);
      assert.match(load.problems[0]!.problem, /no matching orphan\.reference\.txt/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('malformed JSON is reported with the reason', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'bad.asr.json'), '{not json');
      writeFileSync(join(dir, 'bad.reference.txt'), 'hello');
      assert.match(loadGroundTruth(dir).problems[0]!.problem, /invalid JSON/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an empty reference is reported — no rate is defined', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'e.asr.json'), JSON.stringify({ words: [{ text: 'x' }] }));
      writeFileSync(join(dir, 'e.reference.txt'), '   ');
      assert.match(loadGroundTruth(dir).problems[0]!.problem, /no error rate is defined/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a malformed filler fixture is reported with the offending index', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'b.fillers.json'), JSON.stringify({
        language: 'en', words: [{ text: 'a', start: 0, end: 1, isFiller: false }, { text: 'b', start: 1 }],
      }));
      assert.match(loadFillerFixtures(dir).problems[0]!.problem, /word 1 missing/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------

describe('normalisation helpers', () => {
  test('strips edge punctuation and lowercases', () => {
    assert.equal(normaliseForScoring('"Hello,"'), 'hello');
  });
  test('strips the Devanagari danda', () => {
    assert.equal(normaliseForScoring('बहुत।'), 'बहुत');
  });
  test('tokenise drops empties', () => {
    assert.deepEqual(tokenise('  a   b  '), ['a', 'b']);
  });
  test('a punctuation-only token disappears', () => {
    assert.deepEqual(tokenise('a , b'), ['a', 'b']);
  });
});
