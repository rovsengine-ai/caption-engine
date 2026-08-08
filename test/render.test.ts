import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFfmpegArgs, extractAudioArgs } from '../src/render/ffmpeg.js';
import {
  chunkTranscript,
  parseClipResponse,
  dedupeCandidates,
  buildClipPrompt,
  DEFAULT_CLIP_OPTIONS,
} from '../src/clips/score.js';
import { hinglishTranscript } from './fixtures.js';

describe('ffmpeg arg builder', () => {
  test('simple passthrough render', () => {
    const args = buildFfmpegArgs({ inputPath: 'in.mp4', outputPath: 'out.mp4' });
    assert.ok(args.includes('-i'));
    assert.equal(args[args.length - 1], 'out.mp4');
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('yuv420p'), 'needed for social platform playback');
    assert.ok(args.includes('+faststart'), 'needed for progressive playback');
  });

  test('builds trim+concat for segments', () => {
    const args = buildFfmpegArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      segments: [
        { start: 0, end: 5 },
        { start: 10, end: 15 },
      ],
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(fc, /trim=start=0:end=5/);
    assert.match(fc, /trim=start=10:end=15/);
    assert.match(fc, /concat=n=2:v=1:a=1/);
  });

  test('resets PTS on every segment', () => {
    // Without setpts/asetpts, concat yields correct frames with broken timing.
    const args = buildFfmpegArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      segments: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    // Negative lookbehind: "asetpts" contains "setpts", so a naive match double-counts.
    assert.equal((fc.match(/(?<!a)setpts=PTS-STARTPTS/g) ?? []).length, 2, 'video PTS reset');
    assert.equal((fc.match(/asetpts=PTS-STARTPTS/g) ?? []).length, 2, 'audio PTS reset');
  });

  test('burns subtitles AFTER scaling', () => {
    // Order matters: the .ass declares the FINAL frame size, so scaling after
    // burn-in would resize the text too and throw font sizes off.
    const args = buildFfmpegArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      assPath: '/tmp/c.ass',
      width: 1080,
      height: 1920,
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    assert.ok(fc.indexOf('scale=') < fc.indexOf('subtitles='), 'scale must precede subtitles');
  });

  test('escapes colons in the subtitle path', () => {
    const args = buildFfmpegArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      assPath: 'C:/tmp/c.ass',
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(fc, /C\\:/, 'unescaped colons silently break the filter graph');
  });

  test('crops to a vertical aspect', () => {
    const args = buildFfmpegArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      targetAspect: 9 / 16,
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(fc, /crop=/);
    assert.match(fc, /min\(iw/, 'crop must stay inside the source frame');
  });

  test('crop focus clamps to 0..1', () => {
    const a = buildFfmpegArgs({
      inputPath: 'i.mp4', outputPath: 'o.mp4', targetAspect: 9 / 16, cropFocusX: 5,
    });
    const fc = a[a.indexOf('-filter_complex') + 1]!;
    assert.match(fc, /\*1(?![\d.])/, 'focus > 1 should clamp to 1');
  });

  test('audio extraction targets 16kHz mono', () => {
    const args = extractAudioArgs('in.mp4', 'out.wav');
    assert.ok(args.includes('-ar') && args.includes('16000'));
    assert.ok(args.includes('-ac') && args.includes('1'));
    assert.ok(args.includes('-vn'), 'never send video to the ASR');
  });
});

describe('clip finder', () => {
  test('chunks long transcripts with overlap', () => {
    const long = {
      ...hinglishTranscript,
      words: Array.from({ length: 3000 }, (_, i) => ({
        text: `w${i}`,
        start: i * 0.3,
        end: i * 0.3 + 0.25,
        confidence: 1,
        type: 'word' as const,
        keep: true,
      })),
      duration: 900,
    };
    const chunks = chunkTranscript(long, { chunkWords: 1200, chunkOverlapWords: 150 });
    assert.ok(chunks.length >= 2);
    assert.ok(
      chunks[1]!.startIndex < chunks[0]!.startIndex + 1200,
      'chunks must overlap so boundary moments are not missed',
    );
  });

  test('numbers words so the LLM can reference positions', () => {
    const chunks = chunkTranscript(hinglishTranscript, {
      chunkWords: 100,
      chunkOverlapWords: 10,
    });
    assert.match(chunks[0]!.numberedText, /\[0\]aaj/);
  });

  test('prompt instructs against assuming English conventions', () => {
    const chunks = chunkTranscript(hinglishTranscript, { chunkWords: 100, chunkOverlapWords: 10 });
    const p = buildClipPrompt(chunks[0]!, { ...DEFAULT_CLIP_OPTIONS, language: 'hi' });
    assert.match(p, /not English content|Do not assume English/i);
    assert.match(p, /self-contained/i);
  });

  test('parses a well-formed LLM response', () => {
    const long = {
      ...hinglishTranscript,
      words: Array.from({ length: 200 }, (_, i) => ({
        text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4,
        confidence: 1, type: 'word' as const, keep: true,
      })),
      duration: 100,
    };
    const raw = '{"clips":[{"startIndex":0,"endIndex":60,"score":85,"title":"Hook","reason":"Strong"}]}';
    const out = parseClipResponse(raw, long, DEFAULT_CLIP_OPTIONS);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.score, 85);
    assert.ok(out[0]!.end > out[0]!.start);
  });

  test('survives prose wrapped around the JSON', () => {
    const long = {
      ...hinglishTranscript,
      words: Array.from({ length: 200 }, (_, i) => ({
        text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4,
        confidence: 1, type: 'word' as const, keep: true,
      })),
      duration: 100,
    };
    const raw = 'Sure! Here are the clips:\n```json\n{"clips":[{"startIndex":0,"endIndex":60,"score":90,"title":"T","reason":"R"}]}\n```';
    assert.equal(parseClipResponse(raw, long, DEFAULT_CLIP_OPTIONS).length, 1);
  });

  test('rejects clips outside the duration bounds', () => {
    // The model returns out-of-range clips regardless of the prompt.
    const raw = '{"clips":[{"startIndex":0,"endIndex":2,"score":95,"title":"T","reason":"R"}]}';
    assert.equal(parseClipResponse(raw, hinglishTranscript, DEFAULT_CLIP_OPTIONS).length, 0);
  });

  test('returns empty on malformed JSON instead of throwing', () => {
    assert.deepEqual(parseClipResponse('not json', hinglishTranscript, DEFAULT_CLIP_OPTIONS), []);
    assert.deepEqual(parseClipResponse('{broken', hinglishTranscript, DEFAULT_CLIP_OPTIONS), []);
  });

  test('clamps scores into 0..100', () => {
    const long = {
      ...hinglishTranscript,
      words: Array.from({ length: 200 }, (_, i) => ({
        text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4,
        confidence: 1, type: 'word' as const, keep: true,
      })),
      duration: 100,
    };
    const raw = '{"clips":[{"startIndex":0,"endIndex":60,"score":9999,"title":"T","reason":"R"}]}';
    assert.equal(parseClipResponse(raw, long, DEFAULT_CLIP_OPTIONS)[0]!.score, 100);
  });

  test('dedupes overlapping candidates, keeping the best', () => {
    const out = dedupeCandidates([
      { start: 0, end: 30, score: 70, title: 'a', reason: '', transcriptExcerpt: '' },
      { start: 2, end: 31, score: 90, title: 'b', reason: '', transcriptExcerpt: '' },
      { start: 60, end: 90, score: 50, title: 'c', reason: '', transcriptExcerpt: '' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.title, 'b', 'higher score wins the overlap');
  });
});
