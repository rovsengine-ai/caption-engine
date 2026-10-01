import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_MODE,
  resolveProviderChain,
  providerFromEnv,
} from '../src/asr/index.js';
import {
  LocalWhisper,
  buildWhisperPrompt,
  normaliseWhisperResult,
} from '../src/asr/local-whisper.js';

describe('local Whisper provider registry', () => {
  test('the default provider mode is unchanged', () => {
    assert.equal(DEFAULT_PROVIDER_MODE, 'sarvam_fallback_elevenlabs');
  });

  test('local needs no API key and reports real word timestamps', () => {
    const { providers, skipped } = resolveProviderChain('local', {} as NodeJS.ProcessEnv);
    assert.deepEqual(skipped, []);
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.name, 'local');
    assert.equal(providers[0]!.supportsWordTimestamps, true);
    assert.equal(providers[0]!.approxUsdPerAudioHour, 0);
  });

  test('local_fallback_elevenlabs skips Scribe when the key is absent', () => {
    const { providers, skipped } = resolveProviderChain(
      'local_fallback_elevenlabs',
      {} as NodeJS.ProcessEnv,
    );
    assert.deepEqual(providers.map((p) => p.name), ['local']);
    assert.deepEqual(skipped, ['elevenlabs']);
  });

  test('ASR_PROVIDER=local constructs without a key', () => {
    const p = providerFromEnv({ ASR_PROVIDER: 'local' } as NodeJS.ProcessEnv);
    assert.equal(p.name, 'local');
  });
});

describe('whisper payload normalisation', () => {
  test('verbose_json words become a timed transcript', () => {
    const t = normaliseWhisperResult({
      language: 'hindi',
      duration: 1.2,
      words: [
        { word: ' bahut', start: 0.1, end: 0.55, probability: 0.8 },
        { word: 'अच्छा', start: 0.55, end: 1.1, probability: 0.7 },
      ],
    });
    assert.equal(t.hasWordTimings, true);
    assert.equal(t.provider, 'local');
    assert.equal(t.language, 'hi');
    assert.equal(t.detectedLanguageRaw, 'hindi');
    assert.equal(t.words.length, 2);
    assert.equal(t.words[0]!.text, 'bahut');
    assert.equal(t.words[0]!.start, 0.1);
    assert.equal(t.words[0]!.end, 0.55);
    assert.equal(t.words[0]!.confidence, 0.8);
    assert.equal(t.words[1]!.text, 'अच्छा');
  });

  test('word objects are not merged just because they lack a leading space', () => {
    const t = normaliseWhisperResult({
      language: 'en',
      words: [
        { word: 'hello', start: 0, end: 0.4, probability: 0.9 },
        { word: 'world', start: 0.4, end: 0.8, probability: 0.9 },
      ],
    });
    assert.deepEqual(t.words.map((w) => w.text), ['hello', 'world']);
  });

  test('whisper-cli token offsets are milliseconds and subwords join', () => {
    const t = normaliseWhisperResult({
      result: { language: 'en' },
      transcription: [
        {
          tokens: [
            { text: ' hello', offsets: { from: 0, to: 400 }, p: 0.95 },
            { text: 'world', offsets: { from: 400, to: 800 }, p: 0.5 },
            { text: '<|endoftext|>', offsets: { from: 800, to: 800 }, p: 0 },
          ],
        },
      ],
    });
    assert.equal(t.words.length, 1);
    assert.equal(t.words[0]!.text, 'helloworld');
    assert.equal(t.words[0]!.start, 0);
    assert.equal(t.words[0]!.end, 0.8);
    assert.equal(t.words[0]!.confidence, 0.5);
    assert.equal(t.language, 'en');
  });

  test('a payload with no word times is rejected', () => {
    assert.throws(
      () => normaliseWhisperResult({ text: 'only a sentence', language: 'hi' }),
      /word-level timestamps/,
    );
  });
});

describe('local Whisper HTTP client', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  test('posts audio to the whisper.cpp inference endpoint', async () => {
    let url = '';
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = String(input);
      return new Response(JSON.stringify({
        language: 'hindi',
        duration: 0.5,
        words: [{ word: 'नमस्ते', start: 0, end: 0.5, probability: 0.91 }],
      }), { status: 200 });
    }) as typeof fetch;

    const provider = new LocalWhisper({
      LOCAL_WHISPER_ENDPOINT: 'http://127.0.0.1:8080',
    } as NodeJS.ProcessEnv);
    const t = await provider.transcribe(Buffer.from('RIFFfake'));
    assert.equal(url, 'http://127.0.0.1:8080/inference');
    assert.equal(t.hasWordTimings, true);
    assert.equal(t.words[0]!.text, 'नमस्ते');
    assert.equal(t.language, 'hi');
  });

  test('code-switching prompt keeps English in Latin and does not pin the language', () => {
    const prompt = buildWhisperPrompt({
      codeSwitching: true,
      language: 'hi',
      keyterms: ['WhatsApp', 'iPhone'],
    });
    assert.match(prompt ?? '', /Latin script/);
    assert.match(prompt ?? '', /WhatsApp, iPhone/);
  });
});
