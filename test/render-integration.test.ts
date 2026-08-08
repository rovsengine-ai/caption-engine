import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  hasFfmpeg, tempDir, makeTestVideo, makeTestAudio, probeFile,
  extractFrame, inkPixelCount, mkCue, mkTranscript,
} from './helpers.js';
import { initShaper } from '../src/text/shaper.js';
import { renderCueSvg, buildCaptionFrames } from '../src/captions/svg.js';
import { renderVideo, renderPreviewFrame, buildBaseArgs, buildChunkArgs, buildConcatArgs } from '../src/render/pipeline.js';
import { resolveStyle, resolveOutput, OUTPUT_PRESETS } from '../src/captions/style.js';
import { groupIntoCues } from '../src/captions/group.js';
import { autoTrim, keepSegments, applyTrim } from '../src/autotrim/index.js';
import { probeMedia } from '../src/media/probe.js';
import { buildExtractArgs, extractAudio, needsExtraction } from '../src/media/extract.js';
import { escapeFilterValue } from '../src/media/ffmpeg.js';

/**
 * REAL rendering tests. These invoke FFmpeg and inspect the resulting pixels.
 *
 * The distinction matters: asserting that an SVG or .ass file contains the right
 * Unicode proves nothing about what a viewer sees. Everything here renders and
 * then measures actual ink.
 */

const FFMPEG_AVAILABLE = hasFfmpeg();
const skip = FFMPEG_AVAILABLE ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-render-');
});
after(() => tmp?.cleanup());

describe('base pass construction', () => {
  test('crop precedes scale', () => {
    const args = buildBaseArgs(
      { inputPath: 'a.mp4', outputPath: 'b.mp4', width: 1080, height: 1920, durationSec: 5 },
      '/tmp/base.mp4',
    );
    const f = args[args.indexOf('-filter_complex') + 1]!;
    assert.ok(f.indexOf('crop=') >= 0 && f.indexOf('scale=') > f.indexOf('crop='));
  });

  test('audio-only base uses the generated colour input, not a phantom label', () => {
    // Regression: an earlier version emitted [bg], a label never created.
    const args = buildBaseArgs(
      {
        inputPath: 'a.wav', outputPath: 'b.mp4', width: 1080, height: 1920,
        durationSec: 5, backgroundColor: '#101418',
      },
      '/tmp/base.mp4',
    );
    const f = args[args.indexOf('-filter_complex') + 1]!;
    assert.doesNotMatch(f, /\[bg\]/);
    assert.match(f, /\[1:v\]/);
    assert.ok(args.includes('-t'), 'infinite colour source must be bounded');
  });

  test('segments produce trim + PTS reset + concat', () => {
    const args = buildBaseArgs(
      {
        inputPath: 'a.mp4', outputPath: 'b.mp4', width: 640, height: 360,
        durationSec: 5, segments: [{ start: 0, end: 2 }, { start: 3, end: 5 }],
      },
      '/tmp/base.mp4',
    );
    const f = args[args.indexOf('-filter_complex') + 1]!;
    assert.equal((f.match(/(?<!a)setpts=PTS-STARTPTS/g) ?? []).length, 2);
    assert.equal((f.match(/asetpts=PTS-STARTPTS/g) ?? []).length, 2);
    assert.match(f, /concat=n=2:v=1:a=1/);
  });

  test('encoder flags required for QuickTime / social playback', () => {
    const args = buildBaseArgs(
      { inputPath: 'a.mp4', outputPath: 'b.mp4', width: 640, height: 360, durationSec: 3 },
      '/tmp/base.mp4',
    );
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.includes('+faststart'));
    assert.ok(args.includes('libx264'));
  });
});

describe('chunk pass construction', () => {
  const chunk = {
    index: 0, start: 10, end: 20,
    frames: [{ start: 1, end: 2, cueIndex: 0, activeWordIndex: 0, width: 1080, height: 1920 }],
    frameSourceIndices: [0],
  };

  test('seeks to the chunk and bounds its duration', () => {
    const args = buildChunkArgs('/tmp/base.mp4', chunk, ['/tmp/o0.png'], '/tmp/c0.mp4', {});
    assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'accurate seek goes before -i');
    assert.equal(args[args.indexOf('-ss') + 1], '10.000');
    assert.equal(args[args.indexOf('-t') + 1], '10.000');
  });

  test('overlay times are chunk-relative, not absolute', () => {
    const args = buildChunkArgs('/tmp/base.mp4', chunk, ['/tmp/o0.png'], '/tmp/c0.mp4', {});
    const f = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(f, /between\(t\\,1\.000\\,2\.000\)/, 'must use rebased times');
    assert.doesNotMatch(f, /11\.000/, 'absolute time leaked into the chunk');
  });

  test('chunks are video-only so audio is never re-encoded or split', () => {
    const args = buildChunkArgs('/tmp/base.mp4', chunk, ['/tmp/o0.png'], '/tmp/c0.mp4', {});
    assert.ok(args.includes('-an'), 'chunk must not carry audio');
  });
});

