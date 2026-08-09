import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import { layoutCue, renderCueSvg } from '../src/captions/svg.js';
import { DEFAULT_STYLE } from '../src/captions/style.js';
import { initShaper } from '../src/text/shaper.js';
import type { ToneStyle } from '../src/captions/tone-style.js';
import { mkCue } from './helpers.js';

/**
 * Caption lines must not move while the highlight travels across them.
 *
 * THE FAILURE THIS PREVENTS. If a word's position depended on whether it is
 * currently active, then every frame of a cue would lay out differently and the
 * whole line would twitch sideways as the highlight advanced — most visibly
 * with --active-bold or --active-scale, where the active word is genuinely
 * wider than its resting self.
 *
 * The fix is `reservedWidth`: every word reserves the widest state it can ever
 * reach, so layout is a function of the CUE, never of which word is active.
 * These tests assert that property directly by laying out the same cue with
 * different active indices and comparing coordinates.
 *
 * Offline: shaping uses the vendored fonts. No FFmpeg, no network.
 */

const OPTS = {
  width: 1080,
  height: 1920,
  style: { ...DEFAULT_STYLE, fontSizePx: 64 },
};

before(async () => { await initShaper(); });

/** X positions of every word in the cue, in order. */
async function positions(opts: Parameters<typeof layoutCue>[1], words: string[]): Promise<number[]> {
  const lines = await layoutCue(mkCue(words), opts);
  return lines.flatMap((l) => l.words.map((w) => w.x));
}

describe('layout does not depend on which word is active', () => {
  const WORDS = ['this', 'is', 'a', 'caption', 'line'];

  test('positions are identical for every active index', async () => {
    const base = await positions({ ...OPTS, activeWordIndex: -1 }, WORDS);
    for (let i = 0; i < WORDS.length; i++) {
      const withActive = await positions({ ...OPTS, activeWordIndex: i }, WORDS);
      assert.deepEqual(withActive, base, `layout moved when word ${i} was active`);
    }
  });

  test('positions are identical with --active-scale', async () => {
    const o = { ...OPTS, activeScale: 1.25 };
    const base = await positions({ ...o, activeWordIndex: -1 }, WORDS);
    for (let i = 0; i < WORDS.length; i++) {
      const withActive = await positions({ ...o, activeWordIndex: i }, WORDS);
      assert.deepEqual(withActive, base, `scale moved the line when word ${i} was active`);
    }
  });

  test('positions are identical with --active-bold', async () => {
    // The hardest case: the active word uses a genuinely wider face.
    const o = { ...OPTS, activeBold: true };
    const base = await positions({ ...o, activeWordIndex: -1 }, WORDS);
    for (let i = 0; i < WORDS.length; i++) {
      const withActive = await positions({ ...o, activeWordIndex: i }, WORDS);
      assert.deepEqual(withActive, base, `bold moved the line when word ${i} was active`);
    }
  });

  test('reserved width is at least the resting width for every word', async () => {
    const lines = await layoutCue(mkCue(WORDS), { ...OPTS, activeScale: 1.25, activeBold: true });
    for (const line of lines) {
      for (const w of line.words) {
        assert.ok(
          w.reservedWidth >= w.width - 0.01,
          `word "${w.word.text}" reserved ${w.reservedWidth} but rests at ${w.width}`,
        );
      }
    }
  });

  test('a scaled active word reserves more room than an unscaled one', async () => {
    const plain = await layoutCue(mkCue(WORDS), { ...OPTS, activeScale: 1 });
    const scaled = await layoutCue(mkCue(WORDS), { ...OPTS, activeScale: 1.4 });
    const sum = (ls: typeof plain): number =>
      ls.flatMap((l) => l.words).reduce((n, w) => n + w.reservedWidth, 0);
    assert.ok(sum(scaled) > sum(plain), 'a larger active scale must reserve more width');
  });
});

describe('tone styling also cannot move the line', () => {
  const WORDS = ['tone', 'styled', 'caption', 'line'];
  const tones = new Map<number, ToneStyle>([[1, { bold: true, scale: 1.12 }]]);

  test('positions are stable across active indices when a tone is applied', async () => {
    const o = { ...OPTS, activeScale: 1.15, toneStyles: tones };
    const base = await positions({ ...o, activeWordIndex: -1 }, WORDS);
    for (let i = 0; i < WORDS.length; i++) {
      const withActive = await positions({ ...o, activeWordIndex: i }, WORDS);
      assert.deepEqual(withActive, base, `tone + active moved the line at word ${i}`);
    }
  });

  test('a toned word reserves room for its tone, not just its base size', async () => {
    const plain = await layoutCue(mkCue(WORDS), OPTS);
    const toned = await layoutCue(mkCue(WORDS), { ...OPTS, toneStyles: tones });
    const widthOf = (ls: typeof plain, i: number): number =>
      ls.flatMap((l) => l.words).find((w) => w.index === i)!.reservedWidth;
    assert.ok(
      widthOf(toned, 1) > widthOf(plain, 1),
      'the toned word must reserve extra width or it will overflow its slot',
    );
  });
});

describe('rendering stays correct while doing this', () => {
  test('every word appears in the SVG regardless of the active index', async () => {
    const cue = mkCue(['one', 'two', 'three']);
    for (let i = -1; i < 3; i++) {
      const svg = await renderCueSvg(cue, { ...OPTS, activeWordIndex: i });
      const paths = (svg.match(/<path /g) ?? []).length;
      assert.ok(paths > 0, `no glyphs rendered with active index ${i}`);
    }
  });

  test('Indic text lays out and renders without dropping words', async () => {
    const cue = mkCue(['ಇದು', 'ಒಂದು', 'ಪುಸ್ತಕ']);
    const lines = await layoutCue(cue, OPTS);
    const laidOut = lines.flatMap((l) => l.words).length;
    assert.equal(laidOut, 3, 'Indic words must survive layout');
    const svg = await renderCueSvg(cue, { ...OPTS, activeWordIndex: 1 });
    assert.match(svg, /<svg/);
    assert.ok((svg.match(/<path /g) ?? []).length > 0);
  });

  test('mixed Indic and English lays out every token', async () => {
    const cue = mkCue(['ಇದು', 'important', 'meeting', 'ಇದೆ']);
    const lines = await layoutCue(cue, OPTS);
    assert.equal(lines.flatMap((l) => l.words).length, 4);
  });

  test('no word is ever dropped, even when the cue overflows maxLines', async () => {
    const many = Array.from({ length: 24 }, (_, i) => `word${i}`);
    const lines = await layoutCue(mkCue(many), { ...OPTS, maxLines: 2 });
    assert.ok(lines.length <= 2, 'must respect maxLines');
    assert.equal(
      lines.flatMap((l) => l.words).length, many.length,
      'a too-long line is cosmetic; a missing word is a correctness bug',
    );
  });
});
