import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseLanguageCode, toIso6391, isIso6393, languageCodeMappings,
} from '../src/config/language-codes.js';
import { ElevenLabsScribe } from '../src/asr/elevenlabs.js';
import { DeepgramNova } from '../src/asr/deepgram.js';
import { getLanguage } from '../src/config/languages.js';
import { LocalHinglishTransliterator } from '../src/transliterate/providers.js';
import { matchFiller } from '../src/autotrim/fillers.js';
import { scriptForLanguage } from '../src/text/script.js';

/**
 * ISO-639-3 → ISO-639-1 normalisation.
 *
 * ElevenLabs Scribe returns 639-3 ("hin"); everything in this project keys on
 * 639-1 ("hi"). Without normalisation every lookup missed and the failure was
 * SILENT — no filler lexicon, no transliteration support, no font mapping — so
 * the user had to pass `--language hi` by hand to get the behaviour they should
 * have had automatically.
 */

describe('the mappings named in the bug report', () => {
  const REQUIRED: Array<[string, string]> = [
    ['hin', 'hi'], ['eng', 'en'], ['tam', 'ta'], ['tel', 'te'],
    ['kan', 'kn'], ['mal', 'ml'], ['ben', 'bn'], ['mar', 'mr'],
    ['guj', 'gu'], ['pan', 'pa'], ['nep', 'ne'],
  ];

  for (const [from, to] of REQUIRED) {
    test(`${from} → ${to}`, () => {
      assert.equal(toIso6391(from), to);
    });
  }

  test('all of them are recognised as 639-3', () => {
    for (const [from] of REQUIRED) assert.equal(isIso6393(from), true, from);
  });
});

describe('normalisation behaviour', () => {
  test('an existing 2-letter code passes through unchanged', () => {
    for (const c of ['hi', 'en', 'ta', 'te', 'kn']) {
      assert.equal(toIso6391(c), c);
    }
  });

  test('case is normalised', () => {
    assert.equal(toIso6391('HIN'), 'hi');
    assert.equal(toIso6391('Hin'), 'hi');
    assert.equal(toIso6391('HI'), 'hi');
  });

  test('region subtags are separated, not folded into the code', () => {
    const r = normaliseLanguageCode('hin-IN');
    assert.equal(r.code, 'hi');
    assert.equal(r.region, 'IN');
    assert.equal(normaliseLanguageCode('hi_IN').code, 'hi');
    assert.equal(normaliseLanguageCode('en-US').code, 'en');
  });

  test('the raw provider code is preserved for diagnostics', () => {
    const r = normaliseLanguageCode('hin');
    assert.equal(r.raw, 'hin', 'normalising must not destroy what the provider said');
    assert.equal(r.wasMapped, true);
  });

  test('wasMapped is false when nothing changed', () => {
    assert.equal(normaliseLanguageCode('hi').wasMapped, false);
  });

  test('empty and missing input are handled', () => {
    assert.equal(toIso6391(''), '');
    assert.equal(toIso6391(undefined), '');
    assert.equal(toIso6391(null), '');
  });

  test('an unknown code is passed through rather than discarded', () => {
    // Losing the code entirely would be worse than carrying one we cannot map.
    assert.equal(toIso6391('xyz'), 'xyz');
    assert.equal(normaliseLanguageCode('xyz').wasMapped, false);
  });

  test('non-Indic languages are mapped too, so they are not mislabelled', () => {
    assert.equal(toIso6391('spa'), 'es');
    assert.equal(toIso6391('fra'), 'fr');
    assert.equal(toIso6391('deu'), 'de');
    assert.equal(toIso6391('zho'), 'zh');
    assert.equal(toIso6391('jpn'), 'ja');
  });

  test('639-2/B bibliographic variants also map', () => {
    // Providers sometimes emit "fre"/"ger"/"chi" rather than "fra"/"deu"/"zho".
    assert.equal(toIso6391('fre'), 'fr');
    assert.equal(toIso6391('ger'), 'de');
    assert.equal(toIso6391('chi'), 'zh');
  });

  test('no mapping produces a 3-letter result', () => {
    for (const to of Object.values(languageCodeMappings())) {
      assert.ok(to.length <= 3, `${to} is not a short code`);
    }
  });
});

