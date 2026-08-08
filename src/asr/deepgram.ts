import type { Transcript, Word } from '../types.js';
import { MissingApiKeyError } from '../errors.js';
import { normaliseLanguageCode } from '../config/language-codes.js';
import { AsrError, type AsrProvider, type TranscribeOptions } from './types.js';

/**
 * Deepgram Nova-3 — recommended BACKUP provider.
 *
 * Added Telugu and Kannada in Jan 2026, and supports Hindi. Keeping a second
 * provider wired from day one is deliberate: single-vendor ASR concentration is
 * a real product risk (price changes, rate limits, quality regressions), and the
 * cost of an adapter now is far lower than a migration later.
 *
 * Verify yourself: that Deepgram returns word timestamps for the SPECIFIC Indic
 * languages you need, and how it handles code-switched Hinglish — its Indic
 * code-switch behaviour is less documented than Scribe's.
 *
 * Docs: https://developers.deepgram.com/docs/language
 */
export class DeepgramNova implements AsrProvider {
  readonly name = 'deepgram';
  readonly supportsWordTimestamps = true;
  readonly approxUsdPerAudioHour = 0.26; // verify against current pricing

  constructor(
    private readonly apiKey: string,
    private readonly model = 'nova-3',
    private readonly baseUrl = 'https://api.deepgram.com',
  ) {
    if (!apiKey) throw new MissingApiKeyError('deepgram', 'DEEPGRAM_API_KEY');
  }

  async transcribe(audio: Buffer | Uint8Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    const qs = new URLSearchParams({
      model: this.model,
      punctuate: 'true',
      smart_format: 'true',
      // Word timings are on by default in Deepgram's response shape, but be explicit.
      utterances: 'false',
    });
    // Deepgram exposes a multilingual mode that keeps code-switched English in
    // Latin. Forcing a single language is what causes English to be written in
    // the local script.
    if (opts.codeSwitching) {
      qs.set('language', 'multi');
    } else if (opts.language) {
      qs.set('language', opts.language);
    } else {
      qs.set('detect_language', 'true');
    }

    // Nova-3 supports keyterm prompting; earlier models use keywords.
    if (opts.keyterms?.length) {
      const param = this.model.startsWith('nova-3') ? 'keyterm' : 'keywords';
      for (const k of opts.keyterms) qs.append(param, k);
    }

    if (opts.diarize) qs.set('diarize', 'true');

    const res = await fetch(`${this.baseUrl}/v1/listen?${qs}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'audio/wav' },
      body: audio as unknown as BodyInit,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AsrError(
        `Deepgram request failed (${res.status}): ${body.slice(0, 400)}`,
        this.name,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return this.normalise(await res.json());
  }

  normalise(raw: unknown): Transcript {
    const r = raw as DeepgramResponse;
    const alt = r.results?.channels?.[0]?.alternatives?.[0];
    const rawWords = alt?.words ?? [];
    if (rawWords.length === 0) throw new AsrError('Deepgram returned no words', this.name);

    const words: Word[] = rawWords.map((w) => ({
      // `punctuated_word` preserves punctuation, which captions need.
      text: w.punctuated_word ?? w.word,
      start: w.start,
      end: w.end,
      confidence: w.confidence ?? 1,
      type: 'word',
      speakerId: w.speaker !== undefined ? String(w.speaker) : undefined,
      language: normaliseLanguageCode(r.results?.channels?.[0]?.detected_language).code || undefined,
      keep: true,
    }));

    return {
      words,
      language: normaliseLanguageCode(r.results?.channels?.[0]?.detected_language).code || 'unknown',
      detectedLanguageRaw: r.results?.channels?.[0]?.detected_language,
      duration: r.metadata?.duration ?? Math.max(...words.map((w) => w.end), 0),
      provider: this.name,
      model: this.model,
      hasWordTimings: true,
    };
  }
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        words?: Array<{
          word: string;
          punctuated_word?: string;
          start: number;
          end: number;
          confidence?: number;
          speaker?: number;
        }>;
      }>;
    }>;
  };
}
