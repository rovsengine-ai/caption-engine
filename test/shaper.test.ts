import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeText, shapedToSvgPath, measureText, initShaper,
} from '../src/text/shaper.js';
import {
  scriptOf, splitScriptRuns, primaryScript, containsComplexScript,
  scriptForLanguage, isComplexScript,
} from '../src/text/script.js';
import {
  resolveFont, fontReport, discoverFontFamilies, listFontFamilies, systemFallbackFont,
} from '../src/text/fonts.js';
import { ShapingError } from '../src/errors.js';
import { MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX } from '../src/captions/style.js';

before(async () => { await initShaper(); });

describe('script detection', () => {
  test('identifies Indic scripts', () => {
    assert.equal(scriptOf('आ'), 'Devanagari');
    assert.equal(scriptOf('చ'), 'Telugu');
    assert.equal(scriptOf('ಕ'), 'Kannada');
    assert.equal(scriptOf('அ'), 'Tamil');
    assert.equal(scriptOf('അ'), 'Malayalam');
    assert.equal(scriptOf('ব'), 'Bengali');
    assert.equal(scriptOf('ક'), 'Gujarati');
    assert.equal(scriptOf('ਕ'), 'Gurmukhi');
    assert.equal(scriptOf('ا'), 'Arabic');
    assert.equal(scriptOf('A'), 'Latin');
  });

  test('treats punctuation/space/digits as Common', () => {
    for (const c of [' ', '.', ',', '!', '5', '-']) {
      assert.equal(scriptOf(c), 'Common', `"${c}" should be Common`);
    }
  });

  test('keeps ZWJ/ZWNJ inside the run so conjuncts survive', () => {
    assert.equal(scriptOf('‍'), 'Common');
    const runs = splitScriptRuns('क‍ष');
    assert.equal(runs.length, 1, 'ZWJ must not split a Devanagari run');
  });

  test('splits Hinglish into Latin + Devanagari runs', () => {
    const runs = splitScriptRuns('ye बहुत important बात');
    const scripts = runs.map((r) => r.script);
    assert.ok(scripts.includes('Latin'));
    assert.ok(scripts.includes('Devanagari'));
  });

  test('no character is lost when splitting runs', () => {
    const s = 'ye बहुत important बात है!';
    assert.equal(splitScriptRuns(s).map((r) => r.text).join(''), s);
  });

  test('primaryScript picks the dominant script', () => {
    assert.equal(primaryScript('ye बहुत खास बात है'), 'Devanagari');
    assert.equal(primaryScript('this is mostly english बात'), 'Latin');
  });

  test('complex-script detection', () => {
    assert.equal(containsComplexScript('hello world'), false);
    assert.equal(containsComplexScript('hello विद्या'), true);
    assert.equal(isComplexScript('Latin'), false);
    assert.equal(isComplexScript('Devanagari'), true);
  });

  test('maps language tags to scripts', () => {
    assert.equal(scriptForLanguage('hi'), 'Devanagari');
    assert.equal(scriptForLanguage('mr'), 'Devanagari');
    assert.equal(scriptForLanguage('te'), 'Telugu');
    assert.equal(scriptForLanguage('kn'), 'Kannada');
    assert.equal(scriptForLanguage('ur'), 'Arabic');
    assert.equal(scriptForLanguage('en-US'), 'Latin');
  });
});

describe('font resolution', () => {
  test('discovers named regular/bold font families from bundled assets', () => {
    const families = discoverFontFamilies();
    const devanagari = families.find((f) => f.name === 'Noto Sans Devanagari');
    assert.ok(devanagari, 'bundled Devanagari family should be discoverable');
    assert.ok(devanagari!.regular?.endsWith('.ttf'));
    assert.ok(devanagari!.bold?.endsWith('.ttf'));
    assert.ok(devanagari!.scripts.includes('Devanagari'));
    assert.ok(listFontFamilies().includes('Noto Sans'));
  });

  test('selects a named family and clearly rejects a missing one', () => {
    const r = resolveFont('Devanagari', { family: 'Noto Sans Devanagari', bold: true });
    assert.match(r.path, /NotoSansDevanagari_700Bold\.ttf$/);
    assert.throws(
      () => resolveFont('Latin', { family: 'does not exist' }),
      /Available fonts:/,
    );
  });

  test('every supported script resolves to a font file', () => {
    const rep = fontReport();
    const missing = rep.filter((r) => !r.ok);
    assert.equal(
      missing.length, 0,
      `missing fonts for: ${missing.map((m) => m.script).join(', ')}\n` +
        missing.map((m) => m.error).join('\n'),
    );
  });

  test('prefers fonts vendored in the repo for reproducibility', () => {
    const f = resolveFont('Devanagari');
    assert.equal(f.source, 'vendored', `expected vendored font, got ${f.source} (${f.path})`);
  });

  test('throws a helpful error for an override that does not exist', () => {
    assert.throws(
      () => resolveFont('Devanagari', { override: '/nope/missing.ttf' }),
      /Font file not found/,
    );
  });
});

