import type { Transcript } from '../types.js';
import { MissingApiKeyError } from '../errors.js';
import { AsrError, type AsrProvider, type TranscribeOptions } from './types.js';
import { ElevenLabsScribe } from './elevenlabs.js';
import { DeepgramNova } from './deepgram.js';
import { SarvamAI } from './sarvam.js';

export * from './types.js';
export { ElevenLabsScribe, DeepgramNova, SarvamAI };

export type ProviderName = 'elevenlabs' | 'deepgram' | 'sarvam';

/**
 * UI / CLI provider modes.
 * `sarvam_fallback_elevenlabs` tries Sarvam first (Indic/Hinglish), then
 * ElevenLabs Scribe when Sarvam fails or cannot supply word timings.
 */
export type ProviderMode = ProviderName | 'sarvam_fallback_elevenlabs';

export const PROVIDER_MODES: ProviderMode[] = [
  'sarvam_fallback_elevenlabs',
  'sarvam',
  'elevenlabs',
  'deepgram',
];

/** Default when ASR_PROVIDER / --provider is unset. */
export const DEFAULT_PROVIDER_MODE: ProviderMode = 'sarvam_fallback_elevenlabs';

export function isProviderMode(value: string): value is ProviderMode {
  return (PROVIDER_MODES as string[]).includes(value);
}

function constructProvider(name: ProviderName, env: NodeJS.ProcessEnv): AsrProvider {
  switch (name) {
    case 'elevenlabs':
      return new ElevenLabsScribe(env.ELEVENLABS_API_KEY ?? '');
    case 'deepgram':
      return new DeepgramNova(env.DEEPGRAM_API_KEY ?? '');
    case 'sarvam':
      return new SarvamAI(env.SARVAM_API_KEY ?? '');
    default: {
      const _exhaustive: never = name;
      throw new AsrError(`Unknown ASR provider "${String(_exhaustive)}"`, 'registry');
    }
  }
}

