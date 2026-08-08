/**
 * Request batching for transliteration backends with a request-size limit.
 *
 * Sarvam rejects `body.input` longer than 1000 characters:
 *
 *     body.input: String should have at most 1000 characters
 *
 * A 2,339-entry transcript joins to ~13,000 characters, so a single request is
 * never going to work. This module splits the token list into batches that fit,
 * and — critically — keeps a mapping from every batch slot back to the exact
 * index of the original word, because word timings hang off those indices. A
 * batching bug here does not look like a crash; it looks like captions that
 * drift out of sync halfway through the video, which is much worse.
 *
 * Invariants, all asserted by tests:
 *   1. Every input index appears in exactly one batch. No loss, no duplication.
 *   2. Batch order and within-batch order follow the original token order.
 *   3. A word is NEVER split across batches.
 *   4. Every batch's joined `input` is <= the budget.
 *   5. Concatenating all batch index lists reproduces the input index list.
 *
 * Size is measured in UTF-16 code units (JavaScript `String.length`), which is
 * always >= the Unicode code-point count that Python/pydantic uses for
 * `max_length` on the server. For Indic and Latin text the two are identical;
 * for astral characters ours is larger, which only makes batches smaller. It is
 * never smaller than the server's count, so it can never under-estimate.
 */

/** Sarvam's documented hard limit on `body.input`. */
export const SARVAM_HARD_LIMIT = 1000;

/** What we actually aim for, leaving headroom under the hard limit. */
export const DEFAULT_MAX_BATCH_CHARS = 900;

/** Joined between tokens in one request; also the split point on the way back. */
export const DEFAULT_SEPARATOR = ' | ';

export interface BatchOptions {
  /** Hard cap on the joined `input` string, in UTF-16 code units. */
  maxChars?: number;
  separator?: string;
}

export interface TokenBatch {
  /** Positions in the array handed to `planBatches`. Order preserved. */
  indices: number[];
  tokens: string[];
  /** Exactly what goes into `body.input`. */
  input: string;
  /**
   * True when this batch holds a single token that is itself over budget, or a
   * token containing the separator. Such a batch is sent alone — there is no
   * separator to confuse, so the response needs no splitting — and if it is
   * still over the limit the caller must fall back rather than truncate.
   */
  singleton: boolean;
  /** Over budget even as a lone token. Cannot be sent; caller must fall back. */
  oversize: boolean;
}

/** UTF-16 code units. See the module comment for why this is the safe measure. */
export function measure(s: string): number {
  return s.length;
}

/** Code points — what pydantic's `max_length` counts on the server. */
export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * A token that contains the separator (or a newline) would make the response
 * un-splittable: we would count more pieces than we sent and desynchronise.
 * Such tokens are sent alone instead of being rewritten — mangling the input to
 * suit our transport would corrupt the caption.
 */
function separatorUnsafe(token: string, separator: string): boolean {
  const core = separator.trim() || separator;
  return token.includes(core) || /[\r\n]/.test(token);
}

/**
 * Group tokens into requests that fit the budget.
 *
 * `indices` lets the caller pass a subset of a larger array (only the Indic
 * tokens, say) while still tracking where each one came from. When omitted the
 * positions are 0..n-1.
 */
export function planBatches(
  tokens: string[],
  indices?: number[],
  opts: BatchOptions = {},
): TokenBatch[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_BATCH_CHARS;
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  const idx = indices ?? tokens.map((_, i) => i);

  if (idx.length !== tokens.length) {
    throw new Error(
      `planBatches: ${tokens.length} tokens but ${idx.length} indices. ` +
        `These must correspond one-to-one.`,
    );
  }
  if (maxChars <= 0) throw new Error('planBatches: maxChars must be positive.');

  const batches: TokenBatch[] = [];
  let curTokens: string[] = [];
  let curIndices: number[] = [];
  let curLen = 0;

  const flush = (): void => {
    if (curTokens.length === 0) return;
    batches.push({
      indices: curIndices,
      tokens: curTokens,
      input: curTokens.join(separator),
      singleton: curTokens.length === 1,
      oversize: false,
    });
    curTokens = [];
    curIndices = [];
    curLen = 0;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    const at = idx[k]!;
    const tokLen = measure(tok);

    // A token that cannot share a request goes out on its own, in order.
    if (separatorUnsafe(tok, separator) || tokLen > maxChars) {
      flush();
      batches.push({
        indices: [at],
        tokens: [tok],
        input: tok,
        singleton: true,
        // Over budget even alone: unsendable. Never truncated — a half word is
        // a wrong word, and the caller has a working offline fallback.
        oversize: tokLen > maxChars,
      });
      continue;
    }

    // Cost of appending: the separator only exists between tokens.
    const added = curTokens.length === 0 ? tokLen : separator.length + tokLen;
    if (curTokens.length > 0 && curLen + added > maxChars) flush();

    curIndices.push(at);
    curTokens.push(tok);
    curLen = curTokens.length === 1 ? tokLen : curLen + separator.length + tokLen;
  }
  flush();

  // Belt and braces: prove the invariants before anything hits the network.
  assertBatchPlan(batches, idx, maxChars);
  return batches;
}

/**
 * Verify a plan against its input. Exported so tests can check arbitrary plans,
 * and called on every plan because a silent desync is the failure mode that
 * would otherwise reach the user as drifting captions.
 */
export function assertBatchPlan(
  batches: TokenBatch[],
  expectedIndices: number[],
  maxChars: number,
): void {
  const flat = batches.flatMap((b) => b.indices);
  if (flat.length !== expectedIndices.length) {
    throw new Error(
      `Batch plan covers ${flat.length} tokens but ${expectedIndices.length} were supplied.`,
    );
  }
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] !== expectedIndices[i]) {
      throw new Error(
        `Batch plan reordered tokens at position ${i}: ` +
          `expected index ${expectedIndices[i]}, got ${flat[i]}.`,
      );
    }
  }
  for (const b of batches) {
    if (b.indices.length !== b.tokens.length) {
      throw new Error('Batch plan has mismatched indices and tokens.');
    }
    if (!b.oversize && measure(b.input) > maxChars) {
      throw new Error(
        `Batch of ${b.tokens.length} token(s) is ${measure(b.input)} chars, over the ${maxChars} budget.`,
      );
    }
  }
}

/**
 * Split a batch response back into tokens.
 *
 * A singleton batch was sent with no separator, so the whole response is the
 * token — splitting it would shatter any output that happens to contain a pipe.
 * Otherwise we split on the separator's core character and trim, which tolerates
 * the model altering the spacing around it.
 *
 * Returns null when the count does not match, so the caller can retry or fall
 * back. It deliberately does not pad or truncate to fit: a plausible-looking
 * wrong-length result is exactly how timings desynchronise.
 */
export function splitBatchResponse(
  text: string,
  batch: TokenBatch,
  separator: string = DEFAULT_SEPARATOR,
): string[] | null {
  if (batch.singleton) return [text.trim()];

  const core = separator.trim() || separator;
  const parts = text.split(core).map((s) => s.trim());
  if (parts.length !== batch.tokens.length) return null;
  return parts;
}

/**
 * Run `worker` over the batches with a bounded number in flight, returning
 * results in batch order regardless of completion order.
 *
 * Concurrency is capped because these APIs rate-limit, and a burst of 30
 * simultaneous requests is the fastest way to turn a working feature into a
 * wall of 429s.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(limit));
  const out = new Array<R>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(n, items.length) }, runner));
  return out;
}
