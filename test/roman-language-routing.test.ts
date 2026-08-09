import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalHinglishTransliterator, SarvamTransliterator, resolveTransliterator,
} from '../src/transliterate/providers.js';
import { toRomanScript, romaniseTranscript } from '../src/transliterate/index.js';
import { detectLanguage } from '../src/transliterate/detect.js';
import { romanMode, romanNickname } from '../src/transliterate/roman-mode.js';
import { loadGlossary, glossaryForLanguage } from '../src/transliterate/glossary.js';
import { transliterateToken } from '../src/transliterate/devanagari.js';
import { providerSupports } from '../src/transliterate/capabilities.js';
import { CaptionEngineError } from '../src/errors.js';
import { mkTranscript } from './helpers.js';

/**
 * Roman output is `sourceLanguage + roman script` — never a generic "Hinglish"
 * mode.
 *
 * THE BUG CLASS THESE TESTS EXIST TO CATCH.
 *
 * Latin letters are not a language. A Kannada sentence written in Roman letters
 * and a Hindi sentence written in Roman letters look equally "English-ish" to
 * anyone skimming the output, so a pipeline that quietly romanised everything
 * with Hindi rules would produce captions that LOOK fine and are wrong — and
 * would keep looking fine in every screenshot in every bug report.
 *
 * So these tests do not check what the output looks like. They check WHICH
 * ENGINE RAN and WHICH SOURCE LANGUAGE IT WAS TOLD, which is the only thing
 * that distinguishes correct Kannada romanisation from Hindi rules applied to
 * Kannada. Every test here must fail if a non-Hindi language is routed through
 * Hindi/Hinglish logic.
 *
 * There is no `KannadaRomanizer` class to assert on, and inventing one would be
 * theatre: for kn/te/ta/ml the romaniser is Sarvam, parameterised by
 * `source_language_code`. A wrapper class named after the language would pass a
 * name check while still sending the wrong code. So the assertion is on the
 * pair actually responsible for correctness: **provider + source language code
 * on the wire**.
 *
 * NO REAL API CALLS. `fetch` is stubbed everywhere; one test proves it.
 */

const FAKE_HOST = 'https://sarvam.invalid';

const SAMPLES: Record<string, string[]> = {
  hi: ['यह', 'एक', 'किताब', 'है'],
  kn: ['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ', 'ಇದೆ'],
  te: ['ఇది', 'ఒక', 'పుస్తకం', 'ఉంది'],
  ta: ['இது', 'ஒரு', 'புத்தகம்', 'இருக்கிறது'],
  ml: ['ഇത്', 'ഒരു', 'പുസ്തകം', 'ആണ്'],
};

/** Every language Sarvam is the only engine for. */
const NON_DEVANAGARI = ['kn', 'te', 'ta', 'ml'] as const;

interface Wire {
  restore(): void;
  /** `source_language_code` on every Sarvam request, in order. */
  sourceCodes: string[];
  /** `target_language_code`, to prove nothing is being translated. */
  targetCodes: string[];
  urls: string[];
}

/**
 * A Sarvam stand-in that romanises to a marker carrying the language it was
 * told. That makes "which language did the backend actually run as" visible in
 * the output itself, not just in a spy.
 */
