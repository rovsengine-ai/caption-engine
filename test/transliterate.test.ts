import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  transliterateText, transliterateToken, hasDevanagari,
} from '../src/transliterate/devanagari.js';
import {
  addRomanisation, withScript, toRomanScript, capitaliseSentences,
} from '../src/transliterate/index.js';
import {
  resolveTransliterator, LocalHinglishTransliterator, SarvamTransliterator,
  HttpTransliterator, listTransliterators,
} from '../src/transliterate/providers.js';
import { isIndicScript } from '../src/transliterate/script-utils.js';
import { mkTranscript } from './helpers.js';
import type { Transcript } from '../src/types.js';

/**
 * Mixed Hinglish transliteration.
 *
 * The requirement is specific and narrow, and each clause is asserted:
 *   - Indic-script words → readable Roman Hinglish
 *   - Latin-script words → untouched
 *   - NOT translation in either direction
 *   - punctuation, numbers, order and TIMESTAMPS preserved
 */

describe('the specified example', () => {
  test('आज meeting बहुत important है → Aaj meeting bahut important hai', async () => {
    const t = mkTranscript([
      ['आज', 0.0, 0.5], ['meeting', 0.5, 1.2], ['बहुत', 1.2, 1.7],
      ['important', 1.7, 2.5], ['है', 2.5, 2.8],
    ], 'hi');
    const r = await toRomanScript(t);
    assert.equal(
      r.transcript.words.map((w) => w.text).join(' '),
      'Aaj meeting bahut important hai',
    );
  });

  test('the same sentence as free text', () => {
    assert.equal(
      transliterateText('आज meeting बहुत important है'),
      'aaj meeting bahut important hai',
    );
  });
});

describe('Hinglish quality (schwa deletion, not ISO transliteration)', () => {
  const CASES: Array<[string, string]> = [
    ['आज', 'aaj'],          // final schwa deleted, NOT "aaja"
    ['बहुत', 'bahut'],       // initial schwa protected, NOT "bhut"
    ['करना', 'karna'],       // medial schwa deleted, NOT "karana"
    ['समझना', 'samajhna'],   // medial deletion in a longer word
    ['नमस्ते', 'namaste'],   // conjunct + final vowel kept
    ['सम्बन्ध', 'sambandh'], // conjuncts throughout
    ['हिन्दी', 'hindi'],     // final ee → i
    ['दुनिया', 'duniya'],    // final aa → a
    ['ख़ास', 'khaas'],       // MEDIAL aa preserved
    ['त्रिशूल', 'trishool'], // medial oo preserved
  ];

  for (const [input, expected] of CASES) {
    test(`${input} → ${expected}`, () => {
      assert.equal(transliterateToken(input), expected);
    });
  }

  // Vowel-length rules, where the guards matter. Each of these was a real
  // regression while tuning: shortening too aggressively breaks "baat"/"khaas",
  // shortening too little leaves "dikhaata"/"kahaani".
  const VOWEL_LENGTH: Array<[string, string]> = [
    ['दिखाता', 'dikhata'],  // open final → medial aa shortens
    ['बताता', 'batata'],    // same
    ['कहानी', 'kahani'],    // ee ending, 3 syllables → shortens
    ['बारी', 'baari'],      // ee ending, only 2 syllables → keeps length
    ['आजा', 'aaja'],        // word-INITIAL aa is never shortened
    ['राजा', 'raja'],
    ['बात', 'baat'],        // consonant final → medial aa kept
    ['ख़ास', 'khaas'],      // same
  ];

  for (const [input, expected] of VOWEL_LENGTH) {
    test(`vowel length: ${input} → ${expected}`, () => {
      assert.equal(transliterateToken(input), expected);
    });
  }

  test('does not emit ISO diacritics', () => {
    const out = transliterateText('आज का वीडियो बहुत ख़ास है');
    assert.doesNotMatch(out, /[āīūṭḍṇṣśṛñṅḥṁēōĀ]/, 'scholarly diacritics are not Hinglish');
  });

  test('output is pure ASCII Latin', () => {
    const out = transliterateText('मैं आज आपको एक बात बताता हूँ');
    assert.match(out, /^[\x20-\x7E]*$/, `non-ASCII in output: ${out}`);
  });
});

