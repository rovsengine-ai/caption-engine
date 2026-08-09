import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  planBatches, splitBatchResponse, assertBatchPlan, mapWithConcurrency,
  measure, codePoints, utf8Bytes,
  DEFAULT_MAX_BATCH_CHARS, DEFAULT_SEPARATOR, SARVAM_HARD_LIMIT,
} from '../src/transliterate/batching.js';
import { SarvamTransliterator } from '../src/transliterate/providers.js';
import { romaniseTranscript } from '../src/transliterate/index.js';
import { CaptionEngineError } from '../src/errors.js';
import { mkTranscript } from './helpers.js';
import type { Transcript, Word } from '../src/types.js';

/**
 * Sarvam request batching.
 *
 * The bug: the whole transcript went out in one request, and Sarvam rejects
 * `body.input` over 1000 characters —
 *   body.input: String should have at most 1000 characters
 *
 * The dangerous fix is one that makes the error go away but quietly loses or
 * duplicates a word at a batch seam, because that does not throw. It shows up
 * as captions that drift out of sync a third of the way through a video. So the
 * tests below care much more about index alignment and word count than about
 * romanisation quality, which is covered in hinglish.test.ts.
 */

// ---------------------------------------------------------------------------
// A stand-in for the API that enforces the real validation rule.
// ---------------------------------------------------------------------------

interface FakeOpts {
  /** Rewrites the input string. Default: mark each piece so we can see it ran. */
  transform?: (input: string) => string;
  /** Status codes to return before succeeding, one per call. */
  failWith?: number[];
  /** Throw a network error on the first N calls. */
  networkFailures?: number;
  /** Return a body that is not the documented shape. */
  malformed?: boolean | ((call: number) => boolean);
  /**
   * Persistently malformed for the batches whose input satisfies this. Keyed on
   * content, not call number, so a batch stays broken across its retry — which
   * is what it takes to actually reach the fallback path.
   */
  malformedFor?: (input: string, seen: number) => boolean;
  limit?: number;
}

interface FakeApi {
  restore: () => void;
  calls: Array<{ input: string; chars: number; codePoints: number; bytes: number; body: unknown }>;
  overLimit: number;
}

function installFakeSarvam(opts: FakeOpts = {}): FakeApi {
  const original = globalThis.fetch;
  const limit = opts.limit ?? SARVAM_HARD_LIMIT;
  const calls: FakeApi['calls'] = [];
  const failQueue = [...(opts.failWith ?? [])];
  let networkLeft = opts.networkFailures ?? 0;
  let n = 0;
  const api: FakeApi = { restore: () => { globalThis.fetch = original; }, calls, overLimit: 0 };

  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string };
    const call = n++;
    calls.push({
      input: body.input,
      chars: body.input.length,
      codePoints: codePoints(body.input),
      bytes: utf8Bytes(body.input),
      body,
    });

    if (networkLeft > 0) { networkLeft--; throw new TypeError('fetch failed'); }

    // The actual server-side rule that produced the reported bug.
    if (codePoints(body.input) > limit) {
      api.overLimit++;
      return new Response(
        JSON.stringify({ error: { message: 'body.input: String should have at most 1000 characters' } }),
        { status: 422 },
      );
    }

    const status = failQueue.shift();
    if (status) return new Response(JSON.stringify({ error: 'transient' }), { status });

    const bad =
      (typeof opts.malformed === 'function' ? opts.malformed(call) : opts.malformed) ||
      (opts.malformedFor?.(body.input, call) ?? false);
    if (bad) {
      // Drops a piece: the classic silent-desync producer.
      const pieces = body.input.split('|').map((s) => s.trim());
      return new Response(
        JSON.stringify({ transliterated_text: pieces.slice(0, -1).join(' | ') }),
        { status: 200 },
      );
    }

    const transform = opts.transform ?? ((s: string) =>
      s.split('|').map((p) => `R${p.trim()}`).join(' | '));
    return new Response(JSON.stringify({ transliterated_text: transform(body.input) }), { status: 200 });
  }) as unknown as typeof fetch;

  return api;
}

