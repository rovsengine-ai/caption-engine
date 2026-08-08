import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { toRomanScript, romaniseTranscript } from '../src/transliterate/index.js';
import {
  loadGlossary, parseGlossary, applyGlossary, mergeGlossaries,
} from '../src/transliterate/glossary.js';
import { LocalHinglishTransliterator, autoSelectTransliterator } from '../src/transliterate/providers.js';
import { mkTranscript, tempDir } from './helpers.js';

/**
 * Natural mixed Hinglish.
 *
 * The bug that motivated all of this: ASR writes English in Devanagari
 * ("cheat day" → "चीट डे"), and phonetic rules then produce "cheet de".
 * The rules are right; the input was already lossy. Only a glossary can
 * recover the English spelling.
 */

const HI = 'hi';

/** Build a transcript from "word:start:end" triples, optionally with a language tag. */
function tx(spec: Array<[string, number, number] | [string, number, number, string]>) {
  const words = spec.map((s) => ({
    text: s[0] as string,
    start: s[1] as number,
    end: s[2] as number,
    confidence: 1,
    type: 'word' as const,
    keep: true,
    ...(s[3] ? { language: s[3] as string } : {}),
  }));
  return {
    words, language: HI, duration: 10, provider: 'fixture', hasWordTimings: true,
  };
}

const text = (r: { transcript: { words: Array<{ text: string }> } }) =>
  r.transcript.words.map((w) => w.text).join(' ');

describe('the "cheat day" regression', () => {
  test('चीट डे → "cheat day", NOT "cheet de"', async () => {
    const t = tx([['चीट', 0.8, 1.2], ['डे', 1.2, 1.5]]);
    const r = await toRomanScript(t, { provider: 'local' });
    const out = text(r).toLowerCase();
    assert.equal(out, 'cheat day');
    assert.doesNotMatch(out, /cheet/, 'phonetic spelling leaked through');
    assert.doesNotMatch(out, /\bde\b/, '"डे" must not become "de"');
  });

  test('the full sentence from the bug report', async () => {
    const t = tx([
      ['आज', 0.0, 0.4], ['मेरा', 0.4, 0.8], ['चीट', 0.8, 1.2], ['डे', 1.2, 1.5],
      ['है,', 1.5, 1.9], ['बट', 2.0, 2.3], ['कल', 2.3, 2.6], ['से', 2.6, 2.9],
      ['डाइट', 2.9, 3.4], ['स्टार्ट', 3.4, 4.0], ['करूंगा', 4.0, 4.6],
    ]);
    const r = await toRomanScript(t, { provider: 'local' });
    assert.equal(text(r), 'Aaj mera cheat day hai, but kal se diet start karunga');
  });

  test('none of the known-bad spellings survive', async () => {
    const t = tx([
      ['चीट', 0, 0.4], ['डे', 0.4, 0.8], ['बट', 0.8, 1.2],
      ['डाइट', 1.2, 1.6], ['वर्कआउट', 1.6, 2.2],
    ]);
    const out = text(await toRomanScript(t, { provider: 'local' })).toLowerCase();
    for (const bad of ['cheet', 'daait', 'varkaaut', 'bat ']) {
      assert.doesNotMatch(out, new RegExp(bad), `"${bad}" should have been fixed: ${out}`);
    }
    assert.match(out, /cheat day/);
    assert.match(out, /workout/);
  });

  test('the other required examples', async () => {
    const cases: Array<[ReturnType<typeof tx>, string]> = [
      [tx([['आज', 0, .4], ['मेरा', .4, .8], ['cheat', .8, 1.2], ['day', 1.2, 1.5], ['है', 1.5, 1.9]]),
        'Aaj mera cheat day hai'],
      [tx([['आज', 0, .4], ['meeting', .4, 1], ['बहुत', 1, 1.4], ['important', 1.4, 2], ['है', 2, 2.3]]),
        'Aaj meeting bahut important hai'],
      [tx([['मैं', 0, .3], ['कल', .3, .6], ['से', .6, .9], ['diet', .9, 1.3],
        ['start', 1.3, 1.9], ['करूंगा', 1.9, 2.5]]),
        'Main kal se diet start karunga'],
    ];
    for (const [t, expected] of cases) {
      assert.equal(text(await toRomanScript(t, { provider: 'local' })), expected);
    }
  });
});

