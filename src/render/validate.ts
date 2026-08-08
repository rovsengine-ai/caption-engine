import { existsSync, statSync, renameSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FFPROBE, run } from '../media/ffmpeg.js';
import { CaptionEngineError } from '../errors.js';

/**
 * Output validation and atomic publish.
 *
 * WHY THIS EXISTS — a real failure this project shipped.
 *
 * FFmpeg wrote the output file incrementally, so when a render died partway the
 * user was left with a 0-byte (or headerless) .mp4 sitting at the requested
 * path. It LOOKS like a result. Opening it gives:
 *
 *     moov atom not found
 *     Invalid data found when processing input
 *
 * which sends people off debugging a "corrupt video" when the real story is
 * that the render never finished. An output file must therefore be all-or-
 * nothing: render to a temporary name, PROVE the file is playable, and only
 * then move it into place.
 */

export interface ValidationExpectation {
  /** Require a video stream. */
  video?: boolean;
  /** Require an audio stream. */
  audio?: boolean;
  expectedWidth?: number;
  expectedHeight?: number;
  /** Duration must be within this many seconds of the expectation. */
  expectedDurationSec?: number;
  durationToleranceSec?: number;
  /** Require yuv420p (needed for QuickTime / social playback). */
  requireYuv420p?: boolean;
}

export interface MediaValidation {
  ok: boolean;
  path: string;
  sizeBytes: number;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
  problems: string[];
}

/**
 * Validate a rendered file with ffprobe.
 *
 * Deliberately checks the things that distinguish "a file exists" from "a file
 * plays": non-zero size, readable container (a missing moov atom fails here), a
 * positive duration, the streams we expect, and yuv420p.
 */
export async function validateMedia(
  path: string,
  expect: ValidationExpectation = {},
): Promise<MediaValidation> {
  const problems: string[] = [];
  const base: MediaValidation = {
    ok: false, path, sizeBytes: 0, durationSec: 0,
    hasVideo: false, hasAudio: false, problems,
  };

  if (!existsSync(path)) {
    problems.push('file does not exist');
    return base;
  }

  const sizeBytes = statSync(path).size;
  base.sizeBytes = sizeBytes;
  if (sizeBytes === 0) {
    // The signature of a render that died before writing anything.
    problems.push('file is 0 bytes — the encoder produced no output');
    return base;
  }
  if (sizeBytes < 1024) {
    problems.push(`file is only ${sizeBytes} bytes — almost certainly truncated`);
  }

  const res = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams', '-show_format',
    path,
  ], { timeoutMs: 120_000 });

  if (res.code !== 0) {
    const err = res.stderr.trim().split('\n').pop() ?? 'unknown';
    // "moov atom not found" lands here: the container header was never written.
    problems.push(`ffprobe could not read the file: ${err}`);
    return base;
  }

  let j: {
    streams?: Array<{
      codec_type?: string; codec_name?: string; width?: number; height?: number;
      pix_fmt?: string; duration?: string;
    }>;
    format?: { duration?: string };
  };
  try {
    j = JSON.parse(res.stdout);
  } catch {
    problems.push('ffprobe returned unparseable output');
    return base;
  }

  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  const durationSec = Number(j.format?.duration ?? 0);

  Object.assign(base, {
    durationSec,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    width: v?.width,
    height: v?.height,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    pixFmt: v?.pix_fmt,
  });

  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    problems.push(`invalid duration (${j.format?.duration ?? 'missing'})`);
  }
  if (expect.video && !v) problems.push('no video stream');
  if (expect.audio && !a) problems.push('no audio stream — audio was lost during render');
  if (expect.expectedWidth && v?.width !== expect.expectedWidth) {
    problems.push(`width ${v?.width} ≠ expected ${expect.expectedWidth}`);
  }
  if (expect.expectedHeight && v?.height !== expect.expectedHeight) {
    problems.push(`height ${v?.height} ≠ expected ${expect.expectedHeight}`);
  }
  if (expect.requireYuv420p && v && v.pix_fmt !== 'yuv420p') {
    problems.push(`pixel format ${v.pix_fmt} — QuickTime and most social platforms need yuv420p`);
  }
  if (expect.expectedDurationSec !== undefined) {
    const tol = expect.durationToleranceSec ?? 1.0;
    if (Math.abs(durationSec - expect.expectedDurationSec) > tol) {
      problems.push(
        `duration ${durationSec.toFixed(2)}s differs from expected ` +
          `${expect.expectedDurationSec.toFixed(2)}s by more than ${tol}s`,
      );
    }
  }

  base.ok = problems.length === 0;
  return base;
}

/**
 * A staged output: render here, then publish atomically.
 *
 * `tempPath` sits in the SAME directory as the final file so the rename is a
 * cheap same-filesystem move rather than a copy that could itself fail halfway.
 */
export class AtomicOutput {
  readonly tempPath: string;
  private published = false;

  constructor(readonly finalPath: string, readonly inputPath?: string) {
    const dir = dirname(resolve(finalPath));
    mkdirSync(dir, { recursive: true });

    if (inputPath && resolve(inputPath) === resolve(finalPath)) {
      // Overwriting the source in place would destroy it if the render fails,
      // and FFmpeg cannot read and write the same file anyway.
      throw new CaptionEngineError(
        `Output path is the same as the input: ${finalPath}`,
        'Choose a different --output path so the source file is never destroyed.',
      );
    }

    // The extension must remain LAST. FFmpeg infers the muxer from it, so a
    // name ending in ".tmp-1234" fails with a bare "Invalid argument" that
    // gives no hint about the real cause.
    //
    // Leading dot hides it. pid + timestamp + RANDOM suffix keep concurrent
    // runs apart — pid+timestamp alone collides when two renders start in the
    // same millisecond, which is exactly what happens when a caller fans out
    // several outputs from one process.
    const name = basename(finalPath);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const unique = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    this.tempPath = join(dir, `.${stem}.tmp-${unique}${ext}`);
  }

  /** Validate the temp file and move it into place. Throws if it is not playable. */
  async publish(expect: ValidationExpectation = {}): Promise<MediaValidation> {
    const v = await validateMedia(this.tempPath, expect);
    if (!v.ok) {
      this.discard();
      throw new CaptionEngineError(
        `Render produced an invalid file and was discarded: ${v.problems.join('; ')}`,
        'Nothing was written to the output path, so no corrupt file is left behind.\n' +
          'Re-run with CAPTION_ENGINE_DEBUG=1 and CAPTION_ENGINE_KEEP_TEMP=1 to inspect the ' +
          'intermediate files.',
      );
    }

    try {
      renameSync(this.tempPath, this.finalPath);
    } catch {
      // Different filesystem (e.g. temp dir on another mount): fall back to copy.
      copyFileSync(this.tempPath, this.finalPath);
      this.discard();
    }
    this.published = true;
    return { ...v, path: this.finalPath };
  }

  /** Remove the temp file. Safe to call more than once. */
  discard(): void {
    try {
      if (existsSync(this.tempPath)) rmSync(this.tempPath, { force: true });
    } catch { /* best effort */ }
  }

  /** For use in `finally`: clean up unless we published successfully. */
  cleanupIfUnpublished(): void {
    if (!this.published) this.discard();
  }
}
