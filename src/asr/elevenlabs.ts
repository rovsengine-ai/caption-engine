import type { Transcript, Word, WordType } from '../types.js';
import { MissingApiKeyError } from '../errors.js';
import { normaliseLanguageCode } from '../config/language-codes.js';
import { AsrError, type AsrProvider, type TranscribeOptions } from './types.js';

/**
 * ElevenLabs Scribe v2 — the word-timing fallback (and a strong standalone option).
 *
 * Default pipeline mode is Sarvam → ElevenLabs (`sarvam_fallback_elevenlabs`).
 * Use this provider directly when you need guaranteed per-word timestamps:
 *  - Returns real per-word timestamps (`timestamps_granularity: "word"`).
 *  - 2026 Indic code-switch fix: English words inside Hindi/Telugu/Kannada audio
 *    stay in Latin script instead of being mangled into Devanagari. This is the
 *    single behaviour that makes Hinglish captions usable.
 *
 * Verify before trusting: benchmark numbers (~3.1% WER on FLEURS Hindi/Telugu)
 * come from CLEAN READ SPEECH. Real creator audio — phone mics, background music,
 * street noise, heavy regional accents — will be materially worse. Measure it
 * yourself on real clips before building on top of it.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */
export class ElevenLabsScribe implements AsrProvider {
  readonly name = 'elevenlabs';
  readonly supportsWordTimestamps = true;
  readonly approxUsdPerAudioHour = 0.22; // batch Scribe; realtime ~0.39. Verify.

  constructor(
    private readonly apiKey: string,
    private readonly modelId = 'scribe_v2',
    private readonly baseUrl = 'https://api.elevenlabs.io',
  ) {
    if (!apiKey) throw new MissingApiKeyError('elevenlabs', 'ELEVENLABS_API_KEY');
  }

  async transcribe(audio: Buffer | Uint8Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as BlobPart]), 'audio.wav');
    form.append('model_id', this.modelId);
    form.append('timestamps_granularity', 'word');

    // Language hint. For code-switched audio we deliberately DO NOT force one:
    // pinning language_code=hi pushes Scribe to render English words in
    // Devanagari ("cheat day" → "चीट डे"), and no downstream romaniser can undo
    // that — चीट is equally cheet/chit/cheat. Auto-detect keeps English in Latin,
    // which is exactly what mixed Hinglish needs.
    if (opts.language && !opts.codeSwitching) {
      form.append('language_code', opts.language);
    }

    // Domain vocabulary. Biases recognition towards real spellings of brands,
    // names and jargon, so they arrive as English instead of being spelled out
    // phonetically in the local script.
    if (opts.keyterms?.length) {
      form.append('keyterms_prompt', opts.keyterms.join(', '));
    }

    if (opts.diarize) form.append('diarize', 'true');
    for (const [k, v] of Object.entries(opts.extra ?? {})) form.append(k, String(v));

    const res = await fetch(`${this.baseUrl}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AsrError(
        `Scribe request failed (${res.status}): ${body.slice(0, 400)}`,
        this.name,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }

    return this.normalise(await res.json());
  }

  /** Exposed for tests — pure function over a provider payload. */
  normalise(raw: unknown): Transcript {
    const r = raw as ScribeResponse;
    const rawWords = r.words ?? [];
    if (rawWords.length === 0) {
      throw new AsrError('Scribe returned no words', this.name);
    }

    // Scribe returns ISO-639-3 ("hin"). Everything downstream keys on
    // ISO-639-1 ("hi"), so normalise HERE, at the adapter boundary, and never
    // let a 639-3 code escape into the pipeline.
    const docLang = normaliseLanguageCode(r.language_code);

    const words: Word[] = rawWords.map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      // Scribe may omit confidence on some word types; treat absent as certain
      // rather than as zero, which would nuke low-confidence filtering.
      confidence: typeof w.logprob === 'number' ? Math.exp(w.logprob) : (w.confidence ?? 1),
      type: mapType(w.type),
      speakerId: w.speaker_id,
      language: normaliseLanguageCode(w.language_code ?? r.language_code).code || undefined,
      keep: true,
    }));

    const spoken = words.filter((w) => w.type === 'word');
    const warnings: string[] = [];
    if (spoken.length === 0) warnings.push('No spoken words detected — Auto Trim will be a no-op.');

    return {
      words,
      language: docLang.code || 'unknown',
      detectedLanguageRaw: r.language_code,
      duration: Math.max(...words.map((w) => w.end), 0),
      provider: this.name,
      model: this.modelId,
      hasWordTimings: true,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}

function mapType(t: string | undefined): WordType {
  if (t === 'spacing') return 'spacing';
  if (t === 'audio_event') return 'audio_event';
  return 'word';
}

interface ScribeResponse {
  language_code?: string;
  text?: string;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    type?: string;
    speaker_id?: string;
    language_code?: string;
    logprob?: number;
    confidence?: number;
  }>;
}
