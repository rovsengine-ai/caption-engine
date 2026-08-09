import { createHash } from 'node:crypto';
import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Input and configuration fingerprints.
 *
 * The failure this exists to prevent:
 *
 *   1. You caption `my-video.mp4` and save `transcript.json`.
 *   2. You re-export the video from your editor — same filename, new content.
 *   3. You render again with `--transcript-in transcript.json`.
 *   4. Captions are from take 1, video is take 2, and nothing warns you.
 *
 * Filenames and mtimes are not identity. Content is. Every cached artifact
 * carries a fingerprint of the input it was derived from plus a hash of the
 * options that shaped it, and is refused when either fails to match.
 */

export const FINGERPRINT_VERSION = 1;

export interface InputFingerprint {
  /** Schema version, so an old artifact can be recognised rather than misread. */
  v: number;
  /** sha256 of the file's bytes (or of sampled regions in fast mode — see `mode`). */
  sha256: string;
  /** 'full' hashes every byte; 'sampled' hashes size + head/middle/tail blocks. */
  mode: 'full' | 'sampled';
  sizeBytes: number;
  /** Container duration in seconds, when the caller knows it. */
  durationSec?: number;
  /** Informational only — never used for matching. */
  name: string;
}

const SAMPLE_BLOCK = 8 * 1024 * 1024; // 8 MiB per sampled region

/**
 * Hash a file.
 *
 * Full hashing is the default because it is the only mode that cannot be
 * fooled by a re-encode that happens to land on the same byte count. It costs
 * roughly a second per GB on an SSD. Set `CAPTION_ENGINE_FAST_HASH=1` to hash
 * size + head/middle/tail instead — much faster on very large files, and
 * strong enough in practice, but no longer a true content hash.
 */
export async function hashFile(
  path: string,
  opts: { mode?: 'full' | 'sampled' } = {},
): Promise<{ sha256: string; mode: 'full' | 'sampled'; sizeBytes: number }> {
  const st = statSync(path);
  const mode =
    opts.mode ?? (process.env.CAPTION_ENGINE_FAST_HASH === '1' ? 'sampled' : 'full');

  if (mode === 'sampled') {
    return { sha256: sampledHash(path, st.size), mode, sizeBytes: st.size };
  }

  const h = createHash('sha256');
  await new Promise<void>((res, rej) => {
    const s = createReadStream(path);
    s.on('data', (c) => h.update(c));
    s.on('error', rej);
    s.on('end', () => res());
  });
  return { sha256: h.digest('hex'), mode, sizeBytes: st.size };
}