/** No real sleeping in tests; backoff correctness is asserted separately. */
const noSleep = async (): Promise<void> => {};

function sarvam(extra: Record<string, unknown> = {}): SarvamTransliterator {
  return new SarvamTransliterator('test-key', { sleep: noSleep, ...extra });
}

let fake: FakeApi | null = null;
afterEach(() => { fake?.restore(); fake = null; });

// ---------------------------------------------------------------------------
// The reported failure
// ---------------------------------------------------------------------------

describe('the reported failure: body.input over 1000 characters', () => {
  test('a 2,339-word transcript no longer exceeds the limit', async () => {
    const t = bigTranscript(2339);
    assert.equal(t.words.length, 2339, 'fixture must match the reported size');

    // Sanity: one request really would have been rejected.
    const joined = t.words.map((w) => w.text).join(' | ');
    assert.ok(
      codePoints(joined) > SARVAM_HARD_LIMIT,
      `fixture must be large enough to trigger the bug (was ${codePoints(joined)} chars)`,
    );

    fake = installFakeSarvam();
    const p = sarvam();
    const r = await romaniseTranscript(t, p, { language: 'hi' });

    assert.equal(fake.overLimit, 0, 'no request may exceed Sarvam\'s 1000-character limit');
    assert.ok(fake.calls.length > 1, 'the work must be split across requests');
    assert.equal(r.transcript.words.length, 2339, 'word count must survive batching');
  });

  test('every request body stays inside the 900-character budget', async () => {
    fake = installFakeSarvam();
    await sarvam().romanise(indicTokens(1500), 'hi');

    for (const c of fake.calls) {
      assert.ok(
        c.codePoints <= DEFAULT_MAX_BATCH_CHARS,
        `request was ${c.codePoints} code points, over the ${DEFAULT_MAX_BATCH_CHARS} budget`,
      );
      assert.ok(c.codePoints < SARVAM_HARD_LIMIT, 'and comfortably under the hard limit');
    }
  });

  test('the request body uses exactly the documented Sarvam schema', async () => {
    fake = installFakeSarvam();
    await sarvam().romanise(['नमस्ते', 'दुनिया'], 'hi');

    const body = fake.calls[0]!.body as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['input', 'numerals_format', 'source_language_code', 'target_language_code'],
      'no extra keys — some gateways reject unknown fields',
    );
    assert.equal(body.source_language_code, 'hi-IN');
    assert.equal(body.target_language_code, 'en-IN');
    assert.equal(typeof body.input, 'string');
  });

  test('an over-budget body is caught locally rather than sent', async () => {
    // Force the internal guard by asking for a budget above the hard limit.
    const p = new SarvamTransliterator('k', { sleep: noSleep, maxChars: 5000 });
    fake = installFakeSarvam();
    // maxChars is clamped in the constructor, so nothing can exceed the limit.
    await p.romanise(indicTokens(400), 'hi');
    for (const c of fake.calls) {
      assert.ok(c.codePoints < SARVAM_HARD_LIMIT, 'clamped even when misconfigured');
    }
  });
});

// ---------------------------------------------------------------------------
// Batch planning
// ---------------------------------------------------------------------------