/** Merge optional per-request web UI keys over process.env (never mutates the base). */
export function envWithApiKeys(
  base: NodeJS.ProcessEnv,
  keys?: {
    sarvamApiKey?: string;
    elevenlabsApiKey?: string;
    deepgramApiKey?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const sarvam = keys?.sarvamApiKey?.trim();
  const eleven = keys?.elevenlabsApiKey?.trim();
  const deepgram = keys?.deepgramApiKey?.trim();
  if (sarvam) env.SARVAM_API_KEY = sarvam;
  if (eleven) env.ELEVENLABS_API_KEY = eleven;
  if (deepgram) env.DEEPGRAM_API_KEY = deepgram;
  return env;
}

/**
 * Build a single provider from env.
 *
 * Default is Sarvam (Indic/Hinglish). For captioning with automatic ElevenLabs
 * fallback, prefer {@link resolveProviderChain} / {@link DEFAULT_PROVIDER_MODE}.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  const raw = (env.ASR_PROVIDER ?? 'sarvam').toLowerCase();
  // Chain mode resolves to the primary (Sarvam) for callers that expect one provider.
  const name = (raw === 'sarvam_fallback_elevenlabs' ? 'sarvam' : raw) as ProviderName;
  if (name !== 'elevenlabs' && name !== 'deepgram' && name !== 'sarvam') {
    throw new AsrError(
      `Unknown ASR_PROVIDER "${raw}"`,
      'registry',
    );
  }
  return constructProvider(name, env);
}

/** Try to construct a provider; return null if the API key is missing. */
export function tryProvider(name: ProviderName, env: NodeJS.ProcessEnv = process.env): AsrProvider | null {
  try {
    return constructProvider(name, env);
  } catch (err) {
    if (err instanceof MissingApiKeyError) return null;
    throw err;
  }
}

/**
 * Resolve an ordered provider chain for transcription.
 *
 * Missing API keys skip that slot (with no throw) so fallback can continue.
 */
export function resolveProviderChain(
  requested?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { mode: ProviderMode; providers: AsrProvider[]; skipped: string[] } {
  const raw = (requested ?? env.ASR_PROVIDER ?? DEFAULT_PROVIDER_MODE).toLowerCase();
  if (!isProviderMode(raw)) {
    throw new AsrError(
      `Unknown ASR provider "${raw}"`,
      'registry',
    );
  }

  const mode = raw;
  const names: ProviderName[] =
    mode === 'sarvam_fallback_elevenlabs' ? ['sarvam', 'elevenlabs'] : [mode];

  const providers: AsrProvider[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const p = tryProvider(name, env);
    if (p) providers.push(p);
    else skipped.push(name);
  }

  if (providers.length === 0) {
    const needed = names.map((n) => {
      if (n === 'sarvam') return 'SARVAM_API_KEY';
      if (n === 'elevenlabs') return 'ELEVENLABS_API_KEY';
      return 'DEEPGRAM_API_KEY';
    });
    // Pass a human label — never surface internal mode ids like sarvam_fallback_elevenlabs.
    throw new MissingApiKeyError(
      names.length > 1 ? 'sarvam or elevenlabs' : names[0]!,
      needed.join(' or '),
    );
  }

  return { mode, providers, skipped };
}

/**
 * Gate for anything that needs real per-word timings — captions and Auto Trim.
 * Call this before rendering rather than discovering the problem in the output.
 */
export function assertWordTimings(t: Transcript): void {
  if (!t.hasWordTimings) {
    throw new AsrError(
      `Provider "${t.provider}" did not return real per-word timestamps. ` +
        `Word-timed captions and Auto Trim require them. ` +
        (t.warnings?.join(' ') ?? ''),
      t.provider,
    );
  }
}

export interface FallbackHooks {
  /** Called when a provider fails and another will be tried. */
  onFallback?: (from: string, to: string, reason: string) => void;
  /**
   * When true (default), a successful response without word timings is treated
   * as a failure so the next provider in the chain can run. Critical for
   * Sarvam → ElevenLabs: Sarvam's REST API only returns chunk timings.
   */
  requireWordTimings?: boolean;
}

/**
 * Try providers in order until one succeeds. Use for resilience against a single
 * vendor's outage or rate limit — NOT as a quality strategy, since different
 * providers produce visibly different transcripts for the same audio.
 */
export async function transcribeWithFallback(
  providers: AsrProvider[],
  audio: Buffer | Uint8Array,
  opts?: TranscribeOptions,
  hooks: FallbackHooks = {},
): Promise<Transcript> {
  const requireWordTimings = hooks.requireWordTimings !== false;
  const errors: string[] = [];

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!;
    const next = providers[i + 1];
    try {
      const transcript = await p.transcribe(audio, opts);
      if (requireWordTimings && !transcript.hasWordTimings) {
        const reason =
          `${p.name} returned no per-word timestamps` +
          (transcript.warnings?.length ? ` (${transcript.warnings.join('; ')})` : '');
        errors.push(`${p.name}: ${reason}`);
        if (next) {
          hooks.onFallback?.(p.name, next.name, reason);
          continue;
        }
        throw new AsrError(reason, p.name);
      }
      return transcript;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${p.name}: ${message}`);
      if (!next) break;

      // Keep going for provider-specific failures (auth, rate limit, 5xx, missing key).
      // Bad audio (4xx that isn't 429) may fail on every vendor — still try the next
      // one once; word-timing providers sometimes accept files others reject.
      const e = err as AsrError;
      const reason = message;
      hooks.onFallback?.(p.name, next.name, reason);
      if (e instanceof AsrError && !e.retryable && e.status && e.status < 500 && e.status !== 429) {
        continue;
      }
    }
  }

  throw new AsrError(`All ASR providers failed:\n${errors.join('\n')}`, 'fallback');
}
