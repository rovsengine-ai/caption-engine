import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from '../src/cli/args.js';
import { runPipeline, type Reporter } from '../src/cli/run.js';
import { initShaper } from '../src/text/shaper.js';
import { groupIntoCues } from '../src/captions/group.js';
import { buildCaptionFrames } from '../src/captions/svg.js';
import { resolveStyle } from '../src/captions/style.js';
import {
  tempDir, makeTestVideo, makeTestAudio, probeFile, hasFfmpeg, mkTranscript,
} from './helpers.js';
import type { Transcript } from '../src/types.js';

const skip = hasFfmpeg() ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

function silentLog(): Reporter {
  return { step() {}, info() {}, warn() {}, progress() {}, done() {} };
}

function writeTranscript(path: string, t: Transcript): string {
  writeFileSync(path, JSON.stringify(t, null, 2), 'utf8');
  return path;
}

before(async () => {
  await initShaper();
  tmp = tempDir('ce-pipeline-');
});
after(() => tmp?.cleanup());

// ---------------------------------------------------------------------------
// The `render` subcommand must be structurally incapable of billing the user.
// ---------------------------------------------------------------------------

describe('no-ASR guarantee', () => {
  test('render requires a transcript', () => {
    assert.throws(
      () => parseArgs(['render', 'in.mp4', '-o', 'out.mp4']),
      /requires --transcript/,
    );
  });

  test('render rejects --provider', () => {
    assert.throws(
      () => parseArgs(['render', 'in.mp4', '--transcript', 't.json', '--provider', 'elevenlabs']),
      /does not accept --provider/,
    );
  });

  test('render sets the noAsr flag', () => {
    const p = parseArgs(['render', 'in.mp4', '--transcript', 't.json']);
    assert.equal(p.command, 'run');
    if (p.command !== 'run') return;
    assert.equal(p.options.noAsr, true);
    assert.equal(p.options.transcriptIn, 't.json');
  });

  test('--transcript is an alias of --transcript-in', () => {
    const p = parseArgs(['in.mp4', '--transcript', 't.json']);
    if (p.command !== 'run') throw new Error('expected run');
    assert.equal(p.options.transcriptIn, 't.json');
  });

  test('a no-ASR run with no transcript is refused at runtime too', { skip }, async () => {
    // Belt and braces: even if arg parsing were bypassed, the pipeline refuses.
    const src = makeTestVideo(join(tmp.path, 'noasr.mp4'), { durationSec: 2 });
    const p = parseArgs([src, '--format', 'srt', '-o', join(tmp.path, 'x.srt')]);
    if (p.command !== 'run') throw new Error('expected run');
    p.options.noAsr = true;
    await assert.rejects(
      () => runPipeline(p.options, silentLog()),
      /Refusing to transcribe/,
    );
  });

  test('--transcript-in never constructs an ASR provider', { skip }, async () => {
    // Sabotage every provider env var. If any code path tried to build one,
    // it would throw MissingApiKeyError and this test would fail.
    const saved = {
      e: process.env.ELEVENLABS_API_KEY,
      d: process.env.DEEPGRAM_API_KEY,
      s: process.env.SARVAM_API_KEY,
      p: process.env.ASR_PROVIDER,
    };
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    delete process.env.ASR_PROVIDER;
    try {
      const src = makeTestVideo(join(tmp.path, 'reuse.mp4'), { durationSec: 3 });
      const tPath = writeTranscript(
        join(tmp.path, 'reuse.json'),
        mkTranscript([['आज', 0.3, 0.9], ['वीडियो', 1.0, 1.7]], 'hi', 3),
      );
      const p = parseArgs(['render', src, '--transcript', tPath, '--format', 'srt',
        '-o', join(tmp.path, 'reuse.srt')]);
      if (p.command !== 'run') throw new Error('expected run');
      const res = await runPipeline(p.options, silentLog());
      assert.equal(res.transcript.provider, 'fixture', 'transcript should come from the file');
      assert.ok(existsSync(res.outputs.srt!));
    } finally {
      if (saved.e) process.env.ELEVENLABS_API_KEY = saved.e;
      if (saved.d) process.env.DEEPGRAM_API_KEY = saved.d;
      if (saved.s) process.env.SARVAM_API_KEY = saved.s;
      if (saved.p) process.env.ASR_PROVIDER = saved.p;
    }
  });
});

