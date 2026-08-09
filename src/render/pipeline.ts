import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ffmpeg, escapeFilterValue, FFMPEG } from '../media/ffmpeg.js';
import type { CaptionFrame, CaptionFramePlan } from '../captions/svg.js';
import { CaptionEngineError } from '../errors.js';
import { selectRasteriser, type Rasteriser } from './rasteriser.js';
import { planChunks, DEFAULT_CHUNK_OPTIONS, describeChunks, type ChunkPlan } from './chunker.js';
import { AtomicOutput, validateMedia, type MediaValidation } from './validate.js';

/**
 * Video rendering.
 *
 * ARCHITECTURE, and why it is three passes rather than one.
 *
 * The original design built a single filter_complex with one `-i overlay.png`
 * and one `overlay` filter per caption frame. That is fine for a 15-second clip
 * and fatal for a real one: a 465-second video produces 1,000+ frames, and
 * FFmpeg runs out of file descriptors at roughly 250 on a default macOS
 * `ulimit -n` of 256. It fails with "Error binding filtergraph inputs/outputs:
 * Resource temporarily unavailable" and leaves a 0-byte file that then reports
 * "moov atom not found".
 *
 *   Pass 1 — BASE: trim/concat Auto Trim segments, crop, scale. Few inputs.
 *            Produces the output timeline with audio intact.
 *   Pass 2 — CHUNKS: split into ≤80 overlays / ≤45s pieces; each is one FFmpeg
 *            process rendering VIDEO ONLY.
 *   Pass 3 — CONCAT + MUX: stream-copy the video chunks together and mux the
 *            base audio back in.
 *
 * Audio is deliberately never chunked or re-encoded. It is carried through pass
 * 1 and copied at pass 3, so there are no seams and no drift at chunk
 * boundaries — the class of bug that is hardest to notice and worst to ship.
 *
 * Every output is written through AtomicOutput: validated with ffprobe, then
 * renamed. A failed render leaves nothing behind.
 */

export interface Segment { start: number; end: number; }

export interface FrameSource {
  count: number;
  plans: CaptionFramePlan[];
  get(index: number): Promise<CaptionFrame>;
}

export interface RenderJob {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  fps?: number;
  /** Kept portions of the ORIGINAL timeline. Empty/omitted = whole file. */
  segments?: Segment[];
  /**
   * Audio fade applied at each internal segment join, in seconds.
   * Purely a level shape — it never changes a duration. 0 disables it.
   */
  cutFadeSec?: number;
  frames?: CaptionFrame[] | FrameSource;
  /** 0 = left, 0.5 = centre, 1 = right. Static crop by design. */
  cropFocusX?: number;
  crf?: number;
  preset?: string;
  /** Audio-only input: render captions over this solid colour. */
  backgroundColor?: string;
  durationSec: number;
  /** Whether the source has an audio stream (drives validation). */
  hasAudio?: boolean;
  onProgress?: (pct: number, message: string) => void;
  /** Overrides, mainly for tests. */
  maxOverlaysPerChunk?: number;
  maxChunkSeconds?: number;
}

export interface RenderResult {
  outputPath: string;
  workDir: string;
  overlayCount: number;
  durationSec: number;
  rasteriser: string;
  ffmpegPath: string;
  chunks: number;
  validation: MediaValidation;
}

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

