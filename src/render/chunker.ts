import type { CaptionFramePlan } from '../captions/svg.js';

/**
 * Splitting caption work into FFmpeg-sized pieces.
 *
 * WHY — the bug this fixes.
 *
 * The renderer used to build ONE filter_complex with `-i overlay.png` per
 * caption frame. A 465-second video with ~2,300 words produces well over a
 * thousand frames, so FFmpeg was asked to open a thousand-plus input files and
 * chain a thousand-plus overlay filters in a single process.
 *
 * Measured with `ulimit -n 256` (the macOS default):
 *
 *     200 overlays → exit 0, valid output
 *     400 overlays → exit 1, "Too many open files", 0-byte file left behind
 *
 * FFmpeg surfaces the descriptor exhaustion as
 * "Error binding filtergraph inputs/outputs: Resource temporarily unavailable"
 * (EAGAIN), and the half-written file then fails to open with
 * "moov atom not found". On a Linux box with a large `ulimit -n` the same code
 * happily renders 800 overlays — which is why this survived development and
 * broke on a real machine.
 *
 * The fix is to bound BOTH axes: never more than `maxOverlaysPerChunk` inputs,
 * and never more than `maxChunkSeconds` of timeline, per FFmpeg process.
 */

export interface ChunkPlan {
  index: number;
  /** Start on the OUTPUT timeline (after Auto Trim), in seconds. */
  start: number;
  end: number;
  /**
   * Frames for this chunk, with times rebased so 0 = chunk start.
   * A frame straddling a boundary appears in both chunks, clipped to each.
   */
  frames: CaptionFramePlan[];
  /** Index into the global frame list, so the caller can fetch the SVG. */
  frameSourceIndices: number[];
}

export interface ChunkOptions {
  /**
   * Hard cap on overlay inputs per FFmpeg process.
   *
   * 80 is deliberately well under the ~250 where macOS starts failing: FFmpeg
   * also opens the input video, the output, and assorted internal descriptors,
   * and a user may have lowered their limit further.
   */
  maxOverlaysPerChunk: number;
  /** Cap on chunk duration. Keeps memory and retry cost bounded on long videos. */
  maxChunkSeconds: number;
  /** Total duration of the output timeline. */
  totalDurationSec: number;
}

export const DEFAULT_CHUNK_OPTIONS: Omit<ChunkOptions, 'totalDurationSec'> = {
  maxOverlaysPerChunk: 80,
  maxChunkSeconds: 45,
};

/**
 * Group frames into chunks.
 *
 * Boundaries are chosen at frame edges wherever possible, so a caption is not
 * split unless it genuinely spans the maximum chunk length. When a split IS
 * required the frame is emitted in both chunks, clipped to each — that keeps the
 * caption on screen continuously across the seam rather than blinking out.
 */
export function planChunks(
  frames: CaptionFramePlan[],
  opts: ChunkOptions,
): ChunkPlan[] {
  const total = opts.totalDurationSec;
  if (total <= 0) return [];

  // No captions: a single chunk covering the whole timeline.
  if (frames.length === 0) {
    return [{ index: 0, start: 0, end: total, frames: [], frameSourceIndices: [] }];
  }

  const ordered = frames
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.start - b.f.start);

  const boundaries: number[] = [0];
  let count = 0;
  let chunkStart = 0;

  for (const { f } of ordered) {
    const wouldExceedCount = count + 1 > opts.maxOverlaysPerChunk;
    const wouldExceedTime = f.end - chunkStart > opts.maxChunkSeconds;

    if ((wouldExceedCount || wouldExceedTime) && count > 0) {
      // Cut at this frame's start so the frame lands wholly in the next chunk.
      const cut = Math.max(chunkStart + 0.001, Math.min(f.start, total));
      boundaries.push(cut);
      chunkStart = cut;
      count = 0;
    }
    count++;
  }
  boundaries.push(total);

  const chunks: ChunkPlan[] = [];
  for (let c = 0; c < boundaries.length - 1; c++) {
    const start = boundaries[c]!;
    const end = boundaries[c + 1]!;
    if (end - start <= 0.0005) continue;

    const inChunk: CaptionFramePlan[] = [];
    const srcIdx: number[] = [];

    for (const { f, i } of ordered) {
      // Half-open overlap test: a frame ending exactly at the boundary belongs
      // to the earlier chunk only, which is what prevents duplicate rendering.
      if (f.end <= start || f.start >= end) continue;

      const clippedStart = Math.max(f.start, start);
      const clippedEnd = Math.min(f.end, end);
      if (clippedEnd - clippedStart <= 0.0005) continue;

      inChunk.push({
        ...f,
        // Rebase onto the chunk's local timeline. The `enable=between(t,...)`
        // expression is evaluated against the chunk's own clock, so absolute
        // times would put every caption in the wrong place.
        start: Number((clippedStart - start).toFixed(3)),
        end: Number((clippedEnd - start).toFixed(3)),
      });
      srcIdx.push(i);
    }

    chunks.push({ index: chunks.length, start, end, frames: inChunk, frameSourceIndices: srcIdx });
  }

  return chunks;
}

/** Sanity report for tests and diagnostics. */
export function describeChunks(chunks: ChunkPlan[]): {
  count: number;
  maxOverlays: number;
  maxSeconds: number;
  totalOverlays: number;
} {
  return {
    count: chunks.length,
    maxOverlays: chunks.reduce((n, c) => Math.max(n, c.frames.length), 0),
    maxSeconds: chunks.reduce((n, c) => Math.max(n, c.end - c.start), 0),
    totalOverlays: chunks.reduce((n, c) => n + c.frames.length, 0),
  };
}