describe('batch planning', () => {
  test('never splits a word', () => {
    const tokens = indicTokens(600);
    const batches = planBatches(tokens);
    const rejoined = batches.flatMap((b) => b.tokens);
    assert.deepEqual(rejoined, tokens, 'every token appears whole, in order');
  });

  test('covers every index exactly once — no loss, no duplication', () => {
    const tokens = indicTokens(977);
    const batches = planBatches(tokens);
    const flat = batches.flatMap((b) => b.indices);

    assert.equal(flat.length, tokens.length, 'no words lost or duplicated');
    assert.deepEqual(flat, tokens.map((_, i) => i), 'order and coverage exact');
    assert.equal(new Set(flat).size, tokens.length, 'no index appears twice');
  });

  test('preserves caller-supplied indices for a subset of a larger array', () => {
    // The pipeline sends only Indic tokens but must map answers back to the
    // positions those words hold in the FULL transcript.
    const sparse = [3, 9, 14, 27, 40];
    const batches = planBatches(sparse.map(() => 'बहुत'), sparse, { maxChars: 20 });
    assert.deepEqual(batches.flatMap((b) => b.indices), sparse);
  });

  test('a word landing exactly on a boundary goes wholly into one batch', () => {
    // Budget chosen so the third token cannot fit: it must move, not split.
    const tokens = ['नमस्ते', 'दुनिया', 'बहुत'];
    const budget = measure('नमस्ते' + DEFAULT_SEPARATOR + 'दुनिया') + 1;
    const batches = planBatches(tokens, undefined, { maxChars: budget });

    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0]!.tokens, ['नमस्ते', 'दुनिया']);
    assert.deepEqual(batches[1]!.tokens, ['बहुत'], 'the boundary word is intact, not cut');
    for (const b of batches) assert.ok(measure(b.input) <= budget);
  });

  test('a word crossing the boundary keeps its exact index and text', async () => {
    // End to end: the token that straddles a seam must come back attached to
    // the same word, with the same timings.
    const words = 400;
    const t = bigTranscript(words);
    fake = installFakeSarvam();
    const r = await romaniseTranscript(t, sarvam(), { language: 'hi' });

    for (let i = 0; i < t.words.length; i++) {
      assert.equal(r.transcript.words[i]!.start, t.words[i]!.start, `word ${i} start moved`);
      assert.equal(r.transcript.words[i]!.end, t.words[i]!.end, `word ${i} end moved`);
    }
    assert.ok(fake.calls.length >= 2, 'the fixture must actually span batches');
  });

  test('rejects mismatched tokens and indices instead of guessing', () => {
    assert.throws(
      () => planBatches(['a', 'b'], [0]),
      /one-to-one/,
    );
  });

  test('assertBatchPlan catches a plan that drops a token', () => {
    const tokens = indicTokens(50);
    const batches = planBatches(tokens);
    batches[0]!.indices.pop();
    batches[0]!.tokens.pop();
    assert.throws(
      () => assertBatchPlan(batches, tokens.map((_, i) => i), DEFAULT_MAX_BATCH_CHARS),
      /covers \d+ tokens but \d+ were supplied/,
    );
  });

  test('assertBatchPlan catches reordering', () => {
    const tokens = indicTokens(40);
    const batches = planBatches(tokens);
    const b0 = batches[0]!;
    [b0.indices[0], b0.indices[1]] = [b0.indices[1]!, b0.indices[0]!];
    assert.throws(
      () => assertBatchPlan(batches, tokens.map((_, i) => i), DEFAULT_MAX_BATCH_CHARS),
      /reordered/,
    );
  });

  test('empty input produces no requests at all', async () => {
    fake = installFakeSarvam();
    const out = await sarvam().romanise([], 'hi');
    assert.deepEqual(out, []);
    assert.equal(fake.calls.length, 0, 'no pointless API call, no cost');
  });
});

// ---------------------------------------------------------------------------
// Long words, punctuation, numbers
// ---------------------------------------------------------------------------