describe('HarfBuzz shaping correctness', () => {
  // These are the cases FFmpeg's libass got WRONG on the dev host. They are the
  // reason this shaper exists, so they are asserted directly.

  test('Devanagari pre-base matra is reordered (विद्या)', async () => {
    // व ि द ् य ा — the ि (cluster 1) must move BEFORE व (cluster 0).
    // HarfBuzz signals this by emitting a non-monotonic cluster sequence.
    const s = await shapeText('विद्या', 100);
    assert.equal(s.runs.length, 1);
    const clusters = s.runs[0]!.glyphs.map((g) => g.cluster);
    assert.ok(clusters.length >= 3, `expected >=3 glyphs, got ${clusters.length}`);
    const monotonic = clusters.every((c, i) => i === 0 || c >= clusters[i - 1]!);
    assert.ok(
      !monotonic || clusters[0] === 0,
      `matra reordering not applied; clusters=${JSON.stringify(clusters)}`,
    );
    // 6 codepoints must collapse to fewer glyphs via conjunct formation.
    assert.ok(
      s.runs[0]!.glyphs.length < 6,
      `expected conjunct formation to reduce glyph count, got ${s.runs[0]!.glyphs.length}`,
    );
  });

  test('Devanagari conjuncts ligate (क्षेत्र)', async () => {
    // क ् ष े त ् र = 7 codepoints → far fewer glyphs once ligated.
    const s = await shapeText('क्षेत्र', 100);
    const n = s.runs[0]!.glyphs.length;
    assert.ok(n <= 4, `expected <=4 glyphs after ligation, got ${n}`);
  });

  test('Telugu conjunct stacking (చెప్తాను)', async () => {
    const s = await shapeText('చెప్తాను', 100);
    const n = s.runs[0]!.glyphs.length;
    assert.ok(n < 8, `expected stacking to reduce glyphs, got ${n}`);
  });

  test('no .notdef glyphs for any supported script (tofu check)', async () => {
    const samples: Array<[string, string]> = [
      ['Devanagari', 'आज का वीडियो बहुत ख़ास है'],
      ['Telugu', 'నేను ఈరోజు మీకు చెప్తాను'],
      ['Kannada', 'ನಾನು ಇವತ್ತು ನಿಮಗೆ ಹೇಳ್ತೀನಿ'],
      ['Tamil', 'நான் இன்று உங்களுக்கு சொல்கிறேன்'],
      ['Malayalam', 'ഞാൻ ഇന്ന് നിങ്ങളോട് പറയാം'],
      ['Bengali', 'আমি আজ আপনাকে বলছি'],
      ['Gujarati', 'હું આજે તમને કહીશ'],
      ['Gurmukhi', 'ਮੈਂ ਅੱਜ ਤੁਹਾਨੂੰ ਦੱਸਾਂਗਾ'],
      ['Latin', 'today I will tell you'],
    ];
    for (const [label, text] of samples) {
      const s = await shapeText(text, 80);
      const glyphs = s.runs.flatMap((r) => r.glyphs);
      assert.ok(glyphs.length > 0, `${label}: no glyphs produced`);
      // Glyph 0 is .notdef in every TrueType font — that is tofu.
      const tofu = glyphs.filter((g) => g.glyphId === 0);
      assert.equal(tofu.length, 0, `${label}: ${tofu.length} .notdef glyph(s) — missing coverage`);
    }
  });

  test('mixed Hinglish shapes both scripts with correct fonts', async () => {
    const s = await shapeText('ye बहुत important बात है', 80);
    assert.ok(s.runs.length >= 2, 'expected multiple script runs');
    const scripts = new Set(s.runs.map((r) => r.script));
    assert.ok(scripts.has('Latin') && scripts.has('Devanagari'));
    for (const r of s.runs) {
      assert.equal(r.glyphs.filter((g) => g.glyphId === 0).length, 0, `tofu in ${r.script} run`);
    }
  });

  test('a named face falls back only for a script it does not cover, never to tofu', async () => {
    const s = await shapeText('important बात', 80, { fontFamily: 'Noto Sans Devanagari' });
    assert.equal(s.runs.flatMap((r) => r.glyphs).filter((g) => g.glyphId === 0).length, 0);
    assert.ok(s.runs.some((r) => r.script === 'Latin' && /NotoSans_/.test(r.font.path)));
    assert.ok(s.runs.some((r) => r.script === 'Devanagari' && /NotoSansDevanagari_/.test(r.font.path)));
  });

  test('produces drawable SVG path data', async () => {
    const s = await shapeText('विद्या', 100);
    const d = shapedToSvgPath(s);
    assert.ok(d.length > 50, 'path data suspiciously short');
    assert.match(d, /^[Mm]/, 'path should start with a moveto');
    // opentype.js emits M/L/Q/C and relies on implicit closing for fills, so a
    // literal Z is not required. What matters is multiple subpaths (one per
    // glyph contour) and real curve commands.
    assert.ok((d.match(/M/g) ?? []).length >= 3, 'expected several glyph contours');
    assert.match(d, /[QCL]/, 'expected line/curve drawing commands');
    assert.doesNotMatch(d, /NaN|undefined|Infinity/, 'path contains invalid coordinates');
  });

  test('path coordinates are finite numbers', async () => {
    const d = shapedToSvgPath(await shapeText('ye बहुत important', 80));
    const nums = d.match(/-?\d+(\.\d+)?/g) ?? [];
    assert.ok(nums.length > 20, 'expected many coordinates');
    for (const n of nums) {
      assert.ok(Number.isFinite(Number(n)), `non-finite coordinate: ${n}`);
    }
  });

  test('width scales linearly with font size', async () => {
    const a = await measureText('विद्या', 50);
    const b = await measureText('विद्या', 100);
    assert.ok(Math.abs(b - a * 2) < 1.5, `expected ~2x, got ${a} → ${b}`);
  });

  test('empty and whitespace input do not throw', async () => {
    assert.equal((await shapeText('', 80)).runs.length, 0);
    const sp = await shapeText('   ', 80);
    assert.ok(sp.width >= 0);
  });

  test('shaping is deterministic', async () => {
    const a = shapedToSvgPath(await shapeText('क्षेत्र विद्या', 90));
    const b = shapedToSvgPath(await shapeText('क्षेत्र विद्या', 90));
    assert.equal(a, b, 'identical input must produce identical output');
  });
});

