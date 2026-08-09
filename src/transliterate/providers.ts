import { CaptionEngineError } from '../errors.js';
import { transliterateToken, hasDevanagari } from './devanagari.js';
import { isIndicScript } from './script-utils.js';
import {
  planBatches, splitBatchResponse, mapWithConcurrency,
  DEFAULT_MAX_BATCH_CHARS, DEFAULT_SEPARATOR, SARVAM_HARD_LIMIT,
  type TokenBatch,
} from './batching.js';

/**
 * Transliteration backends.
 *
 * Requesting Roman output and SILENTLY getting Devanagari back is the worst
 * possible outcome — it looks like the feature ran. So asking for a backend
 * that is not configured is an error with instructions, never a quiet
 * pass-through.
 *
 * There is exactly one no-op, `NativeScriptPassthrough`, and it is unreachable
 * from `--transliterate`. It can only be selected by `--roman-fallback native`,
 * which is a decision the user makes explicitly and is told about in the run
 * report. "Silent" is the thing being prevented here, not "native".
 */

export type ProviderQuality = 'model' | 'rules';

export interface TransliterationProvider {
  readonly name: string;
  readonly description: string;
  /** True when it works with no network and no credentials. */
  readonly offline: boolean;
  /**
   * 'model' — trained on how people actually romanise; handles loanwords and
   *           unusual spellings.
   * 'rules' — deterministic phonetics. Correct and reproducible, but CANNOT
   *           recover English spelling from Devanagari-written English
   *           ("चीट" is equally cheet/chit/cheat). Lower quality on
   *           code-switched content; lean on the glossary.
   */
  readonly quality: ProviderQuality;
  /** Which languages it can romanise. */
  supports(language: string): boolean;
  /**
   * Romanise a batch of tokens.
   *
   * Contract, relied on by the caller to keep word timings aligned:
   *   - returns EXACTLY as many tokens as it was given, in the same order
   *   - a token already in Latin script is returned unchanged
   */
  romanise(tokens: string[], language: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Local — rule-based, offline, the default
// ---------------------------------------------------------------------------

/**
 * Deterministic Devanagari → Hinglish, implemented in src/transliterate/devanagari.ts.
 *
 * Honest scope: this handles Hindi/Marathi/Nepali (Devanagari) only. It applies
 * real Hindi schwa deletion rather than a character table, which is what makes
 * the output readable, and it is exact and reproducible with no network or key.
 * Its weak spot is English loanwords written in Devanagari, where phonetics
 * cannot recover English spelling — a lexicon covers the common ones.
 */
export class LocalHinglishTransliterator implements TransliterationProvider {
  readonly name = 'local';
  readonly description =
    'built-in rule-based Devanagari→Hinglish (offline, deterministic, LOWER QUALITY ' +
    'on English written in Devanagari — relies on the glossary for those)';
  readonly offline = true;
  readonly quality = 'rules' as const;

  supports(language: string): boolean {
    const base = (language.split('-')[0] ?? '').toLowerCase();
    return ['hi', 'mr', 'ne', 'sa', 'kok', 'mai'].includes(base);
  }

  async romanise(tokens: string[], _language: string): Promise<string[]> {
    return tokens.map((t) => transliterateToken(t));
  }
}

/**
 * No-op "provider": returns every token exactly as it arrived.
 *
 * This is NOT a transliterator and must never be selected by `--transliterate`.
 * It exists only as the target of `--roman-fallback native`, so that keeping the
 * original script is something the user asked for and was told about, rather
 * than something that quietly happened to them.
 *
 * The distinction matters: asking for Roman and silently getting Devanagari is
 * worse than an error, because the render succeeds and looks fine until someone
 * who reads the language sees it.
 */
export class NativeScriptPassthrough implements TransliterationProvider {
  readonly name = 'native';
  readonly description = 'no transliteration — original script preserved (explicit fallback only)';
  readonly offline = true;
  readonly quality = 'rules' as const;

  /** Never claims support: it romanises nothing. */
  supports(): boolean {
    return false;
  }

  async romanise(tokens: string[]): Promise<string[]> {
    return [...tokens];
  }
}

// ---------------------------------------------------------------------------
// Sarvam — model-backed
// ---------------------------------------------------------------------------

/** Transport failures worth another go. Everything else is a real answer. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A misconfiguration, not a hiccup: wrong key, wrong endpoint, rejected schema.
 *
 * These deliberately bypass the per-batch fallback. Falling back would "work" —
 * every batch would quietly degrade to offline quality and the run would look
 * successful — while hiding the one message the user needs, which is that their
 * key is wrong. Retrying is equally pointless; the answer will not change.
 */
export class TransliterationConfigError extends CaptionEngineError {
  readonly fatal = true;
}

function isFatal(err: unknown): boolean {
  return err instanceof TransliterationConfigError;
}

export interface SarvamOptions {
  baseUrl?: string;
  /** Hard cap on `body.input`, in UTF-16 code units. Must stay under 1000. */
  maxChars?: number;
  /** Requests in flight. Kept low on purpose; these APIs rate-limit. */
  concurrency?: number;
  /** Transport attempts per batch, including the first. */
  maxAttempts?: number;
  /** First backoff step in ms; doubles each retry, with jitter. */
  baseDelayMs?: number;
  /** Injectable for tests so retry paths do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Used for a batch Sarvam could not handle. Defaults to the offline engine
   * when it covers the language. One bad batch must not lose 2,000 good words.
   */
  fallback?: TransliterationProvider | null;
  /**
   * When a batch fails and NO offline engine covers the language (kn, te, ta,
   * ml, bn, gu, pa, or, as — everything Sarvam alone serves), keep that batch's
   * original script instead of failing the run.
   *
   * Off by default: silently returning native script when Roman was requested
   * is the failure this whole module exists to prevent. Turned on only by
   * `--roman-fallback native`, and every affected batch is named in the report.
   */
  allowNativeFallback?: boolean;
}

/** What happened on the last `romanise()` call. Surfaced by the CLI. */
export interface SarvamRunStats {
  batches: number;
  requests: number;
  retries: number;
  fallbackBatches: number;
  tokensViaApi: number;
  tokensViaFallback: number;
  /** Words returned unchanged in their original script by --roman-fallback native. */
  tokensViaNative: number;
  /** 1-based batch numbers that kept native script. Named, never just counted. */
  nativeBatches: number[];
  tokensPreserved: number;
  largestInputChars: number;
  notes: string[];
}

/**
 * Sarvam's transliteration endpoint.
 *
 * A trained model, so it handles loanwords and unusual spellings better than
 * rules can. Costs money and needs a key, hence not the default.
 *
 * Two things make this more than a fetch call:
 *
 * SIZE. Sarvam caps `body.input` at 1000 characters. A full transcript is an
 * order of magnitude past that, so tokens are packed into batches under a 900
 * character budget (see batching.ts). Words are never split across batches.
 *
 * ALIGNMENT. Sarvam romanises whole strings, not arrays, so a batch is joined
 * with a delimiter and split back out. Every returned piece is mapped to the
 * index of the word it came from. If a batch comes back with the wrong number
 * of pieces we retry once, then romanise that batch offline — we never pad or
 * truncate to make the counts line up, because that silently shifts every
 * subsequent caption.
 */
export class SarvamTransliterator implements TransliterationProvider {
  readonly name = 'sarvam';
  readonly description = 'Sarvam AI transliteration API (model-based, needs SARVAM_API_KEY)';
  readonly offline = false;
  readonly quality = 'model' as const;

  private readonly baseUrl: string;
  private readonly maxChars: number;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fallbackOverride: TransliterationProvider | null | undefined;
  private readonly allowNativeFallback: boolean;

  /** Reset at the start of every romanise() call. */
  stats: SarvamRunStats = emptyStats();

  constructor(
    private readonly apiKey: string,
    opts: SarvamOptions | string = {},
  ) {
    // Back-compat: the old signature was (apiKey, baseUrl).
    const o: SarvamOptions = typeof opts === 'string' ? { baseUrl: opts } : opts;
    this.baseUrl = o.baseUrl ?? 'https://api.sarvam.ai';
    this.maxChars = Math.min(o.maxChars ?? DEFAULT_MAX_BATCH_CHARS, SARVAM_HARD_LIMIT - 1);
    this.concurrency = Math.max(1, o.concurrency ?? 3);
    this.maxAttempts = Math.max(1, o.maxAttempts ?? 3);
    this.baseDelayMs = o.baseDelayMs ?? 400;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.fallbackOverride = o.fallback;
    this.allowNativeFallback = o.allowNativeFallback ?? false;
  }

  supports(language: string): boolean {
    const base = (language.split('-')[0] ?? '').toLowerCase();
    return ['hi', 'mr', 'ne', 'te', 'kn', 'ta', 'ml', 'bn', 'gu', 'pa', 'or', 'as'].includes(base);
  }

  /** Offline engine for a failed batch, when it covers this language. */
  private resolveFallback(language: string): TransliterationProvider | null {
    if (this.fallbackOverride !== undefined) return this.fallbackOverride;
    const local = new LocalHinglishTransliterator();
    return local.supports(language) ? local : null;
  }

  async romanise(tokens: string[], language: string): Promise<string[]> {
    this.stats = emptyStats();
    const out = [...tokens];

    // Only Indic tokens ever leave the machine. English and other Latin words
    // must come back byte-identical, and sending them invites the model to
    // "correct" the spelling — which would be translation, not transliteration.
    const sendIndices: number[] = [];
    const sendTokens: string[] = [];
    tokens.forEach((t, i) => {
      if (isIndicScript(t)) { sendIndices.push(i); sendTokens.push(t); }
    });
    this.stats.tokensPreserved = tokens.length - sendTokens.length;
    if (sendTokens.length === 0) return out;

    const batches = planBatches(sendTokens, sendIndices, { maxChars: this.maxChars });
    this.stats.batches = batches.length;
    this.stats.largestInputChars = batches.reduce((m, b) => Math.max(m, b.input.length), 0);

    const fallback = this.resolveFallback(language);

    const results = await mapWithConcurrency(batches, this.concurrency, async (batch, bi) => {
      // Unsendable on its own: straight to the fallback, no wasted request.
      if (batch.oversize) {
        return this.runFallback(
          batch, language, fallback,
          `token of ${batch.input.length} chars exceeds the ${this.maxChars}-char request budget`,
          bi,
        );
      }
      try {
        return await this.romaniseBatch(batch, language, bi);
      } catch (err) {
        // A bad key or a rejected schema affects every batch identically.
        // Degrading all of them to offline quality would look like success and
        // bury the actual problem, so this one propagates.
        if (isFatal(err)) throw err;
        return this.runFallback(batch, language, fallback, describe(err), bi);
      }
    });

    results.forEach((batchOut, bi) => {
      const batch = batches[bi]!;
      batch.indices.forEach((srcIdx, k) => {
        const v = batchOut[k];
        if (typeof v === 'string' && v.length > 0) out[srcIdx] = v;
      });
    });

    // Final guard. The caller aligns word timings by position, so a length
    // change here would desynchronise the whole caption track.
    if (out.length !== tokens.length) {
      throw new CaptionEngineError(
        `Sarvam batching produced ${out.length} tokens for ${tokens.length} inputs.`,
        'This is a bug in caption-engine. Use --transliterate local meanwhile.',
      );
    }
    return out;
  }

  /** One batch: request, split, and one content retry before giving up. */
  private async romaniseBatch(batch: TokenBatch, language: string, bi: number): Promise<string[]> {
    for (let contentAttempt = 0; contentAttempt < 2; contentAttempt++) {
      const text = await this.request(batch.input, language);
      const parts = splitBatchResponse(text, batch, DEFAULT_SEPARATOR);
      if (parts) {
        this.stats.tokensViaApi += parts.length;
        return parts;
      }
      if (contentAttempt === 0) {
        this.stats.retries++;
        this.stats.notes.push(
          `batch ${bi + 1}: malformed response (token count mismatch), retrying once`,
        );
        await this.sleep(this.backoff(0));
      }
    }
    throw new CaptionEngineError(
      `Sarvam returned a token count that does not match the ${batch.tokens.length} words sent ` +
        `in batch ${bi + 1}, twice.`,
      'Word timings would desynchronise, so this batch was not used.',
    );
  }

  /** POST one batch, retrying transport-level failures with backoff. */
  private async request(input: string, language: string): Promise<string> {
    // Requirement, asserted rather than assumed: the body we are about to send
    // is inside the documented limit. Reaching here over budget is a bug in the
    // batcher, and it is better caught locally than as a 422 from the server.
    if (input.length >= SARVAM_HARD_LIMIT) {
      throw new TransliterationConfigError(
        `Internal batching error: request body is ${input.length} characters, ` +
          `at or over Sarvam's ${SARVAM_HARD_LIMIT}-character limit.`,
        'Please report this. Use --transliterate local meanwhile.',
      );
    }

    // Exactly the documented schema — no extra keys, which some gateways reject.
    const body = JSON.stringify({
      input,
      source_language_code: normaliseLang(language),
      target_language_code: 'en-IN',
      numerals_format: 'international',
    });

    let lastError = '';
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        this.stats.retries++;
        await this.sleep(this.backoff(attempt - 1));
      }
      this.stats.requests++;

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/transliterate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-subscription-key': this.apiKey },
          body,
        });
      } catch (err) {
        lastError = `network error: ${describe(err)}`;
        continue; // network failures are always worth another attempt
      }

      if (res.ok) {
        let data: { transliterated_text?: unknown };
        try {
          data = (await res.json()) as { transliterated_text?: unknown };
        } catch {
          lastError = 'response was not valid JSON';
          continue;
        }
        const text = data.transliterated_text;
        if (typeof text !== 'string') {
          throw new TransliterationConfigError(
            `Sarvam response is missing the "transliterated_text" string.`,
            'The API contract may have changed. Use --transliterate local meanwhile.',
          );
        }
        return text;
      }

      const errBody = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}: ${errBody.slice(0, 300)}`;

      if (!RETRYABLE_STATUS.has(res.status)) {
        throw new TransliterationConfigError(
          `Sarvam transliteration failed (${res.status}): ${errBody.slice(0, 300)}`,
          res.status === 401 || res.status === 403
            ? 'Check SARVAM_API_KEY — the key was rejected, so every request will fail the ' +
              'same way.\nOr use the offline engine:  --transliterate local'
            : 'Use --transliterate local for the offline engine.',
        );
      }
      // Honour Retry-After when the server tells us how long to wait.
      const retryAfter = Number(res.headers?.get?.('retry-after') ?? NaN);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await this.sleep(Math.min(retryAfter * 1000, 30_000));
      }
    }

    throw new CaptionEngineError(
      `Sarvam transliteration failed after ${this.maxAttempts} attempts. Last error — ${lastError}`,
      'Use --transliterate local for the offline engine.',
    );
  }

  /** Exponential backoff with jitter, so retries do not synchronise. */
  private backoff(step: number): number {
    const base = this.baseDelayMs * Math.pow(2, step);
    return Math.min(base + Math.random() * this.baseDelayMs, 15_000);
  }

  /**
   * Romanise one batch offline. Only this batch is affected — the rest of the
   * transcript keeps the model output.
   */
  private async runFallback(
    batch: TokenBatch,
    language: string,
    fallback: TransliterationProvider | null,
    why: string,
    bi: number,
  ): Promise<string[]> {
    if (!fallback) {
      // No offline engine covers this language — the Kannada case. Sarvam is
      // the only backend for kn/te/ta/ml/bn/gu/pa/or/as, so when one of its
      // batches comes back with the wrong token count there is nothing to
      // romanise with.
      //
      // The strict timestamp check is never relaxed: mismatched output is
      // discarded, not forced onto word timings. The only question is what to
      // do with the batch afterwards, and that is the user's policy.
      if (this.allowNativeFallback) {
        this.stats.fallbackBatches++;
        this.stats.tokensViaNative += batch.tokens.length;
        this.stats.nativeBatches.push(bi + 1);
        this.stats.notes.push(
          `batch ${bi + 1}/${this.stats.batches}: ${why} — no offline transliterator for ` +
            `"${language}", so these ${batch.tokens.length} word(s) KEEP THEIR NATIVE SCRIPT ` +
            `(--roman-fallback native)`,
        );
        return [...batch.tokens];
      }
      throw new CaptionEngineError(
        `Sarvam failed on batch ${bi + 1} of ${this.stats.batches} (${why}), and there is no ` +
          `offline transliterator for "${language}" to fall back to.`,
        `Options:\n` +
          `  • Retry — the failure may be temporary.\n` +
          `  • Keep the native script for the failed batch only, and be told which:\n` +
          `      --roman-fallback native\n` +
          `  • Point at another service:\n` +
          `      export TRANSLITERATE_URL=...   --roman-fallback http\n` +
          `  • Or drop --script roman entirely.`,
      );
    }
    const out = await fallback.romanise(batch.tokens, language);
    if (out.length !== batch.tokens.length) {
      throw new CaptionEngineError(
        `Fallback provider "${fallback.name}" returned ${out.length} tokens for ` +
          `${batch.tokens.length} inputs in batch ${bi + 1}.`,
        'Word timings would desynchronise.',
      );
    }
    this.stats.fallbackBatches++;
    this.stats.tokensViaFallback += out.length;
    this.stats.notes.push(
      `batch ${bi + 1}/${this.stats.batches}: ${why} — romanised offline with "${fallback.name}" ` +
        `(${out.length} word(s))`,
    );
    return out;
  }
}

function emptyStats(): SarvamRunStats {
  return {
    batches: 0, requests: 0, retries: 0, fallbackBatches: 0,
    tokensViaApi: 0, tokensViaFallback: 0, tokensViaNative: 0, nativeBatches: [],
    tokensPreserved: 0, largestInputChars: 0, notes: [],
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normaliseLang(l: string): string {
  const base = (l.split('-')[0] ?? 'hi').toLowerCase();
  return `${base}-IN`;
}

/** Parse an env override, ignoring anything that isn't a positive integer. */
function positiveInt(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Generic HTTP — self-hosted IndicXlit, Bhashini, or anything else
// ---------------------------------------------------------------------------

export class HttpTransliterator implements TransliterationProvider {
  readonly name = 'http';
  readonly description = 'custom HTTP transliteration endpoint (TRANSLITERATE_URL)';
  readonly offline = false;
  readonly quality = 'model' as const;

  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  supports(): boolean {
    return true; // the operator decides what their endpoint covers
  }

  async romanise(tokens: string[], language: string): Promise<string[]> {
    // Send only what needs converting: Latin tokens must survive untouched, and
    // shipping them wastes quota and risks the service "correcting" them.
    const indices: number[] = [];
    const payload: string[] = [];
    tokens.forEach((t, i) => {
      if (isIndicScript(t)) { indices.push(i); payload.push(t); }
    });
    if (payload.length === 0) return tokens;

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify({ tokens: payload, language }),
    });
    if (!res.ok) {
      throw new CaptionEngineError(
        `Transliteration endpoint failed (${res.status}): ${this.endpoint}`,
        'Check TRANSLITERATE_URL, or use --transliterate local.',
      );
    }

    const data = (await res.json()) as { tokens?: string[] };
    const converted = data.tokens ?? [];
    if (converted.length !== payload.length) {
      throw new CaptionEngineError(
        `Endpoint returned ${converted.length} tokens for ${payload.length} inputs.`,
        'The endpoint must return one token per input, in order.',
      );
    }

    const out = [...tokens];
    indices.forEach((srcIdx, k) => {
      const v = converted[k];
      if (v) out[srcIdx] = v;
    });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type { TransliteratorName } from './capabilities.js';
import type { TransliteratorName } from './capabilities.js';

/** Names accepted by --transliterate. 'native' is deliberately absent. */
export function listTransliterators(): string[] {
  return ['auto', 'local', 'sarvam', 'http'];
}

/**
 * Build a transliteration provider.
 *
 * Fails loudly when Roman output is requested but the chosen backend is not
 * configured. There is deliberately no fallback to "return the input unchanged".
 */
/**
 * Pick a backend when the user did not name one.
 *
 * Prefers a MODEL backend for Indic/Hinglish quality: rules cannot recover
 * English spelling from Devanagari-written English, which is the single most
 * visible failure on code-switched content. Falls back to the offline engine so
 * the tool still works with no key — but says so.
 */
export function autoSelectTransliterator(env: NodeJS.ProcessEnv): TransliteratorName {
  if (env.TRANSLITERATE_URL) return 'http';
  if (env.SARVAM_API_KEY) return 'sarvam';
  return 'local';
}

export function resolveTransliterator(
  name: string | undefined,
  language: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowNativeFallback?: boolean } = {},
): TransliterationProvider {
  const requested = name ?? env.TRANSLITERATE_PROVIDER ?? 'auto';

  // 'native' is not a transliterator. Accepting it here would let a user ask
  // for Roman output and get their own text back, which is precisely the
  // failure mode the module exists to prevent. It is reachable only through
  // --roman-fallback, where it is reported.
  if (requested === 'native') {
    throw new CaptionEngineError(
      '"native" is not a transliteration backend — it performs no transliteration.',
      'To keep the original script:\n' +
        '  • drop --script roman, or\n' +
        '  • use --roman-fallback native, which keeps native script ONLY when\n' +
        '    romanisation is genuinely unavailable, and reports it.',
    );
  }

  const chosen = (requested === 'auto'
    ? autoSelectTransliterator(env)
    : requested) as 'local' | 'sarvam' | 'http';

  switch (chosen) {
    case 'local': {
      const p = new LocalHinglishTransliterator();
      if (!p.supports(language)) {
        throw new CaptionEngineError(
          `Roman output requested for "${language}", but the built-in transliterator only ` +
            `covers Devanagari languages (hi, mr, ne).`,
          `Options:\n` +
            `  • Use a model backend that covers ${language}:\n` +
            `      export SARVAM_API_KEY=...\n` +
            `      --transliterate sarvam\n` +
            `  • Point at your own service:\n` +
            `      export TRANSLITERATE_URL=https://...\n` +
            `      --transliterate http\n` +
            `  • Or drop --script roman to keep the native script.`,
        );
      }
      return p;
    }

    case 'sarvam': {
      const key = env.SARVAM_API_KEY;
      if (!key) {
        throw new CaptionEngineError(
          'Roman output requested with --transliterate sarvam, but SARVAM_API_KEY is not set.',
          `Set the key:\n` +
            `  export SARVAM_API_KEY="your-key"\n` +
            `Or use the offline engine (no key, Devanagari only):\n` +
            `  --transliterate local`,
        );
      }
      // Escape hatches for operators hitting a proxy with tighter limits or a
      // stricter rate limit than the public endpoint.
      return new SarvamTransliterator(key, {
        baseUrl: env.SARVAM_BASE_URL,
        maxChars: positiveInt(env.SARVAM_MAX_INPUT_CHARS),
        concurrency: positiveInt(env.SARVAM_CONCURRENCY),
        maxAttempts: positiveInt(env.SARVAM_MAX_ATTEMPTS),
        // Set by --roman-fallback native. Lets a single failed batch keep its
        // original script instead of failing a whole render, for the languages
        // Sarvam alone serves (kn, te, ta, ml, bn, gu, pa, or, as).
        allowNativeFallback: opts.allowNativeFallback ?? false,
      });
    }

    case 'http': {
      const url = env.TRANSLITERATE_URL;
      if (!url) {
        throw new CaptionEngineError(
          'Roman output requested with --transliterate http, but TRANSLITERATE_URL is not set.',
          `Set the endpoint:\n` +
            `  export TRANSLITERATE_URL="https://your-service/transliterate"\n` +
            `It must accept {tokens: string[], language: string} and return\n` +
            `{tokens: string[]} of the same length, in the same order.\n` +
            `Or use the offline engine:  --transliterate local`,
        );
      }
      const headers: Record<string, string> = {};
      if (env.TRANSLITERATE_TOKEN) headers.Authorization = `Bearer ${env.TRANSLITERATE_TOKEN}`;
      return new HttpTransliterator(url, headers);
    }

    default:
      throw new CaptionEngineError(
        `Unknown transliteration provider "${chosen}".`,
        `Valid: ${listTransliterators().join(', ')}`,
      );
  }
}

export { transliterateToken, hasDevanagari };