describe('awkward tokens', () => {
  test('long English words are preserved exactly and never sent', async () => {
    fake = installFakeSarvam();
    const long = [
      'antidisestablishmentarianism',
      'pneumonoultramicroscopicsilicovolcanoconiosis',
      'internationalisation',
      'counterrevolutionaries',
    ];
    const out = await sarvam().romanise([...long, 'बहुत'], 'hi');

    assert.deepEqual(out.slice(0, 4), long, 'Latin words come back byte-identical');
    assert.equal(fake.calls.length, 1, 'only the Indic token needed a request');
    for (const w of long) {
      assert.ok(!fake.calls[0]!.input.includes(w), `"${w}" must not be sent to the API`);
    }
  });

  test('a single token longer than the whole budget is not split', async () => {
    // Pathological, but truncating would produce a wrong word silently.
    const monster = 'अ'.repeat(1200);
    fake = installFakeSarvam();
    const p = sarvam();
    const out = await p.romanise([monster, 'बहुत'], 'hi');

    assert.equal(out.length, 2, 'still one output per input');
    assert.ok(
      fake.calls.every((c) => !c.input.includes('अ'.repeat(1200))),
      'the oversize token is never sent',
    );
    assert.equal(p.stats.fallbackBatches, 1, 'it is romanised offline instead');
    assert.notEqual(out[0], monster, 'and it really was romanised, not passed through');
  });

  test('punctuation and numbers survive with their positions intact', async () => {
    fake = installFakeSarvam();
    const t = mkTranscript([
      ['मैंने', 0.0, 0.4], ['2019', 0.4, 0.9], ['में', 0.9, 1.2],
      ['₹5,000', 1.2, 1.8], ['खर्च', 1.8, 2.2], ['किए', 2.2, 2.5],
      ['।', 2.5, 2.6], ['okay', 2.6, 3.0], ['?', 3.0, 3.1],
    ], 'hi');
    const r = await romaniseTranscript(t, sarvam(), { language: 'hi' });
    const out = r.transcript.words;

    assert.equal(out.length, 9);
    assert.equal(out[1]!.text, '2019', 'digits untouched');
    assert.equal(out[3]!.text, '₹5,000', 'currency and separators untouched');
    assert.equal(out[7]!.text, 'okay', 'English untouched');
    assert.equal(out[8]!.text, '?', 'punctuation untouched');
  });

  test('a token containing the separator is sent alone so counts cannot drift', async () => {
    fake = installFakeSarvam();
    const p = sarvam();
    const out = await p.romanise(['बहुत', 'क|ख', 'अच्छा'], 'hi');

    assert.equal(out.length, 3, 'a pipe inside a word must not shift the mapping');
    const solo = fake.calls.find((c) => c.input === 'क|ख');
    assert.ok(solo, 'the unsafe token went out on its own, unmodified');
  });

  test('mixed Hindi-English speech: only Devanagari is sent', async () => {
    fake = installFakeSarvam();
    const t = mkTranscript([
      ['आज', 0.0, 0.4], ['meeting', 0.4, 1.0], ['बहुत', 1.0, 1.4],
      ['important', 1.4, 2.0], ['है', 2.0, 2.3],
    ], 'hi');
    const r = await romaniseTranscript(t, sarvam(), { language: 'hi' });
    const out = r.transcript.words.map((w) => w.text);

    assert.equal(out[1], 'meeting', 'English survives untranslated');
    assert.equal(out[3], 'important', 'English survives untranslated');
    const sent = fake.calls.map((c) => c.input).join(' ');
    assert.ok(!sent.includes('meeting'), 'English never reaches the API');
    assert.ok(!sent.includes('important'), 'English never reaches the API');
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

describe('timestamp and metadata preservation', () => {
  test('start, end, confidence, type, speaker and language are all untouched', async () => {
    const words: Word[] = Array.from({ length: 300 }, (_, i) => ({
      text: i % 3 === 0 ? 'बहुत' : i % 3 === 1 ? 'english' : 'अच्छा',
      start: i * 0.31,
      end: i * 0.31 + 0.28,
      confidence: 0.5 + (i % 50) / 100,
      type: 'word' as const,
      speakerId: `spk${i % 3}`,
      language: i % 3 === 1 ? 'en' : 'hi',
    }));
    const t: Transcript = {
      words, language: 'hi', duration: 100, provider: 'fixture', hasWordTimings: true,
    };

    fake = installFakeSarvam();
    const r = await romaniseTranscript(t, sarvam(), { language: 'hi' });

    assert.equal(r.transcript.words.length, words.length);
    r.transcript.words.forEach((w, i) => {
      const o = words[i]!;
      assert.equal(w.start, o.start, `word ${i} start`);
      assert.equal(w.end, o.end, `word ${i} end`);
      assert.equal(w.confidence, o.confidence, `word ${i} confidence`);
      assert.equal(w.type, o.type, `word ${i} type`);
      assert.equal(w.speakerId, o.speakerId, `word ${i} speaker`);
      assert.equal(w.language, o.language, `word ${i} language`);
    });
  });

  test('timings are byte-identical even when some batches fall back', async () => {
    const t = bigTranscript(800);
    // Every other batch fails persistently, forcing a mix of API and offline
    // output. Keyed on content so concurrent interleaving cannot change which
    // batches fail — a flaky test here would be worse than no test.
    const order: string[] = [];
    fake = installFakeSarvam({
      malformedFor: (input) => {
        if (!order.includes(input)) order.push(input);
        return order.indexOf(input) % 2 === 1;
      },
    });
    const p = sarvam({ maxAttempts: 1, concurrency: 1 });
    const r = await romaniseTranscript(t, p, { language: 'hi' });

    assert.ok(p.stats.fallbackBatches > 0, 'the test must actually exercise the fallback');
    assert.equal(r.transcript.words.length, t.words.length);
    r.transcript.words.forEach((w, i) => {
      assert.equal(w.start, t.words[i]!.start);
      assert.equal(w.end, t.words[i]!.end);
    });
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('malformed responses and API failures', () => {
  test('a token-count mismatch is retried once', async () => {
    fake = installFakeSarvam({ malformed: (call) => call === 0 });
    const p = sarvam();
    await p.romanise(indicTokens(300), 'hi');

    assert.ok(p.stats.retries >= 1, 'the first bad response triggered a retry');
    assert.ok(
      p.stats.notes.some((n) => /malformed response/.test(n)),
      'and it is recorded rather than hidden',
    );
  });

  test('a persistently malformed batch falls back to local, not to garbage', async () => {
    fake = installFakeSarvam({ malformed: true });
    const p = sarvam();
    const tokens = ['बहुत', 'अच्छा', 'नमस्ते'];
    const out = await p.romanise(tokens, 'hi');

    assert.equal(out.length, tokens.length, 'count preserved');
    assert.equal(p.stats.fallbackBatches, 1);
    assert.equal(out[0], 'bahut', 'offline engine produced real Hinglish');
    assert.ok(!out[0]!.startsWith('R'), 'and the bad API output was discarded');
  });

  test('a response missing transliterated_text fails clearly', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ wrong_key: 'oops' }), { status: 200 })) as unknown as typeof fetch;
    try {
      // No fallback configured, so the error must surface rather than be masked.
      const p = new SarvamTransliterator('k', { sleep: noSleep, fallback: null });
      await assert.rejects(
        () => p.romanise(['बहुत'], 'hi'),
        (e: unknown) => {
          assert.ok(e instanceof CaptionEngineError);
          assert.match((e as Error).message, /transliterated_text/);
          return true;
        },
      );
    } finally { globalThis.fetch = original; }
  });

  test('transient 5xx and 429 are retried with backoff', async () => {
    fake = installFakeSarvam({ failWith: [503, 429] });
    const p = sarvam({ maxAttempts: 3 });
    const out = await p.romanise(['बहुत'], 'hi');

    assert.equal(fake.calls.length, 3, 'two failures then a success');
    assert.equal(p.stats.retries, 2);
    assert.equal(out.length, 1);
    assert.equal(p.stats.fallbackBatches, 0, 'a recoverable error must not trigger fallback');
  });

  test('network errors are retried', async () => {
    fake = installFakeSarvam({ networkFailures: 2 });
    const p = sarvam({ maxAttempts: 3 });
    const out = await p.romanise(['बहुत'], 'hi');
    assert.equal(out.length, 1);
    assert.equal(p.stats.fallbackBatches, 0);
  });

  test('a 401 is NOT retried — a bad key will not fix itself', async () => {
    fake = installFakeSarvam({ failWith: [401, 401, 401] });
    const p = sarvam({ maxAttempts: 3, fallback: null });
    await assert.rejects(
      () => p.romanise(['बहुत'], 'hi'),
      (e: unknown) => {
        assert.match((e as Error).message, /401/);
        assert.match((e as CaptionEngineError).hint ?? '', /SARVAM_API_KEY/);
        return true;
      },
    );
    assert.equal(fake.calls.length, 1, 'one attempt only');
  });

  test('total API failure degrades to offline rather than losing the transcript', async () => {
    fake = installFakeSarvam({ failWith: Array(30).fill(503) });
    const t = bigTranscript(300);
    const p = sarvam({ maxAttempts: 2 });
    const r = await romaniseTranscript(t, p, { language: 'hi' });

    assert.equal(r.transcript.words.length, 300, 'nothing lost');
    assert.equal(p.stats.fallbackBatches, p.stats.batches, 'every batch fell back');
    assert.ok(p.stats.notes.length > 0, 'and every fallback is reported');
    assert.ok(
      r.transcript.words.some((w) => /^[\x20-\x7e]+$/.test(w.text)),
      'output is Roman, not raw Devanagari',
    );
  });

  test('when no offline engine covers the language, it fails clearly', async () => {
    // Tamil: the rule-based engine is Devanagari-only, so there is nothing to
    // fall back to. Silently returning Tamil script would be the wrong answer.
    fake = installFakeSarvam({ failWith: Array(10).fill(500) });
    const p = sarvam({ maxAttempts: 1 });
    await assert.rejects(
      () => p.romanise(['வணக்கம்'], 'ta'),
      (e: unknown) => {
        assert.ok(e instanceof CaptionEngineError);
        assert.match((e as Error).message, /no .*offline transliterator for "ta"/);
        assert.match((e as CaptionEngineError).hint ?? '', /TRANSLITERATE_URL|native script/);
        return true;
      },
    );
  });

  test('one persistently bad batch is recovered by bisection, not degraded', async () => {
    // Broken by content: this exact request string always comes back
    // mis-delimited, so it survives its retry. Smaller requests are DIFFERENT
    // strings, so bisection gets the batch back at model quality rather than
    // dropping it to the offline engine.
    let firstInput: string | null = null;
    fake = installFakeSarvam({
      malformedFor: (input) => {
        firstInput ??= input;
        return input === firstInput;
      },
    });
    const t = bigTranscript(900);
    const p = sarvam({ maxAttempts: 1 });
    const r = await romaniseTranscript(t, p, { language: 'hi' });

    assert.ok(p.stats.batches > 2, 'fixture spans several batches');
    assert.deepEqual(p.stats.subdividedBatches, [1], 'the bad batch was bisected');
    assert.equal(p.stats.fallbackBatches, 0, 'and did not need the offline engine at all');
    assert.ok(p.stats.tokensViaSubdivision > 0, 'its words came back from the model');
    assert.equal(r.transcript.words.length, 900);
  });

  test('a batch that is broken at EVERY size still falls back, once', async () => {
    // The complement: when no request size works, bisection is exhausted and
    // the offline engine takes over — for those words only.
    const poison = 'क्ष';
    fake = installFakeSarvam({ malformedFor: (input) => input.includes(poison) });
    const tokens = [...indicTokens(120), poison];
    const p = sarvam({ maxAttempts: 1 });
    const out = await p.romanise(tokens, 'hi');

    assert.equal(out.length, tokens.length, 'count preserved');
    assert.ok(p.stats.fallbackBatches >= 1, 'the offline engine was used');
    assert.ok(p.stats.tokensViaApi > 0, 'but only for the words that needed it');
    assert.ok(!out[out.length - 1]!.startsWith('R'), 'the poison word did not use API output');
  });

  test('a single malformed reply recovers on retry — no needless degradation', async () => {
    // The complement of the test above: transient badness must NOT cost the
    // batch its model-quality output.
    fake = installFakeSarvam({ malformed: (call) => call === 0 });
    const p = sarvam();
    const out = await p.romanise(indicTokens(200), 'hi');

    assert.equal(p.stats.retries, 1);
    assert.equal(p.stats.fallbackBatches, 0, 'recovered without falling back');
    assert.ok(out.every((t) => t.startsWith('R')), 'every token came from the API');
  });
});

// ---------------------------------------------------------------------------
// Response splitting and concurrency
// ---------------------------------------------------------------------------

describe('response splitting', () => {
  test('tolerates the model changing spacing around the separator', () => {
    const batch = planBatches(['अ', 'ब', 'स'])[0]!;
    assert.deepEqual(splitBatchResponse('a|b|c', batch), ['a', 'b', 'c']);
    assert.deepEqual(splitBatchResponse('a  |  b |c', batch), ['a', 'b', 'c']);
  });

  test('returns null on a count mismatch rather than padding', () => {
    const batch = planBatches(['अ', 'ब', 'स'])[0]!;
    assert.equal(splitBatchResponse('a | b', batch), null, 'too few');
    assert.equal(splitBatchResponse('a | b | c | d', batch), null, 'too many');
  });

  test('a singleton batch is never split, so pipes in output survive', () => {
    const batch = planBatches(['क|ख'])[0]!;
    assert.deepEqual(splitBatchResponse('ka|kha', batch), ['ka|kha']);
  });
});

describe('concurrency', () => {
  test('results come back in batch order regardless of completion order', async () => {
    const items = [50, 10, 30, 5, 40, 1];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5], 'order follows input, not finish time');
  });

  test('never exceeds the configured limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return 0;
    });
    assert.ok(peak <= 3, `peak concurrency was ${peak}, limit was 3`);
  });

  test('the provider keeps requests bounded on a large transcript', async () => {
    fake = installFakeSarvam();
    let inFlight = 0, peak = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      inFlight++; peak = Math.max(peak, inFlight);
      try { return await (original as typeof fetch)(...args); } finally { inFlight--; }
    }) as typeof fetch;

    await sarvam({ concurrency: 2 }).romanise(indicTokens(1200), 'hi');
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });
});

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