// ---------------------------------------------------------------------------

describe('tooling reporting', () => {
  test('run result names the ffmpeg and rasteriser actually used', { skip }, async () => {
    const src = makeTestVideo(join(tmp.path, 'tool.mp4'), { durationSec: 2 });
    const tPath = writeTranscript(
      join(tmp.path, 'tool.json'),
      mkTranscript([['hello', 0.2, 0.8]], 'en', 2),
    );
    const p = parseArgs(['render', src, '--transcript', tPath, '-o', join(tmp.path, 'tool_out.mp4')]);
    if (p.command !== 'run') throw new Error('expected run');
    const res = await runPipeline(p.options, silentLog());
    assert.ok(res.tooling.ffmpeg.length > 0);
    assert.ok(['resvg', 'ffmpeg'].includes(res.tooling.rasteriser), res.tooling.rasteriser);
  });
});

describe('end-to-end output verification', { skip }, () => {
  test('final MP4 exists, is playable and carries synchronised audio', async () => {
    const src = makeTestVideo(join(tmp.path, 'e2e.mp4'), { durationSec: 6 });
    const tPath = writeTranscript(
      join(tmp.path, 'e2e.json'),
      mkTranscript([
        ['आज', 0.4, 1.0], ['का', 1.1, 1.5], ['वीडियो', 1.6, 2.4],
        ['बहुत', 3.0, 3.5], ['ख़ास', 3.6, 4.2],
      ], 'hi', 6),
    );
    const out = join(tmp.path, 'e2e_out.mp4');
    const p = parseArgs(['render', src, '--transcript', tPath, '-o', out]);
    if (p.command !== 'run') throw new Error('expected run');
    await runPipeline(p.options, silentLog());

    assert.ok(existsSync(out), 'no output file');
    assert.ok(statSync(out).size > 10_000, 'output suspiciously small');

    const probe = probeFile(out);
    assert.equal(probe.width, 1080);
    assert.equal(probe.height, 1920);
    assert.equal(probe.pixFmt, 'yuv420p', 'wrong pixel format for social playback');
    assert.ok(probe.hasVideo && probe.hasAudio, 'missing a stream');
    assert.ok(
      Math.abs(probe.durationSec - 6) < 0.5,
      `duration drifted: ${probe.durationSec}s vs source 6s`,
    );
  });

  test('audio and video durations stay within one frame of each other', async () => {
    const src = makeTestVideo(join(tmp.path, 'sync.mp4'), { durationSec: 5, fps: 30 });
    const tPath = writeTranscript(
      join(tmp.path, 'sync.json'),
      mkTranscript([['one', 0.3, 0.9], ['two', 1.2, 1.8], ['three', 2.4, 3.0]], 'en', 5),
    );
    const out = join(tmp.path, 'sync_out.mp4');
    const p = parseArgs(['render', src, '--transcript', tPath, '--aspect', 'original', '-o', out]);
    if (p.command !== 'run') throw new Error('expected run');
    await runPipeline(p.options, silentLog());

    const { execFileSync } = await import('node:child_process');
    const json = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_streams', out,
    ], { encoding: 'utf8' })) as {
      streams: Array<{ codec_type: string; duration?: string }>;
    };
    const v = Number(json.streams.find((s) => s.codec_type === 'video')?.duration ?? 0);
    const a = Number(json.streams.find((s) => s.codec_type === 'audio')?.duration ?? 0);
    assert.ok(v > 0 && a > 0, 'missing stream durations');
    assert.ok(
      Math.abs(v - a) < 0.15,
      `audio/video drift ${Math.abs(v - a).toFixed(3)}s (video ${v}s, audio ${a}s)`,
    );
  });

  test('SRT export is produced without touching the renderer', async () => {
    const src = makeTestAudio(join(tmp.path, 'srt.wav'), 4);
    const tPath = writeTranscript(
      join(tmp.path, 'srt.json'),
      mkTranscript([['नमस्ते', 0.3, 0.9], ['दुनिया', 1.0, 1.6]], 'hi', 4),
    );
    const out = join(tmp.path, 'out.srt');
    const p = parseArgs(['render', src, '--transcript', tPath, '--format', 'srt', '-o', out]);
    if (p.command !== 'run') throw new Error('expected run');
    const res = await runPipeline(p.options, silentLog());
    assert.ok(existsSync(out));
    const body = (await import('node:fs')).readFileSync(out, 'utf8');
    assert.match(body, /नमस्ते/, 'Devanagari should survive into the SRT');
    assert.match(body, /-->/);
    assert.equal(res.tooling.rasteriser, 'none (no video output)');
  });
});

