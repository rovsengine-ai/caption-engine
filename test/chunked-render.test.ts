import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { planChunks, describeChunks } from '../src/render/chunker.js';
import { validateMedia, AtomicOutput } from '../src/render/validate.js';
import { renderVideo } from '../src/render/pipeline.js';
import { planCaptionFrames, renderPlannedFrame } from '../src/captions/svg.js';
import { groupIntoCues } from '../src/captions/group.js';
import { resolveStyle } from '../src/captions/style.js';
import { initShaper } from '../src/text/shaper.js';
import { autoTrim, applyTrim, keepSegments } from '../src/autotrim/index.js';
import {
  tempDir, makeTestVideo, makeTestAudio, probeFile, hasFfmpeg, extractFrame, inkPixelCount,
} from './helpers.js';
import type { Transcript, CaptionCue } from '../src/types.js';
import type { CaptionFramePlan } from '../src/captions/svg.js';

/**
 * Chunked rendering and output integrity.
 *
 * THE BUG THESE GUARD.
 *
 * The renderer used to build one filter_complex with `-i overlay.png` per
 * caption frame. Measured with `ulimit -n 256` (the macOS default):
 *
 *     200 overlays → exit 0, valid file
 *     400 overlays → exit 1, "Too many open files", 0-byte file left on disk
 *
 * The user then sees "moov atom not found" and reasonably concludes the video is
 * corrupt, when in truth the render never completed. Two independent failures,
 * so two independent sets of tests: bound the work per FFmpeg process, and never
 * publish a file that has not been proven playable.
 */

const skip = hasFfmpeg() ? undefined : 'ffmpeg not available';
let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-chunk-');
});
after(() => tmp?.cleanup());

function frames(n: number, spacing = 0.4, dur = 0.36): CaptionFramePlan[] {
  return Array.from({ length: n }, (_, i) => ({
    start: Number((i * spacing).toFixed(3)),
    end: Number((i * spacing + dur).toFixed(3)),
    cueIndex: Math.floor(i / 4),
    activeWordIndex: i % 4,
    width: 1080,
    height: 1920,
  }));
}

describe('chunk planning', () => {
  test('a long video is split so no chunk exceeds the caps', () => {
    // 1,200 frames over 465s — the reported failing case.
    const chunks = planChunks(frames(1200, 0.385), {
      maxOverlaysPerChunk: 80, maxChunkSeconds: 45, totalDurationSec: 465,
    });
    const d = describeChunks(chunks);
    assert.ok(d.count > 1, 'must actually split');
    assert.ok(d.maxOverlays <= 80, `chunk had ${d.maxOverlays} overlays`);
    assert.ok(d.maxSeconds <= 45.01, `chunk was ${d.maxSeconds}s`);
  });

  test('stays far below the ~250-overlay failure threshold', () => {
    const chunks = planChunks(frames(2000, 0.2), {
      maxOverlaysPerChunk: 80, maxChunkSeconds: 45, totalDurationSec: 400,
    });
    // 250 is where FFmpeg started failing on a default macOS descriptor limit.
    assert.ok(describeChunks(chunks).maxOverlays < 250);
  });

  test('chunks are contiguous — no gaps, no overlaps', () => {
    const chunks = planChunks(frames(500), {
      maxOverlaysPerChunk: 50, maxChunkSeconds: 30, totalDurationSec: 200,
    });
    let prev = 0;
    for (const c of chunks) {
      assert.ok(Math.abs(c.start - prev) < 0.005, `gap/overlap at ${prev} → ${c.start}`);
      assert.ok(c.end > c.start);
      prev = c.end;
    }
    assert.ok(Math.abs(prev - 200) < 0.01, `chunks end at ${prev}, expected 200`);
  });

  test('frame times are rebased to each chunk, never absolute', () => {
    const chunks = planChunks(frames(300), {
      maxOverlaysPerChunk: 40, maxChunkSeconds: 30, totalDurationSec: 120,
    });
    for (const c of chunks) {
      const len = c.end - c.start;
      for (const f of c.frames) {
        assert.ok(f.start >= -0.001, `negative start ${f.start} in chunk ${c.index}`);
        assert.ok(f.end <= len + 0.002, `frame end ${f.end} exceeds chunk length ${len}`);
      }
    }
  });

  test('a frame spanning a boundary appears in both chunks, clipped', () => {
    // One long frame straddling the 10s cut.
    const spanning: CaptionFramePlan[] = [
      { start: 0, end: 9.9, cueIndex: 0, activeWordIndex: 0, width: 100, height: 100 },
      { start: 9.9, end: 20, cueIndex: 1, activeWordIndex: 0, width: 100, height: 100 },
    ];
    const chunks = planChunks(spanning, {
      maxOverlaysPerChunk: 1, maxChunkSeconds: 60, totalDurationSec: 20,
    });
    assert.equal(chunks.length, 2);
    // Total on-screen time must be conserved across the split.
    const covered = chunks.reduce(
      (n, c) => n + c.frames.reduce((m, f) => m + (f.end - f.start), 0), 0,
    );
    assert.ok(Math.abs(covered - 20) < 0.05, `caption coverage ${covered}s, expected 20s`);
  });

  test('no frames is still one chunk covering the timeline', () => {
    const chunks = planChunks([], { maxOverlaysPerChunk: 80, maxChunkSeconds: 45, totalDurationSec: 12 });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.end, 12);
  });

  test('every frame is accounted for exactly once when none span a boundary', () => {
    const f = frames(200, 0.5, 0.4); // gaps between frames, so no straddling
    const chunks = planChunks(f, {
      maxOverlaysPerChunk: 30, maxChunkSeconds: 60, totalDurationSec: 100,
    });
    assert.equal(describeChunks(chunks).totalOverlays, 200);
  });
});