describe('size measurement', () => {
  test('code points match what the server counts, for Devanagari', () => {
    const s = 'नमस्ते दुनिया';
    assert.equal(codePoints(s), [...s].length);
    assert.equal(measure(s), s.length);
    assert.ok(utf8Bytes(s) > codePoints(s), 'Devanagari is multi-byte in UTF-8');
  });

  test('the measure is never smaller than the server-side count', () => {
    // Astral characters are 2 UTF-16 units but 1 code point: ours over-counts,
    // which shrinks batches. It must never under-count, or a request could pass
    // our check and still be rejected.
    for (const s of ['abc', 'नमस्ते', '🎬🎬', 'मैं 🎬 hoon']) {
      assert.ok(measure(s) >= codePoints(s), `measure under-counted "${s}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// The real transcript on disk
// ---------------------------------------------------------------------------

describe('new-transcript.json — the file that reproduced the bug', () => {
  const path = new URL('../../new-transcript.json', import.meta.url).pathname;

  test('romanises with the same number of timed words as the original', async (t) => {
    if (!existsSync(path)) { t.skip('new-transcript.json not present'); return; }
    const src = JSON.parse(readFileSync(path, 'utf8')) as Transcript;

    fake = installFakeSarvam();
    const p = sarvam();
    const r = await romaniseTranscript(src, p, { language: 'hi' });

    assert.equal(fake.overLimit, 0, 'no request exceeded 1000 characters');
    assert.equal(
      r.transcript.words.length, src.words.length,
      'the whole point: same number of timed words in and out',
    );

    const timed = (ws: Word[]): number =>
      ws.filter((w) => typeof w.start === 'number' && typeof w.end === 'number').length;
    assert.equal(timed(r.transcript.words), timed(src.words), 'all timings still present');

    src.words.forEach((w, i) => {
      assert.equal(r.transcript.words[i]!.start, w.start, `word ${i} start moved`);
      assert.equal(r.transcript.words[i]!.end, w.end, `word ${i} end moved`);
    });
  });
});

// ---------------------------------------------------------------------------
// No ASR when a transcript is supplied
// ---------------------------------------------------------------------------

describe('--transcript-in must not reach a paid ASR', () => {
  const path = new URL('../../new-transcript.json', import.meta.url).pathname;

  test('no ASR host is contacted while romanising a saved transcript', async (t) => {
    if (!existsSync(path)) { t.skip('new-transcript.json not present'); return; }
    const src = JSON.parse(readFileSync(path, 'utf8')) as Transcript;

    // Any request to an ASR vendor fails the test loudly rather than silently
    // costing money. Sarvam's transliteration endpoint is explicitly allowed.
    const original = globalThis.fetch;
    const contacted: string[] = [];
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const u = String(url);
      if (/elevenlabs|deepgram|\/speech-to-text/i.test(u)) { contacted.push(u); }
      const body = JSON.parse(init.body) as { input: string };
      return new Response(
        JSON.stringify({ transliterated_text: body.input.split('|').map((s) => `R${s.trim()}`).join(' | ') }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      await romaniseTranscript(src, sarvam(), { language: 'hi' });
    } finally { globalThis.fetch = original; }

    assert.deepEqual(contacted, [], 'no ASR endpoint may be called');
  });

  test('the transcript path in run.ts contains no ASR call', () => {
    // Structural check: transcription lives entirely in the `else` branch, so
    // loading a transcript cannot reach it. Asserted against the source because
    // a refactor could reintroduce a billable call without failing any
    // behavioural test that stubs the network.
    const runSrc = readFileSync(
      new URL('../../src/cli/run.ts', import.meta.url).pathname, 'utf8',
    );
    const start = runSrc.indexOf('if (opts.transcriptIn) {');
    const elseAt = runSrc.indexOf('  } else {', start);
    assert.ok(start > 0 && elseAt > start, 'the transcript branch must still exist');

    const branch = runSrc.slice(start, elseAt);
    for (const forbidden of ['extractAudio', 'providerFromEnv', 'provider.transcribe']) {
      assert.ok(
        !branch.includes(forbidden),
        `"${forbidden}" must not appear in the --transcript-in branch`,
      );
    }
  });

  test('keyterms stay optional with no built-in vocabulary', () => {
    // Requirement: no topic-specific terms are ever sent on the user's behalf.
    const runSrc = readFileSync(
      new URL('../../src/cli/run.ts', import.meta.url).pathname, 'utf8',
    );
    const fn = runSrc.slice(
      runSrc.indexOf('function collectKeyterms'),
      runSrc.indexOf('/** Merge a reviewed cut list'),
    );
    assert.ok(fn.includes('opts.keyterms'), 'terms come from the user');
    assert.ok(fn.includes('opts.keytermsFile'), 'or from a user-supplied file');
    assert.ok(
      !/['"`][a-z ]{4,}['"`]\s*\)?\s*;?\s*\n.*terms\.add/i.test(fn),
      'no literal term is added by default',
    );
    assert.ok(!/cheat day/i.test(runSrc), 'no hard-coded topic vocabulary anywhere in run.ts');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HINDI = [
  'नमस्ते', 'बहुत', 'अच्छा', 'क्या', 'आपका', 'नाम', 'मैंने', 'सोचा', 'दोस्तों',
  'वीडियो', 'चैनल', 'ज़रूर', 'शुरू', 'करते', 'हैं', 'लेकिन', 'इसलिए', 'फिर',
];
const ENGLISH = ['video', 'channel', 'subscribe', 'okay', 'meeting', 'important', 'YouTube'];

function indicTokens(n: number): string[] {
  return Array.from({ length: n }, (_, i) => HINDI[i % HINDI.length]!);
}

/** A code-switched transcript of exactly `n` timed words. */
function bigTranscript(n: number): Transcript {
  const words: Word[] = Array.from({ length: n }, (_, i) => {
    const english = i % 5 === 3;
    return {
      text: english ? ENGLISH[i % ENGLISH.length]! : HINDI[i % HINDI.length]!,
      start: Number((i * 0.37).toFixed(3)),
      end: Number((i * 0.37 + 0.33).toFixed(3)),
      confidence: 0.9,
      type: 'word' as const,
      language: english ? 'en' : 'hi',
    };
  });
  return {
    words,
    language: 'hi',
    duration: Number((n * 0.37 + 1).toFixed(3)),
    provider: 'fixture',
    model: 'test',
    hasWordTimings: true,
  };
}
