import { ffmpeg } from './ffmpeg.js';
import type { MediaInfo } from './probe.js';

/**
 * Audio extraction for ASR.
 *
 * Always send AUDIO to the ASR, never the original video: it is 10-100x smaller,
 * uploads faster, costs less, and every provider decodes it the same way.
 *
 * 16 kHz mono PCM is the near-universal ASR input format. Downmixing to mono is
 * deliberate — stereo doubles the payload for no accuracy gain on speech, and
 * some providers silently use only the left channel, which loses a speaker
 * recorded hard-right.
 */

export interface ExtractOptions {
  sampleRate?: number;
  channels?: number;
  /** 'wav' (PCM, universally accepted) or 'flac' (lossless, ~50% smaller). */
  format?: 'wav' | 'flac';
  /** Normalise loudness. Helps ASR on very quiet phone recordings. */
  normalize?: boolean;
  startSec?: number;
  durationSec?: number;
}

export function buildExtractArgs(
  inputPath: string,
  outputPath: string,
  opts: ExtractOptions = {},
): string[] {
  const {
    sampleRate = 16_000,
    channels = 1,
    format = 'wav',
    normalize = false,
    startSec,
    durationSec,
  } = opts;

  const args = ['-y', '-hide_banner'];
  // -ss BEFORE -i is the fast seek; accurate enough for whole-file extraction
  // and dramatically quicker on long files.
  if (startSec !== undefined && startSec > 0) args.push('-ss', String(startSec));
  args.push('-i', inputPath);
  if (durationSec !== undefined) args.push('-t', String(durationSec));

  args.push('-vn', '-sn', '-dn'); // drop video, subtitles, data streams
  args.push('-map', '0:a:0?');    // first audio stream, tolerate absence

  if (normalize) {
    // EBU R128 two-pass would be better but needs an analysis pass; single-pass
    // dynaudnorm is enough to rescue a quiet recording for ASR purposes.
    args.push('-af', 'dynaudnorm=f=200:g=15');
  }

  args.push('-ac', String(channels), '-ar', String(sampleRate));
  args.push('-c:a', format === 'flac' ? 'flac' : 'pcm_s16le');
  args.push(outputPath);
  return args;
}

export async function extractAudio(
  inputPath: string,
  outputPath: string,
  opts: ExtractOptions = {},
): Promise<string> {
  await ffmpeg(buildExtractArgs(inputPath, outputPath, opts), { timeoutMs: 30 * 60_000 });
  return outputPath;
}

/**
 * Decide whether the file can be sent to the ASR as-is.
 *
 * Even for audio input we normally re-encode, because a 48 kHz stereo MP3 is
 * larger and slower to upload than the 16 kHz mono WAV the provider wants.
 */
export function needsExtraction(info: MediaInfo, targetRate = 16_000): boolean {
  if (info.hasVideo) return true;
  const a = info.streams.find((s) => s.type === 'audio');
  if (!a) return true;
  if (a.codec !== 'pcm_s16le') return true;
  if ((a.channels ?? 2) !== 1) return true;
  if ((a.sampleRate ?? 0) !== targetRate) return true;
  return false;
}
