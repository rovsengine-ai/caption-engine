import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SarvamTransliterator, resolveTransliterator } from '../src/transliterate/providers.js';
import { romaniseTranscript, toRomanScript } from '../src/transliterate/index.js';
import { splitBatchResponse, planBatches, subdivide } from '../src/transliterate/batching.js';
import { CaptionEngineError } from '../src/errors.js';
import { mkTranscript } from './helpers.js';

/**
 * The production failure this file exists for:
 *
 *     Sarvam failed on batch 1 of 1:
 *     Sarvam returned a token count that does not match the 62 words sent in
 *     batch 1, twice.
 *     There is no offline transliterator for "kn" to fall back to.
 *
 * Sarvam romanises a STRING, not an array, so 62 Kannada words go out as one
 * pipe-delimited request and the reply has to be split back into exactly 62
 * pieces. Every extra word in a request is another delimiter the model can
 * merge, drop or invent, and a mis-split reply cannot be matched to word
 * timings. It was correctly refused — and then, because Kannada has no offline
 * transliterator, the whole render died on that one batch.
 *
 * The fix is not a looser check. The check stays exactly as strict: nothing is
 * padded, truncated, or paired up by guesswork. What changed is what happens
 * after a mismatch — the batch is bisected and asked again in smaller pieces,
 * down to one word per request, which carries no delimiter at all and therefore
 * cannot be mis-split. Correct at the leaves by construction, not by luck.
 *
 * NO REAL API CALLS. `fetch` is replaced in every test here, and one of the
 * tests asserts that nothing reached a real host.
 */

/** 62 Kannada words — the batch size from the production report. */
const SIXTY_TWO: string[] = [
  'ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ', 'ಮತ್ತು', 'ಪೆನ್ನು', 'ಇದೆ', 'ನಾನು', 'ನಿನ್ನ', 'ಜೊತೆ', 'ಬರುತ್ತೇನೆ',
  'ಇವತ್ತು', 'ಬೆಳಿಗ್ಗೆ', 'ಮನೆಯಲ್ಲಿ', 'ಎಲ್ಲರೂ', 'ಸೇರಿ', 'ಊಟ', 'ಮಾಡಿದೆವು', 'ಆಮೇಲೆ', 'ನಾವು', 'ಹೊರಗೆ',
  'ಹೋದೆವು', 'ಅಲ್ಲಿ', 'ತುಂಬಾ', 'ಜನ', 'ಇದ್ದರು', 'ಆದರೆ', 'ಯಾರೂ', 'ಮಾತನಾಡಲಿಲ್ಲ', 'ನಂತರ', 'ಮಳೆ',
  'ಬಂತು', 'ಮತ್ತೆ', 'ನಾವು', 'ಒಳಗೆ', 'ಬಂದೆವು', 'ಸಂಜೆ', 'ಚಹಾ', 'ಕುಡಿದೆವು', 'ಸ್ವಲ್ಪ', 'ಹೊತ್ತು',
  'ಕುಳಿತೆವು', 'ಆಮೇಲೆ', 'ಹಾಡು', 'ಕೇಳಿದೆವು', 'ರಾತ್ರಿ', 'ಬೇಗ', 'ಮಲಗಿದೆವು', 'ಬೆಳಗ್ಗೆ', 'ಎದ್ದು', 'ನಡೆದೆವು',
  'ದಾರಿಯಲ್ಲಿ', 'ಹೂವು', 'ನೋಡಿದೆವು', 'ಬಹಳ', 'ಚೆನ್ನಾಗಿ', 'ಇತ್ತು', 'ನಮಗೆ', 'ಖುಷಿ', 'ಆಯಿತು', 'ಕೊನೆಗೆ',
  'ಮನೆಗೆ', 'ಮರಳಿದೆವು',
];

const SARVAM_HOST = 'https://sarvam.invalid';
const HTTP_FALLBACK_URL = 'https://fallback.invalid/transliterate';

interface Fake {
  restore(): void;
  /** Every `body.input` sent to the fake Sarvam, in call order. */
  sarvamCalls: string[];
  /** Every token list sent to the fake generic HTTP endpoint. */
  httpCalls: string[][];
  /** Every URL touched, so a test can prove nothing escaped. */
  urls: string[];
}

/**
 * A Sarvam stand-in that mis-delimits exactly the way the real one does.
 *
 * `breaksAt(n)` decides, from the NUMBER OF WORDS in the request, whether the
 * reply comes back with the wrong number of pieces — modelling "the more words
 * in one request, the likelier a delimiter gets swallowed". Keying on size
 * rather than call number is what makes bisection meaningful: a smaller request
 * genuinely behaves differently, which is the whole premise of the fix.
 */