describe('output validation', { skip }, () => {
  test('a 0-byte file is rejected', async () => {
    const p = join(tmp.path, 'zero.mp4');
    writeFileSync(p, '');
    const v = await validateMedia(p, { video: true });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /0 bytes/);
  });

  test('a truncated MP4 (no moov atom) is rejected', async () => {
    // Real MP4 bytes, cut short so the moov atom never arrives — exactly the
    // artefact a killed FFmpeg leaves behind.
    const good = makeTestVideo(join(tmp.path, 'good.mp4'), { durationSec: 2 });
    const bytes = (await import('node:fs')).readFileSync(good);
    const p = join(tmp.path, 'truncated.mp4');
    writeFileSync(p, bytes.subarray(0, Math.floor(bytes.length / 3)));

    const v = await validateMedia(p, { video: true });
    assert.equal(v.ok, false, 'a truncated MP4 must not validate');
    assert.ok(v.sizeBytes > 0, 'this file is non-empty — size alone is not enough');
  });

  test('a missing file is rejected', async () => {
    const v = await validateMedia(join(tmp.path, 'nope.mp4'), { video: true });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /does not exist/);
  });

  test('a good file passes, with correct metadata', async () => {
    const p = makeTestVideo(join(tmp.path, 'ok.mp4'), { width: 640, height: 360, durationSec: 3 });
    const v = await validateMedia(p, {
      video: true, audio: true, expectedWidth: 640, expectedHeight: 360, requireYuv420p: true,
    });
    assert.ok(v.ok, v.problems.join('; '));
    assert.equal(v.pixFmt, 'yuv420p');
    assert.ok(v.durationSec > 2.5);
  });

  test('a wrong-size render is caught', async () => {
    const p = makeTestVideo(join(tmp.path, 'wrongsize.mp4'), { width: 320, height: 180, durationSec: 2 });
    const v = await validateMedia(p, { video: true, expectedWidth: 1080, expectedHeight: 1920 });
    assert.equal(v.ok, false);
    assert.match(v.problems.join(' '), /width|height/);
  });
});