describe('glossary parsing', () => {
  test('mappings and protected phrases', () => {
    const g = parseGlossary(`
# a comment
चीट डे => cheat day
डाइट => diet
cheat day
workout
`);
    assert.equal(g.mappings.length, 2);
    assert.equal(g.protectedPhrases.length, 2);
  });

  test('token-count mismatches are rejected at load, with an explanation', () => {
    assert.throws(
      () => parseGlossary('चीट => cheat day'),
      (e: unknown) => {
        const err = e as Error & { hint?: string };
        assert.match(err.message, /1 token\(s\).*2/);
        assert.match(err.hint ?? '', /word timings/);
        return true;
      },
    );
  });

  test('longest phrases match first', () => {
    const g = parseGlossary('चीट डे => cheat day\nडे => day');
    assert.equal(g.mappings[0]!.from.length, 2, 'two-token entry must be tried first');
  });

  test('tab-separated form also works', () => {
    const g = parseGlossary('डाइट\tdiet');
    assert.equal(g.mappings.length, 1);
    assert.deepEqual(g.mappings[0]!.to, ['diet']);
  });

  test('the shipped default glossary loads and is non-trivial', () => {
    const g = loadGlossary();
    assert.ok(g.mappings.length > 50, `only ${g.mappings.length} mappings`);
    assert.ok(g.protectedPhrases.length > 20);
    const cheat = g.mappings.find((m) => m.to.join(' ') === 'cheat day');
    assert.ok(cheat, 'default glossary must cover the reported case');
  });

  test('a missing glossary file fails with format help', () => {
    assert.throws(() => loadGlossary('/nope/missing.txt'), /Glossary file not found/);
  });
});

describe('phrase-level protection', () => {
  test('multi-token phrases are matched as a unit', () => {
    const g = parseGlossary('वेट लॉस => weight loss');
    const r = applyGlossary(['वेट', 'लॉस'], g);
    assert.deepEqual(r.tokens, ['weight', 'loss']);
    assert.equal(r.locked.size, 2);
  });

  test('a longer phrase wins over a shorter overlapping one', () => {
    const g = parseGlossary('चीट डे => cheat day\nडे => date');
    const r = applyGlossary(['चीट', 'डे'], g);
    assert.deepEqual(r.tokens, ['cheat', 'day'], 'the 2-token entry should have won');
  });

  test('punctuation attached to a mapped token survives', () => {
    const g = parseGlossary('डे => day');
    assert.deepEqual(applyGlossary(['डे,'], g).tokens, ['day,']);
    assert.deepEqual(applyGlossary(['डे।'], g).tokens, ['day.']);
  });

  test('protected Latin phrases are locked, not rewritten', () => {
    const g = parseGlossary('cheat day');
    const r = applyGlossary(['cheat', 'day'], g);
    assert.deepEqual(r.tokens, ['cheat', 'day']);
    assert.equal(r.locked.size, 2, 'both tokens must be locked against the backend');
  });

  test('a locked token is never sent to the transliteration backend', async () => {
    const seen: string[] = [];
    const spy = {
      name: 'spy', description: 'records what it receives', offline: true,
      quality: 'rules' as const,
      supports: () => true,
      async romanise(tokens: string[]) { seen.push(...tokens); return tokens; },
    };
    const t = tx([['चीट', 0, 0.4], ['डे', 0.4, 0.8], ['बहुत', 0.8, 1.2]]);
    await romaniseTranscript(t, spy, {});
    assert.ok(!seen.includes('चीट'), 'glossary-mapped token leaked to the backend');
    assert.ok(!seen.includes('डे'), 'glossary-mapped token leaked to the backend');
    assert.ok(seen.includes('बहुत'), 'ordinary Hindi should still be sent');
  });

  test('a user glossary merges over the built-in one', () => {
    const tmp = tempDir('ce-gloss-');
    try {
      const f = join(tmp.path, 'mine.txt');
      writeFileSync(f, 'फिटनेस => FitnessPro\n', 'utf8');
      const merged = mergeGlossaries(loadGlossary(), loadGlossary(f));
      const hit = applyGlossary(['फिटनेस'], merged);
      assert.ok(
        hit.tokens[0] === 'FitnessPro' || hit.tokens[0] === 'fitness',
        `unexpected: ${hit.tokens[0]}`,
      );
      assert.equal(hit.locked.size, 1);
    } finally { tmp.cleanup(); }
  });
});

describe('ASR language tags drive protection', () => {
  // "ज़ेब्रापेंट" is deliberately NOT in the glossary, so this exercises the
  // language-tag path rather than accidentally passing because of a mapping.
  const TAGGED = 'ज़ेब्रापेंट';

  test('a token the ASR tagged English is never transliterated', async () => {
    const seen: string[] = [];
    const spy = {
      name: 'spy', description: '', offline: true, quality: 'rules' as const,
      supports: () => true,
      async romanise(tokens: string[]) { seen.push(...tokens); return tokens.map(() => 'XX'); },
    };
    const t = tx([['बहुत', 0, 0.4], [TAGGED, 0.4, 0.8, 'en']]);
    const r = await romaniseTranscript(t, spy, { protectEnglish: true });

    assert.ok(!seen.includes(TAGGED), 'ASR-tagged English was sent to the backend');
    assert.ok(seen.includes('बहुत'), 'untagged Hindi should still be sent');
    assert.equal(r.transcript.words[1]!.roman, TAGGED, 'tagged token must be untouched');
    assert.equal(
      r.diagnostics.find((d) => d.original === TAGGED)!.stage, 'asr-english',
    );
  });

  test('--no-protect-english lets it through to the backend', async () => {
    const t = tx([[TAGGED, 0, 0.4, 'en']]);
    const r = await romaniseTranscript(t, new LocalHinglishTransliterator(), {
      protectEnglish: false,
    });
    assert.notEqual(r.transcript.words[0]!.roman, TAGGED, 'should have been romanised');
  });
});

