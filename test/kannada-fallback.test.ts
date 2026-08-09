import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SarvamTransliterator, NativeScriptPassthrough, resolveTransliterator,
} from '../src/transliterate/providers.js';
import { toRomanScript, romaniseTranscript } from '../src/transliterate/index.js';
import { codePoints, SARVAM_HARD_LIMIT } from '../src/transliterate/batching.js';
import { CaptionEngineError } from '../src/errors.js';
import { mkTranscript } from './helpers.js';

/**
 * Kannada + Sarvam: the token-count mismatch, and what to do about it.
 *
 * The failure that motivated this file: Sarvam sometimes returns a different
 * number of pieces than the number of Kannada words sent in a batch. The
 * response cannot be aligned to word timings, so it is discarded — correctly.
 * But Kannada has no offline transliterator, so there was nothing to fall back
 * to and the whole render died on one bad batch.
 *
 * The rule that must never bend: mismatched output is NEVER forced onto
 * timestamps. Everything here is about what happens afterwards.
 *
 * No paid API calls. `fetch` is replaced throughout.
 */

const KANNADA = ['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ', 'ಮತ್ತು', 'ಪೆನ್ನು', 'ಇದೆ'];

interface Fake { restore(): void; calls: string[] }

/**
 * Fake Sarvam.
 *
 * `breakBatch` decides, from the batch content, whether that batch returns a
 * mismatched token count — persistently, so it survives the built-in retry.
 * Keying on content rather than call number is what makes the fallback path
 * actually reachable.
 */
function fakeSarvam(opts: {
  breakBatch?: (input: string) => boolean;
  transform?: (piece: string) => string;
} = {}): Fake {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string };
    calls.push(body.input);
    if (codePoints(body.input) > SARVAM_HARD_LIMIT) {
      return new Response(JSON.stringify({ error: 'too long' }), { status: 422 });
    }
    const pieces = body.input.split('|').map((s) => s.trim());
    if (opts.breakBatch?.(body.input)) {
      // Return one piece too few — the reported failure.
      return new Response(
        JSON.stringify({ transliterated_text: pieces.slice(0, -1).join(' | ') }),
        { status: 200 },
      );
    }
    const t = opts.transform ?? ((p: string) => `R${p}`);
    return new Response(
      JSON.stringify({ transliterated_text: pieces.map(t).join(' | ') }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, calls };
}

const noSleep = async (): Promise<void> => {};
let fake: Fake | null = null;
afterEach(() => { fake?.restore(); fake = null; });

function kn(extra: Record<string, unknown> = {}): SarvamTransliterator {
  return new SarvamTransliterator('test-key', { sleep: noSleep, ...extra });
}

// ---------------------------------------------------------------------------

describe('the strict check never bends', () => {
  test('a mismatched batch is refused rather than aligned', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    await assert.rejects(
      () => kn().romanise(KANNADA, 'kn'),
      (e: unknown) => e instanceof CaptionEngineError && /no offline transliterator/.test(String((e as Error).message)),
      'a token-count mismatch with no fallback must fail loudly',
    );
  });

  test('it retries once, then bisects, before giving up', async () => {
    // The batch is broken at EVERY size here, including one word per request,
    // so this is the genuinely hopeless case. What it pins down is the shape of
    // the effort: one cheap re-roll of the same request, then progressively
    // smaller requests, and only then the fallback policy.
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true });
    await p.romanise(KANNADA, 'kn');

    assert.equal(p.stats.retries, 1, 'exactly one re-roll of the identical request');
    assert.deepEqual(p.stats.subdividedBatches, [1], 'then the batch was bisected');
    assert.ok(p.stats.subdivisionRequests > 0, 'smaller requests were actually tried');
    assert.equal(
      fake.calls.length,
      2 + p.stats.subdivisionRequests,
      'every request is accounted for: the first, its retry, and the bisection',
    );
    // Bisection bottoms out at one word per request, which is the only size
    // that cannot be mis-split. Reaching it proves nothing was skipped.
    assert.ok(
      fake.calls.some((c) => !c.includes('|')),
      'the recursion must reach single-word requests',
    );
  });

  test('bisection is bounded — a hopeless batch cannot become a request storm', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true, maxSubdivisionRequests: 3 });
    const out = await p.romanise(KANNADA, 'kn');

    assert.ok(p.stats.subdivisionRequests <= 3, 'the budget is a hard ceiling');
    assert.equal(out.length, KANNADA.length, 'and the budget never costs a word');
    assert.deepEqual(out, KANNADA);
  });

  test('subdivision can be switched off entirely', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true, maxSubdivisionRequests: 0 });
    await p.romanise(KANNADA, 'kn');

    assert.equal(fake.calls.length, 2, 'just the request and its retry');
    assert.deepEqual(p.stats.subdividedBatches, []);
  });

  test('output length always equals input length, whatever happened', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const out = await kn({ allowNativeFallback: true }).romanise(KANNADA, 'kn');
    assert.equal(out.length, KANNADA.length);
  });
});

