import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStyle, listStylePresets, STYLE_PRESETS, DEFAULT_STYLE,
  assertValidFontSize, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX,
} from '../src/captions/style.js';
import { CaptionEngineError } from '../src/errors.js';
import { parseArgs } from '../src/cli/args.js';

/**
 * Style presets and font-size validation.
 *
 * The bug this guards against: `resolveStyle` used to accept ANY value in
 * `overrides.fontSizePx` — including NaN, 0, negative numbers, or a value far
 * outside the range the shaper/rasteriser are ever exercised at — with no
 * check at all. The CLI's own `--font-size` parser caught obviously bad input
 * (non-numeric, out of 8-400), but any other caller of `resolveStyle` (tests,
 * or a future API embedding this engine) had no such protection, and an
 * invalid size only surfaced many steps later as an opaque failure out of
 * HarfBuzz or the SVG rasteriser — which is exactly the kind of report that
 * reads as "a specific word in a specific language broke," because the
 * failure shows up at the glyph-shaping step, not at the point the bad size
 * was supplied.
 */

describe('font size validation', () => {
  test('the CLI bounds and the style-layer bounds are the same constants', () => {
    // If these ever drift apart, a value that passes the CLI parser could
    // still fail deeper in the pipeline with a confusing error.
    assert.equal(MIN_FONT_SIZE_PX, 8);
    assert.equal(MAX_FONT_SIZE_PX, 400);
  });

  test('a value inside the range is accepted', () => {
    assert.doesNotThrow(() => assertValidFontSize(72));
    assert.doesNotThrow(() => assertValidFontSize(MIN_FONT_SIZE_PX));
    assert.doesNotThrow(() => assertValidFontSize(MAX_FONT_SIZE_PX));
  });

  for (const bad of [0, -10, MIN_FONT_SIZE_PX - 1, MAX_FONT_SIZE_PX + 1, NaN, Infinity, -Infinity]) {
    test(`rejects ${bad} with a typed, actionable error`, () => {
      assert.throws(() => assertValidFontSize(bad), (e: unknown) => {
        assert.ok(e instanceof CaptionEngineError, 'must be the typed error, not a raw Error');
        assert.ok((e as CaptionEngineError).hint, 'must carry a "how to fix" hint');
        assert.doesNotMatch((e as Error).stack ?? '', /^\s*$/, 'sanity: still a real Error');
        return true;
      });
    });
  }

  test('resolveStyle rejects an invalid font-size override before it reaches rendering', () => {
    assert.throws(
      () => resolveStyle('default', 1920, { fontSizePx: -5 }),
      /must be between 8 and 400/,
    );
    assert.throws(
      () => resolveStyle('default', 1920, { fontSizePx: NaN }),
      /must be a finite number/,
    );
  });

  test('resolveStyle accepts a valid custom font size and applies it exactly', () => {
    const style = resolveStyle('default', 1920, { fontSizePx: 100 });
    assert.equal(style.fontSizePx, 100, 'an explicit override is not re-scaled');
  });

  test('no override still scales the preset to the frame height, unaffected by validation', () => {
    const style = resolveStyle('default', 1080);
    assert.equal(style.fontSizePx, Math.round(DEFAULT_STYLE.fontSizePx * (1080 / 1920)));
  });

  test('the error names the actual offending value, not just "invalid"', () => {
    try {
      assertValidFontSize(-3);
      assert.fail('should have thrown');
    } catch (e) {
      assert.match((e as Error).message, /-3/);
    }
  });
});

describe('--font-size at the CLI layer', () => {
  test('a valid value parses through to options untouched', () => {
    const p = parseArgs(['in.mp4', '--transcript-in', 't.json', '--font-size', '96']);
    assert.equal(p.command, 'run');
    assert.equal(p.options.fontSize, 96);
  });

  test('the CLI rejects out-of-range values with a clear, user-facing message', () => {
    assert.throws(
      () => parseArgs(['in.mp4', '--font-size', '1']),
      (e: unknown) => {
        assert.ok(e instanceof CaptionEngineError);
        assert.match((e as Error).message, new RegExp(`>= ${MIN_FONT_SIZE_PX}`));
        return true;
      },
    );
    assert.throws(
      () => parseArgs(['in.mp4', '--font-size', '5000']),
      new RegExp(`<= ${MAX_FONT_SIZE_PX}`),
    );
  });

  test('the CLI rejects non-numeric values with a clear message, not a crash', () => {
    assert.throws(
      () => parseArgs(['in.mp4', '--font-size', 'huge']),
      /must be a number/,
    );
  });

  test('omitting --font-size falls back to the preset default (no forced value)', () => {
    const p = parseArgs(['in.mp4', '--transcript-in', 't.json']);
    assert.equal(p.command, 'run');
    assert.equal((p.options as { fontSize?: number }).fontSize, undefined);
  });
});

