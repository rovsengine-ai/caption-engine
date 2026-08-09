import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, classifyTokens, isLowConfidence } from '../src/transliterate/detect.js';
import { toIso6391, languageCodeMappings } from '../src/config/language-codes.js';
import {
  providerSupports, providersFor, listCapabilities, CAPABILITIES,
} from '../src/transliterate/capabilities.js';
import type { Transcript } from '../src/types.js';

function tx(texts: string[], language = '', perWordLang?: Array<string | undefined>): Transcript {
  return {
    language, provider: 'test', duration: texts.length + 1, hasWordTimings: true,
    words: texts.map((text, i) => ({
      text, start: 0.2 + i * 0.4, end: 0.5 + i * 0.4,
      confidence: 0.97, type: 'word' as const,
      ...(perWordLang?.[i] ? { language: perWordLang[i] } : {}),
    })),
  } as unknown as Transcript;
}

// ---------------------------------------------------------------------------

describe('provider code normalisation', () => {
  const required: Array<[string, string]> = [
    ['hin', 'hi'], ['kan', 'kn'], ['tam', 'ta'], ['tel', 'te'], ['mal', 'ml'],
    ['mar', 'mr'], ['ben', 'bn'], ['guj', 'gu'], ['pan', 'pa'], ['ori', 'or'],
    ['asm', 'as'], ['nep', 'ne'], ['eng', 'en'],
  ];

  for (const [from, to] of required) {
    test(`${from} → ${to}`, () => assert.equal(toIso6391(from), to));
  }

  test('region subtags do not break the mapping', () => {
    assert.equal(toIso6391('hin-IN'), 'hi');
    assert.equal(toIso6391('kan_IN'), 'kn');
  });

  test('case is irrelevant', () => {
    assert.equal(toIso6391('KAN'), 'kn');
  });

  test('an already-2-letter code passes through', () => {
    assert.equal(toIso6391('kn'), 'kn');
  });

  test('every required mapping is in the published table', () => {
    const table = languageCodeMappings();
    for (const [from, to] of required) assert.equal(table[from], to);
  });
});

describe('detection: explicit always wins', () => {
  test('--language kn beats a Devanagari transcript', () => {
    const d = detectLanguage(tx(['आज', 'बहुत']), { explicit: 'kn' });
    assert.equal(d.language, 'kn');
    assert.equal(d.source, 'explicit');
    assert.equal(d.confidence, 1);
  });

  test('but the disagreement is reported, not hidden', () => {
    const d = detectLanguage(tx(['আজ', 'ভালো']), { explicit: 'kn' });
    assert.ok(d.warnings.some((w) => /does not use/.test(w)));
  });

  test('explicit beats a conflicting ASR tag', () => {
    assert.equal(detectLanguage(tx(['आज'], 'hin'), { explicit: 'mr' }).language, 'mr');
  });

  test('a 3-letter explicit code is normalised', () => {
    assert.equal(detectLanguage(tx(['ಇದು']), { explicit: 'kan' }).language, 'kn');
  });

  test('"auto" is not treated as a language', () => {
    const d = detectLanguage(tx(['ಇದು', 'ಒಂದು']), { explicit: 'auto' });
    assert.equal(d.language, 'kn');
    assert.notEqual(d.source, 'explicit');
  });

  test('an explicit language is never low-confidence', () => {
    assert.equal(isLowConfidence(detectLanguage(tx(['ಇದು']), { explicit: 'kn' })), false);
  });
});

