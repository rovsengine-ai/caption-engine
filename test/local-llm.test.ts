import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { transliterateToken } from '../src/transliterate/devanagari.js';
import {
  LocalLlmTransliterator,
  normaliseLlmEndpoint,
  parseRomanLines,
} from '../src/transliterate/local-llm.js';
import { resolveTransliterator } from '../src/transliterate/providers.js';

describe('local LLM transliteration', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test('a bare Ollama origin is completed to /api/generate', () => {
    assert.equal(
      normaliseLlmEndpoint('http://127.0.0.1:11434'),
      'http://127.0.0.1:11434/api/generate',
    );
    assert.equal(
      normaliseLlmEndpoint('http://127.0.0.1:11434/api/generate'),
      'http://127.0.0.1:11434/api/generate',
    );
  });

  test('numbered model replies parse back to one token per line', () => {
    assert.deepEqual(parseRomanLines('1. bahut\n2. aaj\n', 2), ['bahut', 'aaj']);
    assert.equal(parseRomanLines('bahut\n', 2), null);
  });

  test('Latin tokens are not sent and the count is preserved', async () => {
    let body = '';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({ response: 'bahut' }), { status: 200 });
    }) as typeof fetch;

    const engine = new LocalLlmTransliterator({} as NodeJS.ProcessEnv);
    const out = await engine.romanise(['meeting', 'बहुत', 'WhatsApp'], 'hi');
    assert.deepEqual(out, ['meeting', 'bahut', 'WhatsApp']);
    assert.match(body, /बहुत/);
    assert.doesNotMatch(body, /WhatsApp/);
  });

  test('a down model falls back to Devanagari rules without changing length', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const engine = new LocalLlmTransliterator({} as NodeJS.ProcessEnv);
    const tokens = ['बहुत', 'आज', 'meeting'];
    const out = await engine.romanise(tokens, 'hi');
    assert.equal(out.length, tokens.length);
    assert.equal(out[0], transliterateToken('बहुत'));
    assert.equal(out[1], transliterateToken('आज'));
    assert.equal(out[2], 'meeting');
  });

  test('a mismatched reply falls back per token instead of shifting timings', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ response: '   ' }), { status: 200 })) as typeof fetch;

    const engine = new LocalLlmTransliterator({} as NodeJS.ProcessEnv);
    const tokens = ['बहुत', 'अच्छा'];
    const out = await engine.romanise(tokens, 'hi');
    assert.equal(out.length, 2);
    assert.equal(out[0], transliterateToken('बहुत'));
    assert.equal(out[1], transliterateToken('अच्छा'));
  });

  test('Tamil with no model and no rule engine fails instead of guessing', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const engine = new LocalLlmTransliterator({} as NodeJS.ProcessEnv);
    await assert.rejects(() => engine.romanise(['வணக்கம்'], 'ta'));
  });

  test('resolveTransliterator accepts local-llm with no API key', () => {
    const p = resolveTransliterator('local-llm', 'hi', {} as NodeJS.ProcessEnv);
    assert.equal(p.name, 'local-llm');
    assert.equal(p.offline, true);
    assert.equal(p.supports('ta'), true);
    assert.equal(p.supports('ur'), false);
  });
});
