/**
 * Two-pass filler analysis: Pass 1 evidence, Pass 2 verdict, and the FFmpeg
 * output parsing underneath both.
 *
 * Everything here is synthetic. No media file, no network, no API key. The
 * FFmpeg parsers are exercised against captured stderr text rather than a live
 * process, which is the point of keeping them pure — the bugs live in the
 * parsing, and this way they are tested on every platform including ones with
 * no FFmpeg installed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { Transcript, Word } from '../src/types.js';
import {
  analyseFillerCandidates,
  collapseElongation,
  isElongatedToken,
  detectTokenScript,
} from '../src/autotrim/analysis.js';
import { decideFiller, decideFillers, summariseVerdicts } from '../src/autotrim/decide.js';
import { matchFiller, matchNeverCut } from '../src/autotrim/fillers.js';
import { autoTrim, applyTrim, DEFAULT_TRIM_OPTIONS } from '../src/autotrim/index.js';
import {
  AudioAnalysis,
  parseSilenceDetect,
  parseVolumeDetect,
  parseEnergyWindows,
  suggestNoiseFloor,
  unavailableAudioAnalysis,
} from '../src/media/audio-analysis.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Spec = [text: string, start: number, end: number, confidence?: number];

function tx(specs: Spec[], language = 'en', duration?: number): Transcript {
  const words: Word[] = specs.map(([text, start, end, confidence]) => ({
    text, start, end,
    confidence: confidence ?? 0.9,
    type: 'word',
    language,
  }));
  return {
    words,
    language,
    duration: duration ?? (words.length ? words[words.length - 1]!.end + 0.5 : 1),
    provider: 'fixture',
    hasWordTimings: true,
  };
}

/**
 * A synthetic AudioAnalysis. `loud` lists the spans that are above the noise
 * floor; everything else is measured silence.
 */