describe('English words are preserved exactly', () => {
  const ENGLISH = ['meeting', 'important', 'project', 'WhatsApp', 'iPhone', 'AI', 'e-mail', 'COVID-19'];

  for (const w of ENGLISH) {
    test(`"${w}" passes through unchanged`, () => {
      assert.equal(transliterateToken(w), w);
    });
  }

  test('mixed sentence keeps every Latin token byte-identical', async () => {
    const t = mkTranscript([
      ['ये', 0.0, 0.3], ['WhatsApp', 0.3, 1.0], ['पर', 1.0, 1.3],
      ['iPhone', 1.3, 2.0], ['से', 2.0, 2.3], ['भेजा', 2.3, 2.8],
    ], 'hi');
    const r = await toRomanScript(t);
    const text = r.transcript.words.map((w) => w.text);
    assert.ok(text.includes('WhatsApp'), 'capitalisation inside a Latin word must survive');
    assert.ok(text.includes('iPhone'));
    assert.equal(r.preserved, 2);
  });

  test('a rogue provider never even SEES an English token', async () => {
    // Protection is structural, not corrective: Latin tokens are filtered out
    // before the backend is called, so a provider that would translate English
    // into Hindi has no opportunity to. Asserting the OUTPUT (rather than an
    // error) is the stronger guarantee.
    const seen: string[] = [];
    const rogue = {
      name: 'rogue', description: 'would translate English into Hindi', offline: true,
      quality: 'rules' as const,
      supports: () => true,
      async romanise(tokens: string[]) {
        seen.push(...tokens);
        return tokens.map((t) => (t === 'meeting' ? 'मीटिंग' : `${t}-x`));
      },
    };
    const t = mkTranscript([['आज', 0, 0.5], ['meeting', 0.5, 1.2]], 'hi');
    const r = await addRomanisation(t, rogue);

    assert.ok(!seen.includes('meeting'), `provider was handed the English token: ${seen}`);
    assert.equal(r.transcript.words[1]!.roman, 'meeting', 'English must be untouched');
  });

  test('a provider that corrupts a token it WAS given is still caught', async () => {
    // Belt and braces for the tokens that legitimately go to the backend: if a
    // provider returns the wrong count, alignment with timestamps breaks.
    const bad = {
      name: 'bad', description: 'returns too few tokens', offline: true,
      quality: 'rules' as const,
      supports: () => true,
      async romanise(tokens: string[]) { return tokens.slice(1); },
    };
    const t = mkTranscript([['आज', 0, 0.5], ['बहुत', 0.5, 1.0], ['काम', 1.0, 1.5]], 'hi');
    await assert.rejects(() => addRomanisation(t, bad), /desynchronise/);
  });
});

describe('it is not translation', () => {
  test('Hindi words are romanised, not translated to English', async () => {
    const t = mkTranscript([
      ['बहुत', 0.0, 0.5], ['अच्छा', 0.5, 1.0], ['काम', 1.0, 1.5],
    ], 'hi');
    const r = await toRomanScript(t);
    const text = r.transcript.words.map((w) => w.text.toLowerCase()).join(' ');
    assert.match(text, /bahut/);
    assert.match(text, /accha/);
    assert.match(text, /kaam/);
    // The English meanings must NOT appear.
    for (const eng of ['very', 'good', 'work']) {
      assert.doesNotMatch(text, new RegExp(`\\b${eng}\\b`), `translated to "${eng}"`);
    }
  });

  test('word count is unchanged — no merging or splitting', async () => {
    const t = mkTranscript([
      ['मैं', 0.0, 0.3], ['आज', 0.3, 0.7], ['आपको', 0.7, 1.2],
      ['एक', 1.2, 1.5], ['बात', 1.5, 2.0], ['बताता', 2.0, 2.6], ['हूँ', 2.6, 2.9],
    ], 'hi');
    const r = await toRomanScript(t);
    assert.equal(r.transcript.words.length, 7);
  });
});