describe('atomic output', { skip }, () => {
  test('a failed render leaves NO file at the output path', async () => {
    const out = join(tmp.path, 'never-created.mp4');
    const atomic = new AtomicOutput(out);
    writeFileSync(atomic.tempPath, ''); // simulate a died-early encoder

    await assert.rejects(() => atomic.publish({ video: true }), /invalid file and was discarded/);
    assert.ok(!existsSync(out), 'a corrupt file was published to the output path');
    assert.ok(!existsSync(atomic.tempPath), 'the temp file was not cleaned up');
  });

  test('a successful render is renamed into place', async () => {
    const out = join(tmp.path, 'published.mp4');
    const atomic = new AtomicOutput(out);
    makeTestVideo(atomic.tempPath, { durationSec: 2 });

    const v = await atomic.publish({ video: true });
    assert.ok(existsSync(out));
    assert.ok(!existsSync(atomic.tempPath));
    assert.equal(v.path, out);
  });

  test('refuses to overwrite the input file', () => {
    const same = join(tmp.path, 'same.mp4');
    assert.throws(() => new AtomicOutput(same, same), /same as the input/);
  });

  test('the temp file is hidden and unique, so parallel runs cannot collide', () => {
    const a = new AtomicOutput(join(tmp.path, 'x.mp4'));
    const b = new AtomicOutput(join(tmp.path, 'x.mp4'));
    assert.notEqual(a.tempPath, b.tempPath);
    // The extension must stay last so FFmpeg can infer the muxer.
    assert.match(a.tempPath, /\/\.x\.tmp-\d+-\d+-[0-9a-f]+\.mp4$/);
  });
});

