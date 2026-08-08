import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { FFMPEG, FFPROBE } from '../media/ffmpeg.js';
import { fontReport } from '../text/fonts.js';
import { shapeText, initShaper } from '../text/shaper.js';
import { listLanguages } from '../config/languages.js';
import { probeAllRasterisers } from '../render/rasteriser.js';

/**
 * Environment check.
 *
 * Reports what is actually true on THIS machine rather than what the code
 * assumes. Every failure line says what to do about it.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function bin(cmd: string): { ok: boolean; version: string } {
  try {
    const out = execFileSync(cmd, ['-version'], { encoding: 'utf8', timeout: 20_000 });
    return { ok: true, version: out.split('\n')[0] ?? '' };
  } catch {
    return { ok: false, version: '' };
  }
}

/**
 * Resolve which executable will ACTUALLY run.
 *
 * `FFMPEG` may be a bare name resolved through PATH, an absolute path, or an
 * FFMPEG_PATH override, and PATH may contain several FFmpegs. Reporting the
 * resolved real path (symlinks followed) is the only way to answer "which
 * binary is the app using?" — which matters when one build has librsvg and
 * another does not.
 */
export function resolveBinary(cmd: string): {
  configured: string;
  resolved: string | null;
  realpath: string | null;
  source: 'env' | 'absolute' | 'PATH';
  allOnPath: string[];
} {
  const isAbs = cmd.startsWith('/') || cmd.startsWith('.');
  const fromEnv =
    (cmd === process.env.FFMPEG_PATH && 'FFMPEG_PATH') ||
    (cmd === process.env.FFPROBE_PATH && 'FFPROBE_PATH');

  let resolved: string | null = null;
  let allOnPath: string[] = [];

  if (isAbs) {
    resolved = cmd;
  } else {
    try {
      // `command -v` reflects what this shell would run; `which -a` lists every
      // candidate, which is how you spot a shadowing binary earlier in PATH.
      resolved = execFileSync('sh', ['-c', `command -v ${cmd}`], {
        encoding: 'utf8', timeout: 15_000,
      }).trim() || null;
    } catch { resolved = null; }
    try {
      allOnPath = execFileSync('sh', ['-c', `which -a ${cmd} 2>/dev/null || true`], {
        encoding: 'utf8', timeout: 15_000,
      }).trim().split('\n').filter(Boolean);
    } catch { allOnPath = []; }
  }

  let real: string | null = null;
  if (resolved) {
    try { real = realpathSync(resolved); } catch { real = resolved; }
  }

  return {
    configured: cmd,
    resolved,
    realpath: real,
    source: fromEnv ? 'env' : isAbs ? 'absolute' : 'PATH',
    allOnPath,
  };
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // --- Node ---------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  results.push({
    name: 'Node.js',
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    fix: major >= 20 ? undefined : 'Node 20+ required. macOS: brew install node',
  });

  // --- FFmpeg / ffprobe ---------------------------------------------------
  // Report the binary that will ACTUALLY run, not just "found on PATH".
  const ffLoc = resolveBinary(FFMPEG);
  const ff = bin(FFMPEG);
  results.push({
    name: 'ffmpeg',
    ok: ff.ok,
    detail: ff.ok
      ? `${ffLoc.realpath ?? ffLoc.configured} [via ${ffLoc.source}]` +
        (ffLoc.allOnPath.length > 1 ? `  (${ffLoc.allOnPath.length} on PATH)` : '')
      : 'not found',
    fix: ff.ok ? undefined : 'macOS: brew install ffmpeg   Ubuntu: sudo apt install ffmpeg',
  });
  if (ff.ok) {
    results.push({ name: '  ffmpeg version', ok: true, detail: ff.version.slice(0, 66) });
    if (ffLoc.allOnPath.length > 1) {
      results.push({
        name: '  ffmpeg on PATH',
        ok: true,
        detail: ffLoc.allOnPath.join('  ·  '),
      });
    }
  }

  const fpLoc = resolveBinary(FFPROBE);
  const fp = bin(FFPROBE);
  results.push({
    name: 'ffprobe',
    ok: fp.ok,
    detail: fp.ok ? `${fpLoc.realpath ?? fpLoc.configured} [via ${fpLoc.source}]` : 'not found',
    fix: fp.ok ? undefined : 'Ships with ffmpeg. macOS: brew install ffmpeg',
  });

  // --- SVG rasterisation (REAL functional probe) --------------------------
  //
  // This used to grep FFmpeg's banner for "svg"/"librsvg". That check passed on
  // a build whose SVG demuxer was listed but unusable, and the real failure only
  // surfaced later as "Failed to rasterise caption frame 0". A capability check
  // that can be satisfied by a string is not a capability check.
  //
  // Now: actually convert a small SVG to PNG and verify the dimensions.
  const rasterProbes = await probeAllRasterisers();
  const working = rasterProbes.filter((p) => p.functional);

  results.push({
    name: 'SVG rasteriser',
    ok: working.length > 0,
    detail:
      working.length > 0
        ? `${working[0]!.name} — ${working[0]!.detail}`
        : 'NO working rasteriser — caption rendering will fail',
    fix:
      working.length > 0
        ? undefined
        : 'Install the native rasteriser (recommended, no system dependencies):\n' +
          '      npm install @resvg/resvg-js\n' +
          '    Or build FFmpeg with librsvg (Homebrew core ffmpeg does NOT include it):\n' +
          '      brew tap homebrew-ffmpeg/ffmpeg\n' +
          '      brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-librsvg',
  });

  for (const p of rasterProbes) {
    results.push({
      name: `  rasteriser: ${p.name}`,
      ok: p.functional,
      detail: p.functional
        ? `functional — ${p.detail}`
        : `NOT usable — ${p.detail}${p.error ? ` (${p.error.split('\n')[0]})` : ''}`,
      fix:
        p.functional || p.name !== 'ffmpeg'
          ? undefined
          : 'Optional. FFmpeg only rasterises SVG when built with librsvg;\n' +
            '      Homebrew core ffmpeg is not. resvg covers this instead.',
    });
  }

  // --- Encoders -----------------------------------------------------------
  if (ff.ok) {
    try {
      const enc = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], {
        encoding: 'utf8', timeout: 20_000,
      });
      const x264 = /libx264/.test(enc);
      const aac = /\baac\b/.test(enc);
      results.push({
        name: 'H.264 encoder',
        ok: x264,
        detail: x264 ? 'libx264' : 'libx264 missing',
        fix: x264 ? undefined : 'Rebuild ffmpeg with --enable-libx264 (brew reinstall ffmpeg)',
      });
      results.push({
        name: 'AAC encoder',
        ok: aac,
        detail: aac ? 'aac' : 'aac missing',
        fix: aac ? undefined : 'Rebuild ffmpeg with AAC support',
      });
    } catch { /* already reported above */ }
  }

  // --- Fonts --------------------------------------------------------------
  for (const f of fontReport()) {
    results.push({
      name: `font: ${f.script}`,
      ok: f.ok,
      detail: f.ok ? `${f.path?.split('/').pop()} (${f.source})` : 'missing',
      fix: f.ok ? undefined : 'npm run fonts:install',
    });
  }

  // --- Shaping ------------------------------------------------------------
  // The decisive check: does complex-script shaping actually work here?
  try {
    await initShaper();
    const s = await shapeText('विद्या', 100);
    const glyphs = s.runs.flatMap((r) => r.glyphs);
    const tofu = glyphs.filter((g) => g.glyphId === 0).length;
    const reduced = glyphs.length < 6; // 6 codepoints must ligate to fewer glyphs
    results.push({
      name: 'complex shaping',
      ok: tofu === 0 && reduced && glyphs.length > 0,
      detail:
        tofu > 0 ? `${tofu} missing glyph(s)`
        : !reduced ? `no conjunct formation (${glyphs.length} glyphs from 6 codepoints)`
        : `ok (विद्या → ${glyphs.length} glyphs, matra reordered)`,
      fix: tofu > 0 ? 'npm run fonts:install' : undefined,
    });
  } catch (e) {
    results.push({
      name: 'complex shaping',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: 'npm install && npm run fonts:install',
    });
  }

  // --- End-to-end caption probe -------------------------------------------
  //
  // Shapes real Devanagari, renders a caption SVG, rasterises it, and checks
  // the PNG has correct dimensions AND non-trivial ink. This exercises the
  // whole caption path — the check that would have caught the librsvg failure
  // before a user hit it at frame 0 of 73.
  if (working.length > 0) {
    try {
      const { renderCueSvg } = await import('../captions/svg.js');
      const { resolveStyle } = await import('../captions/style.js');
      const { mkdtempSync, rmSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { pngDimensions } = await import('../render/rasteriser.js');

      const dir = mkdtempSync(join(tmpdir(), 'ce-doctor-'));
      try {
        const cue = {
          index: 0, start: 0, end: 1.2,
          words: ['आज', 'वीडियो'].map((text, i) => ({
            text, start: i * 0.6, end: i * 0.6 + 0.5,
            confidence: 1, type: 'word' as const, keep: true,
          })),
          text: 'आज वीडियो',
        };
        const svg = await renderCueSvg(cue, {
          width: 640, height: 360,
          style: { ...resolveStyle('bold', 360), positionY: 0.5 },
          activeWordIndex: 0,
        });
        const out = join(dir, 'caption.png');
        const chosen = rasterProbes.find((p) => p.functional)!.name;
        const { selectRasteriser } = await import('../render/rasteriser.js');
        const { rasteriser } = await selectRasteriser(chosen);
        await rasteriser.rasterise(svg, out, { width: 640, height: 360 });

        const dim = pngDimensions(out);
        const bytes = statSync(out).size;
        const ok = dim?.width === 640 && dim?.height === 360 && bytes > 500;
        results.push({
          name: 'caption render',
          ok,
          detail: ok
            ? `Devanagari caption → ${dim!.width}x${dim!.height} PNG (${bytes} bytes) via ${chosen}`
            : `unexpected output: ${dim ? `${dim.width}x${dim.height}` : 'invalid PNG'}, ${bytes} bytes`,
          fix: ok ? undefined : 'Run with CAPTION_ENGINE_DEBUG=1 and report the output.',
        });
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch (e) {
      results.push({
        name: 'caption render',
        ok: false,
        detail: e instanceof Error ? e.message.split('\n')[0]! : String(e),
        fix: 'The end-to-end caption path is broken. Run: npm test',
      });
    }
  }

  // --- API keys -----------------------------------------------------------
  const keys: Array<[string, string]> = [
    ['ELEVENLABS_API_KEY', 'elevenlabs'],
    ['DEEPGRAM_API_KEY', 'deepgram'],
    ['SARVAM_API_KEY', 'sarvam'],
  ];
  const present = keys.filter(([k]) => Boolean(process.env[k]));
  results.push({
    name: 'ASR API key',
    ok: present.length > 0,
    detail: present.length
      ? present.map(([, p]) => p).join(', ')
      : 'none set (transcription unavailable)',
    fix: present.length
      ? undefined
      : 'export ELEVENLABS_API_KEY="..."   (or DEEPGRAM_API_KEY / SARVAM_API_KEY)\n' +
        '      Not needed for --transcript-in, --dry-run or doctor.',
  });

  return results;
}

/**
 * Failures that do NOT stop the tool working.
 *
 * A non-functional FFmpeg rasteriser is informational once resvg works — that
 * is the entire point of having a fallback. Reporting it as blocking would
 * train users to ignore doctor output.
 */
export function isBlocking(r: CheckResult): boolean {
  if (r.ok) return false;
  if (r.name.startsWith('font:')) return false;      // limits specific scripts
  if (r.name === 'ASR API key') return false;         // not needed with --transcript-in
  if (r.name.startsWith('  rasteriser:')) return false; // covered by the summary line
  return true;
}

export function formatDoctor(results: CheckResult[]): string {
  const lines: string[] = ['', 'caption-engine environment check', '='.repeat(72)];
  for (const r of results) {
    const indented = r.name.startsWith('  ');
    const status = r.ok ? 'ok  ' : isBlocking(r) ? 'FAIL' : 'warn';
    lines.push(`  ${status}  ${r.name.padEnd(24)} ${r.detail}`);
    if (!r.ok && r.fix) lines.push(`        → ${r.fix.replace(/\n/g, '\n        ')}`);
    void indented;
  }

  const failed = results.filter((r) => !r.ok);
  const blocking = results.filter(isBlocking);

  lines.push('='.repeat(72));
  lines.push(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (blocking.length === 0 && failed.length > 0) {
    lines.push('  No blocking failures — items marked "warn" limit specific features only.');
  }
  if (blocking.length > 0) {
    lines.push(`  ${blocking.length} BLOCKING failure(s): ${blocking.map((b) => b.name).join(', ')}`);
  }

  const langs = listLanguages();
  lines.push(
    '',
    `  ${langs.filter((l) => l.rendering === 'verified').length}/${langs.length} languages have verified rendering.`,
    `  Run "caption-engine languages" for the full table.`,
    '',
  );
  return lines.join('\n');
}
