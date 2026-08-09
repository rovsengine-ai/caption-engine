import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autoTrim, DEFAULT_TRIM_OPTIONS, matchFiller } from '../src/autotrim/index.js';
import type { Transcript } from '../src/types.js';

/**
 * Auto Trim false-positive regressions.
 *
 * Every case here is a real word that a previous version cut. The English
 * lexicon was always correct — "a" was never in it — which is precisely why
 * these survived: the language everyone tests in was fine.
 */

type W = [text: string, start: number, end: number];

function tx(words: W[], language: string, duration?: number): Transcript {
  return {
    language,
    provider: 'test',
    duration: duration ?? (words[words.length - 1]?.[2] ?? 0) + 0.4,
    hasWordTimings: true,
    words: words.map(([text, start, end]) => ({
      text, start, end, confidence: 0.97, type: 'word' as const,
    })),
  } as unknown as Transcript;
}

/** Words surviving Auto Trim, in order. */
function survivors(t: Transcript): string[] {
  const r = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
  return t.words
    .filter((_, i) => !r.cuts.some((c) => c.wordIndices.includes(i)))
    .map((w) => w.text);
}

/** Evenly spaced, fluent delivery — no pauses anywhere. */
function fluent(texts: string[]): W[] {
  return texts.map((t, i) => [t, 0.2 + i * 0.35, 0.5 + i * 0.35]);
}

describe('real words must never be cut as fillers', () => {
  const cases: Array<[lang: string, sentence: string[], mustKeep: string, gloss: string]> = [
    ['hi', ['मैं', 'बिल्कुल', 'ठीक', 'हूँ'], 'हूँ', '"am" — मैं ठीक हूँ'],
    ['hi', ['haan', 'bilkul', 'sahi', 'hai'], 'haan', '"yes"'],
    ['gu', ['આ', 'ઘર', 'બહુ', 'સરસ', 'છે'], 'આ', '"this" — આ ઘર = this house'],
    ['te', ['ఆ', 'పుస్తకం', 'నాది'], 'ఆ', '"that" — demonstrative'],
    ['kn', ['ಆ', 'ಪುಸ್ತಕ', 'ನನ್ನದು'], 'ಆ', '"that"'],
    ['ml', ['ആ', 'പുസ്തകം', 'എന്റെ'], 'ആ', '"that"'],
    ['bn', ['এ', 'আমার', 'বাড়ি'], 'এ', '"this"'],
    ['pa', ['ਆ', 'ਇੱਥੇ', 'ਬੈਠ'], 'ਆ', '"come"'],
    ['en', ['this', 'is', 'a', 'test'], 'a', 'the English article — the case that always worked'],
  ];

  for (const [lang, sentence, mustKeep, gloss] of cases) {
    test(`${lang}: "${mustKeep}" survives fluent speech (${gloss})`, () => {
      const kept = survivors(tx(fluent(sentence), lang));
      assert.deepEqual(kept, sentence, `"${mustKeep}" was cut from a fluent sentence`);
    });
  }
});

describe('the always tier contains no real words', () => {
  test('no token is both "always" and "ambiguous" anywhere', async () => {
    // A token in `always` for one lexicon beats `ambiguous` in another, because
    // matchFiller checks every always-list first. That would silently reinstate
    // the bug for code-switched languages.
    const mod = await import('../src/autotrim/fillers.js');
    const langs = mod.supportedFillerLanguages();
    for (const lang of langs) {
      for (const token of ['हूँ', 'haan', 'aa', 'आ', 'આ', 'ఆ', 'ಆ', 'ആ', 'এ', 'ਆ', 'अ']) {
        const m = matchFiller(token, lang);
        if (m.isFiller) {
          assert.ok(
            m.ambiguous,
            `"${token}" is in the ALWAYS tier for ${lang} — it is a real word and needs corroborating evidence`,
          );
        }
      }
    }
  });

  test('genuine hesitation noises are still cut on sight', () => {
    for (const [token, lang] of [['um', 'en'], ['hmm', 'hi'], ['umm', 'te'], ['erm', 'en']] as const) {
      const m = matchFiller(token, lang);
      assert.ok(m.isFiller && !m.ambiguous, `"${token}" (${lang}) should be an unconditional filler`);
    }
  });
});