async function rasteriseRange(
  source: CaptionFrame[] | FrameSource,
  indices: number[],
  dir: string,
  rasteriser: Rasteriser,
  keepSvg: boolean,
): Promise<string[]> {
  const getFrame = Array.isArray(source)
    ? async (i: number) => source[i]!
    : source.get;

  const paths: string[] = [];
  for (const i of indices) {
    const pngPath = join(dir, `cap_${String(i).padStart(6, '0')}.png`);
    if (existsSync(pngPath)) { paths.push(pngPath); continue; } // shared across chunks

    const frame = await getFrame(i);
    if (keepSvg) {
      writeFileSync(join(dir, `cap_${String(i).padStart(6, '0')}.svg`), frame.svg, 'utf8');
    }
    try {
      await rasteriser.rasterise(frame.svg, pngPath, {
        width: frame.width, height: frame.height,
      });
    } catch (e) {
      const debugPath = join(dir, `FAILED_frame_${i}.svg`);
      try { writeFileSync(debugPath, frame.svg, 'utf8'); } catch { /* best effort */ }
      throw new CaptionEngineError(
        `Failed to rasterise caption frame ${i} using "${rasteriser.name}".`,
        `Rasteriser: ${rasteriser.description}\n` +
          `The failing SVG was written to:\n  ${debugPath}\n\n` +
          `Underlying error:\n  ${e instanceof Error ? e.message : String(e)}\n\n` +
          `Try:  --rasteriser ffmpeg    or:  node dist/src/cli.js doctor`,
      );
    }
    paths.push(pngPath);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Pass 1 — base video
// ---------------------------------------------------------------------------

/**
 * Default fade at a cut join.
 *
 * 12 ms is long enough to remove the sample-step click and short enough that no
 * listener perceives a level dip — roughly half a cycle at the lowest speech
 * fundamental. Longer values start to sound like ducking on fast cuts.
 */
export const DEFAULT_CUT_FADE_SEC = 0.012;

/** Build the base (uncaptioned) video on the OUTPUT timeline. */
export function buildBaseArgs(job: RenderJob, outPath: string): string[] {
  const isAudioOnly = Boolean(job.backgroundColor);
  const segments = job.segments ?? [];
  const parts: string[] = [];

  const args = ['-y', '-hide_banner', '-i', job.inputPath];
  if (isAudioOnly) {
    args.push(
      '-f', 'lavfi',
      '-i', `color=c=${job.backgroundColor}:s=${job.width}x${job.height}:r=${job.fps ?? 30}`,
    );
  }

  let vLabel = isAudioOnly ? '1:v' : '0:v';
  let aLabel = '0:a';

  if (segments.length > 0) {
    // Short fades at internal joins.
    //
    // atrim slices at an arbitrary point in the waveform, so two segments butted
    // together almost always step from one instantaneous sample value to a
    // different one — an audible click, and the thing that makes machine-cut
    // audio sound machine-cut.
    //
    // This is a LEVEL change, not a timing change: afade shapes samples inside
    // the segment and does not shorten it. acrossfade would overlap segments and
    // shorten the total, desynchronising every caption — which is why it is not
    // used here. Durations, A/V sync and the caption timeline are untouched.
    //
    // The very first fade-in and the very last fade-out are skipped so the clip
    // does not appear to fade up from nothing at its own start and end.
    const fade = Math.max(0, job.cutFadeSec ?? DEFAULT_CUT_FADE_SEC);

    segments.forEach((s, i) => {
      if (!isAudioOnly) {
        parts.push(`[${vLabel}]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
      }

      const segDur = s.end - s.start;
      // Never let the two fades meet: on a very short segment that would duck
      // the whole thing to near-silence. Truncate rather than round, so the
      // emitted value can never exceed the safe bound after formatting.
      const f = Math.floor(Math.min(fade, segDur / 3) * 10000) / 10000;
      const fadeIn = f > 0 && i > 0;
      const fadeOut = f > 0 && i < segments.length - 1;

      const chain = [`atrim=start=${s.start}:end=${s.end}`, 'asetpts=PTS-STARTPTS'];
      if (fadeIn) chain.push(`afade=t=in:st=0:d=${f.toFixed(4)}`);
      if (fadeOut) chain.push(`afade=t=out:st=${(segDur - f).toFixed(4)}:d=${f.toFixed(4)}`);

      parts.push(`[0:a]${chain.join(',')}[a${i}]`);
    });
    if (isAudioOnly) {
      parts.push(`${segments.map((_, i) => `[a${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[acat]`);
      aLabel = 'acat';
    } else {
      parts.push(
        `${segments.map((_, i) => `[v${i}][a${i}]`).join('')}` +
          `concat=n=${segments.length}:v=1:a=1[vcat][acat]`,
      );
      vLabel = 'vcat';
      aLabel = 'acat';
    }
  }

  if (!isAudioOnly) {
    const ar = job.width / job.height;
    const cw = `min(iw\\,ih*${ar})`;
    const ch = `min(ih\\,iw/${ar})`;
    const fx = Math.min(1, Math.max(0, job.cropFocusX ?? 0.5));
    parts.push(
      `[${vLabel}]crop=${cw}:${ch}:(iw-${cw})*${fx}:(ih-${ch})/2,` +
        `scale=${job.width}:${job.height}:flags=lanczos,setsar=1[vout]`,
    );
    vLabel = 'vout';
  } else {
    parts.push(`[${vLabel}]scale=${job.width}:${job.height},setsar=1[vout]`);
    vLabel = 'vout';
  }

  args.push('-filter_complex', parts.join(';'));
  args.push('-map', `[${vLabel}]`);
  args.push('-map', segments.length > 0 ? `[${aLabel}]` : '0:a?');

  args.push(
    '-c:v', 'libx264',
    '-preset', job.preset ?? 'medium',
    '-crf', String(job.crf ?? 20),
    '-pix_fmt', 'yuv420p',
    // A keyframe at least every 2s keeps chunk boundaries cheap and exact.
    '-g', String(Math.max(2, Math.round((job.fps ?? 30) * 2))),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
  );
  if (job.fps) args.push('-r', String(job.fps));
  // The generated colour source is infinite; bound it explicitly.
  if (isAudioOnly) args.push('-t', job.durationSec.toFixed(3), '-shortest');

  args.push(outPath);
  return args;
}

// ---------------------------------------------------------------------------
// Pass 2 — one chunk
// ---------------------------------------------------------------------------

/** Overlay a chunk's captions onto a slice of the base video. Video only. */
export function buildChunkArgs(
  basePath: string,
  chunk: ChunkPlan,
  overlayPaths: string[],
  outPath: string,
  opts: { crf?: number; preset?: string; fps?: number },
): string[] {
  const duration = chunk.end - chunk.start;
  const args = ['-y', '-hide_banner'];

  // Accurate seek: -ss before -i decodes from the preceding keyframe and
  // discards, which is exact and much faster than seeking after decode.
  args.push('-ss', chunk.start.toFixed(3), '-t', duration.toFixed(3), '-i', basePath);
  for (const p of overlayPaths) args.push('-i', p);

  if (overlayPaths.length > 0) {
    const parts: string[] = [];
    let label = '0:v';
    overlayPaths.forEach((_, i) => {
      const out = i === overlayPaths.length - 1 ? 'vout' : `ov${i}`;
      const f = chunk.frames[i]!;
      parts.push(
        `[${label}][${i + 1}:v]overlay=0:0:` +
          `enable='between(t\\,${f.start.toFixed(3)}\\,${f.end.toFixed(3)})'[${out}]`,
      );
      label = out;
    });
    args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
  } else {
    args.push('-map', '0:v');
  }

  args.push(
    '-an', // audio is carried by the base and muxed back at concat time
    '-c:v', 'libx264',
    '-preset', opts.preset ?? 'medium',
    '-crf', String(opts.crf ?? 20),
    '-pix_fmt', 'yuv420p',
  );
  if (opts.fps) args.push('-r', String(opts.fps));
  args.push(outPath);
  return args;
}

// ---------------------------------------------------------------------------
// Pass 3 — concat + mux
// ---------------------------------------------------------------------------

export function buildConcatArgs(listPath: string, basePath: string, outPath: string, hasAudio: boolean): string[] {
  const args = [
    '-y', '-hide_banner',
    '-f', 'concat', '-safe', '0', '-i', listPath,
  ];
  if (hasAudio) args.push('-i', basePath);

  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', '1:a:0');

  // Stream copy on both sides: the chunks were encoded with identical settings,
  // and the audio has never been touched since pass 1. No re-encode means no
  // generation loss and no chance of drift.
  args.push('-c', 'copy', '-movflags', '+faststart', '-shortest', outPath);
  return args;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function renderVideo(job: RenderJob): Promise<RenderResult> {
  const workDir = mkdtempSync(join(tmpdir(), 'caption-engine-'));
  const keepTemp = Boolean(process.env.CAPTION_ENGINE_KEEP_TEMP);
  const atomic = new AtomicOutput(job.outputPath, job.inputPath);

  const frameCount = Array.isArray(job.frames) ? job.frames.length : (job.frames?.count ?? 0);
  const framePlans: CaptionFramePlan[] = Array.isArray(job.frames)
    ? job.frames
    : (job.frames?.plans ?? []);

  let rasteriserName = 'none';
  let chunkCount = 0;

  try {
    // ---- rasteriser up front, before any work ----------------------------
    let rasteriser: Rasteriser | null = null;
    if (frameCount > 0) {
      const sel = await selectRasteriser();
      rasteriser = sel.rasteriser;
      rasteriserName = sel.rasteriser.name;
    }

    // ---- Pass 1: base ----------------------------------------------------
    job.onProgress?.(0, 'building base video');
    const basePath = join(workDir, 'base.mp4');
    await ffmpeg(buildBaseArgs(job, basePath), { timeoutMs: 6 * 60 * 60_000 });

    const baseInfo = await validateMedia(basePath, { video: true });
    if (!baseInfo.ok) {
      throw new CaptionEngineError(
        `Base render failed validation: ${baseInfo.problems.join('; ')}`,
        'This happens before captions are applied, so the problem is in the source ' +
          'media, the Auto Trim segments, or the crop/scale settings.',
      );
    }
    const hasAudio = baseInfo.hasAudio;
    // Trust the base's real duration over the caller's estimate — trim maths can
    // drift by a frame and the chunk plan must cover the whole file.
    const timelineDuration = baseInfo.durationSec;

    // ---- Pass 2: chunks --------------------------------------------------
    const chunks = planChunks(framePlans, {
      maxOverlaysPerChunk:
        job.maxOverlaysPerChunk ??
        (Number(process.env.CAPTION_ENGINE_MAX_OVERLAYS) ||
          DEFAULT_CHUNK_OPTIONS.maxOverlaysPerChunk),
      maxChunkSeconds:
        job.maxChunkSeconds ??
        (Number(process.env.CAPTION_ENGINE_MAX_CHUNK_SECONDS) ||
          DEFAULT_CHUNK_OPTIONS.maxChunkSeconds),
      totalDurationSec: timelineDuration,
    });
    chunkCount = chunks.length;

    const shape = describeChunks(chunks);
    job.onProgress?.(
      0,
      `${frameCount} caption frames → ${shape.count} chunk(s), ` +
        `max ${shape.maxOverlays} overlays / ${shape.maxSeconds.toFixed(0)}s each`,
    );

    // A single chunk with no captions: the base already IS the answer.
    if (chunks.length === 1 && chunks[0]!.frames.length === 0 && frameCount === 0) {
      await ffmpeg(['-y', '-hide_banner', '-i', basePath, '-c', 'copy',
        '-movflags', '+faststart', atomic.tempPath], { timeoutMs: 60 * 60_000 });
    } else {
      const chunkFiles: string[] = [];
      for (const chunk of chunks) {
        const overlayPaths = rasteriser
          ? await rasteriseRange(job.frames!, chunk.frameSourceIndices, workDir, rasteriser, keepTemp)
          : [];

        const chunkOut = join(workDir, `chunk_${String(chunk.index).padStart(4, '0')}.mp4`);
        await ffmpeg(
          buildChunkArgs(basePath, chunk, overlayPaths, chunkOut, {
            crf: job.crf, preset: job.preset, fps: job.fps,
          }),
          { timeoutMs: 6 * 60 * 60_000 },
        );

        const cv = await validateMedia(chunkOut, { video: true });
        if (!cv.ok) {
          throw new CaptionEngineError(
            `Chunk ${chunk.index + 1}/${chunks.length} ` +
              `(${chunk.start.toFixed(1)}-${chunk.end.toFixed(1)}s) is invalid: ` +
              `${cv.problems.join('; ')}`,
            `The chunk had ${chunk.frames.length} caption overlay(s). ` +
              `If this says "Too many open files", lower the chunk size:\n` +
              `  CAPTION_ENGINE_MAX_OVERLAYS=40 node dist/src/cli.js ...`,
          );
        }

        chunkFiles.push(chunkOut);
        job.onProgress?.(
          Math.round(((chunk.index + 1) / chunks.length) * 100),
          `rendered chunk ${chunk.index + 1}/${chunks.length}`,
        );
      }

      // ---- Pass 3: concat + mux -----------------------------------------
      job.onProgress?.(100, 'joining chunks');
      const listPath = join(workDir, 'chunks.txt');
      writeFileSync(
        listPath,
        chunkFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n',
        'utf8',
      );
      await ffmpeg(buildConcatArgs(listPath, basePath, atomic.tempPath, hasAudio), {
        timeoutMs: 2 * 60 * 60_000,
      });
    }

    // ---- Validate and publish -------------------------------------------
    const validation = await atomic.publish({
      video: true,
      audio: hasAudio,
      expectedWidth: job.width,
      expectedHeight: job.height,
      requireYuv420p: true,
      expectedDurationSec: timelineDuration,
      // Concat + stream copy can round to the nearest frame at each seam.
      durationToleranceSec: Math.max(1.0, chunks.length * 0.12),
    });

    job.onProgress?.(100, 'done');
    return {
      outputPath: job.outputPath,
      workDir,
      overlayCount: frameCount,
      durationSec: validation.durationSec,
      rasteriser: rasteriserName,
      ffmpegPath: FFMPEG,
      chunks: chunkCount,
      validation,
    };
  } finally {
    atomic.cleanupIfUnpublished();
    if (!keepTemp) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Render a single caption frame to PNG. Used by tests, previews and visual checks. */
export async function renderPreviewFrame(
  svg: string,
  outPath: string,
  background?: string,
  size?: { width: number; height: number },
): Promise<string> {
  mkdirSync(join(outPath, '..'), { recursive: true });
  const { rasteriser } = await selectRasteriser();
  const dims = size ?? readSvgSize(svg) ?? { width: 0, height: 0 };

  if (!background) {
    await rasteriser.rasterise(svg, outPath, dims);
    return outPath;
  }

  const dir = mkdtempSync(join(tmpdir(), 'caption-preview-'));
  try {
    const pngPath = join(dir, 'overlay.png');
    await rasteriser.rasterise(svg, pngPath, dims);
    await ffmpeg([
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', `color=c=${background}:s=${dims.width}x${dims.height}:d=1`,
      '-i', pngPath,
      '-filter_complex', '[0:v][1:v]overlay=0:0[out]',
      '-map', '[out]', '-frames:v', '1', outPath,
    ], { timeoutMs: 120_000 });
    return outPath;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function readSvgSize(svg: string): { width: number; height: number } | null {
  const w = svg.match(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/);
  const h = svg.match(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/);
  if (!w || !h) return null;
  return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
}

export { escapeFilterValue, resolve };
export { selectRasteriser, probeAllRasterisers } from './rasteriser.js';
export { planChunks, describeChunks, DEFAULT_CHUNK_OPTIONS } from './chunker.js';
export { AtomicOutput, validateMedia } from './validate.js';
