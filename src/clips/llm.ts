import type { LlmComplete } from './score.js';
import { CaptionEngineError } from '../errors.js';

/**
 * Minimal Anthropic Messages API client for clip scoring.
 *
 * Deliberately dependency-free — this is one POST, and the clip finder takes an
 * injected `LlmComplete`, so swapping in another provider means writing a
 * function of the same shape rather than changing any core code.
 */
/**
 * Pull a short, human-readable reason out of an error response.
 *
 * Only the provider's structured `error.message` is used, capped and stripped
 * of anything token-shaped. If the body is not the expected JSON, nothing is
 * reported beyond the status code — an opaque error is better than one that
 * might carry a credential.
 */
export async function safeErrorDetail(res: {
  text(): Promise<string>;
}): Promise<string> {
  const body = await res.text().catch(() => '');
  if (!body) return '';
  let msg: unknown;
  try {
    msg = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
  } catch {
    return '';
  }
  if (typeof msg !== 'string') return '';
  return msg
    // Anything long and token-shaped goes, whatever provider invented it.
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .slice(0, 200)
    .trim();
}

export function makeAnthropicCompletion(
  apiKey: string,
  model = 'claude-sonnet-4-5',
): LlmComplete {
  return async (prompt: string): Promise<string> => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      // Never interpolate a raw provider body into an error.
      //
      // A rejected request can echo the credential back — some gateways include
      // the offending header in their 401 payload. The CLI redacts secrets
      // before printing, but constructing the string at all means it can reach
      // a log file, a --json consumer, or a bug report that skips that path.
      // Take the provider's own message field if it looks safe, nothing else.
      const detail = await safeErrorDetail(res);
      throw new CaptionEngineError(
        `Clip scoring request failed (${res.status}${detail ? `: ${detail}` : ''}).`,
        res.status === 401 || res.status === 403
          ? 'Check ANTHROPIC_API_KEY.'
          : 'Retry, or omit --clips to skip clip detection.',
      );
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  };
}