describe('detection: from the ASR tag', () => {
  test('a 3-letter tag is normalised and used', () => {
    const d = detectLanguage(tx(['ಇದು', 'ಒಂದು'], 'kan'));
    assert.equal(d.language, 'kn');
    assert.equal(d.source, 'asr');
  });

  test('script corroboration raises confidence', () => {
    const agreeing = detectLanguage(tx(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ'], 'kan'));
    assert.ok(agreeing.confidence >= 0.9);
  });

  test('when the tag contradicts the script, the script wins and says so', () => {
    // "the ASR said Hindi but everything is Kannada" is a real provider failure.
    const d = detectLanguage(tx(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ'], 'hin'));
    assert.equal(d.language, 'kn');
    assert.equal(d.source, 'script');
    assert.ok(d.warnings.some((w) => /Trusting the script/.test(w)));
  });
});

describe('detection: from script alone', () => {
  const cases: Array<[string, string[], string]> = [
    ['kn', ['ಇದು', 'ಒಂದು'], 'Kannada'],
    ['ta', ['இது', 'ஒரு'], 'Tamil'],
    ['te', ['ఇది', 'ఒక'], 'Telugu'],
    ['ml', ['ഇത്', 'ഒരു'], 'Malayalam'],
    ['gu', ['આ', 'ઘર'], 'Gujarati'],
    ['pa', ['ਇਹ', 'ਘਰ'], 'Gurmukhi'],
    ['or', ['ଏହା', 'ଘର'], 'Oriya'],
  ];

  for (const [code, words, script] of cases) {
    test(`${script} → ${code}`, () => {
      const d = detectLanguage(tx(words));
      assert.equal(d.language, code);
      assert.equal(d.script, script);
    });
  }

  test('a script written by several languages is flagged, not guessed silently', () => {
    // Devanagari is hi/mr/ne/sa/kok/mai. Script cannot separate them.
    const d = detectLanguage(tx(['आज', 'बहुत', 'अच्छा']));
    assert.equal(d.language, 'hi');
    assert.deepEqual(d.alternatives.slice(0, 2), ['mr', 'ne']);
    assert.ok(d.warnings.some((w) => /cannot tell them apart/.test(w)));
    assert.ok(isLowConfidence(d), 'a script-only Devanagari guess should be low confidence');
  });

  test('Bengali script names Assamese as the alternative', () => {
    assert.deepEqual(detectLanguage(tx(['আজ', 'ভালো'])).alternatives, ['as']);
  });

  test('a single-language script is high confidence', () => {
    assert.equal(isLowConfidence(detectLanguage(tx(['ಇದು', 'ಒಂದು']))), false);
  });
});

describe('detection: code-switching and edge cases', () => {
  test('mixed Latin and Indic is flagged as code-switched', () => {
    const d = detectLanguage(tx(['ಇದು', 'ಒಂದು', 'important', 'meeting']));
    assert.equal(d.codeSwitched, true);
    assert.equal(d.language, 'kn');
    assert.equal(d.latinTokens, 2);
    assert.equal(d.indicTokens, 2);
  });

  test('the dominant script wins when scripts are mixed', () => {
    const d = detectLanguage(tx(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ', 'आज']));
    assert.equal(d.language, 'kn');
  });

  test('an all-English transcript warns that Roman is a no-op', () => {
    const d = detectLanguage(tx(['this', 'is', 'english'], 'eng'));
    assert.equal(d.indicTokens, 0);
    assert.ok(d.warnings.some((w) => /no-op|nothing to romanise/i.test(w)));
  });

  test('numbers and punctuation carry no language evidence', () => {
    const d = detectLanguage(tx(['2024', '—', '!', '50%']));
    assert.equal(d.indicTokens, 0);
    assert.equal(d.script, null);
  });

  test('an empty transcript does not throw', () => {
    const d = detectLanguage(tx([]));
    assert.equal(d.language, '');
    assert.equal(d.source, 'unknown');
  });

  test('token classification marks Latin tokens for protection', () => {
    const t = classifyTokens(tx(['ಇದು', 'important']).words);
    assert.equal(t[0]!.isLatin, false);
    assert.equal(t[1]!.isLatin, true);
  });
});

// ---------------------------------------------------------------------------

describe('provider capability table', () => {
  test('local covers Devanagari only', () => {
    assert.ok(providerSupports('local', 'hi'));
    assert.ok(providerSupports('local', 'mr'));
    assert.equal(providerSupports('local', 'kn'), false);
    assert.equal(providerSupports('local', 'ta'), false);
  });

  test('sarvam covers the twelve Indic languages', () => {
    for (const l of ['hi', 'mr', 'ne', 'te', 'kn', 'ta', 'ml', 'bn', 'gu', 'pa', 'or', 'as']) {
      assert.ok(providerSupports('sarvam', l), `sarvam should cover ${l}`);
    }
  });

  test('sarvam does not claim Urdu', () => {
    assert.equal(providerSupports('sarvam', 'ur'), false);
  });

  test('http is unknowable, so it claims everything', () => {
    assert.ok(providerSupports('http', 'kn'));
    assert.equal(CAPABILITIES.http.languages, null);
  });

  test('native claims NOTHING — it transliterates nothing', () => {
    assert.equal(providerSupports('native', 'hi'), false);
    assert.equal(providerSupports('native', 'kn'), false);
    assert.deepEqual(CAPABILITIES.native.languages, []);
  });

  test('providersFor ranks model backends ahead of rules', () => {
    assert.deepEqual(providersFor('hi'), ['sarvam', 'http', 'local']);
    assert.deepEqual(providersFor('kn'), ['sarvam', 'http']);
  });

  test('region subtags resolve', () => {
    assert.ok(providerSupports('sarvam', 'kn-IN'));
  });

  test('the table lists every backend', () => {
    assert.deepEqual(listCapabilities().map((c) => c.name), ['local', 'sarvam', 'http', 'native']);
  });
});
