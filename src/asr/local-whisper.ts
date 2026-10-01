/**
 * Approach decision — local ASR is Approach B (Whisper), not A or C.
 *
 * A (Sarvam Shuka / AudioLM) answers audio questions. It does not emit
 * per-word start/end times, and assertWordTimings() rejects any transcript
 * with hasWordTimings: false. The same limitation already disqualifies the
 * Sarvam cloud adapter for karaoke captions.
 *
 * C (distil / fine-tune on Sarvam labels) needs a cloud data pipeline and
 * does not produce a usable local transcriber today.
 *
 * B (whisper.cpp, Metal) is the provider that fits AsrProvider: word times
 * come from cross-attention alignment, Hindi and the other Indic languages
 * this project renders are in Whisper's language set, and inference stays on
 * this machine. Transliteration quality is a separate problem — Whisper's
 * romanisation is not natural Hinglish — so romanisation is LocalLlmTransliterator,
 * with the existing rule engines underneath it. This file only transcribes.
 *
 * Runtime: HTTP to whisper.cpp's server (LOCAL_WHISPER_ENDPOINT, default
 * http://127.0.0.1:8080). If that is down and WHISPER_MODEL_PATH is set, the
 * same adapter spawns whisper-cli / whisper-cpp and reads the JSON-full file.
 * No API key. No npm inference dependency.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Transcript, Word } from '../types.js';
import { normaliseLanguageCode } from '../config/language-codes.js';
import { AsrError, type AsrProvider, type TranscribeOptions } from './types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_WHISPER_ENDPOINT = 'http://127.0.0.1:8080';

/** Whisper's English language names → ISO-639-1, then normaliseLanguageCode. */
const WHISPER_LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  hindi: 'hi',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  malayalam: 'ml',
  marathi: 'mr',
  gujarati: 'gu',
  punjabi: 'pa',
  urdu: 'ur',
  odia: 'or',
  oriya: 'or',
  assamese: 'as',
  nepali: 'ne',
};

/**
 * Initial prompt for code-switching and domain words.
 *
 * Whisper has no keyterm API. A short prompt is the supported way to bias
 * the decoder toward Latin spellings of English words inside Indic audio.
 */
export function buildWhisperPrompt(opts: TranscribeOptions): string | undefined {
  const parts: string[] = [];
  if (opts.codeSwitching) {
    parts.push(
      'Code-switched Indic-English speech. Keep English words, brand names, and Latin tokens in Latin script.',
    );
  }
  if (opts.keyterms?.length) {
    parts.push(`Vocabulary: ${opts.keyterms.join(', ')}.`);
  }
  const text = parts.join(' ').trim();
  return text.length > 0 ? text : undefined;
}

export class LocalWhisper implements AsrProvider {
  readonly name = 'local';
  readonly supportsWordTimestamps = true;
  readonly approxUsdPerAudioHour = 0;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async transcribe(audio: Buffer | Uint8Array, opts: TranscribeOptions = {}): Promise<Transcript> {
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
    const errors: string[] = [];

    try {
      return await this.viaServer(bytes, opts);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    if (this.modelPath()) {
      try {
        return await this.viaBinary(bytes, opts);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    } else {
      errors.push(
        'WHISPER_MODEL_PATH is not set, so the whisper.cpp binary was not tried. ' +
          'Start the server with `npm run local:start`, or set WHISPER_MODEL_PATH to a ggml model.',
      );
    }

    throw new AsrError(
      `Local Whisper failed.\n${errors.join('\n')}`,
      this.name,
      undefined,
      true,
    );
  }

  private endpoint(): string {
    const raw = (this.env.LOCAL_WHISPER_ENDPOINT ?? DEFAULT_WHISPER_ENDPOINT).trim();
    return (raw || DEFAULT_WHISPER_ENDPOINT).replace(/\/+$/, '');
  }

  private modelPath(): string | undefined {
    const p = this.env.WHISPER_MODEL_PATH?.trim();
    return p || undefined;
  }

  private modelName(): string {
    return this.env.WHISPER_MODEL?.trim() || 'large-v3-turbo';
  }

  private async viaServer(audio: Buffer, opts: TranscribeOptions): Promise<Transcript> {
    const endpoint = this.endpoint();
    const fields = serverFields(opts);
    const urls = [`${endpoint}/inference`, `${endpoint}/v1/audio/transcriptions`];
    let last = `no response from ${endpoint}`;

    for (const url of urls) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          body: audioForm(audio, fields),
          signal: AbortSignal.timeout(30 * 60 * 1000),
        });
      } catch (err) {
        const refused = isConnRefused(err);
        last = `cannot reach ${url} (${describe(err)})`;
        if (refused) break;
        continue;
      }

      if (res.status === 404) {
        last = `${url} returned 404`;
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AsrError(
          `Local Whisper request failed (${res.status}) at ${url}: ${body.slice(0, 400)}`,
          this.name,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new AsrError(`Local Whisper returned non-JSON from ${url}`, this.name);
      }
      return normaliseWhisperResult(json, this.modelName());
    }