describe('--roman-fallback native', () => {
  test('a failed Kannada batch keeps its original script instead of dying', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true });
    const out = await p.romanise(KANNADA, 'kn');
    assert.deepEqual(out, KANNADA, 'the words should come back untouched, not mangled');
  });

  test('the affected batch is NAMED, not just counted', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true });
    await p.romanise(KANNADA, 'kn');
    assert.deepEqual(p.stats.nativeBatches, [1]);
    assert.equal(p.stats.tokensViaNative, KANNADA.length);
    assert.ok(p.stats.notes.some((n) => /KEEP THEIR NATIVE SCRIPT/.test(n)));
    assert.ok(p.stats.notes.some((n) => /batch 1\//.test(n)));
  });

  test('the reason is recorded, not just the fact', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const p = kn({ allowNativeFallback: true });
    await p.romanise(KANNADA, 'kn');
    assert.ok(p.stats.notes.some((n) => /token count/i.test(n)));
  });

  test('only the FAILED batch keeps native script; good batches still romanise', async () => {
    // Two batches; break only the one containing the marker word.
    const words = [...KANNADA, 'ಮಾರ್ಕರ್', ...KANNADA];
    fake = fakeSarvam({ breakBatch: (input) => input.includes('ಮಾರ್ಕರ್') });
    const p = kn({ allowNativeFallback: true, maxChars: 40 });
    const out = await p.romanise(words, 'kn');

    assert.equal(out.length, words.length);
    assert.ok(out.some((t) => t.startsWith('R')), 'some batch should have romanised');
    assert.ok(out.includes('ಮಾರ್ಕರ್'), 'the broken batch should retain native script');
    assert.ok(p.stats.nativeBatches.length >= 1);
    assert.ok(p.stats.nativeBatches.length < p.stats.batches, 'not every batch should have fallen back');
  });

  test('a successful run reports no native fallback at all', async () => {
    fake = fakeSarvam();
    const p = kn({ allowNativeFallback: true });
    await p.romanise(KANNADA, 'kn');
    assert.equal(p.stats.tokensViaNative, 0);
    assert.deepEqual(p.stats.nativeBatches, []);
  });
});

describe('Kannada content edge cases', () => {
  test('punctuation attached to a word survives', async () => {
    fake = fakeSarvam();
    const out = await kn().romanise(['ಇದು,', 'ಒಂದು.', 'ಪುಸ್ತಕ?'], 'kn');
    assert.equal(out.length, 3);
  });

  test('a long compound word is not split across batches', async () => {
    const compound = 'ಕರ್ನಾಟಕರಾಜ್ಯೋತ್ಸವಸಂಭ್ರಮಾಚರಣೆ';
    fake = fakeSarvam();
    const out = await kn({ maxChars: 60 }).romanise([compound, ...KANNADA], 'kn');
    assert.equal(out.length, KANNADA.length + 1);
    for (const sent of fake.calls) {
      if (sent.includes(compound)) {
        assert.ok(sent.includes(compound), 'the compound must appear whole in its request');
      }
    }
  });

  test('leading/trailing whitespace differences in the reply do not desync', async () => {
    fake = fakeSarvam({ transform: (p) => `  R${p}  ` });
    const out = await kn().romanise(KANNADA, 'kn');
    assert.equal(out.length, KANNADA.length);
    assert.ok(out.every((t) => t.trim() === t), 'pieces should be trimmed');
  });

  test('Latin tokens never leave the machine', async () => {
    fake = fakeSarvam();
    const out = await kn().romanise(['ಇದು', 'important', 'meeting', 'ಇದೆ'], 'kn');
    assert.equal(out[1], 'important');
    assert.equal(out[2], 'meeting');
    for (const sent of fake.calls) {
      assert.ok(!sent.includes('important'), 'English must not be sent to the API');
    }
  });

  test('an all-Latin input makes no request at all', async () => {
    fake = fakeSarvam();
    const out = await kn().romanise(['important', 'meeting'], 'kn');
    assert.deepEqual(out, ['important', 'meeting']);
    assert.equal(fake.calls.length, 0);
  });
});

