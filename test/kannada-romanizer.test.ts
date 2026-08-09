import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  transliterateKannadaToken, transliterateKannadaText, hasKannada,
} from '../src/transliterate/kannada.js';
import { transliterateToken as devanagariToken } from '../src/transliterate/devanagari.js';
import { KannadaRomanizer, offlineEngineFor } from '../src/transliterate/providers.js';

/**
 * The offline Kannada engine.
 *
 * It exists so that "there is no offline transliterator for kn" stops being a
 * reason for a render to die. Everything here is deterministic and offline —
 * there is no network call to mock, because there is no network call.
 *
 * The expected spellings below are PRACTICAL romanisation, the same register as
 * the Hinglish engine: readable by someone who does not know the script, not
 * ISO-15919. Where the scheme is deliberately lossy (retroflex/dental, long/short
 * e and o) the tests say so rather than pretending the collapse is accidental.
 */

describe('the core mapping', () => {
  const CASES: Array<[string, string, string]> = [
    ['ಇದು', 'idu', 'independent vowel + consonant with u sign'],
    ['ಒಂದು', 'ondu', 'anusvara before a dental becomes n'],
    ['ಪುಸ್ತಕ', 'pustaka', 'the inherent vowel SURVIVES word-finally — unlike Hindi'],
    ['ಇದೆ', 'ide', 'e sign'],
    ['ಮತ್ತು', 'mattu', 'geminate through virama'],
    ['ಪೆನ್ನು', 'pennu', 'geminate n'],
    ['ಕರ್ನಾಟಕ', 'karnaataka', 'r + virama cluster, long aa'],
    ['ಸಂಭ್ರಮ', 'sambhrama', 'anusvara before a labial becomes m'],
    ['ಬೆಳಿಗ್ಗೆ', 'beligge', 'retroflex l, geminate g'],
    ['ಹೂವು', 'hoovu', 'long uu sign'],
    ['ಜನ', 'jana', 'two open syllables'],
    ['ಮಳೆ', 'male', 'retroflex l romanises as plain l'],
  ];

  for (const [kannada, expected, why] of CASES) {
    test(`${kannada} → ${expected}  (${why})`, () => {
      assert.equal(transliterateKannadaToken(kannada), expected);
    });
  }

  test('the inherent vowel is never deleted — the key difference from Hindi', () => {
    // Hindi would give "pustak". Kannada does not do that, and an engine that
    // applied Hindi schwa deletion here would produce a word no one says.
    assert.equal(transliterateKannadaToken('ಪುಸ್ತಕ'), 'pustaka');
    assert.ok(!transliterateKannadaToken('ಪುಸ್ತಕ').endsWith('k'));
  });

  test('a written halanta suppresses the vowel', () => {
    assert.equal(transliterateKannadaToken('ಗ್'), 'g');
  });

  test('visarga becomes h', () => {
    assert.equal(transliterateKannadaToken('ಃ'), 'h');
  });

  test('Kannada digits become ASCII digits', () => {
    assert.equal(transliterateKannadaToken('೨೦೨೪'), '2024');
  });
});

describe('anusvara assimilation', () => {
  test('labial consonants give m', () => {
    for (const [word, expected] of [['ಸಂಪ', 'sampa'], ['ಸಂಬ', 'samba'], ['ಸಂಮ', 'samma']]) {
      assert.equal(transliterateKannadaToken(word!), expected);
    }
  });

  test('everything else gives n', () => {
    for (const [word, expected] of [['ಸಂತ', 'santa'], ['ಸಂಗ', 'sanga'], ['ಸಂಕ', 'sanka']]) {
      assert.equal(transliterateKannadaToken(word!), expected);
    }
  });
});

describe('non-Kannada input is never touched', () => {
  test('English words pass through byte-identical', () => {
    for (const w of ['meeting', 'iPhone', 'YouTube', 'deadline']) {
      assert.equal(transliterateKannadaToken(w), w);
    }
  });

  test('numbers, symbols and punctuation pass through', () => {
    for (const w of ['2024', '50%', '₹500', '#reels', 'a@b.com', '...', '—']) {
      assert.equal(transliterateKannadaToken(w), w);
    }
  });

  test('Devanagari is NOT romanised by this engine', () => {
    // Kannada rules must not quietly process Hindi any more than the reverse.
    assert.equal(transliterateKannadaToken('नमस्ते'), 'नमस्ते');
  });

  test('and the Devanagari engine does not process Kannada', () => {
    assert.equal(devanagariToken('ಪುಸ್ತಕ'), 'ಪುಸ್ತಕ');
  });

  test('punctuation attached to a Kannada word is preserved in place', () => {
    assert.equal(transliterateKannadaToken('ಇದು,'), 'idu,');
    assert.equal(transliterateKannadaToken('ಇದೆ?'), 'ide?');
    assert.equal(transliterateKannadaToken('"ಜನ"'), '"jana"');
  });

  test('hasKannada only fires on Kannada', () => {
    assert.equal(hasKannada('ಇದು'), true);
    assert.equal(hasKannada('नमस्ते'), false);
    assert.equal(hasKannada('hello'), false);
  });
});

describe('whitespace and structure are preserved exactly', () => {
  test('multiple spaces survive', () => {
    assert.equal(transliterateKannadaText('ಇದು   ಒಂದು'), 'idu   ondu');
  });

  test('line breaks survive', () => {
    assert.equal(transliterateKannadaText('ಇದು\nಒಂದು'), 'idu\nondu');
  });

  test('tabs and mixed whitespace survive', () => {
    assert.equal(transliterateKannadaText('ಇದು\t ಒಂದು'), 'idu\t ondu');
  });

  test('mixed Kannada and English keeps both and the spacing between them', () => {
    assert.equal(
      transliterateKannadaText('ಇದು ಒಂದು important meeting ಇದೆ'),
      'idu ondu important meeting ide',
    );
  });

  test('an empty string is not an error', () => {
    assert.equal(transliterateKannadaToken(''), '');
    assert.equal(transliterateKannadaText(''), '');
  });

  test('word count is never changed', () => {
    const input = 'ಇದು ಒಂದು ಪುಸ್ತಕ ಮತ್ತು ಪೆನ್ನು ಇದೆ';
    assert.equal(
      transliterateKannadaText(input).split(/\s+/).length,
      input.split(/\s+/).length,
    );
  });
});

describe('as a provider', () => {
  test('it claims Kannada and nothing else', () => {
    const p = new KannadaRomanizer();
    assert.equal(p.supports('kn'), true);
    assert.equal(p.supports('kn-IN'), true);
    for (const l of ['hi', 'mr', 'te', 'ta', 'ml', 'en']) {
      assert.equal(p.supports(l), false, `must not claim ${l}`);
    }
  });

  test('it is offline and rule-based, and says so', () => {
    const p = new KannadaRomanizer();
    assert.equal(p.offline, true);
    assert.equal(p.quality, 'rules');
    assert.match(p.description, /LOWER QUALITY/, 'the limitation must be stated, not hidden');
  });

  test('it returns exactly one token per input, in order', async () => {
    const p = new KannadaRomanizer();
    const input = ['ಇದು', 'meeting', 'ಒಂದು', '2024'];
    const out = await p.romanise(input, 'kn');
    assert.equal(out.length, input.length);
    assert.deepEqual(out, ['idu', 'meeting', 'ondu', '2024']);
  });

  test('offlineEngineFor routes kn here and never to the Devanagari engine', () => {
    const p = offlineEngineFor('kn');
    assert.ok(p instanceof KannadaRomanizer);
    assert.equal(p!.name, 'kannada');
  });
});