function fakeApi(opts: {
  breaksAt?: (words: number) => boolean;
  /** Any request containing this word fails, at every size. */
  poison?: string;
  /** How a successfully aligned word comes back. Latin by default. */
  transform?: (piece: string) => string;
  /** Reply for the generic HTTP fallback endpoint. */
  httpReply?: (tokens: string[]) => string[];
  /** Return an empty string for the whole reply. */
  emptyReply?: (words: number) => boolean;
} = {}): Fake {
  const original = globalThis.fetch;
  const f: Fake = {
    restore: () => { globalThis.fetch = original; },
    sarvamCalls: [], httpCalls: [], urls: [],
  };

  globalThis.fetch = (async (url: string, init: { body: string }) => {
    f.urls.push(String(url));

    if (String(url).startsWith(HTTP_FALLBACK_URL)) {
      const { tokens } = JSON.parse(init.body) as { tokens: string[] };
      f.httpCalls.push(tokens);
      const reply = opts.httpReply ? opts.httpReply(tokens) : tokens.map((t) => `H${t}`);
      return new Response(JSON.stringify({ tokens: reply }), { status: 200 });
    }

    const { input } = JSON.parse(init.body) as { input: string };
    f.sarvamCalls.push(input);
    const pieces = input.split('|').map((s) => s.trim());

    if (opts.emptyReply?.(pieces.length)) {
      return new Response(JSON.stringify({ transliterated_text: '' }), { status: 200 });
    }
    const broken = opts.breaksAt?.(pieces.length)
      || (opts.poison !== undefined && pieces.includes(opts.poison));
    if (broken) {
      // A one-word request carries no delimiter, so there is nothing to
      // mis-split — the only way it can fail is by coming back unusable. That
      // asymmetry IS the fix, so the fake has to model it honestly rather than
      // pretend a single word can be mis-delimited.
      if (pieces.length === 1) {
        return new Response(JSON.stringify({ transliterated_text: '' }), { status: 200 });
      }
      // The real symptom: two adjacent words come back run together, so the
      // reply has one piece fewer than the request had words.
      const merged = [pieces[0]! + pieces[1]!, ...pieces.slice(2)];
      return new Response(
        JSON.stringify({ transliterated_text: merged.join(' | ') }), { status: 200 },
      );
    }
    const t = opts.transform ?? ((p: string) => `R${p}`);
    return new Response(
      JSON.stringify({ transliterated_text: pieces.map(t).join(' | ') }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  return f;
}

const noSleep = async (): Promise<void> => {};
let fake: Fake | null = null;
afterEach(() => { fake?.restore(); fake = null; });

function sarvam(extra: Record<string, unknown> = {}): SarvamTransliterator {
  return new SarvamTransliterator('test-key', {
    baseUrl: SARVAM_HOST, sleep: noSleep, ...extra,
  });
}

// ---------------------------------------------------------------------------

describe('the reported failure: 62 Kannada words, batch 1 of 1', () => {
  test('the whole batch used to die; now every word is romanised', async () => {
    // Anything over eight words in a request comes back mis-delimited.
    fake = fakeApi({ breaksAt: (n) => n > 8 });
    const p = sarvam();

    const out = await p.romanise(SIXTY_TWO, 'kn');

    assert.equal(out.length, 62, 'word count is the whole point');
    assert.ok(out.every((t) => t.startsWith('R')), 'every word came back from the model');
    assert.equal(p.stats.tokensViaNative, 0, 'nothing was left in Kannada');
    assert.equal(p.stats.fallbackBatches, 0, 'and nothing needed the fallback policy');
  });

  test('it is one batch, so the failure really is the reported one', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 8 });
    const p = sarvam();
    await p.romanise(SIXTY_TWO, 'kn');
    assert.equal(p.stats.batches, 1, 'batch 1 of 1, exactly as in the report');
    assert.deepEqual(p.stats.subdividedBatches, [1]);
  });

  test('word ORDER survives the bisection', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 8 });
    const out = await sarvam().romanise(SIXTY_TWO, 'kn');
    // The fake prefixes each word, so the expected output is knowable exactly.
    assert.deepEqual(out, SIXTY_TWO.map((w) => `R${w}`));
  });

  test('recovery is bounded and reported, not silent', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 8 });
    const p = sarvam();
    await p.romanise(SIXTY_TWO, 'kn');

    assert.ok(p.stats.subdivisionRequests > 0);
    assert.ok(p.stats.subdivisionRequests <= 48, 'the default budget is respected');
    assert.equal(p.stats.tokensViaSubdivision, 62);
    assert.ok(
      p.stats.notes.some((n) => /bisected into smaller requests/.test(n)),
      'the run must be able to explain what it did',
    );
  });

  test('even a model that only ever manages one word at a time succeeds', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 1 });
    const p = sarvam({ maxSubdivisionRequests: 256 });
    const out = await p.romanise(SIXTY_TWO, 'kn');

    assert.deepEqual(out, SIXTY_TWO.map((w) => `R${w}`));
    assert.equal(p.stats.tokensViaNative, 0);
  });

  test('timings, word count and order are untouched end to end', async () => {
    const t = mkTranscript(
      SIXTY_TWO.map((w, i) => [w, 0.2 + i * 0.5, 0.6 + i * 0.5] as [string, number, number]),
      'kn',
    );
    const before = t.words.map((w) => ({ s: w.start, e: w.end }));

    fake = fakeApi({ breaksAt: (n) => n > 8 });
    const r = await romaniseTranscript(t, sarvam(), { language: 'kn' });

    assert.equal(r.transcript.words.length, before.length);
    r.transcript.words.forEach((w, i) => {
      assert.equal(w.start, before[i]!.s, `word ${i} start moved`);
      assert.equal(w.end, before[i]!.e, `word ${i} end moved`);
      assert.equal(w.roman, `R${SIXTY_TWO[i]}`, `word ${i} romanised out of order`);
    });
    assert.equal(r.keptNativeScript, false);
  });

  test('English words are never sent and never rewritten', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 4 });
    const mixed = [...SIXTY_TWO.slice(0, 20), 'meeting', 'deadline', ...SIXTY_TWO.slice(20, 40)];
    const out = await sarvam().romanise(mixed, 'kn');

    assert.equal(out[20], 'meeting');
    assert.equal(out[21], 'deadline');
    for (const sent of fake.sarvamCalls) {
      assert.ok(!sent.includes('meeting'), 'English must not leave the machine');
      assert.ok(!sent.includes('deadline'), 'English must not leave the machine');
    }
  });

  test('no request ever left for a real host', async () => {
    fake = fakeApi({ breaksAt: (n) => n > 8 });
    await sarvam().romanise(SIXTY_TWO, 'kn');
    assert.ok(fake.urls.length > 0, 'the test must actually exercise the transport');
    for (const u of fake.urls) {
      assert.ok(u.startsWith(SARVAM_HOST), `unexpected host: ${u}`);
      assert.ok(!/sarvam\.ai/.test(u), 'the real API must never be contacted');
    }
  });
});