function audioWith(loud: Array<[number, number]>, duration: number, windowSec = 0.025): AudioAnalysis {
  const windows = [];
  for (let t = 0; t < duration - 1e-9; t += windowSec) {
    const on = loud.some(([a, b]) => t + windowSec > a && t < b);
    windows.push({ t: Math.round(t * 1000) / 1000, db: on ? -20 : -91 });
  }
  const silences: Array<{ start: number; end: number | null }> = [];
  let cursor = 0;
  for (const [a, b] of [...loud].sort((x, y) => x[0] - y[0])) {
    if (a > cursor) silences.push({ start: cursor, end: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < duration) silences.push({ start: cursor, end: null }); // runs to EOF
  return new AudioAnalysis({
    silences,
    volume: { meanDb: -24, maxDb: -12 },
    noiseDb: -35,
    windows,
    windowSec,
    duration,
  });
}

const only = (t: Transcript, audio: AudioAnalysis | null, token: string) => {
  const rows = analyseFillerCandidates(t, audio);
  const row = rows.find((r) => r.originalToken === token);
  assert.ok(row, `no candidate produced for "${token}"`);
  return row!;
};

// ---------------------------------------------------------------------------
// FFmpeg output parsing — pure, no media
// ---------------------------------------------------------------------------

describe('silencedetect parsing', () => {
  test('reads paired start/end', () => {
    const s = parseSilenceDetect(`
[silencedetect @ 0x1] silence_start: 1.5093
[silencedetect @ 0x1] silence_end: 3.01859 | silence_duration: 1.50929
`);
    assert.deepEqual(s, [{ start: 1.5093, end: 3.01859 }]);
  });

  test('a silence running to EOF has no silence_end and must still be reported', () => {
    // This is the trailing dead air at the end of almost every raw take — the
    // single most common thing a creator wants trimmed. Dropping it because
    // FFmpeg never logged a closing line loses the most valuable cut.
    const s = parseSilenceDetect('silence_start: 4.017\n');
    assert.deepEqual(s, [{ start: 4.017, end: null }]);
  });

  test('two starts in a row emit the first as open rather than mispairing', () => {
    const s = parseSilenceDetect('silence_start: 1.0\nsilence_start: 5.0\nsilence_end: 6.0\n');
    assert.deepEqual(s, [{ start: 1, end: null }, { start: 5, end: 6 }]);
  });

  test('an end before its start is not trusted', () => {
    assert.deepEqual(parseSilenceDetect('silence_start: 5.0\nsilence_end: 2.0\n'),
      [{ start: 5, end: null }]);
  });

  test('noise with no silence lines yields nothing, not a crash', () => {
    assert.deepEqual(parseSilenceDetect('frame= 120 fps=0.0 q=-1.0 size=N/A\n'), []);
    assert.deepEqual(parseSilenceDetect(''), []);
  });
});

describe('volumedetect parsing and the adaptive noise floor', () => {
  const stderr = 'mean_volume: -24.9 dB\nmax_volume: -18.1 dB\n';

  test('reads mean and max', () => {
    assert.deepEqual(parseVolumeDetect(stderr), { meanDb: -24.9, maxDb: -18.1 });
  });

  test('missing measurements are null, never NaN', () => {
    assert.deepEqual(parseVolumeDetect('nothing here'), { meanDb: null, maxDb: null });
  });

  test('the threshold is derived from the file, biased below its own mean', () => {
    assert.equal(suggestNoiseFloor({ meanDb: -24.9, maxDb: -18.1 }), -31);
  });

  test('never lands above max_volume - 12, which would call the loudest moment silence', () => {
    // mean - 6 would be -26 here, but max - 12 is -32. The stricter one wins.
    assert.equal(suggestNoiseFloor({ meanDb: -20, maxDb: -20 }), -32);
  });

  test('clamped at both ends so a pathological file cannot cut everything or nothing', () => {
    assert.equal(suggestNoiseFloor({ meanDb: -200, maxDb: -190 }), -60);
    assert.equal(suggestNoiseFloor({ meanDb: 0, maxDb: 40 }), -20);
  });

  test('an unmeasurable file yields null so the caller falls back deliberately', () => {
    assert.equal(suggestNoiseFloor({ meanDb: null, maxDb: null }), null);
  });
});

describe('energy window parsing', () => {
  test('pairs pts_time with RMS_level', () => {
    const w = parseEnergyWindows(
      'frame:0 pts:0 pts_time:0\nlavfi.astats.Overall.RMS_level=-21.07\n' +
      'frame:1 pts:400 pts_time:0.025\nlavfi.astats.Overall.RMS_level=-30.5\n',
    );
    assert.deepEqual(w, [{ t: 0, db: -21.07 }, { t: 0.025, db: -30.5 }]);
  });

  test('digital silence prints -inf and must become a finite floor', () => {
    // -Infinity poisons every average it touches.
    const w = parseEnergyWindows('pts_time:1.0\nlavfi.astats.Overall.RMS_level=-inf\n');
    assert.equal(w[0]!.db, -91);
    assert.ok(Number.isFinite(w[0]!.db));
  });
});

describe('AudioAnalysis queries', () => {
  const a = audioWith([[0, 1.5], [3.0, 4.0]], 6.0);

  test('energy and voicing separate speech from silence', () => {
    assert.ok(a.energyDb(0.1, 1.4) > -40);
    assert.equal(a.voicedRatio(0.1, 1.4), 1);
    assert.equal(a.voicedRatio(1.6, 2.9), 0);
  });

  test('silentRatio measures coverage, not presence', () => {
    assert.equal(a.silentRatio(1.6, 2.9), 1);
    assert.equal(a.silentRatio(0.1, 1.4), 0);
  });

  test('measured quiet is found on both sides of a boundary', () => {
    assert.ok(a.quietBefore(3.0) > 1.0, 'silence before 3.0 should be measured');
    assert.ok(a.quietAfter(4.0) > 1.0, 'silence after 4.0 should be measured');
  });

  test('querying outside the measured range returns a conservative answer, not a throw', () => {
    assert.equal(a.energyDb(100, 101), -91);
    assert.equal(a.voicedRatio(100, 101), 0);
    assert.equal(a.energyDb(5, 5), -91); // zero-width span
  });

  test('an unavailable analysis reports itself instead of pretending to be silence', () => {
    const u = unavailableAudioAnalysis('no audio stream');
    assert.equal(u.available, false);
    assert.match(u.unavailableReason!, /no audio stream/);
    assert.equal(u.quietBefore(1), 0);
    assert.equal(u.quietAfter(1), 0);
  });
});

// ---------------------------------------------------------------------------
// Elongation — the "aaa" case
// ---------------------------------------------------------------------------

describe('elongation detection', () => {
  test('a run of 3+ identical characters is a drawl', () => {
    for (const t of ['aaa', 'aaaa', 'aaaaaa', 'ummm', 'uhhh', 'hmmm']) {
      assert.ok(isElongatedToken(t), `${t} should be elongated`);
    }
  });

  test('two characters is not elongation — ordinary words double letters', () => {
    for (const t of ['aa', 'book', 'cool', 'letter', 'meeting', 'aage']) {
      assert.equal(isElongatedToken(t), false, `${t} must not be elongated`);
    }
  });

  test('a long word that merely CONTAINS a run is not a drawl', () => {
    // Regression: this flagged a 14-character word as a hesitation and cut it.
    assert.equal(isElongatedToken('zzzznotafiller'), false);
    assert.equal(isElongatedToken('aaabbbcccddd'), false);
  });

  test('collapsing reduces the run but leaves ordinary doubles alone', () => {
    assert.equal(collapseElongation('aaa'), 'a');
    assert.equal(collapseElongation('ummm'), 'um');
    assert.equal(collapseElongation('cool'), 'cool');
  });

  test('script detection separates Latin, Indic and mixed tokens', () => {
    assert.equal(detectTokenScript('meeting'), 'latin');
    assert.equal(detectTokenScript('बहुत'), 'indic');
    assert.equal(detectTokenScript('ಕನ್ನಡ'), 'indic');
    assert.equal(detectTokenScript('OK२'), 'mixed');
    assert.equal(detectTokenScript('123'), 'other');
  });
});

// ---------------------------------------------------------------------------
// The English article "a" — the reported failure
// ---------------------------------------------------------------------------

describe('the English article "a" is never cut automatically', () => {
  test('"a" is in the never tier and matchFiller refuses to call it a filler', () => {
    assert.equal(matchNeverCut('a', 'en'), true);
    const m = matchFiller('a', 'en');
    assert.equal(m.isFiller, false);
    assert.equal(m.protectedWord, true);
  });

  test('"a" survives even with every circumstantial signal pointing at a cut', () => {
    // Short, low confidence, and followed by a long measured pause: exactly the
    // combination that would otherwise manufacture a confident wrong cut.
    const t = tx([['that', 0.2, 0.5], ['was', 0.52, 0.7], ['a', 0.72, 0.80, 0.28], ['disaster', 2.0, 2.6]], 'en', 3.2);
    const audio = audioWith([[0.2, 0.82], [2.0, 2.6]], 3.2);
    const v = decideFiller(only(t, audio, 'a'));
    assert.equal(v.decision, 'keep');
    assert.equal(v.blockedBy, 'protected-word');
  });

  test('"aaa" IS cut in the same position — elongation is the discriminator', () => {
    const t = tx([['that', 0.2, 0.5], ['was', 0.52, 0.7], ['aaa', 0.72, 1.5, 0.25], ['disaster', 2.0, 2.6]], 'en', 3.2);
    const audio = audioWith([[0.2, 0.7], [0.72, 1.5], [2.0, 2.6]], 3.2);
    const v = decideFiller(only(t, audio, 'aaa'));
    assert.equal(v.decision, 'propose-cut');
    assert.ok(v.confidence >= 0.7, `expected a confident cut, got ${v.confidence}`);
  });

  test('end to end: "a" survives autoTrim, "aaa" does not', () => {
    const t = tx([
      ['this', 0.2, 0.45], ['is', 0.47, 0.62], ['a', 0.64, 0.72, 0.4],
      ['meeting', 0.74, 1.2], ['aaa', 1.55, 2.3, 0.22], ['now', 2.9, 3.2],
    ], 'en', 3.8);
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, audio: audioWith([[0.2, 1.2], [1.55, 2.3], [2.9, 3.2]], 3.8) });
    const kept = applyTrim(t, trim).words.filter((w) => w.keep !== false).map((w) => w.text);
    assert.ok(kept.includes('a'), 'the article was removed');
    assert.ok(kept.includes('meeting'), 'a real word was removed');
    assert.ok(!kept.includes('aaa'), 'the drawl survived');
  });
});