describe('preservation invariants', () => {
  test('timestamps are byte-for-byte identical', async () => {
    const src: Array<[string, number, number]> = [
      ['आज', 0.123, 0.567], ['meeting', 0.567, 1.234],
      ['बहुत', 1.234, 1.789], ['है', 1.789, 2.345],
    ];
    const t = mkTranscript(src, 'hi');
    const r = await toRomanScript(t);
    r.transcript.words.forEach((w, i) => {
      assert.equal(w.start, src[i]![1], `start of word ${i} changed`);
      assert.equal(w.end, src[i]![2], `end of word ${i} changed`);
    });
  });

  test('word ORDER is preserved', async () => {
    const t = mkTranscript([
      ['पहला', 0.0, 0.4], ['second', 0.4, 0.9], ['तीसरा', 0.9, 1.4], ['fourth', 1.4, 2.0],
    ], 'hi');
    const r = await toRomanScript(t);
    const text = r.transcript.words.map((w) => w.text);
    assert.equal(text[1], 'second');
    assert.equal(text[3], 'fourth');
    assert.ok(text[0] !== 'second' && text[2] !== 'fourth');
  });

  test('punctuation attached to words survives', () => {
    assert.equal(transliterateToken('है।'), 'hai.');
    assert.equal(transliterateToken('क्या?'), 'kya?');
    assert.equal(transliterateToken('अच्छा!'), 'accha!');
    assert.equal(transliterateToken('"बात"'), '"baat"');
    assert.equal(transliterateToken('(आज)'), '(aaj)');
  });

  test('numbers survive; Devanagari digits become ASCII', () => {
    assert.equal(transliterateToken('2026'), '2026');
    assert.equal(transliterateToken('१२३'), '123');
    assert.equal(transliterateText('5 मिनट में'), '5 minat mein');
  });

  test('other metadata on each word is carried through', async () => {
    const t: Transcript = {
      words: [{
        text: 'आज', start: 0.1, end: 0.6, confidence: 0.87,
        type: 'word', keep: true, speakerId: 'spk_1', language: 'hi',
      }],
      language: 'hi', duration: 1, provider: 'fixture', hasWordTimings: true,
    };
    const r = await toRomanScript(t);
    const w = r.transcript.words[0]!;
    assert.equal(w.confidence, 0.87);
    assert.equal(w.speakerId, 'spk_1');
    assert.equal(w.keep, true);
  });

  test('the original native text is retained alongside the roman form', async () => {
    const t = mkTranscript([['आज', 0, 0.5]], 'hi');
    const provider = new LocalHinglishTransliterator();
    const r = await addRomanisation(t, provider);
    assert.equal(r.transcript.words[0]!.text, 'आज', 'native text must not be destroyed');
    assert.equal(r.transcript.words[0]!.roman, 'aaj');
  });
});

describe('capitalisation', () => {
  test('first word is capitalised', () => {
    const t = mkTranscript([['aaj', 0, 0.4], ['meeting', 0.4, 1.0]], 'hi');
    const c = capitaliseSentences(t);
    assert.equal(c.words[0]!.text, 'Aaj');
    assert.equal(c.words[1]!.text, 'meeting');
  });

  test('a new sentence after terminal punctuation is capitalised', () => {
    const t = mkTranscript([
      ['aaj', 0, 0.4], ['hai.', 0.4, 0.8], ['kal', 0.8, 1.2],
    ], 'hi');
    const c = capitaliseSentences(t);
    assert.equal(c.words[0]!.text, 'Aaj');
    assert.equal(c.words[2]!.text, 'Kal');
  });

  test('mid-sentence Latin words keep their own casing', () => {
    const t = mkTranscript([['aaj', 0, 0.4], ['iPhone', 0.4, 1.0]], 'hi');
    assert.equal(capitaliseSentences(t).words[1]!.text, 'iPhone');
  });
});

