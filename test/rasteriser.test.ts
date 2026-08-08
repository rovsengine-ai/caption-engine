import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  selectRasteriser, probeRasteriser, probeAllRasterisers, pngDimensions,
  ResvgRasteriser, FfmpegRasteriser, resetRasteriserCache,
} from '../src/render/rasteriser.js';
import { renderCueSvg } from '../src/captions/svg.js';
import { resolveStyle } from '../src/captions/style.js';
import { initShaper } from '../src/text/shaper.js';
import { tempDir, mkCue, hasFfmpeg } from './helpers.js';

/**
 * Rasterisation tests.
 *
 * These exist because of a real production failure: caption rasterisation went
 * through FFmpeg's SVG demuxer, which needs a librsvg-enabled build. Ubuntu's
 * ffmpeg has one; Homebrew's core ffmpeg does not. The old doctor check grepped
 * the version banner for "svg" and passed anyway, so the first sign of trouble
 * was "Failed to rasterise caption frame 0" on a user's Mac.
 *
 * Every check here is FUNCTIONAL — actually convert SVG to PNG and inspect the
 * bytes. Nothing asserts on a version string.
 */

let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-raster-test-');
});
after(() => tmp?.cleanup());

describe('PNG header parsing', () => {
  test('reads dimensions from a real PNG', async () => {
    const { rasteriser } = await selectRasteriser();
    const out = join(tmp.path, 'dim.png');
    await rasteriser.rasterise(
      '<svg xmlns="http://www.w3.org/2000/svg" width="123" height="45" viewBox="0 0 123 45">' +
        '<path d="M0 0 L123 0 L123 45 Z" fill="#fff"/></svg>',
      out,
      { width: 123, height: 45 },
    );
    assert.deepEqual(pngDimensions(out), { width: 123, height: 45 });
  });

  test('returns null for a non-PNG file', () => {
    const f = join(tmp.path, 'notpng.bin');
    writeFileSync(f, Buffer.from('this is definitely not a png at all'));
    assert.equal(pngDimensions(f), null);
  });

  test('returns null for a truncated file', () => {
    const f = join(tmp.path, 'trunc.png');
    writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(pngDimensions(f), null);
  });

  test('returns null for a missing file', () => {
    assert.equal(pngDimensions(join(tmp.path, 'nope.png')), null);
  });

  test('rejects a file with a PNG signature but no IHDR', () => {
    const f = join(tmp.path, 'fake.png');
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.write('XXXX', 12, 'ascii');
    writeFileSync(f, b);
    assert.equal(pngDimensions(f), null);
  });
});

describe('rasteriser selection', () => {
  test('at least one rasteriser is functional', async () => {
    const probes = await probeAllRasterisers();
    const working = probes.filter((p) => p.functional);
    assert.ok(
      working.length > 0,
      `no working rasteriser:\n${probes.map((p) => `  ${p.name}: ${p.detail}`).join('\n')}`,
    );
  });

  test('resvg is preferred when available', async () => {
    resetRasteriserCache();
    const probes = await probeAllRasterisers();
    const resvg = probes.find((p) => p.name === 'resvg');
    if (!resvg?.functional) return; // platform without a prebuilt binary
    const { rasteriser } = await selectRasteriser();
    assert.equal(
      rasteriser.name, 'resvg',
      'resvg must win: it needs no system libraries and no fonts',
    );
  });

  test('probe verifies dimensions, not just that a file appeared', async () => {
    // A rasteriser that writes a valid but wrong-sized PNG must FAIL the probe.
    const liar = {
      name: 'liar',
      description: 'writes the wrong size',
      async rasterise(_svg: string, outPath: string) {
        const { rasteriser } = await selectRasteriser();
        await rasteriser.rasterise(
          '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="7" viewBox="0 0 7 7">' +
            '<path d="M0 0 L7 0 L7 7 Z" fill="#fff"/></svg>',
          outPath,
          { width: 7, height: 7 },
        );
      },
    };
    const p = await probeRasteriser(liar);
    assert.equal(p.functional, false);
    assert.match(p.detail, /wrong dimensions/);
  });

  test('probe reports failure rather than throwing', async () => {
    const broken = {
      name: 'broken',
      description: 'always throws',
      async rasterise() { throw new Error('deliberate failure'); },
    };
    const p = await probeRasteriser(broken);
    assert.equal(p.functional, false);
    assert.match(p.error ?? '', /deliberate failure/);
  });

  test('unknown forced rasteriser is rejected with valid options', async () => {
    await assert.rejects(
      () => selectRasteriser('definitely-not-a-rasteriser'),
      /Unknown rasteriser/,
    );
  });

  test('an explicitly forced rasteriser is honoured', async () => {
    const probes = await probeAllRasterisers();
    for (const p of probes.filter((x) => x.functional)) {
      const { rasteriser } = await selectRasteriser(p.name);
      assert.equal(rasteriser.name, p.name);
    }
  });
});