describe('caption frame timing', () => {
  test('frames never overlap', async () => {
    const t = mkTranscript([
      ['a', 0.0, 0.4], ['b', 0.4, 0.8], ['c', 0.9, 1.4], ['d', 2.5, 3.0],
    ], 'en', 4);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    for (let i = 1; i < frames.length; i++) {
      assert.ok(
        frames[i]!.start >= frames[i - 1]!.end - 1e-6,
        `frame ${i - 1} ends ${frames[i - 1]!.end} after frame ${i} starts ${frames[i]!.start}`,
      );
    }
  });

  test('every frame carries its own dimensions for verification', async () => {
    const t = mkTranscript([['x', 0.1, 0.5]], 'en', 1);
    const style = resolveStyle('default', 1080);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1920, height: 1080, style, highlight: 'active-word',
    });
    assert.ok(frames.length > 0);
    for (const f of frames) {
      assert.equal(f.width, 1920);
      assert.equal(f.height, 1080);
    }
  });

  test('long pauses do not create frames spanning the silence', async () => {
    const t = mkTranscript([['before', 0.2, 0.7], ['after', 8.0, 8.6]], 'en', 9);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    const spanning = frames.find((f) => f.start < 1.0 && f.end > 7.5);
    assert.equal(spanning, undefined, 'a frame spanned a 7-second silence');
  });

  test('empty transcript produces no frames rather than throwing', async () => {
    const t = mkTranscript([], 'en', 5);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    assert.deepEqual(frames, []);
  });

  test('a very long caption still renders and wraps', async () => {
    const words: Array<[string, number, number]> = Array.from({ length: 25 }, (_, i) => [
      `word${i}`, i * 0.3, i * 0.3 + 0.25,
    ]);
    const t = mkTranscript(words, 'en', 9);
    const style = resolveStyle('default', 1920);
    const cues = groupIntoCues(t);
    const frames = await buildCaptionFrames(cues, {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    assert.ok(frames.length >= 25, `expected a frame per word, got ${frames.length}`);
    // No word may be dropped.
    const total = cues.reduce((n, c) => n + c.words.length, 0);
    assert.equal(total, 25);
  });

  test('overlapping word timings are clamped, not rendered on top of each other', async () => {
    const t: Transcript = {
      words: [
        { text: 'a', start: 0.0, end: 1.0, confidence: 1, type: 'word', keep: true },
        { text: 'b', start: 0.5, end: 1.5, confidence: 1, type: 'word', keep: true },
      ],
      language: 'en', duration: 2, provider: 'fixture', hasWordTimings: true,
    };
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    for (let i = 1; i < frames.length; i++) {
      assert.ok(frames[i]!.start >= frames[i - 1]!.end - 1e-6, 'overlapping frames emitted');
    }
    for (const f of frames) assert.ok(f.end > f.start, 'zero/negative-length frame');
  });
});
