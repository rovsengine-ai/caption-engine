/**
 * Approach decision — local romanisation is a small LLM, with rules underneath.
 *
 * Whisper (Approach B) is the right local ASR because it returns word times.
 * It is the wrong transliterator: its Indic romanisation is not the way people
 * type Hinglish (बहुत should become "bahut", not a scholarly spelling).
 *
 * Shuka (Approach A) does not emit word times, so it cannot own this pipeline.
 * Fine-tuning (Approach C) is a later project, not a backend we can call today.
 *
 * This provider asks a local Ollama (or any OpenAI-compatible) model to
 * romanise Indic tokens the way people type them, one token in and one token
 * out. Latin tokens are never sent. If the model is down, or a batch cannot
 * be aligned, Devanagari and Kannada fall back to the built-in rule engines
 * in devanagari.ts and kannada.ts. Other scripts have no rule engine; those
 * fail loudly instead of returning a different number of tokens.
 *
 * Defaults: LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/api/generate
 *           LOCAL_LLM_MODEL=gemma3:4b
 * No API key.
 */

import { CaptionEngineError } from '../errors.js';
import { transliterateKannadaToken } from './kannada.js';
import { transliterateToken } from './devanagari.js';
import type { TransliterationProvider } from './providers.js';
import { isIndicScript } from './script-utils.js';

export const DEFAULT_LLM_ENDPOINT = 'http://127.0.0.1:11434/api/generate';
export const DEFAULT_LLM_MODEL = 'gemma3:4b';

/** The twelve Indic languages this project asks a model to romanise. */
export const LOCAL_LLM_LANGUAGES = [
  'hi', 'mr', 'ne', 'te', 'kn', 'ta', 'ml', 'bn', 'gu', 'pa', 'or', 'as',
] as const;

const DEVANAGARI_RULES = ['hi', 'mr', 'ne', 'sa', 'kok', 'mai'];

/**
 * How many words one prompt may carry.
 *
 * Alignment is the contract: the model must return exactly as many lines as
 * tokens. A short batch is a different, easier request, which is why a
 * mismatch is retried on halves rather than padded.
 */
const MAX_BATCH_WORDS = 12;

export class LocalLlmTransliterator implements TransliterationProvider {
  readonly name = 'local-llm';
  readonly description = 'Local LLM transliteration via Ollama (no API key needed)';
  readonly offline = true;
  readonly quality = 'model' as const;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  supports(language: string): boolean {
    const base = (language.split('-')[0] ?? '').toLowerCase();
    return (LOCAL_LLM_LANGUAGES as readonly string[]).includes(base);
  }

  async romanise(tokens: string[], language: string): Promise<string[]> {
    const out = [...tokens];
    const sendIndices: number[] = [];
    const sendTokens: string[] = [];
    tokens.forEach((t, i) => {
      if (isIndicScript(t)) {
        sendIndices.push(i);
        sendTokens.push(t);
      }
    });
    if (sendTokens.length === 0) return out;

    let converted: string[];
    try {
      converted = await this.convertAll(sendTokens, language);
    } catch (err) {
      const rules = rulesFor(sendTokens, language);
      if (rules) return place(out, sendIndices, rules);
      throw err;
    }

    if (converted.length !== sendTokens.length) {
      const rules = rulesFor(sendTokens, language);
      if (rules) return place(out, sendIndices, rules);
      throw new CaptionEngineError(
        `Local LLM returned ${converted.length} tokens for ${sendTokens.length} inputs.`,
        'Word timings would desynchronise. The model must return one romanisation per word.',
      );
    }

    const polished = converted.map((value, i) => {
      const src = sendTokens[i] ?? '';
      if (!value.trim() || isIndicScript(value)) {
        const one = rulesFor([src], language);
        return one?.[0] ?? src;
      }
      return value.trim();
    });
    return place(out, sendIndices, polished);
  }

  private endpoint(): string {
    const raw = (this.env.LOCAL_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT).trim();
    return normaliseLlmEndpoint(raw || DEFAULT_LLM_ENDPOINT);
  }

  private model(): string {
    return this.env.LOCAL_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  }