describe('ambiguous fillers need a real pause', () => {
  test('cut when preceded by a genuine gap', () => {
    const kept = survivors(tx([
      ['the', 0.2, 0.4], ['point', 0.45, 0.8], ['matlab', 1.3, 1.6], ['yeh', 1.65, 1.9],
    ], 'hi'));
    assert.ok(!kept.includes('matlab'));
  });

  test('kept when delivered fluently', () => {
    const kept = survivors(tx([
      ['the', 0.2, 0.4], ['point', 0.45, 0.8], ['matlab', 0.85, 1.1], ['yeh', 1.15, 1.4],
    ], 'hi'));
    assert.ok(kept.includes('matlab'));
  });

  test('a missing neighbour is NOT a pause — first word survives', () => {
    // Regression: gapBefore was Infinity for the first word, so every ambiguous
    // filler at either edge was cut unconditionally.
    const kept = survivors(tx(fluent(['so', 'um', 'the', 'point', 'is']), 'en'));
    assert.ok(kept.includes('so'), 'leading ambiguous filler was cut with no evidence');
    assert.ok(!kept.includes('um'), 'genuine filler should still go');
  });

  test('a missing neighbour is NOT a pause — last word survives', () => {
    const kept = survivors(tx(fluent(['that', 'is', 'the', 'point', 'matlab']), 'hi'));
    assert.ok(kept.includes('matlab'), 'trailing ambiguous filler was cut with no evidence');
  });

  test('trailing dead air at the end of a clip is not evidence', () => {
    // Almost every clip has trailing silence; it says nothing about hesitation.
    const kept = survivors(tx(fluent(['ye', 'sahi', 'hai', 'matlab']), 'hi', 30));
    assert.ok(kept.includes('matlab'));
  });
});

describe('repeated words: retake vs emphasis', () => {
  test('a genuine retake with a break at the seam is cut', () => {
    const kept = survivors(tx([
      ['I', 0.2, 0.35], ['think', 0.4, 0.7], ['that', 0.75, 1.0],
      // 0.5s break — the speaker stopped and restarted
      ['I', 1.5, 1.65], ['think', 1.7, 2.0], ['that', 2.05, 2.3],
      ['we', 2.35, 2.5], ['should', 2.55, 2.9],
    ], 'en'));
    assert.deepEqual(kept, ['I', 'think', 'that', 'we', 'should']);
  });

  test('fluent repetition is emphasis and must be kept', () => {
    const kept = survivors(tx(fluent(['thank', 'you', 'thank', 'you', 'so', 'much']), 'en'));
    assert.deepEqual(kept, ['thank', 'you', 'thank', 'you', 'so', 'much']);
  });

  test('fluent Hindi emphasis is kept', () => {
    const kept = survivors(tx(fluent(['बहुत', 'बहुत', 'धन्यवाद', 'आपका']), 'hi'));
    assert.ok(kept.includes('धन्यवाद'));
    assert.equal(kept.filter((w) => w === 'बहुत').length, 2, 'emphasis repetition was removed');
  });

  test('the seam-pause requirement can be turned off', () => {
    const t = tx(fluent(['thank', 'you', 'thank', 'you']), 'en');
    const r = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS, falseStartRequiresPause: false });
    assert.equal(r.cuts.length, 1);
  });
});

describe('names and content words are never touched', () => {
  test('a proper name that resembles nothing in the lexicon survives', () => {
    const kept = survivors(tx(fluent(['Aarav', 'aur', 'Aashna', 'aaye']), 'hi'));
    assert.deepEqual(kept, ['Aarav', 'aur', 'Aashna', 'aaye']);
  });

  test('restoring every cut reproduces the original word list', () => {
    const t = tx(fluent(['so', 'um', 'the', 'point', 'is']), 'en');
    const r = autoTrim(t, { ...DEFAULT_TRIM_OPTIONS });
    for (const c of r.cuts) c.restored = true;
    const kept = t.words
      .filter((_, i) => !r.cuts.some((c) => !c.restored && c.wordIndices.includes(i)))
      .map((w) => w.text);
    assert.deepEqual(kept, ['so', 'um', 'the', 'point', 'is']);
  });
});
