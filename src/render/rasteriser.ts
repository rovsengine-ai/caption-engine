import { writeFileSync, readFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FFMPEG, run } from '../media/ffmpeg.js';
import { CaptionEngineError } from '../errors.js';

/**
 * SVG → PNG rasterisation.
 *
 * WHY THIS IS ITS OWN MODULE — a real production failure, worth recording.
 *
 * Captions are generated as SVG (pre-shaped vector outlines; see
 * src/text/shaper.ts). Rasterising them originally went through FFmpeg's SVG
 * demuxer, which requires FFmpeg to be built with librsvg.
 *
 *   Ubuntu's ffmpeg package  → built --enable-librsvg  → worked
 *   Homebrew's core ffmpeg   → NO librsvg              → failed on every frame
 *
 * Homebrew's `ffmpeg` formula does not depend on librsvg; SVG input needs a
 * third-party tap built with `--with-librsvg`. So the pipeline worked on the
 * development host and failed on the platform users actually run, with the
 * unhelpful error "Failed to rasterise caption frame 0".
 *
 * Making the whole product depend on a non-default FFmpeg build is the wrong
 * trade. resvg (Rust) ships prebuilt N-API binaries for darwin-arm64,
 * darwin-x64, linux and windows, has zero system dependencies, and — because
 * our SVG contains only <path> and <rect>, never <text> — needs no font
 * database at all. Rasterisation is now completely independent of both FFmpeg's
 * build flags and the host's installed fonts.
 *
 * FFmpeg remains the fallback, but ONLY when a real functional probe proves it
 * works. It is never selected on the basis of a version string.
 */

export interface RasterOptions {
  /** Expected output width; used to verify the result, not to resize. */
  width: number;
  height: number;
}

export interface Rasteriser {
  readonly name: string;
  readonly description: string;
  rasterise(svg: string, outPath: string, opts: RasterOptions): Promise<void>;
}

export interface RasteriserProbe {
  name: string;
  available: boolean;
  /** Did a real SVG→PNG conversion succeed with correct dimensions? */
  functional: boolean;
  detail: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// resvg — primary
// ---------------------------------------------------------------------------

type ResvgCtor = new (svg: string | Buffer, opts?: unknown) => {
  render(): { asPng(): Buffer; width: number; height: number };
};

let resvgCtor: ResvgCtor | null | undefined;
let resvgLoadError: string | null = null;

async function loadResvg(): Promise<ResvgCtor | null> {
  if (resvgCtor !== undefined) return resvgCtor;
  try {
    const mod = (await import('@resvg/resvg-js')) as unknown as { Resvg: ResvgCtor };
    resvgCtor = mod.Resvg ?? null;
    if (!resvgCtor) resvgLoadError = 'module loaded but exported no Resvg class';
  } catch (e) {
    // Keep the REAL reason. resvg is a native N-API module whose binary is an
    // optional dependency chosen by platform; the common failure is a
    // node_modules populated for a different OS/arch (e.g. a folder synced
    // between macOS and Linux, or a lockfile installed with --force). Reporting
    // "not installed" for that case sends people down the wrong path.
    resvgLoadError = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    resvgCtor = null;
  }
  return resvgCtor;
}

/** Human-readable explanation of why resvg is unavailable, with the fix. */
function resvgUnavailableDetail(): string {
  const platform = `${process.platform}-${process.arch}`;
  const missing = resvgLoadError?.match(/Cannot find module '(@resvg\/[^']+)'/)?.[1];
  if (missing) {
    return (
      `native binary for this platform (${platform}) is missing: ${missing}. ` +
      `node_modules was probably installed for a different OS/arch`
    );
  }
  return resvgLoadError ?? `not installed (platform ${platform})`;
}

export class ResvgRasteriser implements Rasteriser {
  readonly name = 'resvg';
  readonly description = '@resvg/resvg-js (Rust, no system dependencies, no fonts required)';