  private async convertAll(tokens: string[], language: string): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < tokens.length; i += MAX_BATCH_WORDS) {
      const batch = tokens.slice(i, i + MAX_BATCH_WORDS);
      out.push(...(await this.convertBatch(batch, language)));
    }
    return out;
  }

  private async convertBatch(tokens: string[], language: string): Promise<string[]> {
    if (tokens.length === 0) return [];
    try {
      const text = await this.complete(promptFor(tokens, language));
      const lines = parseRomanLines(text, tokens.length);
      if (lines) return lines;
    } catch (err) {
      // A down server will fail every split the same way. Surface it once so
      // romanise() can use the rule engine instead of issuing N more requests.
      if (isNetworkError(err) || tokens.length === 1) throw err;
    }

    if (tokens.length === 1) {
      throw new CaptionEngineError(
        'Local LLM could not romanise a single token.',
        'Check that Ollama is running (`npm run local:start`) and that ' +
          `${this.model()} is pulled.`,
      );
    }

    const mid = Math.ceil(tokens.length / 2);
    const left = await this.convertBatch(tokens.slice(0, mid), language);
    const right = await this.convertBatch(tokens.slice(mid), language);
    return [...left, ...right];
  }

  private async complete(prompt: string): Promise<string> {
    const endpoint = this.endpoint();
    const model = this.model();
    const openai = /\/v1\/|chat\/completions/i.test(endpoint);
    const body = openai
      ? {
          model,
          temperature: 0,
          stream: false,
          messages: [{ role: 'user', content: prompt }],
        }
      : {
          model,
          prompt,
          stream: false,
          options: { temperature: 0 },
        };

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new CaptionEngineError(
        `Local LLM is not reachable at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
        'Start Ollama with `npm run local:start`, or use `--transliterate local` for the offline rules.',
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new CaptionEngineError(
        `Local LLM request failed (${res.status}): ${errBody.slice(0, 300)}`,
        `Check LOCAL_LLM_MODEL (${model}) is pulled: ollama pull ${model}`,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new CaptionEngineError(
        'Local LLM returned non-JSON.',
        'LOCAL_LLM_ENDPOINT should be Ollama /api/generate or an OpenAI-compatible chat URL.',
      );
    }
    const text = completionText(data);
    if (!text.trim()) {
      throw new CaptionEngineError(
        'Local LLM returned an empty romanisation.',
        'Try a larger LOCAL_LLM_MODEL, or `--transliterate local` for Devanagari and Kannada.',
      );
    }
    return text;
  }
}

/** Accept a bare Ollama origin or the full generate URL. */
export function normaliseLlmEndpoint(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      return `${url.origin}/api/generate`;
    }
    return trimmed;
  } catch {
    return DEFAULT_LLM_ENDPOINT;
  }
}

export function promptFor(tokens: string[], language: string): string {
  const lines = tokens.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return [
    'Transliterate each Indic word into the Roman spelling people actually type.',
    'This is not translation and not scholarly transliteration (not IAST, not ISO 15919).',
    'Hindi examples: बहुत → bahut, आज → aaj, समझना → samajhna, क्या → kya, है → hai.',
    'Keep English loanwords in the spelling people type when the script is Indic.',
    `Source language: ${language}.`,
    `Return EXACTLY ${tokens.length} lines, in the same order, one romanised word per line.`,
    'No numbering, no bullets, no commentary, no blank lines.',
    '',
    lines,
  ].join('\n');
}

/** Pull exactly `expected` romanised words out of a model reply, or null. */
export function parseRomanLines(text: string, expected: number): string[] | null {
  const stripped = text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '');
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^here (are|is)\b/i.test(line))
    .map((line) => line.replace(/^\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .map((line) => line.replace(/^["']|["']$/g, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length !== expected) return null;
  return lines;
}

/**
 * Rule engine for one language, or null when this script has none.
 *
 * Mirrors offlineEngineFor() in providers.ts without importing it — that
 * import would cycle, because the registry constructs this class.
 */
function rulesFor(tokens: string[], language: string): string[] | null {
  const base = (language.split('-')[0] ?? '').toLowerCase();
  if (DEVANAGARI_RULES.includes(base)) return tokens.map((t) => transliterateToken(t));
  if (base === 'kn') return tokens.map((t) => transliterateKannadaToken(t));
  return null;
}

function place(out: string[], indices: number[], converted: string[]): string[] {
  indices.forEach((src, k) => {
    const value = converted[k];
    if (typeof value === 'string' && value.length > 0) out[src] = value;
  });
  return out;
}

function completionText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;
  if (typeof rec.response === 'string') return rec.response;
  const choices = rec.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const message = (choices[0] as Record<string, unknown>).message;
    if (message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
  }
  return '';
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof CaptionEngineError)) return false;
  return /not reachable|ECONNREFUSED|fetch failed|network/i.test(err.message);
}