function sampledHash(path: string, size: number): string {
  const h = createHash('sha256');
  h.update(`size:${size}`);
  const fd = openSync(path, 'r');
  try {
    const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_BLOCK / 2), Math.max(0, size - SAMPLE_BLOCK)];
    const buf = Buffer.allocUnsafe(SAMPLE_BLOCK);
    for (const off of offsets) {
      if (off >= size) continue;
      const n = readSync(fd, buf, 0, Math.min(SAMPLE_BLOCK, size - off), off);
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** Fingerprint an input media file. */
export async function fingerprintInput(
  path: string,
  opts: { durationSec?: number; mode?: 'full' | 'sampled' } = {},
): Promise<InputFingerprint> {
  const { sha256, mode, sizeBytes } = await hashFile(path, { mode: opts.mode });
  return {
    v: FINGERPRINT_VERSION,
    sha256,
    mode,
    sizeBytes,
    ...(opts.durationSec !== undefined ? { durationSec: round(opts.durationSec) } : {}),
    name: basename(path),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Configuration hashing
// ---------------------------------------------------------------------------

/**
 * Stable stringify: object keys sorted at every depth, so `{a,b}` and `{b,a}`
 * hash identically. Undefined values are dropped, matching JSON semantics.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 of the stable serialisation, truncated to 16 hex chars for readability. */
export function configHash(config: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16);
}

/**
 * The options that change what a *transcript* contains.
 *
 * Deliberately narrow. Styling, aspect ratio and output path do not belong
 * here — changing them must not invalidate a transcript you paid for. Getting
 * this set wrong in the permissive direction risks stale data; getting it
 * wrong in the strict direction just costs another ASR call, so when in doubt
 * a field is included.
 */
export function transcriptConfigHash(o: {
  provider?: string;
  language?: string;
  codeSwitching?: boolean;
  keyterms?: string[];
  model?: string;
}): string {
  return configHash({
    provider: o.provider ?? null,
    language: o.language ?? null,
    codeSwitching: o.codeSwitching ?? false,
    keyterms: [...(o.keyterms ?? [])].sort(),
    model: o.model ?? null,
  });
}

/** The options that change which *cuts* Auto Trim proposes. */
export function cutsConfigHash(o: {
  trimSilence?: number;
  keepFillers?: boolean;
  language?: string;
  lowConfidenceThreshold?: number;
  /** Whether waveform evidence was measured. Changes which cuts are proposed. */
  audioAnalysis?: boolean;
  /** Pass 2 propose-cut vs review-required threshold. */
  fillerConfidence?: number | null;
}): string {
  return configHash({
    trimSilence: o.trimSilence ?? null,
    keepFillers: o.keepFillers ?? false,
    language: o.language ?? null,
    lowConfidenceThreshold: o.lowConfidenceThreshold ?? null,
    // A cut list produced with measured audio is not interchangeable with one
    // produced from ASR gaps alone: same input, same flags otherwise, different
    // proposals. Reusing one for the other is exactly the stale-cache bug the
    // fingerprint exists to prevent, so both settings belong in the key.
    audioAnalysis: o.audioAnalysis ?? null,
    fillerConfidence: o.fillerConfidence ?? null,
  });
}

// ---------------------------------------------------------------------------
// Stamping and verification
// ---------------------------------------------------------------------------

/** Metadata block attached to every cached artifact under the `_engine` key. */
export interface ArtifactStamp {
  v: number;
  kind: 'transcript' | 'cuts' | 'analysis';
  input: InputFingerprint;
  configHash: string;
  createdAt: string;
}

export function makeStamp(
  kind: ArtifactStamp['kind'],
  input: InputFingerprint,
  cfgHash: string,
): ArtifactStamp {
  return {
    v: FINGERPRINT_VERSION,
    kind,
    input,
    configHash: cfgHash,
    createdAt: new Date().toISOString(),
  };
}

export type StampVerdict =
  | { ok: true }
  | { ok: false; code: 'unstamped'; detail: string }
  | { ok: false; code: 'input-changed'; detail: string }
  | { ok: false; code: 'config-changed'; detail: string }
  | { ok: false; code: 'version'; detail: string };

/**
 * Decide whether a stamped artifact may be reused for this input and config.
 *
 * An artifact with **no** stamp is reported as `unstamped` rather than
 * rejected: files produced by earlier versions of this tool are still valid,
 * and refusing them outright would be a breaking change. The caller decides
 * whether to warn or fail.
 */
export function verifyStamp(
  stamp: ArtifactStamp | undefined | null,
  current: InputFingerprint,
  cfgHash: string,
): StampVerdict {
  if (!stamp || typeof stamp !== 'object' || !stamp.input) {
    return {
      ok: false,
      code: 'unstamped',
      detail: 'file carries no input fingerprint (written by an older version)',
    };
  }
  if (stamp.v !== FINGERPRINT_VERSION) {
    return { ok: false, code: 'version', detail: `stamp version ${stamp.v}, expected ${FINGERPRINT_VERSION}` };
  }

  const a = stamp.input;
  // Compare hashes only when both sides were produced the same way.
  if (a.mode === current.mode && a.sha256 !== current.sha256) {
    return {
      ok: false,
      code: 'input-changed',
      detail:
        `content hash differs (cached ${a.sha256.slice(0, 12)}…, current ${current.sha256.slice(0, 12)}…)`,
    };
  }
  if (a.sizeBytes !== current.sizeBytes) {
    return {
      ok: false,
      code: 'input-changed',
      detail: `file size differs (cached ${a.sizeBytes} bytes, current ${current.sizeBytes} bytes)`,
    };
  }
  if (
    a.durationSec !== undefined &&
    current.durationSec !== undefined &&
    Math.abs(a.durationSec - current.durationSec) > 0.05
  ) {
    return {
      ok: false,
      code: 'input-changed',
      detail: `duration differs (cached ${a.durationSec}s, current ${current.durationSec}s)`,
    };
  }
  if (stamp.configHash !== cfgHash) {
    return {
      ok: false,
      code: 'config-changed',
      detail: `options differ (cached ${stamp.configHash}, current ${cfgHash})`,
    };
  }
  return { ok: true };
}

/** Human-readable explanation plus the flag that overrides the refusal. */
export function explainVerdict(v: Exclude<StampVerdict, { ok: true }>, file: string): string {
  const head = `${file} does not match this input.`;
  const why = `Reason: ${v.detail}`;
  const fix =
    v.code === 'input-changed'
      ? 'The media file changed since this was created — most likely you re-exported it under the same name.\n' +
        'Re-run without --transcript-in / --cuts-in to regenerate, or pass --allow-stale to use it anyway.'
      : v.code === 'config-changed'
        ? 'The options that shaped this file differ from the ones you just passed.\n' +
          'Re-run to regenerate, or pass --allow-stale to use it anyway.'
        : 'Regenerate the file, or pass --allow-stale to use it as-is.';
  return `${head}\n${why}\n${fix}`;
}