describe('the strict alignment check is unchanged', () => {
  test('a mis-delimited reply is still refused, never force-fitted', () => {
    const batch = planBatches(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ'])[0]!;
    assert.equal(splitBatchResponse('idu ondu | pustaka', batch), null, 'too few');
    assert.equal(splitBatchResponse('i | du | ondu | pustaka', batch), null, 'too many');
  });

  test('an empty piece counts as a failure, not as an answer', () => {
    // Previously an empty piece passed the count check and the word was then
    // quietly left in Kannada — a silent native fallback, which is exactly the
    // outcome this module exists to prevent.
    const batch = planBatches(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ'])[0]!;
    assert.equal(splitBatchResponse('idu |  | pustaka', batch), null);
    assert.equal(splitBatchResponse('', planBatches(['ಇದು'])[0]!), null, 'empty singleton');
  });

  test('a stray separator at the very edge is tolerated — it loses nothing', () => {
    const batch = planBatches(['ಇದು', 'ಒಂದು'])[0]!;
    assert.deepEqual(splitBatchResponse('| idu | ondu |', batch), ['idu', 'ondu']);
  });

  test('an empty reply does not silently leave words in Kannada', async () => {
    fake = fakeApi({ emptyReply: () => true });
    await assert.rejects(
      () => sarvam().romanise(SIXTY_TWO.slice(0, 6), 'kn'),
      (e: unknown) => e instanceof CaptionEngineError
        && /no offline transliterator/.test((e as Error).message),
      'an empty reply must fail loudly, not pass as success',
    );
  });

  test('bisection keeps each sub-request pointing at its own words', () => {
    const batch = planBatches(SIXTY_TWO.slice(0, 8))[0]!;
    const [a, b] = subdivide(batch);
    assert.ok(a && b);
    assert.deepEqual(
      [...a.indices, ...b.indices], batch.indices,
      'indices must concatenate back to the parent, in order',
    );
    assert.deepEqual([...a.tokens, ...b.tokens], batch.tokens);
    assert.equal(a.tokens.length + b.tokens.length, 8, 'no word is lost or duplicated');
  });

  test('a single word is never split further', () => {
    assert.deepEqual(subdivide(planBatches(['ಇದು'])[0]!), []);
  });
});

describe('what happens to words bisection genuinely cannot rescue', () => {
  /** Broken at every size, including one word per request. */
  const hopeless = { breaksAt: () => true };

  test('error (the default) refuses, and explains what was already tried', async () => {
    fake = fakeApi(hopeless);
    await assert.rejects(
      () => sarvam().romanise(SIXTY_TWO.slice(0, 6), 'kn'),
      (e: unknown) => {
        const err = e as CaptionEngineError & { hint?: string };
        assert.ok(e instanceof CaptionEngineError);
        assert.match(err.message, /no offline transliterator for "kn"/);
        assert.match(err.message, /even after splitting the batch into smaller requests/);
        assert.match(String(err.hint ?? ''), /Nothing was guessed/);
        assert.match(String(err.hint ?? ''), /--roman-fallback native/);
        return true;
      },
    );
  });

  test('native keeps ONLY the words it could not rescue', async () => {
    // One word poisons every request it appears in. Before bisection it would
    // have taken all 62 of its batch-mates down with it; now it costs exactly
    // itself.
    const words = SIXTY_TWO.slice(0, 12);
    const bad = words[7]!;
    fake = fakeApi({ poison: bad });
    const p = sarvam({ allowNativeFallback: true });
    const out = await p.romanise(words, 'kn');

    assert.equal(out.length, words.length, 'word count preserved');
    assert.equal(out[7], bad, 'the unrescuable word kept its Kannada');
    words.forEach((w, i) => {
      if (i !== 7) assert.equal(out[i], `R${w}`, `word ${i} should still be model output`);
    });
    assert.equal(p.stats.tokensViaNative, 1, 'exactly one word degraded, not the batch');
    assert.deepEqual(p.stats.nativeBatches, [1]);
  });

  test('native reports every word it left in Kannada', async () => {
    fake = fakeApi(hopeless);
    const words = SIXTY_TWO.slice(0, 6);
    const p = sarvam({ allowNativeFallback: true });
    const out = await p.romanise(words, 'kn');

    assert.deepEqual(out, words, 'untouched, not mangled');
    assert.equal(p.stats.tokensViaNative, words.length);
    assert.deepEqual(p.stats.nativeBatches, [1], 'the batch is named, not just counted');
    assert.ok(p.stats.notes.some((n) => /KEEP THEIR NATIVE SCRIPT/.test(n)));
  });

  test('http sends exactly those words to TRANSLITERATE_URL', async () => {
    // The bug this covers: --roman-fallback http was only consulted when
    // choosing a backend. Sarvam supports Kannada, so it was chosen, and the
    // policy then had no effect on the batch failure it was recommended for —
    // the error message advertised a flag that did nothing.
    fake = fakeApi(hopeless);
    const env = {
      SARVAM_API_KEY: 'test-key',
      SARVAM_BASE_URL: SARVAM_HOST,
      TRANSLITERATE_URL: HTTP_FALLBACK_URL,
    } as NodeJS.ProcessEnv;

    const p = resolveTransliterator('sarvam', 'kn', env, { fallbackPolicy: 'http' });
    const words = SIXTY_TWO.slice(0, 6);
    const out = await p.romanise(words, 'kn');

    assert.deepEqual(out, words.map((w) => `H${w}`), 'the endpoint romanised them');
    assert.equal(fake.httpCalls.length, 1, 'one call, for the unrescuable words only');
    assert.deepEqual(fake.httpCalls[0], words);
  });

  test('http does not disable the offline engine for languages it covers', async () => {
    // Passing the policy down must widen the options, never narrow them: with
    // no TRANSLITERATE_URL set, Hindi must still reach the built-in engine.
    fake = fakeApi(hopeless);
    const env = { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: SARVAM_HOST } as NodeJS.ProcessEnv;
    const p = resolveTransliterator('sarvam', 'hi', env, { fallbackPolicy: 'http' });

    const out = await p.romanise(['बहुत', 'अच्छा'], 'hi');
    assert.equal(out[0], 'bahut', 'the offline engine still ran');
  });

  test('a working run is never replaced by a fallback', async () => {
    // Latin output here, because this goes through the full toRomanScript path
    // which refuses to label anything still in Kannada as Roman.
    fake = fakeApi({ transform: (p) => `w${p.length}` });
    const t = mkTranscript(
      SIXTY_TWO.slice(0, 4).map((w, i) => [w, i, i + 0.5] as [string, number, number]),
      'kn',
    );
    const r = await toRomanScript(t, {
      language: 'kn',
      provider: 'sarvam',
      fallback: 'native',
      env: { SARVAM_API_KEY: 'test-key', SARVAM_BASE_URL: SARVAM_HOST } as NodeJS.ProcessEnv,
    });

    assert.equal(r.fallbackUsed, null);
    assert.equal(r.keptNativeScript, false);
    assert.equal(r.batching?.subdividedBatches.length, 0, 'nothing needed bisecting');
  });
});
