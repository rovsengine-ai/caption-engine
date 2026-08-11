import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg } from './ffmpeg.js';

/**
 * Frame sampling for visual Auto Trim.
 *
 * 1 frame per second is deliberate: enough to catch "the speaker looked away
 * for a few seconds" or "the camera whipped around", cheap enough that a
 * 10-minute video is 600 frames — a handful of batched Vision AI calls, not
 * one per video frame.
 */

export interface ExtractedFrame {
  timestampSec: number;
  path: string;
}

export function buildFrameExtractArgs(
  inputPath: string,
  framesDir: string,
  fps: number,
): string[] {
  return [
    '-y', '-hide_banner',
    '-i', inputPath,
    '-vf', `fps=${fps}`,
    '-q:v', '2', // high JPEG quality; frames are for a vision model, not a viewer
    join(framesDir, 'frame-%06d.jpg'),
  ];
}

export interface ExtractFramesOptions {
  /** Frames sampled per second of video. */
  fps?: number;
}

/**
 * Extract frames at a fixed rate and map each to its timestamp.
 *
 * Timestamps are derived from the output frame index and `fps` rather than
 * probed per file — `-vf fps=N` produces frames on an exact, constant grid,
 * so frame `i` (1-indexed by ffmpeg's `%06d`) landed at `(i - 1) / fps`
 * seconds without needing a second ffprobe pass per frame.
 */
export async function extractFrames(
  inputPath: string,
  workDir: string,
  opts: ExtractFramesOptions = {},
): Promise<ExtractedFrame[]> {
  const fps = opts.fps ?? 1;
  const framesDir = join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });

  await ffmpeg(buildFrameExtractArgs(inputPath, framesDir, fps), { timeoutMs: 30 * 60_000 });

  const files = readdirSync(framesDir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort();

  return files.map((f, i) => ({
    timestampSec: Math.round((i / fps) * 1000) / 1000,
    path: join(framesDir, f),
  }));
}