    throw new AsrError(last, this.name, undefined, true);
  }

  private async viaBinary(audio: Buffer, opts: TranscribeOptions): Promise<Transcript> {
    const model = this.modelPath();
    if (!model) {
      throw new AsrError('WHISPER_MODEL_PATH is not set', this.name);
    }

    const dir = await mkdtemp(join(tmpdir(), 'ce-whisper-'));
    const wavPath = join(dir, 'audio.wav');
    const outBase = join(dir, 'out');
    try {
      await writeFile(wavPath, audio);
      const args = ['-m', model, '-f', wavPath, '-ojf', '-of', outBase];
      if (opts.language && !opts.codeSwitching) args.push('-l', opts.language);
      const prompt = buildWhisperPrompt(opts);
      if (prompt) args.push('--prompt', prompt);

      const bin = this.env.WHISPER_BIN?.trim() || 'whisper-cli';
      const bins = [bin, 'whisper-cpp'].filter((b, i, all) => all.indexOf(b) === i);
      let stderr = '';
      let ran = false;
      for (const candidate of bins) {
        try {
          const result = await execFileAsync(candidate, args, {
            timeout: 30 * 60 * 1000,
            maxBuffer: 8 * 1024 * 1024,
            encoding: 'utf8',
          });
          stderr = result.stderr ?? '';
          ran = true;
          break;
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { stderr?: string };
          if (e.code === 'ENOENT') continue;
          throw new AsrError(
            `whisper.cpp exited with an error: ${(e.stderr ?? e.message).slice(0, 500)}`,
            this.name,
          );
        }
      }
      if (!ran) {
        throw new AsrError(
          `Neither ${bins.join(' nor ')} was found on PATH.`,
          this.name,
          undefined,
          true,
        );
      }

      const jsonPath = `${outBase}.json`;
      let text: string;
      try {
        text = await readFile(jsonPath, 'utf8');
      } catch {
        throw new AsrError(
          `whisper.cpp produced no JSON at ${jsonPath}. ${stderr.slice(0, 300)}`,
          this.name,
        );
      }
      return normaliseWhisperResult(JSON.parse(text) as unknown, this.modelName());
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function serverFields(opts: TranscribeOptions): Record<string, string> {
  const fields: Record<string, string> = {
    response_format: 'verbose_json',
    temperature: '0',
    word_timestamps: 'true',
  };
  if (opts.language && !opts.codeSwitching) fields.language = opts.language;
  const prompt = buildWhisperPrompt(opts);
  if (prompt) fields.prompt = prompt;
  return fields;
}

function audioForm(audio: Buffer, fields: Record<string, string>): FormData {
  const form = new FormData();
  form.append('file', new Blob([audio as unknown as BlobPart]), 'audio.wav');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

function isConnRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENOTFOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

interface TimedPiece {
  text: string;
  start: number;
  end: number;
  probability: number;
  /** True for a provider word. False for a BPE token that may continue the previous word. */
  atomic: boolean;
}

/**
 * Turn a whisper.cpp server payload, an OpenAI verbose_json payload, or a
 * whisper-cli `-ojf` file into a Transcript with real word times.
 *
 * Throws when the payload has no word-level times. Sentence-only JSON must
 * not be reported as hasWordTimings: true.
 */
export function normaliseWhisperResult(raw: unknown, model = 'large-v3-turbo'): Transcript {
  const rec = asRecord(raw);
  if (!rec) {
    throw new AsrError('Local Whisper returned an empty payload', 'local');
  }

  const languageRaw = languageRawOf(rec);
  const pieces = extractPieces(rec);
  const words = piecesToWords(pieces, languageRaw);
  if (words.length === 0) {
    throw new AsrError(
      'Local Whisper returned no word-level timestamps. ' +
        'Start whisper-server with a ggml model and send word_timestamps=true ' +
        '(npm run local:start does this).',
      'local',
    );
  }

  const mapped = mapWhisperLanguage(languageRaw);
  const durationField = numberOr(rec.duration, NaN);
  const duration = Number.isFinite(durationField)
    ? durationField
    : Math.max(...words.map((w) => w.end), 0);

  return {
    words,
    language: mapped.code || 'unknown',
    detectedLanguageRaw: languageRaw || undefined,
    duration,
    provider: 'local',
    model,
    hasWordTimings: true,
  };
}

function extractPieces(rec: Record<string, unknown>): TimedPiece[] {
  const top = wordArray(rec.words);
  if (top.length > 0) return top;

  const fromSegments: TimedPiece[] = [];
  if (Array.isArray(rec.segments)) {
    for (const seg of rec.segments) {
      const s = asRecord(seg);
      if (!s) continue;
      const words = wordArray(s.words);
      if (words.length > 0) {
        fromSegments.push(...words);
        continue;
      }
      fromSegments.push(...tokenArray(s.tokens));
    }
  }
  if (fromSegments.length > 0) return fromSegments;

  if (Array.isArray(rec.transcription)) {
    const fromCli: TimedPiece[] = [];
    for (const seg of rec.transcription) {
      const s = asRecord(seg);
      if (!s) continue;
      const tokens = tokenArray(s.tokens);
      if (tokens.length > 0) fromCli.push(...tokens);
    }
    if (fromCli.length > 0) return fromCli;
  }

  return [];
}

function wordArray(value: unknown): TimedPiece[] {
  if (!Array.isArray(value)) return [];
  const out: TimedPiece[] = [];
  for (const item of value) {
    const w = asRecord(item);
    if (!w) continue;
    const text = typeof w.word === 'string' ? w.word : typeof w.text === 'string' ? w.text : '';
    const start = timeBound(w, 'start');
    const end = timeBound(w, 'end');
    if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      text,
      start,
      end,
      probability: probabilityOf(w),
      atomic: true,
    });
  }
  return out;
}

function tokenArray(value: unknown): TimedPiece[] {
  if (!Array.isArray(value)) return [];
  const out: TimedPiece[] = [];
  for (const item of value) {
    const t = asRecord(item);
    if (!t || typeof t.text !== 'string') continue;
    const start = timeBound(t, 'start');
    const end = timeBound(t, 'end');
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({ text: t.text, start, end, probability: probabilityOf(t), atomic: false });
  }
  return out;
}

/**
 * Word times in seconds.
 *
 * whisper.cpp's HTTP server and OpenAI verbose_json use seconds in `start`
 * and `end`. whisper-cli `-ojf` stores milliseconds in `offsets` and a
 * timestamp string. Those two shapes must not be mixed up.
 */
function timeBound(rec: Record<string, unknown>, side: 'start' | 'end'): number {
  const direct = side === 'start' ? rec.start : rec.end;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const offsets = asRecord(rec.offsets);
  if (offsets) {
    const raw = numberOr(side === 'start' ? offsets.from : offsets.to, NaN);
    if (Number.isFinite(raw)) return raw / 1000;
  }
  const timestamps = asRecord(rec.timestamps);
  if (timestamps) {
    const stamp = side === 'start' ? timestamps.from : timestamps.to;
    if (typeof stamp === 'string') return timestampToSeconds(stamp);
  }
  return NaN;
}

function probabilityOf(rec: Record<string, unknown>): number {
  const p = numberOr(rec.probability, NaN);
  if (Number.isFinite(p)) return clamp01(p);
  const alt = numberOr(rec.p, NaN);
  if (Number.isFinite(alt)) return clamp01(alt);
  return 1;
}

function piecesToWords(pieces: TimedPiece[], languageRaw: string): Word[] {
  const lang = mapWhisperLanguage(languageRaw).code || undefined;
  const words: Word[] = [];
  let current: Word | null = null;

  for (const piece of pieces) {
    const boundary = piece.atomic || piece.text.startsWith(' ') || current === null;
    const text = piece.text.trim();
    if (!text || isSpecialToken(text)) continue;
    const end = piece.end >= piece.start ? piece.end : piece.start;
    if (boundary || !current) {
      if (current) words.push(current);
      current = {
        text,
        start: piece.start,
        end,
        confidence: clamp01(piece.probability),
        type: 'word',
        language: lang,
        keep: true,
      };
    } else {
      current.text += text;
      current.end = end;
      current.confidence = Math.min(current.confidence, clamp01(piece.probability));
    }
  }
  if (current) words.push(current);
  return words.filter((w) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end));
}

function isSpecialToken(text: string): boolean {
  return /^<\|.*\|>$/.test(text) || /^\[_.*\]$/.test(text) || text === '[BLANK_AUDIO]';
}

function languageRawOf(rec: Record<string, unknown>): string {
  if (typeof rec.language === 'string') return rec.language;
  if (typeof rec.language_code === 'string') return rec.language_code;
  const result = asRecord(rec.result);
  if (result && typeof result.language === 'string') return result.language;
  return '';
}

function mapWhisperLanguage(raw: string): ReturnType<typeof normaliseLanguageCode> {
  const key = raw.trim().toLowerCase();
  const named = WHISPER_LANGUAGE_NAMES[key];
  return normaliseLanguageCode(named ?? raw);
}

function timestampToSeconds(stamp: string): number {
  const m = stamp.trim().match(/^(?:(\d+):)?(\d+):(\d+)[,.](\d+)$/);
  if (!m) return NaN;
  const hours = Number(m[1] ?? 0);
  const mins = Number(m[2] ?? 0);
  const secs = Number(m[3] ?? 0);
  const frac = m[4] ?? '0';
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return hours * 3600 + mins * 60 + secs + ms / 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
