import { existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { FFPROBE, run } from './ffmpeg.js';
import { UnsupportedFormatError, CaptionEngineError } from '../errors.js';

/**
 * Media inspection and format validation.
 *
 * Format is decided by what ffprobe actually finds in the file, not by the
 * extension — a `.mp4` containing only audio, or an extensionless file, must
 * both work correctly.
 */

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.mts',
];
export const AUDIO_EXTENSIONS = [
  '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif', '.caf',
];
export const SUPPORTED_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

export interface StreamInfo {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  channels?: number;
  sampleRate?: number;
  /** Display rotation from container metadata (90/180/270). */
  rotation?: number;
}

export interface MediaInfo {
  path: string;
  /** 'video' when a real video stream exists, else 'audio'. */
  kind: 'video' | 'audio';
  formatName: string;
  durationSec: number;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
  streams: StreamInfo[];
  /** Display dimensions, rotation applied. Undefined for audio-only. */
  width?: number;
  height?: number;
  fps?: number;
}

interface FfprobeJson {
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string;
    duration?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number }>;
  }>;
  format?: { format_name?: string; duration?: string; size?: string };
}

function parseFps(r?: string): number | undefined {
  if (!r || r === '0/0') return undefined;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  if (!existsSync(path)) {
    throw new CaptionEngineError(
      `Input file not found: ${path}`,
      `Check the path. If it contains spaces, quote it:\n  node dist/cli.js "my video.mp4"`,
    );
  }
  const st = statSync(path);
  if (st.isDirectory()) {
    throw new CaptionEngineError(`Input is a directory, not a file: ${path}`);
  }
  if (st.size === 0) {
    throw new CaptionEngineError(`Input file is empty (0 bytes): ${path}`);
  }

  const res = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    path,
  ], { timeoutMs: 120_000 });

  if (res.code !== 0) {
    throw new UnsupportedFormatError(
      path,
      `ffprobe could not read it (${res.stderr.trim().split('\n').pop() ?? 'unknown'})`,
      SUPPORTED_EXTENSIONS,
    );
  }

  let j: FfprobeJson;
  try {
    j = JSON.parse(res.stdout) as FfprobeJson;
  } catch {
    throw new UnsupportedFormatError(path, 'unparseable ffprobe output', SUPPORTED_EXTENSIONS);
  }

  const streams: StreamInfo[] = (j.streams ?? []).map((s) => {
    const rotTag = s.tags?.rotate ? Number(s.tags.rotate) : undefined;
    const rotSide = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
    const rotation = rotTag ?? (rotSide !== undefined ? Math.abs(rotSide) : undefined);
    const type =
      s.codec_type === 'video' ? 'video'
      : s.codec_type === 'audio' ? 'audio'
      : s.codec_type === 'subtitle' ? 'subtitle'
      : 'other';
    return {
      index: s.index ?? 0,
      type,
      codec: s.codec_name ?? 'unknown',
      width: s.width,
      height: s.height,
      fps: parseFps(s.avg_frame_rate) ?? parseFps(s.r_frame_rate),
      channels: s.channels,
      sampleRate: s.sample_rate ? Number(s.sample_rate) : undefined,
      rotation,
    };
  });

  // Cover art in an MP3 appears as a video stream. Treating it as video would
  // make us try to render a slideshow of one JPEG — check for real motion.
  const videoStreams = streams.filter(
    (s) => s.type === 'video' && s.codec !== 'mjpeg' && s.codec !== 'png' && (s.fps ?? 0) > 1,
  );
  const audioStreams = streams.filter((s) => s.type === 'audio');

  const hasVideo = videoStreams.length > 0;
  const hasAudio = audioStreams.length > 0;

  if (!hasVideo && !hasAudio) {
    throw new UnsupportedFormatError(
      path,
      'no audio or video streams found',
      SUPPORTED_EXTENSIONS,
    );
  }

  const v = videoStreams[0];
  let width = v?.width;
  let height = v?.height;
  // A 90/270° rotation means the DISPLAY dimensions are swapped relative to the
  // coded frame. Phone footage is full of this; ignoring it produces captions
  // laid out for the wrong orientation.
  if (v?.rotation === 90 || v?.rotation === 270) {
    [width, height] = [height, width];
  }

  const duration = Number(j.format?.duration ?? 0) ||
    Math.max(0, ...(j.streams ?? []).map((s) => Number(s.duration ?? 0)));

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new CaptionEngineError(
      `Could not determine duration of ${path}.`,
      'The file may be truncated or still being written. Try re-encoding:\n' +
        `  ffmpeg -i "${path}" -c copy fixed.mp4`,
    );
  }

  return {
    path,
    kind: hasVideo ? 'video' : 'audio',
    formatName: j.format?.format_name ?? 'unknown',
    durationSec: duration,
    sizeBytes: Number(j.format?.size ?? st.size),
    hasVideo,
    hasAudio,
    streams,
    width,
    height,
    fps: v?.fps,
  };
}

/** Extension-based pre-check, for fast CLI feedback before spawning ffprobe. */
export function looksSupported(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === '' || SUPPORTED_EXTENSIONS.includes(ext);
}

export function assertHasAudio(info: MediaInfo): void {
  if (!info.hasAudio) {
    throw new CaptionEngineError(
      `"${info.path}" has no audio stream — there is nothing to transcribe.`,
      'Captions are generated from speech. Provide a file containing audio.',
    );
  }
}