describe('SVG content requirements', () => {
  test('caption SVG contains NO <text> elements', async () => {
    // Load-bearing: resvg renders without any font database ONLY because all
    // glyphs are vector outlines. A stray <text> element would silently vanish.
    const style = resolveStyle('bold', 1920);
    const svg = await renderCueSvg(mkCue(['आज', 'वीडियो', 'ख़ास']), {
      width: 1080, height: 1920, style, activeWordIndex: 1,
    });
    assert.doesNotMatch(svg, /<text/i, 'caption SVG must not rely on font lookup at render time');
    assert.doesNotMatch(svg, /font-family/i, 'no font references should reach the rasteriser');
    assert.match(svg, /<path/, 'expected vector outlines');
  });

  test('SVG declares explicit pixel dimensions and a matching viewBox', async () => {
    const style = resolveStyle('default', 1920);
    const svg = await renderCueSvg(mkCue(['test']), {
      width: 1080, height: 1920, style, activeWordIndex: 0,
    });
    assert.match(svg, /width="1080"/);
    assert.match(svg, /height="1920"/);
    assert.match(svg, /viewBox="0 0 1080 1920"/);
  });

  test('SVG is XML-safe for text containing &, <, > and quotes', async () => {
    const style = resolveStyle('default', 1920);
    const svg = await renderCueSvg(mkCue(['A&B', '<tag>', '"q"', "it's"]), {
      width: 1080, height: 1920, style, activeWordIndex: 0,
    });
    // Glyphs become path data, so the raw characters must not appear as markup.
    const body = svg.replace(/^<svg[^>]*>/, '');
    assert.doesNotMatch(body, /<tag>/, 'literal markup leaked into the SVG');
    // Must still parse: balanced tags, no stray unescaped ampersands.
    const amps = body.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g) ?? [];
    assert.equal(amps.length, 0, 'unescaped ampersand would break XML parsing');
  });

  test('every generated SVG actually rasterises', async () => {
    const style = resolveStyle('bold', 1920);
    const svg = await renderCueSvg(mkCue(['A&B', '<x>', "it's", '"q"']), {
      width: 640, height: 360, style, activeWordIndex: 0,
    });
    const { rasteriser } = await selectRasteriser();
    const out = join(tmp.path, 'special.png');
    await rasteriser.rasterise(svg, out, { width: 640, height: 360 });
    assert.deepEqual(pngDimensions(out), { width: 640, height: 360 });
  });
});