describe('adapters normalise at the boundary', () => {
  test('ElevenLabs "hin" becomes "hi" on the transcript', () => {
    const scribe = new ElevenLabsScribe('test-key');
    const t = scribe.normalise({
      language_code: 'hin',
      words: [
        { text: 'आज', start: 0, end: 0.4, type: 'word' },
        { text: 'cheat', start: 0.4, end: 0.9, type: 'word', language_code: 'eng' },
      ],
    });
    assert.equal(t.language, 'hi', 'document language must be ISO-639-1');
    assert.equal(t.detectedLanguageRaw, 'hin', 'raw code must be preserved');
  });

  test('per-word language tags are normalised too', () => {
    // This one matters: --protect-english checks `word.language === "en"`,
    // so an unnormalised "eng" would silently disable English protection.
    const scribe = new ElevenLabsScribe('k');
    const t = scribe.normalise({
      language_code: 'hin',
      words: [{ text: 'cheat', start: 0, end: 0.5, type: 'word', language_code: 'eng' }],
    });
    assert.equal(t.words[0]!.language, 'en');
  });

  test('Deepgram detected_language is normalised', () => {
    const dg = new DeepgramNova('k');
    const t = dg.normalise({
      metadata: { duration: 2 },
      results: {
        channels: [{
          detected_language: 'hin',
          alternatives: [{ words: [{ word: 'aaj', start: 0, end: 0.4, confidence: 1 }] }],
        }],
      },
    });
    assert.equal(t.language, 'hi');
    assert.equal(t.detectedLanguageRaw, 'hin');
  });

  test('a provider already returning 639-1 is untouched', () => {
    const scribe = new ElevenLabsScribe('k');
    const t = scribe.normalise({
      language_code: 'hi',
      words: [{ text: 'आज', start: 0, end: 0.4, type: 'word' }],
    });
    assert.equal(t.language, 'hi');
  });
});

describe('normalisation unblocks everything downstream', () => {
  // Each of these silently did the wrong thing when the code was "hin".
  test('the language registry resolves', () => {
    assert.equal(getLanguage('hin'), undefined, 'registry is keyed on 639-1');
    assert.ok(getLanguage(toIso6391('hin')), 'normalised code must resolve');
    assert.equal(getLanguage(toIso6391('hin'))!.name, 'Hindi');
  });

  test('the local transliterator accepts the normalised code', () => {
    const p = new LocalHinglishTransliterator();
    assert.equal(p.supports('hin'), false, 'raw 639-3 is not understood');
    assert.equal(p.supports(toIso6391('hin')), true, 'normalised code must be supported');
  });

  test('filler matching works after normalisation', () => {
    // With "hin", Hindi fillers fell back to the English-only list.
    assert.equal(matchFiller('मतलब', toIso6391('hin')).isFiller, true);
  });

  test('font/script selection works after normalisation', () => {
    assert.equal(scriptForLanguage(toIso6391('hin')), 'Devanagari');
    assert.equal(scriptForLanguage(toIso6391('tam')), 'Tamil');
    assert.equal(scriptForLanguage(toIso6391('tel')), 'Telugu');
    assert.equal(scriptForLanguage(toIso6391('kan')), 'Kannada');
    assert.equal(scriptForLanguage(toIso6391('mal')), 'Malayalam');
    assert.equal(scriptForLanguage(toIso6391('ben')), 'Bengali');
    assert.equal(scriptForLanguage(toIso6391('guj')), 'Gujarati');
    assert.equal(scriptForLanguage(toIso6391('pan')), 'Gurmukhi');
  });

  test('the user no longer has to pass --language hi by hand', () => {
    // The whole point: a transcript detected as "hin" is fully usable with no
    // manual override.
    const scribe = new ElevenLabsScribe('k');
    const t = scribe.normalise({
      language_code: 'hin',
      words: [{ text: 'बहुत', start: 0, end: 0.4, type: 'word' }],
    });
    const p = new LocalHinglishTransliterator();
    assert.ok(p.supports(t.language), 'romanisation must work with no --language flag');
    assert.ok(getLanguage(t.language), 'registry must resolve with no --language flag');
  });
});
