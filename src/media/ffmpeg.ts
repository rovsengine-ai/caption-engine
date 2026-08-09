import { spawn, execFileSync } from 'node:child_process';
import { FfmpegError, FfmpegMissingError } from '../errors.js';

/**
 * Thin, safe wrapper around the FFmpeg binaries.
 *
 * Everything goes through argv arrays — never a shell string — so filenames
 * containing spaces, quotes, `$`, `;` or newlines cannot be reinterpreted as
 * shell syntax. The only place escaping is genuinely required is INSIDE
 * filter-graph arguments (see escapeFilterValue), because FFmpeg parses those
 * itself.
 */

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function assertBinary(bin: string): void {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 20_000 });
  } catch {
    throw new FfmpegMissingError(bin);
  }
}

export function run(
  bin: string,
  args: string[],
  opts: { onStderr?: (chunk: string) => void; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new FfmpegError(`${bin} timed out after ${opts.timeoutMs}ms`, args, stderr));
      }, opts.timeoutMs);
    }

    proc.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 8_000_000) stdout = stdout.slice(-4_000_000);
    });
    proc.stderr.on('data', (d) => {
      const s = String(d);
      opts.onStderr?.(s);
      stderr += s;
      // FFmpeg's progress output is unbounded on long renders.
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new FfmpegMissingError(bin));
      else reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface BinaryRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Like `run`, but keeps stdout as raw bytes.
 *
 * `run` accumulates stdout with `String(chunk)`, which is correct for FFmpeg's
 * textual metadata output and destroys anything binary: bytes that are not
 * valid UTF-8 become U+FFFD and cannot be recovered. Decoding PCM through that
 * path yields a waveform of replacement characters, so pitch analysis needs its
 * own capture.
 *
 * `maxBytes` is a hard ceiling, because raw audio is large: 16 kHz mono 16-bit
 * is ~1.9 MB per minute, so a two-hour lecture would be ~230 MB in one Buffer.
 * Hitting the cap truncates rather than throwing — a partial pitch track is
 * still useful, and it is reported so callers know the analysis is partial.
 */
export function runBinary(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<BinaryRunResult & { truncated: boolean }> {
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let stderr = '';
    let timer: NodeJS.Timeout | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new FfmpegError(`${bin} timed out after ${opts.timeoutMs}ms`, args, stderr));
      }, opts.timeoutMs);
    }

    proc.stdout.on('data', (d: Buffer) => {
      if (total >= maxBytes) { truncated = true; return; }
      chunks.push(d);
      total += d.length;
    });
    proc.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new FfmpegMissingError(bin));
      else reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr, truncated });
    });
  });
}

export async function ffmpeg(
  args: string[],
  opts: { onStderr?: (c: string) => void; timeoutMs?: number } = {},
): Promise<RunResult> {
  const res = await run(FFMPEG, args, opts);
  if (res.code !== 0) {
    throw new FfmpegError(
      `ffmpeg exited with code ${res.code}: ${lastRealError(res.stderr)}`,
      args,
      res.stderr,
    );
  }
  return res;
}

/** Surface the meaningful line from FFmpeg's very chatty stderr. */
function lastRealError(stderr: string): string {
  const lines = stderr.trim().split('\n').filter(Boolean);
  const interesting = lines.filter(
    (l) =>
      /error|invalid|no such file|unable|failed|not found|cannot/i.test(l) &&
      !/^\s*(configuration|built with|lib\w+)/i.test(l),
  );
  return (interesting.pop() ?? lines.pop() ?? 'unknown error').trim().slice(0, 400);
}

/**
 * Escape a value embedded in an FFmpeg FILTER GRAPH argument.
 *
 * FFmpeg parses filter graphs in layers, so a path reaching e.g. `subtitles=`
 * is unescaped more than once. Characters needing protection: `\` `'` `:` `,`
 * `[` `]` `;` and `=`.
 *
 * The reliable, portable form is to wrap in single quotes and escape the
 * backslash, the single quote, and the colon:
 *   /tmp/a b/c'd:e.ass  →  '/tmp/a b/c\'d\:e.ass'
 *
 * Verified against paths containing spaces, apostrophes, colons, commas,
 * brackets, semicolons, `$`, `%` and non-ASCII characters — see
 * test/paths.test.ts, which renders real files for each case.
 */
export function escapeFilterValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
  return `'${escaped}'`;
}

/**
 * Escape text destined for `drawtext`, which has its own expansion rules on top
 * of filter-graph parsing. Not used for captions (we draw vector outlines
 * instead), but kept correct for diagnostics that do use drawtext.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "’") // a literal ' cannot survive drawtext reliably
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}