describe('real chunked rendering', { skip }, () => {
  async function buildFrameSource(t: Transcript, width: number, height: number) {
    const cues: CaptionCue[] = groupIntoCues(t);
    const style = resolveStyle('default', height);
    const svgOpts = { width, height, style, highlight: 'active-word' as const };
    const plans = planCaptionFrames(cues, { width, height, highlight: 'active-word' });
    return {
      count: plans.length,
      plans,
      async get(i: number) {
        const p = plans[i]!;
        return { ...p, svg: await renderPlannedFrame(cues, p, svgOpts) };
      },
    };
  }

  test('renders across multiple chunks with correct duration and audio', async () => {
    const src = makeTestVideo(join(tmp.path, 'multi.mp4'), { durationSec: 20, fps: 24 });
    const words = Array.from({ length: 40 }, (_, i) => ({
      text: `w${i}`, start: i * 0.45, end: i * 0.45 + 0.4,
      confidence: 1, type: 'word' as const, keep: true,
    }));
    const t: Transcript = {
      words, language: 'en', duration: 20, provider: 'fixture', hasWordTimings: true,
    };
    const fs = await buildFrameSource(t, 640, 360);
    const out = join(tmp.path, 'multi_out.mp4');

    // Force many small chunks so the multi-chunk path is genuinely exercised.
    const res = await renderVideo({
      inputPath: src, outputPath: out, width: 640, height: 360,
      frames: fs, durationSec: 20, hasAudio: true,
      maxOverlaysPerChunk: 6, maxChunkSeconds: 4,
    });

    assert.ok(res.chunks > 3, `expected several chunks, got ${res.chunks}`);
    assert.ok(res.validation.ok, res.validation.problems.join('; '));

    const p = probeFile(out);
    assert.ok(p.hasVideo && p.hasAudio, 'audio must survive chunking');
    assert.ok(
      Math.abs(p.durationSec - 20) < 1.0,
      `duration ${p.durationSec}s drifted from 20s across chunk seams`,
    );
  });

  test('captions remain visible across a chunk boundary', async () => {
    const src = makeTestVideo(join(tmp.path, 'boundary.mp4'), { durationSec: 12, fps: 24 });
    // Continuous speech, so a caption is on screen at every boundary.
    const words = Array.from({ length: 24 }, (_, i) => ({
      text: `word${i}`, start: i * 0.5, end: i * 0.5 + 0.49,
      confidence: 1, type: 'word' as const, keep: true,
    }));
    const t: Transcript = {
      words, language: 'en', duration: 12, provider: 'fixture', hasWordTimings: true,
    };
    const fs = await buildFrameSource(t, 640, 360);
    const out = join(tmp.path, 'boundary_out.mp4');

    await renderVideo({
      inputPath: src, outputPath: out, width: 640, height: 360,
      frames: fs, durationSec: 12, hasAudio: true,
      maxOverlaysPerChunk: 5, maxChunkSeconds: 3, // boundaries around 3s, 6s, 9s
    });

    // Sample either side of an expected seam; both must still show ink.
    for (const at of [2.8, 3.2, 5.8, 6.2]) {
      const png = extractFrame(out, at, join(tmp.path, `b_${at}.png`));
      const ink = inkPixelCount(png, 200);
      assert.ok(ink > 200, `no caption visible at ${at}s (ink=${ink}) — lost at a chunk seam`);
    }
  });

  test('Auto Trim cuts still shorten the timeline when chunked', async () => {
    const src = makeTestVideo(join(tmp.path, 'trimchunk.mp4'), { durationSec: 24, fps: 24 });
    const words = [
      ...Array.from({ length: 10 }, (_, i) => ({
        text: `a${i}`, start: i * 0.4, end: i * 0.4 + 0.35,
        confidence: 1, type: 'word' as const, keep: true,
      })),
      // 8 seconds of silence here
      ...Array.from({ length: 10 }, (_, i) => ({
        text: `b${i}`, start: 12 + i * 0.4, end: 12 + i * 0.4 + 0.35,
        confidence: 1, type: 'word' as const, keep: true,
      })),
    ];
    const t: Transcript = {
      words, language: 'en', duration: 24, provider: 'fixture', hasWordTimings: true,
    };
    const trim = autoTrim(t);
    const segments = keepSegments(trim);
    const trimmed = applyTrim(t, trim);
    const fs = await buildFrameSource(trimmed, 640, 360);

    const out = join(tmp.path, 'trimchunk_out.mp4');
    const res = await renderVideo({
      inputPath: src, outputPath: out, width: 640, height: 360,
      frames: fs, segments, durationSec: trim.trimmedDuration, hasAudio: true,
      maxOverlaysPerChunk: 6, maxChunkSeconds: 4,
    });

    assert.ok(res.validation.ok, res.validation.problems.join('; '));
    const p = probeFile(out);
    assert.ok(
      p.durationSec < 20,
      `Auto Trim did not shorten the timeline: ${p.durationSec}s (source was 24s)`,
    );
    assert.ok(p.hasAudio);
  });

  test('portrait 1080x1920 output', async () => {
    const src = makeTestVideo(join(tmp.path, 'port.mp4'), { width: 1280, height: 720, durationSec: 6 });
    const words = Array.from({ length: 12 }, (_, i) => ({
      text: `p${i}`, start: i * 0.45, end: i * 0.45 + 0.4,
      confidence: 1, type: 'word' as const, keep: true,
    }));
    const t: Transcript = {
      words, language: 'en', duration: 6, provider: 'fixture', hasWordTimings: true,
    };
    const fs = await buildFrameSource(t, 1080, 1920);
    const out = join(tmp.path, 'port_out.mp4');

    const res = await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920,
      frames: fs, durationSec: 6, hasAudio: true,
      maxOverlaysPerChunk: 5, maxChunkSeconds: 2,
    });
    assert.equal(res.validation.width, 1080);
    assert.equal(res.validation.height, 1920);
    // yuv420p is what QuickTime and the social platforms require.
    assert.equal(res.validation.pixFmt, 'yuv420p');
  });

  test('audio-only input renders through the chunked path', async () => {
    const src = makeTestAudio(join(tmp.path, 'audio.wav'), 8);
    const words = Array.from({ length: 16 }, (_, i) => ({
      text: `s${i}`, start: i * 0.45, end: i * 0.45 + 0.4,
      confidence: 1, type: 'word' as const, keep: true,
    }));
    const t: Transcript = {
      words, language: 'en', duration: 8, provider: 'fixture', hasWordTimings: true,
    };
    const fs = await buildFrameSource(t, 640, 640);
    const out = join(tmp.path, 'audio_out.mp4');

    const res = await renderVideo({
      inputPath: src, outputPath: out, width: 640, height: 640,
      frames: fs, durationSec: 8, backgroundColor: '#101418', hasAudio: true,
      maxOverlaysPerChunk: 5, maxChunkSeconds: 3,
    });
    assert.ok(res.validation.ok, res.validation.problems.join('; '));
    assert.ok(res.validation.hasVideo && res.validation.hasAudio);
  });

  test('an impossible render leaves no output file behind', async () => {
    const out = join(tmp.path, 'should-not-exist.mp4');
    await assert.rejects(() =>
      renderVideo({
        inputPath: join(tmp.path, 'no-such-input.mp4'),
        outputPath: out, width: 640, height: 360, durationSec: 5,
      }),
    );
    assert.ok(!existsSync(out), 'a failed render published a file');
  });
});