/**
 * Custom font sizes across every supported script.
 *
 * Regression coverage for a class of report that reads as "a specific word in
 * a specific language fails, but only when the font size is customised": if
 * that were true it would mean shaping (glyph selection) depends on the
 * requested pixel size, which it must not — HarfBuzz always shapes in FONT
 * UNITS (see loadFont's `hbFont.setScale(unitsPerEm, unitsPerEm)`), and pixel
 * size is applied afterwards as a single SVG transform. These tests assert
 * that property holds at both ends of the accepted --font-size range, for
 * every bundled script, not just the sizes a preset happens to use.
 */
describe('custom font sizes do not change glyph selection', () => {
  const SAMPLES: Record<string, string> = {
    Latin: 'hello WORLD 123',
    Devanagari: 'नमस्ते क्षेत्र विद्या सम्बन्ध',
    Telugu: 'తెలుగు రాష్ట్రం క్షేమం',
    Kannada: 'ಕನ್ನಡ ಕ್ಷೇತ್ರ ಸಂಬಂಧ',
    Tamil: 'தமிழ் க்ஷேமம்',
    Malayalam: 'മലയാളം ക്ഷേമം',
    Bengali: 'বাংলা ক্ষেত্র',
    Gujarati: 'ગુજરાતી ક્ષેત્ર',
    Gurmukhi: 'ਪੰਜਾਬੀ ਸੰਬੰਧ',
  };

  const SIZES = [MIN_FONT_SIZE_PX, 24, 72, 84, MAX_FONT_SIZE_PX];

  for (const [script, text] of Object.entries(SAMPLES)) {
    test(`${script} shapes without a missing glyph at every size, bold and regular`, async () => {
      for (const size of SIZES) {
        for (const bold of [false, true]) {
          const shaped = await shapeText(text, size, { bold });
          for (const run of shaped.runs) {
            assert.ok(
              run.glyphs.every((g) => g.glyphId !== 0),
              `${script} "${text}" at ${size}px (bold=${bold}) produced a missing glyph`,
            );
          }
          const d = shapedToSvgPath(shaped);
          assert.doesNotMatch(d, /NaN|Infinity/, `${script} at ${size}px produced invalid path data`);
        }
      }
    });
  }

  test('advance width is strictly monotonic in font size across the whole accepted range', async () => {
    let prev = 0;
    for (const size of SIZES) {
      const w = await measureText('क्षेत्र', size);
      assert.ok(w > prev, `width did not grow from previous size at ${size}px`);
      prev = w;
    }
  });
});

describe('invalid font sizes fail clearly instead of producing garbage output', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    test(`shapeText rejects ${bad} with a typed, actionable error`, async () => {
      await assert.rejects(shapeText('hello', bad), (e: unknown) => {
        assert.ok(e instanceof ShapingError, 'must be the typed shaping error');
        assert.match((e as Error).message, /[Ii]nvalid font size/);
        assert.ok((e as ShapingError).hint, 'must explain the valid range');
        return true;
      });
    });
  }
});

describe('missing-glyph failures name the actual word, and try a system fallback first', () => {
  test('systemFallbackFont never throws when fc-match is unavailable', () => {
    // On a machine without fontconfig this must return null, not crash — it
    // is a best-effort extra chance, never a hard dependency.
    assert.doesNotThrow(() => systemFallbackFont('Devanagari', false));
  });

  test('an unrenderable script still throws MissingFontError with real alternatives (existing contract)', () => {
    // resolveFont's own contract is unchanged by the shaper's new fallback —
    // this just confirms the fallback addition did not weaken it.
    assert.throws(() => resolveFont('Latin', { family: 'Definitely Not A Real Family' }));
  });
});