describe('provider auto-selection', () => {
  test('prefers a model backend when one is configured', () => {
    assert.equal(autoSelectTransliterator({ SARVAM_API_KEY: 'k' } as NodeJS.ProcessEnv), 'sarvam');
    assert.equal(autoSelectTransliterator({ TRANSLITERATE_URL: 'u' } as NodeJS.ProcessEnv), 'http');
  });

  test('falls back to local when nothing is configured', () => {
    assert.equal(autoSelectTransliterator({} as NodeJS.ProcessEnv), 'local');
  });

  test('local is labelled as rules-quality, not model-quality', () => {
    const p = new LocalHinglishTransliterator();
    assert.equal(p.quality, 'rules');
    assert.match(p.description, /LOWER QUALITY/);
  });
});

describe('diagnostics separate ASR errors from transliteration errors', () => {
  test('every token reports the stage that decided it', async () => {
    const t = tx([
      ['आज', 0, 0.4], ['चीट', 0.4, 0.8], ['डे', 0.8, 1.2], ['meeting', 1.2, 1.8],
    ]);
    const r = await toRomanScript(t, { provider: 'local' });
    const byOriginal = new Map(r.diagnostics.map((d) => [d.original, d]));
    assert.equal(byOriginal.get('आज')!.stage, 'transliterated');
    assert.equal(byOriginal.get('चीट')!.stage, 'glossary-map');
    assert.equal(byOriginal.get('डे')!.stage, 'glossary-map');
    assert.ok(
      ['already-latin', 'glossary-protect'].includes(byOriginal.get('meeting')!.stage),
      byOriginal.get('meeting')!.stage,
    );
  });

  test('diagnostics carry the original timestamps for cross-checking', async () => {
    const t = tx([['आज', 0.123, 0.456]]);
    const r = await toRomanScript(t, { provider: 'local' });
    assert.equal(r.diagnostics[0]!.start, 0.123);
    assert.equal(r.diagnostics[0]!.end, 0.456);
  });
});

describe('invariants hold with the glossary in play', () => {
  const SENTENCE = tx([
    ['आज', 0.11, 0.42], ['मेरा', 0.42, 0.83], ['चीट', 0.83, 1.24], ['डे', 1.24, 1.55],
    ['है,', 1.55, 1.96], ['बट', 2.01, 2.32], ['कल', 2.32, 2.63], ['से', 2.63, 2.94],
    ['डाइट', 2.94, 3.45], ['स्टार्ट', 3.45, 4.06], ['करूंगा', 4.06, 4.67],
  ]);

  test('token count is unchanged', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    assert.equal(r.transcript.words.length, SENTENCE.words.length);
  });

  test('every timestamp is byte-identical', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    r.transcript.words.forEach((w, i) => {
      assert.equal(w.start, SENTENCE.words[i]!.start, `start ${i}`);
      assert.equal(w.end, SENTENCE.words[i]!.end, `end ${i}`);
    });
  });

  test('native and roman outputs have identical timing', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    const native = SENTENCE.words.map((w) => [w.start, w.end]);
    const roman = r.transcript.words.map((w) => [w.start, w.end]);
    assert.deepEqual(roman, native);
  });

  test('order is preserved', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    const out = r.transcript.words.map((w) => w.text.toLowerCase());
    assert.ok(out.indexOf('cheat') < out.indexOf('day'));
    assert.ok(out.indexOf('diet') < out.indexOf('start'));
  });

  test('punctuation survives', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    assert.ok(text(r).includes('hai,'), 'the comma was lost');
  });

  test('numbers, acronyms and brands survive', async () => {
    const t = tx([
      ['मैंने', 0, 0.4], ['2', 0.4, 0.6], ['GB', 0.6, 0.9],
      ['का', 0.9, 1.1], ['YouTube', 1.1, 1.6], ['वीडियो', 1.6, 2.1],
      ['देखा', 2.1, 2.5],
    ]);
    const out = text(await toRomanScript(t, { provider: 'local' }));
    assert.match(out, /\b2\b/);
    assert.match(out, /GB/, 'acronym casing lost');
    assert.match(out, /YouTube/, 'brand casing lost');
    assert.match(out, /video/, 'वीडियो should map to "video", not "veediyo"');
  });

  test('no Indic script survives into Roman output', async () => {
    const r = await toRomanScript(SENTENCE, { provider: 'local' });
    for (const w of r.transcript.words) {
      assert.doesNotMatch(w.text, /[ऀ-ॿ]/, `Devanagari left in output: ${w.text}`);
    }
  });
});
