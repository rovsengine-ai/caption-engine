import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  transliterateToken, transliterateText, decomposeNukta, hasDevanagari,
} from '../src/transliterate/devanagari.js';

/**
 * Precomposed nukta letters, and multi-word tokens.
 *
 * Found by running the real transcript through the pipeline rather than by a
 * test: "[घंटी की आवाज़]" came out as "[ghanti ki aavaaज़]" — Devanagari left
 * sitting inside Roman output.
 *
 * Two independent causes:
 *
 *   1. The transcript used U+095B ZA (one code point). The parser reads one code
 *      point at a time and only knew JA + U+093C NUKTA (two code points). The
 *      table in CONSONANTS that claimed to cover "precomposed" forms was itself
 *      written decomposed, so it never matched anything and hid the gap.
 *
 *   2. Audio-event labels arrive as ONE token containing spaces. Word-final
 *      schwa deletion then fired only at the end of the whole label, giving
 *      "horna kee" instead of "horn ki".
 */

/** Unicode's own canonical decompositions, generated from the UCD. */
const CANONICAL: Array<[string, string]> = [
  ['\u0929', '\u0928\u093C'], // DEVANAGARI LETTER NNNA
  ['\u0931', '\u0930\u093C'], // DEVANAGARI LETTER RRA
  ['\u0934', '\u0933\u093C'], // DEVANAGARI LETTER LLLA
  ['\u0958', '\u0915\u093C'], // DEVANAGARI LETTER QA
  ['\u0959', '\u0916\u093C'], // DEVANAGARI LETTER KHHA
  ['\u095A', '\u0917\u093C'], // DEVANAGARI LETTER GHHA
  ['\u095B', '\u091C\u093C'], // DEVANAGARI LETTER ZA
  ['\u095C', '\u0921\u093C'], // DEVANAGARI LETTER DDDHA
  ['\u095D', '\u0922\u093C'], // DEVANAGARI LETTER RHA
  ['\u095E', '\u092B\u093C'], // DEVANAGARI LETTER FA
  ['\u095F', '\u092F\u093C'], // DEVANAGARI LETTER YYA
];

describe('precomposed nukta letters', () => {
  test('the table matches Unicode NFD exactly — complete and correct', () => {
    for (const [composed, expected] of CANONICAL) {
      assert.equal(
        decomposeNukta(composed), expected,
        `U+${composed.codePointAt(0)!.toString(16).toUpperCase()} must decompose canonically`,
      );
      // Cross-check against the runtime's own Unicode data, so the table cannot
      // drift from the standard without a test failing.
      assert.equal(composed.normalize('NFD'), expected, 'fixture disagrees with NFD');
    }
  });

  test('covers every precomposed nukta code point in the block', () => {
    for (let cp = 0x0958; cp <= 0x095f; cp++) {
      const ch = String.fromCodePoint(cp);
      assert.notEqual(decomposeNukta(ch), ch, `U+${cp.toString(16)} left undecomposed`);
    }
  });

  test('U+095B ZA — the exact character from the transcript — romanises', () => {
    // Built from code points, not typed literals. An editor that normalises
    // this file would otherwise turn both spellings into the same string and
    // the test would pass while proving nothing — which is exactly how the bug
    // hid in CONSONANTS in the first place.
    const AA = 'आ', VA = 'व', AA_MATRA = 'ा';
    const composed = AA + VA + AA_MATRA + 'ज़';
    const decomposed = AA + VA + AA_MATRA + 'ज़';

    assert.notEqual(composed, decomposed, 'the two spellings must really differ');
    assert.equal(composed.normalize('NFD'), decomposed, 'and be canonically equivalent');

    assert.equal(transliterateToken(composed), 'aavaaz');
    assert.equal(
      transliterateToken(composed), transliterateToken(decomposed),
      'both spellings of the same word must give the same Roman output',
    );
  });

  test('no Devanagari survives in the output for either spelling', () => {
    for (const [composed] of CANONICAL) {
      const word = 'आ' + composed;  // आ + the letter
      const out = transliterateToken(word);
      assert.ok(!hasDevanagari(out), `"${word}" left Devanagari in "${out}"`);
    }
  });

  test('leaves Latin text alone — NFD is not applied wholesale', () => {
    // Calling .normalize('NFD') on everything would split é into e + U+0301.
    // Code-switched captions must come back byte-identical.
    for (const s of ['café', 'naïve', 'Zoë', 'meeting', 'YouTube']) {
      assert.equal(decomposeNukta(s), s, `"${s}" must be untouched`);
    }
  });

  test('repeated calls give the same answer (no regex lastIndex bug)', () => {
    const s = 'ज़ज़';
    const first = decomposeNukta(s);
    for (let i = 0; i < 5; i++) {
      assert.equal(decomposeNukta(s), first, 'call ' + i + ' differed');
    }
  });
});

describe('tokens containing more than one word', () => {
  test('the audio-event label from the transcript romanises fully', () => {
    const label = '[घंटी की आवाज़]';
    const out = transliterateToken(label);

    assert.equal(out, '[ghanti ki aavaaz]');
    assert.ok(!hasDevanagari(out), 'no Devanagari may remain');
  });

  test('word-final rules apply per word, not once per token', () => {
    // "horn" not "horna": the schwa is word-final inside the label.
    const label = '[गाड़ियों के ' +
      'हॉर्न की आवाज़]';
    const out = transliterateToken(label);

    assert.match(out, /horn /, 'expected "horn", not "horna"');
    assert.match(out, / ki /, 'expected "ki", not "kee"');
    assert.ok(!hasDevanagari(out));
  });

  test('spacing is preserved exactly', () => {
    const t = 'आज  कल\tघर';
    const out = transliterateToken(t);
    assert.equal(out, 'aaj  kal\tghar', 'runs of whitespace must survive verbatim');
  });

  test('agrees with transliterateText on the same content', () => {
    const t = 'आज कल घर';
    assert.equal(transliterateToken(t), transliterateText(t));
  });

  test('a single-word token is unaffected by the split path', () => {
    assert.equal(transliterateToken('आज'), 'aaj');
    assert.equal(transliterateToken('बहुत'), 'bahut');
  });
});