  constructor(private readonly Ctor: ResvgCtor) {}

  async rasterise(svg: string, outPath: string, opts: RasterOptions): Promise<void> {
    // Transparent background — these PNGs are alpha-composited over video.
    const r = new this.Ctor(svg, {
      background: 'rgba(0,0,0,0)',
      fitTo: { mode: 'original' },
      // No font config: our SVG has no <text>, so no font lookup happens.
      // If that ever changes, resvg will silently drop the text — the
      // svg-has-no-text assertion in the test suite guards against it.
    });
    const img = r.render();
    if (img.width !== opts.width || img.height !== opts.height) {
      throw new CaptionEngineError(
        `Rasterised caption is ${img.width}x${img.height}, expected ${opts.width}x${opts.height}.`,
        'The SVG width/height attributes disagree with the requested frame size.',
      );
    }
    writeFileSync(outPath, img.asPng());
  }
}

// ---------------------------------------------------------------------------
// FFmpeg — fallback, only when functionally verified
// ---------------------------------------------------------------------------

export class FfmpegRasteriser implements Rasteriser {
  readonly name = 'ffmpeg';
  readonly description = `FFmpeg SVG demuxer (requires a build with librsvg): ${FFMPEG}`;

  async rasterise(svg: string, outPath: string, opts: RasterOptions): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'ce-raster-'));
    const svgPath = join(dir, 'frame.svg');
    try {
      writeFileSync(svgPath, svg, 'utf8');
      const args = ['-y', '-hide_banner', '-i', svgPath, '-frames:v', '1', outPath];
      const res = await run(FFMPEG, args, { timeoutMs: 120_000 });
      if (res.code !== 0 || !existsSync(outPath)) {
        throw new CaptionEngineError(
          `FFmpeg failed to rasterise SVG (exit ${res.code}).`,
          `Command:\n  ${FFMPEG} ${args.join(' ')}\n\n` +
            `stderr:\n  ${res.stderr.trim().split('\n').slice(-4).join('\n  ')}`,
        );
      }
      void opts;
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Functional probing
// ---------------------------------------------------------------------------

/**
 * A minimal SVG exercising exactly what caption frames use: a filled path, a
 * stroked path, and explicit dimensions. Deliberately NOT just a <rect> — a
 * renderer can handle rects and still mishandle path geometry.
 */
const PROBE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">' +
  '<path d="M2 2 L18 2 L18 18 L2 18 Z" fill="#ffffff"/>' +
  '<path d="M22 4 L36 4 L36 16 L22 16 Z" fill="none" stroke="#ff0000" stroke-width="2"/>' +
  '</svg>';

/**
 * Read a PNG's dimensions from the IHDR chunk. No image library needed.
 *
 * (This function previously used `require('node:fs')`, which is not defined in
 * an ES module — so it silently returned null and made every rasteriser look
 * broken. Imports at module scope only.)
 */
export function pngDimensions(path: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(path);
    // 8-byte signature, then IHDR: length(4) + type(4) + width(4) + height(4)
    if (buf.length < 24) return null;
    const isPng =
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
    if (!isPng) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * Real functional probe: rasterise → confirm the file exists, is non-trivial,
 * and has the exact expected dimensions.
 *
 * This deliberately does NOT grep FFmpeg's version banner for "svg". A build
 * can list the demuxer and still fail at runtime, and the string check is
 * exactly what let the librsvg problem reach users.
 */
export async function probeRasteriser(r: Rasteriser): Promise<RasteriserProbe> {
  const dir = mkdtempSync(join(tmpdir(), 'ce-probe-'));
  const out = join(dir, 'probe.png');
  try {
    await r.rasterise(PROBE_SVG, out, { width: 40, height: 20 });
    if (!existsSync(out)) {
      return { name: r.name, available: true, functional: false, detail: 'no output file produced' };
    }
    const size = statSync(out).size;
    if (size < 50) {
      return {
        name: r.name, available: true, functional: false,
        detail: `output file is only ${size} bytes`,
      };
    }
    const dim = pngDimensions(out);
    if (!dim) {
      return { name: r.name, available: true, functional: false, detail: 'output is not a valid PNG' };
    }
    if (dim.width !== 40 || dim.height !== 20) {
      return {
        name: r.name, available: true, functional: false,
        detail: `wrong dimensions: got ${dim.width}x${dim.height}, expected 40x20`,
      };
    }
    return {
      name: r.name, available: true, functional: true,
      detail: `rasterised 40x20 PNG (${size} bytes)`,
    };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return {
      name: r.name, available: true, functional: false,
      detail: 'rasterisation threw',
      error: err,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export interface RasteriserSelection {
  rasteriser: Rasteriser;
  probes: RasteriserProbe[];
}

let cached: RasteriserSelection | null = null;

/**
 * Choose a rasteriser, preferring resvg, falling back to FFmpeg only if FFmpeg
 * actually works. Never returns a rasteriser that has not passed the probe.
 */
export async function selectRasteriser(force?: string): Promise<RasteriserSelection> {
  if (cached && !force) return cached;

  const probes: RasteriserProbe[] = [];
  const candidates: Rasteriser[] = [];

  const Ctor = await loadResvg();
  if (Ctor) {
    candidates.push(new ResvgRasteriser(Ctor));
  } else {
    probes.push({
      name: 'resvg',
      available: false,
      functional: false,
      detail: resvgUnavailableDetail(),
      error: resvgLoadError ?? undefined,
    });
  }
  candidates.push(new FfmpegRasteriser());

  const wanted = force ?? process.env.CAPTION_ENGINE_RASTERISER;
  const ordered = wanted
    ? candidates.filter((c) => c.name === wanted)
    : candidates;

  if (wanted && ordered.length === 0) {
    throw new CaptionEngineError(
      `Unknown rasteriser "${wanted}".`,
      'Valid values: resvg, ffmpeg. Unset CAPTION_ENGINE_RASTERISER to auto-select.',
    );
  }

  for (const c of ordered) {
    const p = await probeRasteriser(c);
    probes.push(p);
    if (p.functional) {
      const sel = { rasteriser: c, probes };
      if (!force) cached = sel;
      return sel;
    }
  }

  throw new CaptionEngineError(
    'No working SVG rasteriser found. Caption rendering cannot proceed.',
    'Install the native rasteriser (recommended — no system dependencies):\n' +
      '  npm install @resvg/resvg-js\n' +
      `  (this platform is ${process.platform}-${process.arch}; if node_modules was\n` +
      '   installed on a different OS, remove it and reinstall:\n' +
      '     rm -rf node_modules package-lock.json && npm install)\n\n' +
      'Or build FFmpeg with librsvg (Homebrew core ffmpeg does NOT include it):\n' +
      '  brew tap homebrew-ffmpeg/ffmpeg\n' +
      '  brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-librsvg\n\n' +
      'Probe results:\n' +
      probes
        .map((p) => `  ${p.name}: ${p.detail}${p.error ? ` — ${p.error}` : ''}`)
        .join('\n'),
  );
}

/** Test seam. */
export function resetRasteriserCache(): void {
  cached = null;
}

/** All probe results, for `doctor`. Does not throw when nothing works. */
export async function probeAllRasterisers(): Promise<RasteriserProbe[]> {
  const out: RasteriserProbe[] = [];
  const Ctor = await loadResvg();
  if (Ctor) out.push(await probeRasteriser(new ResvgRasteriser(Ctor)));
  else {
    out.push({
      name: 'resvg',
      available: false,
      functional: false,
      detail: resvgUnavailableDetail(),
      error: resvgLoadError ?? undefined,
    });
  }
  out.push(await probeRasteriser(new FfmpegRasteriser()));
  return out;
}