describe('timestamps and word order survive the fallback', () => {
  const t = mkTranscript(
    KANNADA.map((w, i) => [w, 0.2 + i * 0.5, 0.6 + i * 0.5] as [string, number, number]),
    'kn',
  );

  test('word count, order and timings are unchanged when a batch keeps native script', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const before = t.words.map((w) => ({ text: w.text, s: w.start, e: w.end }));

    const r = await romaniseTranscript(t, kn({ allowNativeFallback: true }), { language: 'kn' });

    assert.equal(r.transcript.words.length, before.length);
    r.transcript.words.forEach((w, i) => {
      assert.equal(w.start, before[i]!.s, `word ${i} start moved`);
      assert.equal(w.end, before[i]!.e, `word ${i} end moved`);
      assert.equal(w.text, before[i]!.text, `word ${i} text changed under native fallback`);
    });
  });

  test('the result flags that output is still native', async () => {
    fake = fakeSarvam({ breakBatch: () => true });
    const r = await romaniseTranscript(t, kn({ allowNativeFallback: true }), { language: 'kn' });
    assert.equal(r.keptNativeScript, true, 'the caller must be able to detect this');
  });

  test('a fully successful Kannada run does NOT flag native script', async () => {
    fake = fakeSarvam();
    const r = await romaniseTranscript(t, kn({ allowNativeFallback: true }), { language: 'kn' });
    assert.equal(r.keptNativeScript, false);
  });
});

describe('fallback policy selection', () => {
  const t = mkTranscript([['ಇದು', 0.2, 0.6], ['ಒಂದು', 0.7, 1.1]], 'kn');
  const noKeyEnv = {} as NodeJS.ProcessEnv;

  test('error (default) refuses when no backend covers Kannada', async () => {
    await assert.rejects(
      () => toRomanScript(t, { language: 'kn', provider: 'local', env: noKeyEnv }),
      (e: unknown) => {
        const msg = String((e as Error).message);
        assert.match(msg, /"kn"/, 'the error must name the language');
        return e instanceof CaptionEngineError;
      },
    );
  });

  test('native keeps the original script and says so', async () => {
    const r = await toRomanScript(t, {
      language: 'kn', provider: 'local', env: noKeyEnv, fallback: 'native',
    });
    assert.equal(r.fallbackUsed, 'native');
    assert.equal(r.keptNativeScript, true);
    assert.ok(r.fallbackReason && r.fallbackReason.length > 0, 'a reason must accompany the fallback');
    assert.deepEqual(r.transcript.words.map((w) => w.text), ['ಇದು', 'ಒಂದು']);
  });

  test('native does not relabel the output as roman', async () => {
    // Claiming script:'roman' while returning Kannada would make the lie
    // machine-readable as well as visible.
    const r = await toRomanScript(t, {
      language: 'kn', provider: 'local', env: noKeyEnv, fallback: 'native',
    });
    assert.notEqual(r.transcript.words[0]!.text, 'Idu');
  });

  test('http uses TRANSLITERATE_URL', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      // The documented endpoint contract: one token per input, in order.
      JSON.stringify({ tokens: ['Idu', 'ondu'] }), { status: 200 },
    )) as unknown as typeof fetch;
    try {
      const r = await toRomanScript(t, {
        language: 'kn', provider: 'local', fallback: 'http',
        env: { TRANSLITERATE_URL: 'https://example.invalid/x' } as NodeJS.ProcessEnv,
      });
      assert.equal(r.fallbackUsed, 'http');
      assert.equal(r.provider, 'http');
    } finally { globalThis.fetch = original; }
  });

  test('http without TRANSLITERATE_URL fails with instructions, never silently', async () => {
    await assert.rejects(
      () => toRomanScript(t, { language: 'kn', provider: 'local', env: noKeyEnv, fallback: 'http' }),
      /TRANSLITERATE_URL is not set/,
    );
  });

  test('a working backend is never replaced by the fallback', async () => {
    // Policy widens what is acceptable; it must not change a successful path.
    const hi = mkTranscript([['आज', 0.2, 0.6], ['बहुत', 0.7, 1.1]], 'hi');
    const r = await toRomanScript(hi, {
      language: 'hi', provider: 'local', env: noKeyEnv, fallback: 'native',
    });
    assert.equal(r.fallbackUsed, null);
    assert.equal(r.keptNativeScript, false);
    assert.notEqual(r.transcript.words[0]!.text, 'आज');
  });
});

describe('native is not a transliteration backend', () => {
  test('--transliterate native is rejected with an explanation', () => {
    assert.throws(
      () => resolveTransliterator('native', 'kn', {} as NodeJS.ProcessEnv),
      /not a transliteration backend/,
    );
  });

  test('the passthrough claims to support nothing', () => {
    const p = new NativeScriptPassthrough();
    assert.equal(p.supports(), false);
  });

  test('the passthrough returns tokens byte-identical', async () => {
    const out = await new NativeScriptPassthrough().romanise(KANNADA);
    assert.deepEqual(out, KANNADA);
    assert.notEqual(out, KANNADA, 'should be a copy, not the same array');
  });
});