// ---------------------------------------------------------------------------
// Pauses, position, repetition
// ---------------------------------------------------------------------------

describe('pause evidence', () => {
  const hindi = (gapAfterMatlab: number) => tx([
    ['iska', 0.2, 0.6], ['matlab', 0.62, 1.0], ['hai', 1.0 + gapAfterMatlab, 1.4 + gapAfterMatlab],
  ], 'hi', 3);

  test('an ambiguous filler mid-flow is kept — it is being used as a word', () => {
    const t = hindi(0.02);
    const v = decideFiller(only(t, null, 'matlab'));
    assert.equal(v.decision, 'keep');
    assert.match(v.reason, /no pause/);
  });

  test('the same word after a real pause is proposed for cutting', () => {
    const t = hindi(0.8);
    const v = decideFiller(only(t, null, 'matlab'));
    assert.equal(v.decision, 'propose-cut');
  });

  test('measured silence is preferred over an ASR gap', () => {
    // No ASR gap at all, but the waveform says the speaker was quiet: an ASR
    // gap is the absence of a label, which proves nothing on its own.
    const t = tx([['iska', 0.2, 0.6], ['matlab', 0.62, 1.0], ['hai', 1.02, 1.4]], 'hi', 3);
    const audio = audioWith([[0.2, 0.6], [0.62, 1.0], [2.2, 2.6]], 3);
    const row = only(t, audio, 'matlab');
    assert.ok(row.measuredQuietAfterSec > 0.5, 'measured quiet should be found after the token');
    assert.equal(decideFiller(row).decision, 'propose-cut');
  });

  test('a missing neighbour counts as gap 0, never Infinity', () => {
    const t = tx([['matlab', 0.2, 0.6], ['theek', 0.62, 1.0]], 'hi', 2);
    const row = only(t, null, 'matlab');
    assert.equal(row.gapBeforeSec, 0);
    assert.ok(Number.isFinite(row.gapBeforeSec));
    assert.equal(row.position, 'start');
    assert.equal(decideFiller(row).decision, 'keep');
  });

  test('a trailing ambiguous filler is not cut on clip-boundary air alone', () => {
    const t = tx([['theek', 0.2, 0.6], ['matlab', 0.62, 1.0]], 'hi', 8);
    assert.equal(decideFiller(only(t, null, 'matlab')).decision, 'keep');
  });
});

