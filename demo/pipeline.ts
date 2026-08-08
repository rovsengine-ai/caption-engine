/**
 * End-to-end demo, no API keys required.
 *
 * Uses a fixture transcript (what Scribe would return) and drives the ENTIRE
 * downstream pipeline: Auto Trim → re-time → cue grouping → ASS → FFmpeg render.
 * Produces a real MP4 with burned-in word-timed captions.
 *
 *   npm run demo
 *
 * Swap `fixtureTranscript` for a real `provider.transcribe(audio)` call once you
 * have a key, and nothing else in this file changes. That's the point of the
 * vendor-neutral schema.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoTrim, applyTrim, keepSegments } from '../src/autotrim/index.js';
import { groupIntoCues, DEFAULT_STYLE } from '../src/captions/group.js';
import { buildAss, buildSrt } from '../src/captions/ass.js';
import { buildFfmpegArgs, runFfmpeg } from '../src/render/ffmpeg.js';
import type { Transcript } from '../src/types.js';

const OUT = join(process.cwd(), 'demo-out');
mkdirSync(OUT, { recursive: true });

const W = 1080;
const H = 1920;

const fixtureTranscript: Transcript = {
  provider: 'fixture',
  model: 'demo',
  hasWordTimings: true,
  language: 'hi',
  duration: 16.0,
  words: [
    ['aaj', 0.5, 0.8], ['main', 0.8, 1.1],
    ['aaj', 1.3, 1.6], ['main', 1.6, 1.9],            // repeated take
    ['aapko', 1.9, 2.3], ['ek', 2.3, 2.5],
    ['important', 2.5, 3.1], ['cheez', 3.1, 3.5],     // English inside Hindi
    ['batata', 3.5, 3.9], ['hoon.', 3.9, 4.3],
    ['matlab', 5.0, 5.4],                              // filler after a pause
    ['um', 5.6, 5.8],                                  // always-filler
    ['ye', 6.0, 6.2], ['bahut', 6.2, 6.6],
    ['khaas', 6.6, 7.0], ['hai.', 7.0, 7.3],
    // 3s dead air
    ['iska', 10.3, 10.7], ['matlab', 10.7, 11.1],      // real word — must survive
    ['hai', 11.1, 11.4], ['success.', 11.4, 12.0],
  ].map(([text, start, end]) => ({
    text: text as string,
    start: start as number,
    end: end as number,
    confidence: 0.95,
    type: 'word' as const,
    keep: true,
  })),
};

async function main() {
  console.log('caption-engine demo\n' + '='.repeat(60));

  // ---- 1. Auto Trim --------------------------------------------------------
  const trim = autoTrim(fixtureTranscript);
  console.log(`\n[1] Auto Trim — ${trim.cuts.length} cuts proposed`);
  for (const c of trim.cuts) {
    console.log(`      ${c.start.toFixed(2)}s → ${c.end.toFixed(2)}s  ${c.reason.padEnd(12)} ${c.label}`);
  }
  console.log(
    `    ${trim.originalDuration}s → ${trim.trimmedDuration}s ` +
      `(removed ${trim.secondsRemoved}s, ${Math.round((trim.secondsRemoved / trim.originalDuration) * 100)}%)`,
  );

  const survived = fixtureTranscript.words.filter(
    (w) => w.text === 'matlab' && !trim.cuts.some((c) => w.start >= c.start && w.end <= c.end),
  );
  console.log(
    `    ambiguity check: "matlab" kept ${survived.length}× (the real-word use), cut where it was hesitation`,
  );

  // ---- 2. Re-time onto the trimmed timeline --------------------------------
  const trimmed = applyTrim(fixtureTranscript, trim);
  const segments = keepSegments(trim);
  console.log(`\n[2] Kept segments: ${segments.map((s) => `${s.start}-${s.end}`).join(', ')}`);

  // ---- 3. Group into cues --------------------------------------------------
  const cues = groupIntoCues(trimmed);
  console.log(`\n[3] ${cues.length} caption cues`);
  for (const c of cues) {
    console.log(`      ${c.start.toFixed(2)}-${c.end.toFixed(2)}  "${c.text}"`);
  }

  // ---- 4. Generate subtitles ----------------------------------------------
  const ass = buildAss(cues, {
    video: { width: W, height: H },
    style: { ...DEFAULT_STYLE, fontSizePx: 76, activeColor: '#FFD400' },
  });
  const assPath = join(OUT, 'captions.ass');
  writeFileSync(assPath, ass, 'utf8');
  writeFileSync(join(OUT, 'captions.srt'), buildSrt(cues), 'utf8');
  console.log(`\n[4] Wrote captions.ass (${ass.split('\n').length} lines) and captions.srt`);

  // ---- 5. Render -----------------------------------------------------------
  // Synthesise a source clip so the demo runs with no input file.
  const srcPath = join(OUT, 'source.mp4');
  const mk = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x101418:s=${W}x${H}:d=${fixtureTranscript.duration}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${fixtureTranscript.duration}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    srcPath,
  ]);
  if (mk.code !== 0) throw new Error(`source generation failed:\n${mk.stderr.slice(-1500)}`);

  const outPath = join(OUT, 'captioned.mp4');
  const args = buildFfmpegArgs({
    inputPath: srcPath,
    outputPath: outPath,
    segments,
    assPath,
    width: W,
    height: H,
    fps: 30,
  });
  console.log(`\n[5] ffmpeg ${args.slice(0, 4).join(' ')} ... (${args.length} args)`);

  const res = await runFfmpeg(args);
  if (res.code !== 0) throw new Error(`render failed:\n${res.stderr.slice(-2500)}`);

  console.log(`\n✓ Rendered ${outPath}`);
  console.log(`  Source ${fixtureTranscript.duration}s → output ~${trim.trimmedDuration}s (cuts applied)`);
}

main().catch((err) => {
  console.error('\n✗ demo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
