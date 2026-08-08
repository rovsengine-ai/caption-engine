import type { LlmComplete } from './score.js';
import { CaptionEngineError } from '../errors.js';

/**
 * Minimal Anthropic Messages API client for clip scoring.
 *
 * Deliberately dependency-free — this is one POST, and the clip finder takes an
 * injected `LlmComplete`, so swapping in another provider means writing a
 * function of the same shape rather than changing any core code.
 */
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
      const body = await res.text().catch(() => '');
      throw new CaptionEngineError(
        `Clip scoring request failed (${res.status}): ${body.slice(0, 300)}`,
        res.status === 401
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