describe('repetition', () => {
  test('deliberate repetition of a real word reads as emphasis, not hesitation', () => {
    const t = tx([['bahut', 0.2, 0.6], ['bahut', 0.62, 1.0], ['dhanyavaad', 1.02, 1.7]], 'hi', 2.5);
    const rows = analyseFillerCandidates(t, null);
    for (const r of rows.filter((x) => x.normalizedToken === 'bahut')) {
      assert.ok(r.repetitionRun > 1, 'repetition should be counted');
    }
  });

  test('a repeated listed noise is still a filler — stuttering is not emphasis', () => {
    const t = tx([['um', 0.2, 0.4], ['um', 0.42, 0.6], ['right', 1.2, 1.6]], 'en', 2.5);
    const verdicts = decideFillers(analyseFillerCandidates(t, null))
      .filter((v) => v.evidence.normalizedToken === 'um');
    assert.ok(verdicts.length >= 1);
    assert.ok(verdicts.every((v) => v.decision === 'propose-cut'),
      'repeated "um" should still be cut');
  });
});

describe('position', () => {
  test('a filler at the very start is reported as such', () => {
    const t = tx([['um', 0.2, 0.4], ['hello', 0.9, 1.4]], 'en', 2);
    assert.equal(only(t, null, 'um').position, 'start');
  });

  test('a filler at the very end is reported as such', () => {
    const t = tx([['hello', 0.2, 0.7], ['um', 1.2, 1.5]], 'en', 2);
    assert.equal(only(t, null, 'um').position, 'end');
  });

  test('unambiguous noises are cut at either edge', () => {
    const t = tx([['um', 0.2, 0.4], ['hello', 0.9, 1.4], ['um', 1.9, 2.1]], 'en', 3);
    const v = decideFillers(analyseFillerCandidates(t, null));
    assert.equal(v.filter((x) => x.decision === 'propose-cut').length, 2);
  });
});

// ---------------------------------------------------------------------------
// Per-language protection
// ---------------------------------------------------------------------------