describe('concat pass construction', () => {
  test('stream-copies video and muxes base audio', () => {
    const args = buildConcatArgs('/tmp/list.txt', '/tmp/base.mp4', '/tmp/out.mp4', true);
    assert.ok(args.includes('concat'));
    assert.ok(args.includes('-c') && args.includes('copy'), 'no re-encode at concat');
    assert.ok(args.includes('0:v:0') && args.includes('1:a:0'));
  });

  test('omits the audio map when the source has none', () => {
    const args = buildConcatArgs('/tmp/list.txt', '/tmp/base.mp4', '/tmp/out.mp4', false);
    assert.ok(!args.includes('1:a:0'));
  });
});

describe('filter path escaping', () => {
  const CASES = [
    ['spaces', '/tmp/my file.ass'],
    ['apostrophe', "/tmp/it's.ass"],
    ['colon', '/tmp/a:b.ass'],
    ['backslash', '/tmp/a\\b.ass'],
    ['comma', '/tmp/a,b.ass'],
    ['bracket', '/tmp/a[b].ass'],
    ['unicode', '/tmp/वीडियो.ass'],
  ] as const;

  for (const [label, p] of CASES) {
    test(`${label} is wrapped and escaped`, () => {
      const e = escapeFilterValue(p);
      assert.ok(e.startsWith("'") && e.endsWith("'"), 'must be single-quoted');
      if (p.includes(':')) assert.match(e, /\\:/, 'colon must be escaped');
      if (p.includes("'")) assert.match(e, /\\'/, 'apostrophe must be escaped');
    });
  }
});

describe('audio extraction args', () => {
  test('targets 16 kHz mono PCM and drops non-audio streams', () => {
    const a = buildExtractArgs('in.mp4', 'out.wav');
    assert.ok(a.includes('-vn') && a.includes('-sn') && a.includes('-dn'));
    assert.equal(a[a.indexOf('-ar') + 1], '16000');
    assert.equal(a[a.indexOf('-ac') + 1], '1');
    assert.ok(a.includes('pcm_s16le'));
  });

  test('fast seek is placed before -i', () => {
    const a = buildExtractArgs('in.mp4', 'out.wav', { startSec: 10 });
    assert.ok(a.indexOf('-ss') < a.indexOf('-i'), '-ss after -i is the slow accurate seek');
  });
});

describe('output presets', () => {
  test('portrait / landscape / square dimensions', () => {
    assert.deepEqual(resolveOutput('portrait', {}), { width: 1080, height: 1920 });
    assert.deepEqual(resolveOutput('landscape', {}), { width: 1920, height: 1080 });
    assert.deepEqual(resolveOutput('square', {}), { width: 1080, height: 1080 });
  });

  test('original preserves source size', () => {
    assert.deepEqual(resolveOutput('original', { width: 1280, height: 720 }), {
      width: 1280, height: 720,
    });
  });

  test('original forces even dimensions for H.264', () => {
    const r = resolveOutput('original', { width: 1281, height: 721 });
    assert.equal(r.width % 2, 0);
    assert.equal(r.height % 2, 0);
  });

  test('style sizes scale with frame height', () => {
    const small = resolveStyle('bold', 960);
    const large = resolveStyle('bold', 1920);
    assert.ok(large.fontSizePx > small.fontSizePx, 'font should scale with output height');
  });
});

// ---------------------------------------------------------------------------
// Everything below runs FFmpeg for real.
// ---------------------------------------------------------------------------

describe('real rendering', { skip }, () => {
  test('caption frame rasterises with visible ink', async () => {
    const style = resolveStyle('bold', 1920);
    const svg = await renderCueSvg(mkCue(['आज', 'का', 'वीडियो']), {
      width: 1080, height: 600, style: { ...style, positionY: 0.5 }, activeWordIndex: 1,
    });
    const png = join(tmp.path, 'frame.png');
    await renderPreviewFrame(svg, png, '#000000', { width: 1080, height: 600 });
    assert.ok(existsSync(png));
    const ink = inkPixelCount(png);
    assert.ok(ink > 2000, `expected visible caption ink, got ${ink} px`);
  });

  test('every supported script produces visible ink (no invisible tofu)', async () => {
    const cases: Array<[string, string[]]> = [
      ['hi', ['आज', 'वीडियो']],
      ['te', ['నేను', 'చెప్తాను']],
      ['kn', ['ನಾನು', 'ಹೇಳ್ತೀನಿ']],
      ['ta', ['நான்', 'சொல்கிறேன்']],
      ['ml', ['ഞാൻ', 'പറയാം']],
      ['bn', ['আমি', 'বলছি']],
      ['gu', ['હું', 'કહીશ']],
      ['pa', ['ਮੈਂ', 'ਦੱਸਾਂਗਾ']],
      ['en', ['hello', 'world']],
    ];
    const style = { ...resolveStyle('bold', 1920), positionY: 0.5 };
    for (const [code, words] of cases) {
      const svg = await renderCueSvg(mkCue(words), {
        width: 1080, height: 400, style, activeWordIndex: 0,
      });
      const png = join(tmp.path, `ink_${code}.png`);
      await renderPreviewFrame(svg, png, '#000000', { width: 1080, height: 400 });
      const ink = inkPixelCount(png);
      assert.ok(ink > 1500, `${code}: only ${ink} ink px — glyphs may be missing`);
    }
  });

  test('video → captioned mp4, correct size, audio preserved', async () => {
    const src = makeTestVideo(join(tmp.path, 'src.mp4'), { durationSec: 4 });
    const t = mkTranscript([['आज', 0.3, 0.8], ['वीडियो', 0.9, 1.6], ['ख़ास', 1.7, 2.3]], 'hi', 4);
    const cues = groupIntoCues(t);
    const style = resolveStyle('bold', 1920);
    const frames = await buildCaptionFrames(cues, {
      width: 1080, height: 1920, style, highlight: 'active-word', activeScale: 1.08,
    });
    const out = join(tmp.path, 'out.mp4');
    await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920,
      frames, durationSec: 4,
    });

    const p = probeFile(out);
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.ok(p.hasAudio, 'audio stream was lost');
    assert.equal(p.pixFmt, 'yuv420p');
    assert.ok(Math.abs(p.durationSec - 4) < 0.6, `duration ${p.durationSec}s, expected ~4s`);
  });

  test('captions are actually burned into the video pixels', async () => {
    const src = makeTestVideo(join(tmp.path, 'src2.mp4'), { durationSec: 4 });
    const t = mkTranscript([['आज', 0.3, 1.2], ['वीडियो', 1.4, 2.4]], 'hi', 4);
    const style = resolveStyle('bold', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    const out = join(tmp.path, 'burned.mp4');
    await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920, frames, durationSec: 4,
    });

    // A frame during speech must contain more ink than one after it ends.
    const during = extractFrame(out, 0.8, join(tmp.path, 'during.png'));
    const after = extractFrame(out, 3.6, join(tmp.path, 'after.png'));
    const inkDuring = inkPixelCount(during, 200);
    const inkAfter = inkPixelCount(after, 200);
    assert.ok(
      inkDuring > inkAfter + 1000,
      `captions not visible: during=${inkDuring} after=${inkAfter}`,
    );
  });

  test('audio-only input renders video of exactly the audio duration', async () => {
    const src = makeTestAudio(join(tmp.path, 'a.wav'), 5);
    const t = mkTranscript([['नमस्ते', 0.4, 1.0], ['दुनिया', 1.2, 2.0]], 'hi', 5);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    const out = join(tmp.path, 'audio.mp4');
    await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920,
      frames, durationSec: 5, backgroundColor: '#101418',
    });
    const p = probeFile(out);
    assert.ok(p.hasVideo && p.hasAudio);
    assert.ok(
      Math.abs(p.durationSec - 5) < 0.35,
      `audio-only output ${p.durationSec}s, expected 5s`,
    );
  });

  for (const preset of ['portrait', 'landscape', 'square'] as const) {
    test(`renders ${preset} (${OUTPUT_PRESETS[preset].width}x${OUTPUT_PRESETS[preset].height})`, async () => {
      const src = makeTestVideo(join(tmp.path, `s_${preset}.mp4`), {
        width: 1280, height: 720, durationSec: 3,
      });
      const { width, height } = resolveOutput(preset, { width: 1280, height: 720 });
      const t = mkTranscript([['test', 0.3, 0.9], ['caption', 1.0, 1.8]], 'en', 3);
      const style = resolveStyle('bold', height);
      const frames = await buildCaptionFrames(groupIntoCues(t), {
        width, height, style, highlight: 'active-word',
      });
      const out = join(tmp.path, `o_${preset}.mp4`);
      await renderVideo({ inputPath: src, outputPath: out, width, height, frames, durationSec: 3 });
      const p = probeFile(out);
      assert.equal(p.width, width);
      assert.equal(p.height, height);
    });
  }

  test('auto-trim shortens the rendered file by the removed amount', async () => {
    const src = makeTestVideo(join(tmp.path, 'trim.mp4'), { durationSec: 10 });
    const t = mkTranscript([
      ['hello', 0.3, 0.8], ['world', 0.9, 1.4],
      // 5s of silence here
      ['again', 6.5, 7.0], ['now', 7.1, 7.6],
    ], 'en', 10);
    const trim = autoTrim(t);
    const segments = keepSegments(trim);
    const trimmed = applyTrim(t, trim);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(trimmed), {
      width: 1080, height: 1920, style, highlight: 'active-word',
    });
    const out = join(tmp.path, 'trimmed.mp4');
    await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920,
      frames, segments, durationSec: trim.trimmedDuration,
    });
    const p = probeFile(out);
    assert.ok(
      p.durationSec < 9,
      `expected trimming to shorten below 9s, got ${p.durationSec}s`,
    );
    assert.ok(p.hasAudio, 'audio lost during trim/concat');
  });

  test('output paths with spaces, quotes and unicode render successfully', async () => {
    const dir = join(tmp.path, "weird dir's :name");
    mkdirSync(dir, { recursive: true });
    const src = makeTestVideo(join(tmp.path, 'p.mp4'), { durationSec: 2 });
    const t = mkTranscript([['ok', 0.2, 0.8]], 'en', 2);
    const style = resolveStyle('default', 1920);
    const frames = await buildCaptionFrames(groupIntoCues(t), {
      width: 1080, height: 1920, style, highlight: 'none',
    });
    const out = join(dir, "आउट put's :file.mp4");
    await renderVideo({
      inputPath: src, outputPath: out, width: 1080, height: 1920, frames, durationSec: 2,
    });
    assert.ok(existsSync(out) && statSync(out).size > 1000);
  });
});