describe('transparency', () => {
  test('rasterised captions have a real alpha channel', async () => {
    const style = resolveStyle('bold', 1920);
    const svg = await renderCueSvg(mkCue(['आज', 'वीडियो']), {
      width: 400, height: 200, style: { ...style, positionY: 0.5, fontSizePx: 48 },
      activeWordIndex: 0,
    });
    const { rasteriser } = await selectRasteriser();
    const out = join(tmp.path, 'alpha.png');
    await rasteriser.rasterise(svg, out, { width: 400, height: 200 });

    // Colour type 6 = truecolour with alpha. Byte 25 of a PNG is IHDR colour type.
    const buf = readFileSync(out);
    const colourType = buf[25];
    assert.ok(
      colourType === 6 || colourType === 4,
      `expected an alpha-capable PNG colour type, got ${colourType}`,
    );
  });

  test('background is transparent, not black', async () => {
    // Compositing a black-backed PNG over video would black out the whole frame.
    const style = resolveStyle('bold', 1920);
    const svg = await renderCueSvg(mkCue(['x']), {
      width: 200, height: 100, style: { ...style, positionY: 0.5, fontSizePx: 30 },
      activeWordIndex: -1,
    });
    const { rasteriser } = await selectRasteriser();
    const out = join(tmp.path, 'trans.png');
    await rasteriser.rasterise(svg, out, { width: 200, height: 100 });
    // A fully opaque 200x100 PNG cannot compress to a few hundred bytes; a
    // mostly-transparent one does. Cheap structural check, no decoder needed.
    assert.ok(statSync(out).size < 20_000, 'PNG looks fully painted — background may be opaque');
  });
});

describe('frame sizes', () => {
  const SIZES: Array<[string, number, number]> = [
    ['portrait 1080x1920', 1080, 1920],
    ['landscape 1920x1080', 1920, 1080],
    ['square 1080x1080', 1080, 1080],
    ['small 320x240', 320, 240],
  ];

  for (const [label, w, h] of SIZES) {
    test(`${label} rasterises at exactly that size`, async () => {
      const style = resolveStyle('bold', h);
      const svg = await renderCueSvg(mkCue(['आज', 'वीडियो']), {
        width: w, height: h, style, activeWordIndex: 0,
      });
      const { rasteriser } = await selectRasteriser();
      const out = join(tmp.path, `size_${w}x${h}.png`);
      await rasteriser.rasterise(svg, out, { width: w, height: h });
      assert.deepEqual(pngDimensions(out), { width: w, height: h });
    });
  }

  test('a size mismatch is reported, not silently accepted', async () => {
    const probes = await probeAllRasterisers();
    if (!probes.find((p) => p.name === 'resvg')?.functional) return;
    const { Resvg } = (await import('@resvg/resvg-js')) as unknown as { Resvg: never };
    const r = new ResvgRasteriser(Resvg as never);
    await assert.rejects(
      () => r.rasterise(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">' +
          '<path d="M0 0 L10 10" stroke="#fff"/></svg>',
        join(tmp.path, 'mismatch.png'),
        { width: 999, height: 999 },
      ),
      /expected 999x999/,
    );
  });
});

describe('per-language rasterisation', () => {
  const LANGS: Array<[string, string[]]> = [
    ['Devanagari', ['आज', 'का', 'वीडियो', 'ख़ास']],
    ['Devanagari conjuncts', ['विद्या', 'क्षेत्र', 'त्रिशूल']],
    ['Telugu', ['నేను', 'ఈరోజు', 'చెప్తాను']],
    ['Kannada', ['ನಾನು', 'ಇವತ್ತು', 'ಹೇಳ್ತೀನಿ']],
    ['Tamil', ['நான்', 'இன்று', 'சொல்கிறேன்']],
    ['Malayalam', ['ഞാൻ', 'ഇന്ന്', 'പറയാം']],
    ['Bengali', ['আমি', 'আজ', 'বলছি']],
    ['Gujarati', ['હું', 'આજે', 'કહીશ']],
    ['Gurmukhi', ['ਮੈਂ', 'ਅੱਜ', 'ਦੱਸਾਂਗਾ']],
    ['Hinglish', ['ye', 'बहुत', 'important', 'है']],
  ];

  for (const [label, words] of LANGS) {
    test(`${label} rasterises with substantial ink`, async () => {
      const style = { ...resolveStyle('bold', 1920), positionY: 0.5, fontSizePx: 64 };
      const svg = await renderCueSvg(mkCue(words), {
        width: 1080, height: 300, style, activeWordIndex: 0,
      });
      const { rasteriser } = await selectRasteriser();
      const out = join(tmp.path, `lang_${label.replace(/\W+/g, '_')}.png`);
      await rasteriser.rasterise(svg, out, { width: 1080, height: 300 });

      assert.deepEqual(pngDimensions(out), { width: 1080, height: 300 });
      // Missing glyphs collapse the file size; real text does not compress that far.
      const bytes = statSync(out).size;
      assert.ok(bytes > 2000, `${label}: PNG only ${bytes} bytes — glyphs may be missing`);
    });
  }
});

