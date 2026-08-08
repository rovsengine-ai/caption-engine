/**
 * LEGACY ASS burn-in path.
 *
 * Superseded by src/render/pipeline.ts (shaped-SVG overlays), which is what the
 * CLI uses. This module is retained because it is the shortest way to burn an
 * .ass file into a video, which is useful for:
 *   - comparing our renderer against libass on a given host
 *   - users who only want an .ass and will burn it in themselves
 *
 * DO NOT use it for Indic captions. libass shaping is host-dependent — see the
 * header of src/text/shaper.ts for the measurements. For guaranteed rendering,
 * use renderVideo() from ./pipeline.js.
 */
import { spawn } from 'node:child_process';

export interface Segment {
  start: number;
  end: number;
}

export interface RenderOptions {
  inputPath: string;
  outputPath: string;
  /** Segments of the ORIGINAL timeline to keep. Omit/empty = keep everything. */
  segments?: Segment[];
  /** Path to a .ass file to burn in. */
  assPath?: string;
  /** Crop/pad to a target aspect, e.g. 9/16 for reels. */
  targetAspect?: number;
  /**
   * Horizontal focus for the crop, 0 = left edge, 0.5 = centre, 1 = right edge.
   *
   * v1 is deliberately a STATIC crop. Subject-tracking auto-reframe is the single
   * most reliable way to blow a timeline — ship the dumb version, find out whether
   * users actually ask for the smart one.
   */
  cropFocusX?: number;
  width?: number;
  height?: number;
  fps?: number;
  crf?: number;
  preset?: string;
  /** Extra args appended before the output path. Escape hatch. */
  extraArgs?: string[];
}

/**
 * Build the FFmpeg argv for a render.
 *
 * Kept as a pure function so it can be unit-tested without running FFmpeg —
 * filter-graph bugs are much easier to catch as a string diff than by staring
 * at a wrong video.
 */
export function buildFfmpegArgs(opts: RenderOptions): string[] {
  const {
    inputPath,
    outputPath,
    segments = [],
    assPath,
    targetAspect,
    cropFocusX = 0.5,
    width,
    height,
    fps,
    crf = 20,
    preset = 'medium',
    extraArgs = [],
  } = opts;

  const args = ['-y', '-i', inputPath];
  const vChain: string[] = [];
  const filterParts: string[] = [];

  let vLabel = '0:v';
  let aLabel = '0:a';

  // ---- Cuts: trim each kept segment, then concat -----------------------------
  // setpts/asetpts reset each segment's timestamps to zero. Without them concat
  // produces a video with the right frames and completely wrong timing — it looks
  // like frames are frozen or audio drifts.
  if (segments.length > 0) {
    segments.forEach((s, i) => {
      filterParts.push(
        `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}]`,
      );
    });
    const inputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
    filterParts.push(`${inputs}concat=n=${segments.length}:v=1:a=1[vcat][acat]`);
    vLabel = 'vcat';
    aLabel = 'acat';
  }

  // ---- Reframe to target aspect ---------------------------------------------
  if (targetAspect) {
    // Crop to the target aspect using the smaller dimension, positioned by focus.
    // `min(iw, ih*ar)` keeps the crop inside the frame for both landscape and
    // portrait sources instead of erroring on out-of-range crops.
    const cw = `min(iw\\,ih*${targetAspect})`;
    const ch = `min(ih\\,iw/${targetAspect})`;
    const x = `(iw-${cw})*${clamp01(cropFocusX)}`;
    const y = `(ih-${ch})/2`;
    vChain.push(`crop=${cw}:${ch}:${x}:${y}`);
  }

  if (width && height) {
    vChain.push(`scale=${width}:${height}:flags=lanczos`);
  }
  if (fps) vChain.push(`fps=${fps}`);

  // ---- Burn in captions ------------------------------------------------------
  // Must come AFTER scaling: the .ass PlayResX/Y describe the FINAL frame size,
  // so burning before a scale would resize the text along with the video and
  // throw the font size off.
  if (assPath) {
    vChain.push(`subtitles=${escapeFilterPath(assPath)}`);
  }

  if (vChain.length > 0) {
    filterParts.push(`[${vLabel}]${vChain.join(',')}[vout]`);
    vLabel = 'vout';
  }

  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', `[${vLabel}]`);
    args.push('-map', segments.length > 0 ? `[${aLabel}]` : '0:a?');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p', // required for playback on most social platforms
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart', // lets playback start before full download
    ...extraArgs,
    outputPath,
  );

  return args;
}

export interface RunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(args: string[], bin = 'ffmpeg'): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += String(d);
      // FFmpeg's stderr is unbounded on long renders; keep only the tail.
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export async function render(opts: RenderOptions, bin = 'ffmpeg'): Promise<void> {
  const args = buildFfmpegArgs(opts);
  const { code, stderr } = await runFfmpeg(args, bin);
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}\nargs: ${args.join(' ')}\n${stderr.slice(-3000)}`);
  }
}

/** Probe a media file. Returns null if ffprobe is unavailable or the file is unreadable. */
export async function probe(
  inputPath: string,
  bin = 'ffprobe',
): Promise<{ width: number; height: number; durationSec: number; fps: number; hasAudio: boolean } | null> {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath];
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, args);
    let s = '';
    p.stdout.on('data', (d) => (s += String(d)));
    p.on('error', reject);
    p.on('close', () => resolve(s));
  }).catch(() => '');

  if (!out) return null;
  try {
    const j = JSON.parse(out) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const v = j.streams?.find((s) => s.codec_type === 'video');
    const hasAudio = Boolean(j.streams?.some((s) => s.codec_type === 'audio'));
    return {
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      durationSec: Number(j.format?.duration ?? 0),
      fps: parseFps(v?.avg_frame_rate),
      hasAudio,
    };
  } catch {
    return null;
  }
}

function parseFps(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return 0;
  return Math.round((n / d) * 1000) / 1000;
}

/**
 * The subtitles filter needs colons and backslashes escaped, or a Windows path
 * like C:\x.ass silently breaks the whole filter graph.
 */
function escapeFilterPath(p: string): string {
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Extract 16kHz mono audio — always send THIS to the ASR, never the video file. */
export function extractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y', '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  ];
}