function stubWire(): Wire {
  const original = globalThis.fetch;
  const w: Wire = {
    restore: () => { globalThis.fetch = original; },
    sourceCodes: [], targetCodes: [], urls: [],
  };
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    w.urls.push(String(url));
    const b = JSON.parse(init.body) as {
      input: string; source_language_code: string; target_language_code: string;
    };
    w.sourceCodes.push(b.source_language_code);
    w.targetCodes.push(b.target_language_code);
    const lang = b.source_language_code.split('-')[0];
    const pieces = b.input.split('|').map((s) => s.trim());
    return new Response(
      JSON.stringify({
        transliterated_text: pieces.map((_, i) => `${lang}word${i}`).join(' | '),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return w;
}

const noKey = {} as NodeJS.ProcessEnv;
const withSarvam = {
  SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: FAKE_HOST,
} as NodeJS.ProcessEnv;

let wire: Wire | null = null;
afterEach(() => { wire?.restore(); wire = null; });

function transcriptFor(lang: string) {
  return mkTranscript(
    SAMPLES[lang]!.map((w, i) => [w, i * 0.5, i * 0.5 + 0.4] as [string, number, number]),
    lang,
  );
}

// ---------------------------------------------------------------------------

describe('the Hindi engine is reserved for Devanagari languages', () => {
  test('the built-in engine claims Hindi and refuses kn/te/ta/ml', () => {
    const local = new LocalHinglishTransliterator();
    assert.equal(local.supports('hi'), true, 'Hindi is the engine it implements');
    for (const lang of NON_DEVANAGARI) {
      assert.equal(
        local.supports(lang), false,
        `the Devanagari engine must NOT claim to romanise ${lang}`,
      );
    }
  });

  test('the capability table agrees — no Hindi engine for kn/te/ta/ml', () => {
    assert.equal(providerSupports('local', 'hi'), true);
    for (const lang of NON_DEVANAGARI) {
      assert.equal(providerSupports('local', lang), false, `local must not cover ${lang}`);
    }
  });

  test('Hindi rules cannot even read Kannada, so a misroute would be silent data loss', () => {
    // Not a routing check — the reason routing matters. The Devanagari engine
    // works on Devanagari code points; handed Kannada it returns the input
    // unchanged, which downstream looks exactly like "the model left it native".
    for (const lang of NON_DEVANAGARI) {
      const word = SAMPLES[lang]![0]!;
      assert.equal(
        transliterateToken(word), word,
        `the Hindi engine silently passed ${lang} through — this is why it must never be chosen`,
      );
    }
  });

  test('resolving a non-Devanagari language with no model backend FAILS, never falls back to Hindi', () => {
    for (const lang of NON_DEVANAGARI) {
      assert.throws(
        () => resolveTransliterator(undefined, lang, noKey),
        (e: unknown) => {
          assert.ok(e instanceof CaptionEngineError);
          assert.match((e as Error).message, new RegExp(`"${lang}"`), 'the error names the language');
          return true;
        },
        `${lang} with no key must error, not quietly become Hinglish`,
      );
    }
  });
});

describe('provider + source language code, per language', () => {
  test('hi resolves to the Devanagari (Hindi) engine when there is no key', () => {
    const p = resolveTransliterator(undefined, 'hi', noKey);
    assert.equal(p.name, 'local');
    assert.ok(p instanceof LocalHinglishTransliterator);
  });

  test('kn/te/ta/ml resolve to the model backend, never to local', () => {
    for (const lang of NON_DEVANAGARI) {
      const p = resolveTransliterator(undefined, lang, withSarvam);
      assert.equal(p.name, 'sarvam', `${lang} must use the model backend`);
      assert.ok(p instanceof SarvamTransliterator);
      assert.ok(
        !(p instanceof LocalHinglishTransliterator),
        `${lang} must never be handed to the Hindi engine`,
      );
    }
  });

  test('each language reaches the wire as its own source_language_code', async () => {
    for (const [lang, expected] of Object.entries({
      hi: 'hi-IN', kn: 'kn-IN', te: 'te-IN', ta: 'ta-IN', ml: 'ml-IN',
    })) {
      wire?.restore();
      wire = stubWire();
      const p = resolveTransliterator('sarvam', lang, withSarvam);
      await p.romanise(SAMPLES[lang]!, lang);

      assert.deepEqual(
        [...new Set(wire.sourceCodes)], [expected],
        `${lang} must be sent as ${expected} — anything else is a misroute`,
      );
      assert.ok(
        !wire.sourceCodes.includes('hi-IN') || lang === 'hi',
        `${lang} was sent to the API as Hindi`,
      );
    }
  });

  test('the target is always Roman, never an English translation', async () => {
    wire = stubWire();
    const p = resolveTransliterator('sarvam', 'kn', withSarvam);
    await p.romanise(SAMPLES.kn!, 'kn');
    // en-IN is Sarvam's code for "Latin script", not "translate to English".
    // Asserted so a future change to a genuine translation endpoint is caught.
    assert.deepEqual([...new Set(wire.targetCodes)], ['en-IN']);
  });

  test('the Hindi engine is never invoked during a kn/te/ta/ml run', async () => {
    const original = LocalHinglishTransliterator.prototype.romanise;
    const calls: string[] = [];
    LocalHinglishTransliterator.prototype.romanise = async function (tokens, language) {
      calls.push(language);
      return original.call(this, tokens, language);
    };
    try {
      for (const lang of NON_DEVANAGARI) {
        wire?.restore();
        wire = stubWire();
        await toRomanScript(transcriptFor(lang), {
          language: lang, provider: 'sarvam', env: withSarvam,
        });
      }
      assert.deepEqual(calls, [], `the Hindi engine ran for: ${calls.join(', ')}`);
    } finally {
      LocalHinglishTransliterator.prototype.romanise = original;
    }
  });
});

describe('detected language flows through to the transliteration stage', () => {
  test('detection picks the right language from the script alone', () => {
    for (const lang of Object.keys(SAMPLES)) {
      // No ASR tag at all — script is the only evidence.
      const t = { ...transcriptFor(lang), language: '' };
      assert.equal(detectLanguage(t).language, lang, `${lang} misdetected from its own script`);
    }
  });

  test('what was detected is what the backend is told', async () => {
    for (const lang of NON_DEVANAGARI) {
      wire?.restore();
      wire = stubWire();
      const t = { ...transcriptFor(lang), language: '' };
      const detected = detectLanguage(t).language;
      await toRomanScript(t, { language: detected, provider: 'sarvam', env: withSarvam });

      assert.deepEqual([...new Set(wire.sourceCodes)], [`${detected}-IN`]);
    }
  });

  test('the source language is reported on the result and never silently changed', async () => {
    for (const lang of Object.keys(SAMPLES)) {
      wire?.restore();
      wire = stubWire();
      const t = transcriptFor(lang);
      const r = await toRomanScript(t, { language: lang, provider: 'sarvam', env: withSarvam });

      assert.equal(r.mode.language, lang, 'the mode must carry the source language');
      assert.equal(r.transcript.language, lang, 'the transcript keeps its language');
    }
  });

  test('per-word language tags survive romanisation', async () => {
    wire = stubWire();
    const t = transcriptFor('kn');
    t.words[1]!.language = 'en';
    const r = await romaniseTranscript(t, resolveTransliterator('sarvam', 'kn', withSarvam), {
      language: 'kn',
    });
    assert.equal(r.transcript.words[1]!.language, 'en', 'word-level language must be preserved');
  });

  test('word count, order and timings are unchanged for every language', async () => {
    for (const lang of Object.keys(SAMPLES)) {
      wire?.restore();
      wire = stubWire();
      const t = transcriptFor(lang);
      const before = t.words.map((w) => ({ s: w.start, e: w.end }));
      const r = await toRomanScript(t, { language: lang, provider: 'sarvam', env: withSarvam });

      assert.equal(r.transcript.words.length, before.length, `${lang} word count changed`);
      r.transcript.words.forEach((w, i) => {
        assert.equal(w.start, before[i]!.s, `${lang} word ${i} start moved`);
        assert.equal(w.end, before[i]!.e, `${lang} word ${i} end moved`);
      });
    }
  });
});

describe('"Hinglish" names one mode, not the category', () => {
  test('only Hindi is Hinglish', () => {
    assert.equal(romanMode('hi').isHinglish, true);
    for (const lang of [...NON_DEVANAGARI, 'bn', 'gu', 'en']) {
      assert.equal(
        romanMode(lang).isHinglish, false,
        `${lang} romanised is NOT Hinglish, however Latin it looks`,
      );
    }
  });

  test('each language gets its own label, naming the source language', () => {
    assert.match(romanMode('kn').label, /Kannada → Roman/);
    assert.match(romanMode('te').label, /Telugu → Roman/);
    assert.match(romanMode('ta').label, /Tamil → Roman/);
    assert.match(romanMode('ml').label, /Malayalam → Roman/);
    assert.match(romanMode('hi').label, /Hindi → Roman/);
  });

  test('the colloquial names are available but are not the language', () => {
    assert.equal(romanNickname('hi'), 'Hinglish');
    assert.equal(romanNickname('kn'), 'Kannglish');
    assert.equal(romanNickname('te'), 'Tenglish');
    assert.equal(romanNickname('ta'), 'Tanglish');
    assert.equal(romanNickname('ml'), 'Manglish');
  });

  test('an unknown language does not become Hindi', () => {
    const m = romanMode('');
    assert.equal(m.language, '');
    assert.equal(m.isHinglish, false);
    assert.match(m.label, /unknown/);
  });

  test('Sarvam refuses to invent a source language', async () => {
    wire = stubWire();
    const p = new SarvamTransliterator('test-key', { baseUrl: FAKE_HOST, sleep: async () => {} });
    await assert.rejects(
      () => p.romanise(SAMPLES.kn!, ''),
      /without a source language/,
      'an empty language must fail, not default to Hindi',
    );
  });
});

describe('the Hindi glossary does not follow other languages around', () => {
  test('Devanagari-keyed mappings are dropped for kn/te/ta/ml', () => {
    const full = loadGlossary();
    assert.ok(full.mappings.length > 0, 'the fixture glossary must actually have mappings');

    for (const lang of NON_DEVANAGARI) {
      const g = glossaryForLanguage(full, lang);
      assert.equal(
        g.mappings.length, 0,
        `${lang} should inherit none of the Devanagari-written-English mappings`,
      );
    }
  });

  test('Hindi keeps them', () => {
    const g = glossaryForLanguage(loadGlossary(), 'hi');
    assert.ok(g.mappings.length > 0, 'Hindi must keep the mappings written for it');
  });

  test('English protection is language-neutral and survives everywhere', () => {
    const full = loadGlossary();
    for (const lang of ['hi', ...NON_DEVANAGARI]) {
      const g = glossaryForLanguage(full, lang);
      assert.deepEqual(
        g.protectedPhrases, full.protectedPhrases,
        `${lang} must still protect English phrases`,
      );
    }
  });

  test('English words inside Kannada speech are preserved, not sent, not translated', async () => {
    wire = stubWire();
    const t = mkTranscript([
      ['ಇದು', 0, 0.4],
      ['meeting', 0.5, 0.9],
      ['ಇದೆ', 1.0, 1.4],
    ], 'kn');
    const r = await toRomanScript(t, { language: 'kn', provider: 'sarvam', env: withSarvam });

    assert.equal(r.transcript.words[1]!.text, 'meeting', 'English must pass through untouched');
    assert.equal(r.mode.language, 'kn');
  });
});

describe('English source: already Roman', () => {
  test('en + roman is a no-op, not an error', async () => {
    const t = mkTranscript([['hello', 0, 0.4], ['world', 0.5, 0.9]], 'en');
    const r = await toRomanScript(t, { language: 'en', env: noKey });

    assert.deepEqual(r.transcript.words.map((w) => w.text), ['hello', 'world']);
    assert.equal(r.transcript.language, 'en');
    assert.equal(r.keptNativeScript, false, 'Latin IS the Roman script — nothing was kept back');
    assert.equal(r.mode.alreadyRoman, true);
  });

  test('it does not pretend a transliteration provider ran', async () => {
    const t = mkTranscript([['hello', 0, 0.4]], 'en');
    const r = await toRomanScript(t, { language: 'en', env: noKey });
    assert.equal(r.provider, 'none');
    assert.equal(r.converted, 0);
  });

  test('a genuinely unsupported language still fails — the no-op is not a catch-all', async () => {
    // Urdu is Arabic script: not already Roman, and no backend covers it.
    const t = mkTranscript([['یہ', 0, 0.4], ['ایک', 0.5, 0.9]], 'ur');
    await assert.rejects(
      () => toRomanScript(t, { language: 'ur', env: withSarvam }),
      (e: unknown) => {
        assert.ok(e instanceof CaptionEngineError);
        assert.match((e as Error).message, /"ur"/);
        return true;
      },
    );
  });
});

describe('no real API calls', () => {
  test('every request went to the stub', async () => {
    wire = stubWire();
    for (const lang of Object.keys(SAMPLES)) {
      await toRomanScript(transcriptFor(lang), {
        language: lang, provider: 'sarvam', env: withSarvam,
      });
    }
    assert.ok(wire.urls.length > 0, 'the transport must actually have been exercised');
    for (const u of wire.urls) {
      assert.ok(u.startsWith(FAKE_HOST), `unexpected host: ${u}`);
      assert.ok(!/sarvam\.ai/.test(u), 'the real API must never be contacted');
    }
  });
});