describe('media probing', { skip }, () => {
  test('detects a video file', async () => {
    const src = makeTestVideo(join(tmp.path, 'probe.mp4'), { width: 640, height: 360, durationSec: 3 });
    const info = await probeMedia(src);
    assert.equal(info.kind, 'video');
    assert.equal(info.hasVideo, true);
    assert.equal(info.hasAudio, true);
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
  });

  test('detects an audio-only file', async () => {
    const src = makeTestAudio(join(tmp.path, 'probe.wav'), 3);
    const info = await probeMedia(src);
    assert.equal(info.kind, 'audio');
    assert.equal(info.hasVideo, false);
    assert.equal(info.hasAudio, true);
  });

  test('rejects a non-media file with an actionable error', async () => {
    const f = join(tmp.path, 'notmedia.txt');
    writeFileSync(f, 'this is not media');
    await assert.rejects(() => probeMedia(f), /Unsupported input format/);
  });

  test('rejects an empty file', async () => {
    const f = join(tmp.path, 'empty.mp4');
    writeFileSync(f, '');
    await assert.rejects(() => probeMedia(f), /empty/i);
  });

  test('rejects a missing file', async () => {
    await assert.rejects(() => probeMedia(join(tmp.path, 'nope.mp4')), /not found/i);
  });

  test('needsExtraction is false only for 16k mono PCM', async () => {
    const wav = makeTestAudio(join(tmp.path, 'ne.wav'), 2);
    const info = await probeMedia(wav);
    // The generated file is 44.1k stereo, so it must be re-encoded.
    assert.equal(needsExtraction(info), true);
  });

  test('extractAudio produces a readable 16k mono wav', async () => {
    const src = makeTestVideo(join(tmp.path, 'ex.mp4'), { durationSec: 3 });
    const out = join(tmp.path, 'ex.wav');
    await extractAudio(src, out);
    const info = await probeMedia(out);
    assert.equal(info.hasAudio, true);
    const a = info.streams.find((s) => s.type === 'audio')!;
    assert.equal(a.sampleRate, 16000);
    assert.equal(a.channels, 1);
  });
});
