import type { Transcript, Word } from '../types.js';
import { MissingApiKeyError } from '../errors.js';
import { normaliseLanguageCode } from '../config/language-codes.js';
import { AsrError, type AsrProvider, type TranscribeOptions } from './types.js';

/**
 * Sarvam AI — India-hosted, 22 Indian languages.
 *
 * ⚠️ IMPORTANT LIMITATION, and the reason this is NOT the primary provider:
 * Sarvam's REST speech-to-text returns CHUNK-LEVEL timestamps (sentence/phrase),
 * not per-word. Their Batch API adds diarisation and chunk timestamps — still not
 * per-word. You CANNOT build word-timed karaoke captions or transcript-driven
 * Auto Trim on chunk timings.
 *
 * So what is it for?
 *   1. Accuracy benchmarking against Scribe on regional-accent audio.
 *   2. A data-residency option — audio stays in India, which matters under DPDP
 *      and is a genuine marketing claim, not just compliance paperwork.
 *   3. Plain transcripts / translation, where word timings don't matter.
 *
 * `interpolateChunk` exists so you can still eyeball output in the editor, but
 * it FABRICATES timings by splitting chunks proportionally to word length. It is
 * not accurate enough to ship as captions. The transcript is flagged
 * `hasWordTimings: false` and carries a warning so downstream code can refuse it —
 * see assertWordTimings() in src/asr/index.ts.
 *
 * STATUS as of August 2026 (re-verified against Sarvam's docs):
 *   - Word-level timestamps: still NOT available. The Batch API's timestamps are
 *     sentence/phrase level. This adapter's central limitation is unchanged.
 *   - Saarika v2.5 is being deprecated; Saaras is the current transcription line.
 *     `model` is constructor-injectable so you can move to a newer version
 *     without touching this file.
 *   - Saaras exposes output MODES: transcribe | translate | verbatim |
 *     transliterate | codemix.
 *
 * That last point is worth acting on: `transliterate` / `codemix` are a
 * ready-made backend for the romanisation that src/transliterate/ currently
 * leaves stubbed. Sarvam romanises the way people actually type, which is
 * exactly what a rule-based converter gets wrong. If you wire up `--script
 * roman`, evaluate this before self-hosting IndicXlit — but note you would be
 * using Sarvam for TEXT, still not for word timings.
 *
 * Docs: https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/overview
 */
export class SarvamAI implements AsrProvider {
  readonly name = 'sarvam';
  readonly supportsWordTimestamps = false; // ← the whole point
  readonly approxUsdPerAudioHour = 0.36; // ~₹30/hour

  constructor(
    private readonly apiKey: string,
    private readonly model = 'saaras:v3',
    private readonly baseUrl = 'https://api.sarvam.ai',
  ) {
    if (!apiKey) throw new MissingApiKeyError('sarvam', 'SARVAM_API_KEY');
  }

  async transcribe(audio: Buffer | Uint8Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    const form = new FormData();
    form.append('file', new Blob([audio as unknown as BlobPart]), 'audio.wav');
    form.append('model', this.model);
    if (opts.language) form.append('language_code', opts.language);

    const res = await fetch(`${this.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AsrError(
        `Sarvam request failed (${res.status}): ${body.slice(0, 400)}`,
        this.name,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    return this.normalise(await res.json());
  }

  normalise(raw: unknown): Transcript {
    const r = raw as SarvamResponse;
    const chunks = r.timestamps?.length
      ? r.timestamps
      : [{ text: r.transcript ?? '', start_time: 0, end_time: 0 }];

    const words: Word[] = [];
    for (const c of chunks) {
      words.push(...interpolateChunk(c.text, c.start_time, c.end_time, r.language_code));
    }

    if (words.length === 0) throw new AsrError('Sarvam returned no text', this.name);

    return {
      words,
      language: normaliseLanguageCode(r.language_code).code || 'unknown',
      detectedLanguageRaw: r.language_code,
      duration: Math.max(...words.map((w) => w.end), 0),
      provider: this.name,
      model: this.model,
      hasWordTimings: false,
      warnings: [
        'Sarvam returns chunk-level timestamps only. Word timings below are INTERPOLATED ' +
          'and are not accurate enough for word-timed captions or Auto Trim. ' +
          'Use ElevenLabs Scribe v2 or Deepgram Nova-3 for production captioning.',
      ],
    };
  }
}

/** Split a chunk across its words, weighting by character length. Approximate by design. */
function interpolateChunk(
  text: string,
  start: number,
  end: number,
  language?: string,
): Word[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const totalChars = tokens.reduce((n, t) => n + t.length, 0) || 1;
  const span = Math.max(end - start, 0);

  let cursor = start;
  return tokens.map((t) => {
    const dur = span * (t.length / totalChars);
    const w: Word = {
      text: t,
      start: cursor,
      end: cursor + dur,
      confidence: 0.5, // deliberately low — these timings are fabricated
      type: 'word',
      language: language ? normaliseLanguageCode(language).code : undefined,
      keep: true,
    };
    cursor += dur;
    return w;
  });
}

interface SarvamResponse {
  transcript?: string;
  language_code?: string;
  timestamps?: Array<{ text: string; start_time: number; end_time: number }>;
}