describe('active-word highlighting through rasterisation', () => {
  test('different active words produce different PNGs', async () => {
    const style = { ...resolveStyle('bold', 1920), positionY: 0.5, fontSizePx: 64 };
    const cue = mkCue(['आज', 'का', 'वीडियो']);
    const { rasteriser } = await selectRasteriser();

    const outs: Buffer[] = [];
    for (const idx of [0, 1, 2]) {
      const svg = await renderCueSvg(cue, {
        width: 800, height: 240, style, activeWordIndex: idx, activeScale: 1.1,
      });
      const p = join(tmp.path, `hl_${idx}.png`);
      await rasteriser.rasterise(svg, p, { width: 800, height: 240 });
      outs.push(readFileSync(p));
    }
    assert.ok(!outs[0]!.equals(outs[1]!), 'highlighting word 0 vs 1 produced identical images');
    assert.ok(!outs[1]!.equals(outs[2]!), 'highlighting word 1 vs 2 produced identical images');
  });

  test('highlight:none differs from active-word', async () => {
    const style = { ...resolveStyle('bold', 1920), positionY: 0.5, fontSizePx: 64 };
    const cue = mkCue(['one', 'two']);
    const { rasteriser } = await selectRasteriser();

    const a = join(tmp.path, 'hl_on.png');
    const b = join(tmp.path, 'hl_off.png');
    await rasteriser.rasterise(
      await renderCueSvg(cue, { width: 600, height: 200, style, activeWordIndex: 0 }),
      a, { width: 600, height: 200 },
    );
    await rasteriser.rasterise(
      await renderCueSvg(cue, { width: 600, height: 200, style, activeWordIndex: -1 }),
      b, { width: 600, height: 200 },
    );
    assert.ok(!readFileSync(a).equals(readFileSync(b)));
  });
});

describe('paths with spaces and unicode', () => {
  const NAMES = [
    'with spaces.png',
    "it's quoted.png",
    'colon:name.png',
    'वीडियो.png',
    'ünïcodé.png',
    'comma,name.png',
  ];

  for (const name of NAMES) {
    test(`writes to "${name}"`, async () => {
      const dir = join(tmp.path, 'weird dir', "sub'dir");
      mkdirSync(dir, { recursive: true });
      const style = resolveStyle('default', 1920);
      const svg = await renderCueSvg(mkCue(['ok']), {
        width: 200, height: 100, style: { ...style, positionY: 0.5, fontSizePx: 30 },
        activeWordIndex: 0,
      });
      const { rasteriser } = await selectRasteriser();
      const out = join(dir, name);
      await rasteriser.rasterise(svg, out, { width: 200, height: 100 });
      assert.ok(existsSync(out), `not written: ${out}`);
      assert.deepEqual(pngDimensions(out), { width: 200, height: 100 });
    });
  }
});

describe('failure modes', () => {
  test('FFmpeg rasteriser surfaces the exact failed command', async (t) => {
    if (!hasFfmpeg()) return t.skip('ffmpeg not available');
    const r = new FfmpegRasteriser();
    try {
      await r.rasterise('this is not svg at all', join(tmp.path, 'bad.png'), {
        width: 10, height: 10,
      });
      assert.fail('should have thrown on invalid SVG');
    } catch (e) {
      const err = e as Error & { hint?: string };
      assert.match(err.hint ?? '', /-frames:v/, 'hint should contain the actual command');
    }
  });

  test('invalid SVG fails loudly rather than writing a blank frame', async () => {
    const { rasteriser } = await selectRasteriser();
    const out = join(tmp.path, 'invalid.png');
    await assert.rejects(
      () => rasteriser.rasterise('<not-svg/>', out, { width: 100, height: 100 }),
    );
  });
});