describe('provider selection and failure modes', () => {
  test('there is no no-op provider', () => {
    assert.ok(!listTransliterators().includes('noop' as never));
  });

  test('local is the default and works offline', () => {
    const p = resolveTransliterator(undefined, 'hi', {} as NodeJS.ProcessEnv);
    assert.equal(p.name, 'local');
    assert.equal(p.offline, true);
  });

  test('local rejects a language it cannot handle, with alternatives', () => {
    assert.throws(
      () => resolveTransliterator('local', 'te', {} as NodeJS.ProcessEnv),
      (e: unknown) => {
        const err = e as Error & { hint?: string };
        assert.match(err.message, /only.*Devanagari|te/i);
        assert.match(err.hint ?? '', /sarvam/, 'must suggest a backend that covers it');
        return true;
      },
    );
  });

  test('sarvam without a key fails clearly', () => {
    assert.throws(
      () => resolveTransliterator('sarvam', 'hi', {} as NodeJS.ProcessEnv),
      (e: unknown) => {
        const err = e as Error & { hint?: string };
        assert.match(err.message, /SARVAM_API_KEY is not set/);
        assert.match(err.hint ?? '', /export SARVAM_API_KEY/);
        return true;
      },
    );
  });

  test('http without an endpoint fails clearly', () => {
    assert.throws(
      () => resolveTransliterator('http', 'hi', {} as NodeJS.ProcessEnv),
      /TRANSLITERATE_URL is not set/,
    );
  });

  test('unknown provider names are rejected', () => {
    assert.throws(
      () => resolveTransliterator('magic', 'hi', {} as NodeJS.ProcessEnv),
      /Unknown transliteration provider/,
    );
  });

  test('sarvam is selected when a key is present', () => {
    const p = resolveTransliterator('sarvam', 'hi', { SARVAM_API_KEY: 'k' } as NodeJS.ProcessEnv);
    assert.ok(p instanceof SarvamTransliterator);
    assert.equal(p.offline, false);
  });

  test('http is selected when an endpoint is present', () => {
    const p = resolveTransliterator('http', 'hi', {
      TRANSLITERATE_URL: 'https://x/y',
    } as NodeJS.ProcessEnv);
    assert.ok(p instanceof HttpTransliterator);
  });

  test('TRANSLITERATE_PROVIDER sets the default', () => {
    assert.throws(
      () => resolveTransliterator(undefined, 'hi', {
        TRANSLITERATE_PROVIDER: 'sarvam',
      } as NodeJS.ProcessEnv),
      /SARVAM_API_KEY is not set/,
    );
  });

  test('a provider returning the wrong token count is rejected', async () => {
    const bad = {
      name: 'bad', description: 'drops tokens', offline: true,
      quality: 'rules' as const,
      supports: () => true,
      async romanise(tokens: string[]) { return tokens.slice(1); },
    };
    const t = mkTranscript([['आज', 0, 0.4], ['बहुत', 0.4, 1.0]], 'hi');
    await assert.rejects(() => addRomanisation(t, bad), /Word timings would desynchronise/);
  });
});

describe('withScript', () => {
  test('refuses to switch to roman without romanisation applied', () => {
    const t = mkTranscript([['आज', 0, 0.5]], 'hi');
    assert.throws(() => withScript(t, 'roman'), /no romanisation/);
  });

  test('native is a pass-through', () => {
    const t = mkTranscript([['आज', 0, 0.5]], 'hi');
    assert.equal(withScript(t, 'native'), t);
  });

  test('after romanisation, roman text replaces the visible text', async () => {
    const t = mkTranscript([['आज', 0, 0.5], ['meeting', 0.5, 1.0]], 'hi');
    const r = await addRomanisation(t, new LocalHinglishTransliterator());
    const out = withScript(r.transcript, 'roman');
    assert.equal(out.words[0]!.text, 'aaj');
    assert.equal(out.words[1]!.text, 'meeting');
  });
});

describe('script detection helpers', () => {
  test('hasDevanagari', () => {
    assert.equal(hasDevanagari('आज'), true);
    assert.equal(hasDevanagari('meeting'), false);
    assert.equal(hasDevanagari('आज meeting'), true);
  });

  test('isIndicScript covers the other scripts too', () => {
    assert.equal(isIndicScript('నేను'), true);
    assert.equal(isIndicScript('ನಾನು'), true);
    assert.equal(isIndicScript('hello'), false);
  });
});

describe('edge cases', () => {
  test('empty and whitespace input', () => {
    assert.equal(transliterateToken(''), '');
    assert.equal(transliterateText('   '), '   ');
  });

  test('a token of pure punctuation', () => {
    assert.equal(transliterateToken('...'), '...');
    assert.equal(transliterateToken('।'), '.');
  });

  test('an all-English transcript is left completely alone', async () => {
    const t = mkTranscript([['hello', 0, 0.4], ['world', 0.4, 1.0]], 'hi');
    const r = await toRomanScript(t);
    assert.equal(r.converted, 0);
    assert.equal(r.preserved, 2);
    assert.equal(r.transcript.words[1]!.text, 'world');
  });

  test('repeated transliteration is idempotent', () => {
    const once = transliterateText('आज meeting बहुत important है');
    assert.equal(transliterateText(once), once, 'romanised text must not change again');
  });

  test('ZWJ/ZWNJ inside a word do not break conjuncts', () => {
    const out = transliterateToken('क्‍ष');
    assert.doesNotMatch(out, /[‌‍]/, 'zero-width joiners leaked into the output');
  });
});
