import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { activeWordWindows, resolveWordStyle } from '../src/captions/active.js';
import { planCaptionFrames } from '../src/captions/svg.js';
import { DEFAULT_STYLE } from '../src/captions/style.js';
import { parseArgs } from '../src/cli/args.js';
import { mkCue } from './helpers.js';

describe('shared active-word timing', () => {
  test('uses ASR word starts and holds exactly until the next word starts', () => {
    const cue = mkCue(['one', 'two', 'three']);
    cue.words[0]!.start = 1; cue.words[0]!.end = 1.2;
    cue.words[1]!.start = 1.55; cue.words[1]!.end = 1.75;
    cue.words[2]!.start = 2; cue.words[2]!.end = 2.3;
    cue.start = 1; cue.end = 2.4;
    const windows = activeWordWindows(cue);
    assert.deepEqual(windows.map((w) => [w.start, w.end]), [[1, 1.55], [1.55, 2], [2, 2.4]]);
    const frames = planCaptionFrames([cue], { width: 100, height: 100, highlight: 'active-word' });
    assert.deepEqual(frames.filter((f) => f.activeWordIndex >= 0).map((f) => [f.start, f.end]), [[1, 1.55], [1.55, 2], [2, 2.4]]);
  });

  test('resolves active color, real-bold request, and scale in one style', () => {
    const resting = resolveWordStyle(DEFAULT_STYLE, false, { activeBold: true, activeScale: 1.2 });
    const active = resolveWordStyle(DEFAULT_STYLE, true, { activeBold: true, activeScale: 1.2 });
    assert.equal(resting.bold, false);
    assert.equal(active.bold, true);
    assert.equal(active.color, DEFAULT_STYLE.activeColor);
    assert.equal(active.scale, 1.2);
  });
});

describe('active appearance CLI', () => {
  test('parses named font, active color and active-bold', () => {
    const parsed = parseArgs(['input.mp4', '--font', 'Noto Sans', '--active-color', 'ff00aa', '--active-bold']);
    assert.equal(parsed.command, 'run');
    if (parsed.command !== 'run') return;
    assert.equal(parsed.options.font, 'Noto Sans');
    assert.equal(parsed.options.activeColor, '#ff00aa');
    assert.equal(parsed.options.activeBold, true);
  });

  test('rejects malformed active color', () => {
    assert.throws(() => parseArgs(['input.mp4', '--active-color', 'blue']), /hex colour/);
  });
});
