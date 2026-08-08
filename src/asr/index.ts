import type { Transcript } from '../types.js';
import { AsrError, type AsrProvider } from './types.js';
import { ElevenLabsScribe } from './elevenlabs.js';
import { DeepgramNova } from './deepgram.js';
import { SarvamAI } from './sarvam.js';

export * from './types.js';
export { ElevenLabsScribe, DeepgramNova, SarvamAI };

export type ProviderName = 'elevenlabs' | 'deepgram' | 'sarvam';

/**
 * Build a provider from env. Keeping construction in one place means swapping
 * the primary provider is a config change, not a code change.
 *
 *   ASR_PROVIDER=elevenlabs
 *   ELEVENLABS_API_KEY=...
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  const name = (env.ASR_PROVIDER ?? 'elevenlabs') as ProviderName;
  switch (name) {
    case 'elevenlabs':
      return new ElevenLabsScribe(env.ELEVENLABS_API_KEY ?? '');
    case 'deepgram':
      return new DeepgramNova(env.DEEPGRAM_API_KEY ?? '');
    case 'sarvam':
      return new SarvamAI(env.SARVAM_API_KEY ?? '');
    default:
      throw new AsrError(`Unknown ASR_PROVIDER "${name}"`, 'registry');
  }
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

/**
 * Try providers in order until one succeeds. Use for resilience against a single
 * vendor's outage or rate limit — NOT as a quality strategy, since different
 * providers produce visibly different transcripts for the same audio.
 */
export async function transcribeWithFallback(
  providers: AsrProvider[],
  audio: Buffer | Uint8Array,
  opts?: Parameters<AsrProvider['transcribe']>[1],
): Promise<Transcript> {
  const errors: string[] = [];
  for (const p of providers) {
    try {
      return await p.transcribe(audio, opts);
    } catch (err) {
      const e = err as AsrError;
      errors.push(`${p.name}: ${e.message}`);
      // A non-retryable error (bad key, bad audio) will fail identically on the
      // next provider for auth reasons but not for audio reasons — so keep going
      // only when it's plausibly provider-specific.
      if (e instanceof AsrError && !e.retryable && e.status && e.status < 500 && e.status !== 429) {
        continue;
      }
    }
  }
  throw new AsrError(`All ASR providers failed:\n${errors.join('\n')}`, 'fallback');
}
