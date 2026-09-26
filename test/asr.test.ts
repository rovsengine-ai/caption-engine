import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsScribe } from '../src/asr/elevenlabs.js';
import { DeepgramNova } from '../src/asr/deepgram.js';
import { SarvamAI } from '../src/asr/sarvam.js';
import { assertWordTimings } from '../src/asr/index.js';

/**
 * These test the NORMALISERS — pure functions over provider payloads. No network.
 * The payload shapes mirror each vendor's documented response.
 */

describe('ElevenLabs Scribe normaliser', () => {
  const scribe = new ElevenLabsScribe('test-key');

  const payload = {
    language_code: 'hi',
    text: 'aaj important hai',
    words: [
      { text: 'aaj', start: 0.1, end: 0.4, type: 'word', logprob: -0.05 },
      { text: ' ', start: 0.4, end: 0.45, type: 'spacing' },
      { text: 'important', start: 0.45, end: 1.0, type: 'word', language_code: 'en' },
      { text: 'hai', start: 1.0, end: 1.3, type: 'word', speaker_id: 'speaker_0' },
    ],
  };

  test('normalises to the core schema', () => {
    const t = scribe.normalise(payload);
    assert.equal(t.provider, 'elevenlabs');
    assert.equal(t.language, 'hi');
    assert.equal(t.hasWordTimings, true);
    assert.equal(t.words.length, 4);
  });

  test('preserves per-word language for code-switched audio', () => {
    const t = scribe.normalise(payload);
    const eng = t.words.find((w) => w.text === 'important');
    assert.equal(eng?.language, 'en', 'per-word language drives filler matching');
  });

  test('maps word types', () => {
    const t = scribe.normalise(payload);
    assert.equal(t.words[1]!.type, 'spacing');
    assert.equal(t.words[0]!.type, 'word');
  });

  test('converts logprob to a 0..1 confidence', () => {
    const t = scribe.normalise(payload);
    const c = t.words[0]!.confidence;
    assert.ok(c > 0 && c <= 1, `confidence out of range: ${c}`);
  });

  test('absent confidence defaults to 1, not 0', () => {
    // Defaulting to 0 would make low-confidence filtering delete everything.
    const t = scribe.normalise(payload);
    assert.equal(t.words[2]!.confidence, 1);
  });

  test('derives duration from the last word', () => {
    assert.equal(scribe.normalise(payload).duration, 1.3);
  });

  test('carries diarisation through', () => {
    const t = scribe.normalise(payload);
    assert.equal(t.words[3]!.speakerId, 'speaker_0');
  });

  test('throws on an empty result rather than returning a hollow transcript', () => {
    assert.throws(() => scribe.normalise({ words: [] }), /no words/i);
  });

  test('rejects construction without an API key, naming the env var to set', () => {
    assert.throws(() => new ElevenLabsScribe(''), (err: unknown) => {
      const e = err as Error & { hint?: string };
      assert.match(e.message, /Please provide a Sarvam AI API Key/i);
      assert.match(e.hint ?? '', /ELEVENLABS_API_KEY/, 'hint must name the env var');
      return true;
    });
  });

  test('Deepgram and Sarvam also fail with actionable key errors', async () => {
    const { DeepgramNova } = await import('../src/asr/deepgram.js');
    const { SarvamAI } = await import('../src/asr/sarvam.js');
    assert.throws(() => new DeepgramNova(''), (e: unknown) => {
      assert.match((e as Error & { hint?: string }).hint ?? '', /DEEPGRAM_API_KEY/);
      return true;
    });
    assert.throws(() => new SarvamAI(''), (e: unknown) => {
      assert.match((e as Error & { hint?: string }).hint ?? '', /SARVAM_API_KEY/);
      return true;
    });
  });
});

describe('Deepgram normaliser', () => {
  const dg = new DeepgramNova('test-key');
  const payload = {
    metadata: { duration: 2.5 },
    results: {
      channels: [
        {
          detected_language: 'te',
          alternatives: [
            {
              words: [
                { word: 'nenu', punctuated_word: 'Nenu', start: 0.1, end: 0.5, confidence: 0.98 },
                { word: 'cheptanu', start: 0.5, end: 1.2, confidence: 0.91, speaker: 0 },
              ],
            },
          ],
        },
      ],
    },
  };

  test('normalises to the same core schema', () => {
    const t = dg.normalise(payload);
    assert.equal(t.provider, 'deepgram');
    assert.equal(t.language, 'te');
    assert.equal(t.hasWordTimings, true);
    assert.equal(t.words.length, 2);
  });

  test('prefers punctuated_word for caption text', () => {
    assert.equal(dg.normalise(payload).words[0]!.text, 'Nenu');
  });

  test('uses metadata duration when present', () => {
    assert.equal(dg.normalise(payload).duration, 2.5);
  });

  test('stringifies numeric speaker ids', () => {
    assert.equal(dg.normalise(payload).words[1]!.speakerId, '0');
  });

  test('throws on empty results', () => {
    assert.throws(() => dg.normalise({ results: { channels: [] } }), /no words/i);
  });
});

describe('Sarvam normaliser — the chunk-timestamp trap', () => {
  const sarvam = new SarvamAI('test-key');
  const payload = {
    language_code: 'hi',
    transcript: 'aaj main aapko batata hoon',
    timestamps: [{ text: 'aaj main aapko batata hoon', start_time: 0, end_time: 3.0 }],
  };

  test('advertises that it lacks word timestamps', () => {
    assert.equal(sarvam.supportsWordTimestamps, false);
  });

  test('flags hasWordTimings false even though it emits word objects', () => {
    const t = sarvam.normalise(payload);
    assert.equal(t.hasWordTimings, false);
    assert.ok(t.words.length > 1, 'it does split the chunk into words...');
  });

  test('warns loudly that the timings are interpolated', () => {
    const t = sarvam.normalise(payload);
    assert.ok(t.warnings && t.warnings.length > 0);
    assert.match(t.warnings!.join(' '), /interpolated|chunk-level/i);
  });

  test('marks interpolated words low-confidence', () => {
    for (const w of sarvam.normalise(payload).words) {
      assert.ok(w.confidence <= 0.5, 'fabricated timings must not look confident');
    }
  });

  test('interpolated timings stay inside the chunk and in order', () => {
    const t = sarvam.normalise(payload);
    assert.ok(t.words[0]!.start >= 0);
    assert.ok(t.words[t.words.length - 1]!.end <= 3.0001);
    for (let i = 1; i < t.words.length; i++) {
      assert.ok(t.words[i]!.start >= t.words[i - 1]!.start);
    }
  });

  test('assertWordTimings BLOCKS it from the caption pipeline', () => {
    const t = sarvam.normalise(payload);
    assert.throws(
      () => assertWordTimings(t),
      /did not return real per-word timestamps/,
      'this guard is what stops chunk timings reaching production captions',
    );
  });

  test('assertWordTimings passes a real provider through', () => {
    const good = new ElevenLabsScribe('k').normalise({
      language_code: 'hi',
      words: [{ text: 'a', start: 0, end: 0.2, type: 'word' }],
    });
    assert.doesNotThrow(() => assertWordTimings(good));
  });
});
