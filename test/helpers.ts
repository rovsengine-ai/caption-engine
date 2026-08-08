import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import type { Transcript, Word, CaptionCue } from '../src/types.js';

export function w(text: string, start: number, end: number, extra: Partial<Word> = {}): Word {
  return { text, start, end, confidence: 0.95, type: 'word', keep: true, ...extra };
}

export function mkTranscript(
  words: Array<[string, number, number]>,
  language = 'hi',
  duration?: number,
): Transcript {
  const ws = words.map(([t, s, e]) => w(t, s, e, { language }));
  return {
    words: ws,
    language,
    duration: duration ?? Math.max(...ws.map((x) => x.end), 0) + 0.5,
    provider: 'fixture',
    model: 'test',
    hasWordTimings: true,
  };
}

export function mkCue(words: string[], startAt = 0, wordDur = 0.4): CaptionCue {
  const ws = words.map((t, i) => w(t, startAt + i * wordDur, startAt + i * wordDur + wordDur * 0.9));
  return {
    index: 0,
    start: startAt,
    end: startAt + words.length * wordDur,
    words: ws,
    text: words.join(' '),
  };
}

export function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export function tempDir(prefix = 'ce-test-'): { path: string; cleanup: () => void } {
  const p = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: p,
    cleanup: () => { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/** Generate a small test video with a tone, for real render tests. */
export function makeTestVideo(
  outPath: string,
  opts: { width?: number; height?: number; durationSec?: number; fps?: number } = {},
): string {
  const { width = 640, height = 360, durationSec = 4, fps = 24 } = opts;
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=0x203040:s=${width}x${height}:d=${durationSec}:r=${fps}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${durationSec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    outPath,
  ], { timeout: 180_000 });
  if (r.status !== 0) throw new Error(`test video generation failed: ${r.stderr?.toString().slice(-500)}`);
  return outPath;
}

export function makeTestAudio(outPath: string, durationSec = 4): string {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
    outPath,
  ], { timeout: 180_000 });
  if (r.status !== 0) throw new Error(`test audio generation failed`);
  return outPath;
}

export interface ProbeResult {
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  hasVideo: boolean;
  pixFmt: string;
}

export function probeFile(path: string): ProbeResult {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
  ], { encoding: 'utf8', timeout: 120_000 });
  const j = JSON.parse(out) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; pix_fmt?: string }>;
    format?: { duration?: string };
  };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  return {
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    durationSec: Number(j.format?.duration ?? 0),
    hasAudio: Boolean(j.streams?.some((s) => s.codec_type === 'audio')),
    hasVideo: Boolean(v),
    pixFmt: v?.pix_fmt ?? '',
  };
}

/** Count non-background pixels in a PNG — used to assert captions actually drew. */
export function inkPixelCount(pngPath: string, threshold = 40): number {
  // Uses ffmpeg rather than an image library so tests need no extra dependency.
  const out = execFileSync('ffmpeg', [
    '-v', 'error', '-i', pngPath,
    '-vf', `format=gray,geq=lum='if(gt(lum(X\\,Y),${threshold}),255,0)'`,
    '-f', 'rawvideo', '-',
  ], { maxBuffer: 200 * 1024 * 1024, timeout: 120_000 });
  let n = 0;
  for (const b of out) if (b > 128) n++;
  return n;
}

export function extractFrame(video: string, timeSec: number, outPng: string): string {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(timeSec), '-i', video, '-frames:v', '1', outPng,
  ], { timeout: 120_000 });
  if (r.status !== 0 || !existsSync(outPng)) {
    throw new Error(`frame extraction failed at ${timeSec}s`);
  }
  return outPng;
}