describe('style presets', () => {
  test('the original five presets still exist with their original look', () => {
    // Backward compatibility: existing renders must not silently change.
    assert.deepEqual(STYLE_PRESETS.default, {});
    assert.deepEqual(STYLE_PRESETS.bold, {
      fontSizePx: 84, outlineWidthPx: 8, uppercase: true,
      primaryColor: '#FFFFFF', activeColor: '#FFD400', maxWordsPerCue: 3,
    });
    assert.deepEqual(STYLE_PRESETS.minimal, {
      fontSizePx: 60, outlineWidthPx: 3, activeColor: '#FFFFFF',
      primaryColor: '#FFFFFF', maxWordsPerCue: 5,
    });
    assert.deepEqual(STYLE_PRESETS.neon, {
      fontSizePx: 78, primaryColor: '#FFFFFF', activeColor: '#00E5FF',
      outlineColor: '#001018', outlineWidthPx: 7,
    });
    assert.deepEqual(STYLE_PRESETS.classic, {
      fontSizePx: 54, primaryColor: '#FFFFFF', activeColor: '#FFFFFF',
      outlineColor: '#000000', outlineWidthPx: 4, positionY: 0.88, maxWordsPerCue: 8,
      maxCharsPerLine: 42,
    });
  });

  test('there are now more than five presets to choose from', () => {
    assert.ok(listStylePresets().length > 5, 'the preset library should have grown');
  });

  test('every preset resolves without throwing, at a few frame heights', () => {
    for (const name of listStylePresets()) {
      for (const height of [1080, 1920, 2160]) {
        assert.doesNotThrow(() => resolveStyle(name, height), `preset "${name}" failed at height ${height}`);
      }
    }
  });

  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  test('every preset has valid typography, colour and layout values', () => {
    for (const name of listStylePresets()) {
      const style = resolveStyle(name, 1920);
      assert.ok(
        style.fontSizePx >= MIN_FONT_SIZE_PX && style.fontSizePx <= MAX_FONT_SIZE_PX,
        `preset "${name}" fontSizePx ${style.fontSizePx} out of bounds`,
      );
      assert.ok(style.outlineWidthPx >= 1, `preset "${name}" outlineWidthPx must be at least 1`);
      assert.match(style.primaryColor, HEX, `preset "${name}" primaryColor must be valid hex`);
      assert.match(style.activeColor, HEX, `preset "${name}" activeColor must be valid hex`);
      assert.match(style.outlineColor, HEX, `preset "${name}" outlineColor must be valid hex`);
      assert.ok(style.positionY >= 0 && style.positionY <= 1, `preset "${name}" positionY must be in 0..1`);
      assert.ok(style.maxWordsPerCue >= 1, `preset "${name}" maxWordsPerCue must be positive`);
      assert.ok(style.maxCharsPerLine >= 1, `preset "${name}" maxCharsPerLine must be positive`);
      assert.ok(style.fontFamily.length > 0, `preset "${name}" must name a font family`);
    }
  });

  test('new presets still respect an explicit --font-size override', () => {
    for (const name of listStylePresets()) {
      const style = resolveStyle(name, 1920, { fontSizePx: 55 });
      assert.equal(style.fontSizePx, 55, `preset "${name}" should honour an explicit size override`);
    }
  });

  test('an unknown preset still fails loudly and lists real alternatives', () => {
    assert.throws(() => resolveStyle('not-a-real-preset', 1920), (e: unknown) => {
      assert.ok(e instanceof CaptionEngineError);
      const msg = (e as Error).message + (e as CaptionEngineError).hint;
      for (const name of listStylePresets()) assert.ok(msg.includes(name), `should list "${name}"`);
      return true;
    });
  });
});