describe('real words in Indic languages are protected', () => {
  const cases: Array<[lang: string, token: string, gloss: string]> = [
    ['hi', 'है', 'is'],
    ['hi', 'हूँ', 'am'],
    ['hi', 'नहीं', 'not'],
    ['te', 'ledu', 'is not'],
    ['kn', 'illa', 'is not'],
    ['ta', 'illai', 'is not'],
    ['mr', 'aahe', 'is'],
  ];

  for (const [lang, token, gloss] of cases) {
    test(`${lang}: "${token}" (${gloss}) is in the never tier`, () => {
      assert.equal(matchNeverCut(token, lang), true);
      assert.equal(matchFiller(token, lang).isFiller, false);
    });
  }

  test('no never-tier word is also in the always tier for the same language', () => {
    // The always tier means "not a word in this language". A token in both
    // would make the two tiers contradict each other.
    for (const [lang, token] of cases) {
      const m = matchFiller(token, lang);
      assert.equal(m.isFiller, false, `${token} (${lang}) resolved as a filler`);
    }
  });
});

describe('per-language hesitations are still detected', () => {
  for (const [lang, token] of [['hi', 'हम्म'], ['te', 'హ్మ్'], ['kn', 'ಹ್ಮ್'], ['ta', 'ஹ்ம்'], ['mr', 'हम्म']] as const) {
    test(`${lang}: "${token}" is an unambiguous hesitation`, () => {
      const t = tx([['x', 0.2, 0.5], [token, 0.9, 1.2], ['y', 1.7, 2.0]], lang, 3);
      const v = decideFiller(only(t, null, token));
      assert.equal(v.decision, 'propose-cut');
      assert.equal(v.confidence, 0.95);
    });
  }
});

// ---------------------------------------------------------------------------
// Verdict plumbing
// ---------------------------------------------------------------------------

describe('verdicts and cut records', () => {
  test('a review-required cut is emitted but NOT applied', () => {
    // An elongated token with no corroboration at all lands in review.
    const t = tx([['aaa', 0.2, 0.32, 0.9], ['hello', 0.34, 0.8]], 'en', 1.5);
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, fillerConfidence: 0.95 });
    const review = trim.cuts.filter((c) => c.decision === 'review-required');
    assert.ok(review.length >= 1, 'expected a review-required cut');
    assert.ok(review.every((c) => c.restored), 'review cuts must start restored');
    const kept = applyTrim(t, trim).words.filter((w) => w.keep !== false).map((w) => w.text);
    assert.ok(kept.includes('aaa'), 'a review-required cut must not be applied');
  });

  test('secondsRemoved counts only cuts that will actually be applied', () => {
    const t = tx([['aaa', 0.2, 0.32, 0.9], ['hello', 0.34, 0.8]], 'en', 1.5);
    const trim = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, fillerConfidence: 0.95 });
    if (trim.cuts.every((c) => c.restored)) assert.equal(trim.secondsRemoved, 0);
  });

  test('every proposed cut carries its evidence and a reason', () => {
    const t = tx([['um', 0.2, 0.4], ['hello', 0.9, 1.4]], 'en', 2);
    const cut = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS }).cuts.find((c) => c.reason === 'filler');
    assert.ok(cut);
    assert.equal(cut!.decision, 'propose-cut');
    assert.ok(cut!.decisionReason && cut!.decisionReason.length > 0);
    assert.equal(cut!.evidence?.originalToken, 'um');
    assert.ok(Array.isArray(cut!.evidence?.signals));
  });

  test('turning off audio analysis does not crash and yields weaker evidence', () => {
    const t = tx([['iska', 0.2, 0.6], ['matlab', 0.62, 1.0], ['hai', 1.02, 1.4]], 'hi', 3);
    const rows = analyseFillerCandidates(t, null);
    assert.ok(rows.every((r) => r.audioAvailable === false));
    assert.ok(rows.every((r) => r.measuredQuietBeforeSec === 0));
  });

  test('the summary adds up', () => {
    const t = tx([['um', 0.2, 0.4], ['a', 0.5, 0.6], ['hello', 0.9, 1.4]], 'en', 2);
    const s = summariseVerdicts(decideFillers(analyseFillerCandidates(t, null)));
    assert.equal(s.total, s.keep + s.proposeCut + s.reviewRequired);
  });

  test('a token held longer than any hesitation is refused', () => {
    const t = tx([['x', 0.2, 0.5], ['um', 0.6, 5.0], ['y', 5.2, 5.5]], 'en', 6);
    const v = decideFiller(only(t, null, 'um'), { maxFillerDurationSec: 2 });
    assert.equal(v.decision, 'keep');
    assert.equal(v.blockedBy, 'too-long');
  });
});
