import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { shapeText, initShaper } from '../src/text/shaper.js';
import { renderCueSvg } from '../src/captions/svg.js';
import { resolveStyle } from '../src/captions/style.js';
import { matchFiller, supportedFillerLanguages } from '../src/autotrim/fillers.js';
import { autoTrim } from '../src/autotrim/index.js';
import { LANGUAGES, listLanguages, getLanguage } from '../src/config/languages.js';
import { resolveFont } from '../src/text/fonts.js';
import { scriptForLanguage } from '../src/text/script.js';
import { mkTranscript, mkCue } from './helpers.js';

before(async () => { await initShaper(); });

/**
 * One realistic sentence per language. These are the strings actually rendered
 * and asserted on, so "supported" means "this text produced correct glyphs",
 * not "the language appears in a config file".
 */
const SAMPLES: Record<string, string[]> = {
  hi: ['आज', 'का', 'वीडियो', 'बहुत', 'ख़ास', 'है'],
  mr: ['मी', 'आज', 'तुम्हाला', 'सांगतो'],
  ne: ['म', 'आज', 'तपाईंलाई', 'भन्छु'],
  te: ['నేను', 'ఈరోజు', 'మీకు', 'చెప్తాను'],
  kn: ['ನಾನು', 'ಇವತ್ತು', 'ನಿಮಗೆ', 'ಹೇಳ್ತೀನಿ'],
  ta: ['நான்', 'இன்று', 'உங்களுக்கு', 'சொல்கிறேன்'],
  ml: ['ഞാൻ', 'ഇന്ന്', 'നിങ്ങളോട്', 'പറയാം'],
  bn: ['আমি', 'আজ', 'আপনাকে', 'বলছি'],
  gu: ['હું', 'આજે', 'તમને', 'કહીશ'],
  pa: ['ਮੈਂ', 'ਅੱਜ', 'ਤੁਹਾਨੂੰ', 'ਦੱਸਾਂਗਾ'],
  or: ['ମୁଁ', 'ଆଜି', 'ଆପଣଙ୍କୁ', 'କହିବି'],
  as: ['মই', 'আজি', 'আপোনাক', 'কওঁ'],
  en: ['today', 'I', 'will', 'tell', 'you'],
};

describe('language registry', () => {
  test('every registry entry has a render sample', () => {
    const missing = Object.keys(LANGUAGES).filter(
      (c) => !SAMPLES[c] && LANGUAGES[c]!.rendering === 'verified',
    );
    assert.deepEqual(missing, [], `verified languages without a test sample: ${missing}`);
  });

  test('every sample language is in the registry', () => {
    for (const code of Object.keys(SAMPLES)) {
      assert.ok(getLanguage(code), `${code} missing from LANGUAGES`);
    }
  });

  test('registry claims match reality — no language claims fillers it lacks', () => {
    const withFillers = supportedFillerLanguages();
    for (const l of listLanguages()) {
      if (l.fillers === 'present') {
        assert.ok(
          withFillers.includes(l.code),
          `${l.code} claims fillers:present but has no lexicon`,
        );
      }
    }
  });

  test('nothing is marked native-reviewed unless it truly is', () => {
    // Only English is reviewed today. If this fails someone flipped a flag
    // without doing the review — see docs/NATIVE_REVIEW.md.
    const reviewed = listLanguages().filter((l) => l.nativeReviewed).map((l) => l.code);
    assert.deepEqual(reviewed, ['en'], `unexpected nativeReviewed: ${reviewed}`);
  });
});

describe('per-language rendering', () => {
  for (const [code, words] of Object.entries(SAMPLES)) {
    const cfg = getLanguage(code)!;

    test(`${code} (${cfg.name}): font resolves`, () => {
      const script = scriptForLanguage(code);
      const f = resolveFont(script);
      assert.ok(f.path.length > 0);
    });

    test(`${code} (${cfg.name}): no tofu / missing glyphs`, async () => {
      const s = await shapeText(words.join(' '), 72, { bold: true });
      const glyphs = s.runs.flatMap((r) => r.glyphs);
      assert.ok(glyphs.length > 0, 'no glyphs produced');
      const tofu = glyphs.filter((g) => g.glyphId === 0);
      assert.equal(tofu.length, 0, `${tofu.length} .notdef glyph(s) for "${words.join(' ')}"`);
    });

    test(`${code} (${cfg.name}): renders a non-empty SVG`, async () => {
      const style = resolveStyle('bold', 1920);
      const svg = await renderCueSvg(mkCue(words), {
        width: 1080, height: 1920, style, activeWordIndex: 1, activeScale: 1.08,
      });
      assert.match(svg, /^<svg/);
      const paths = svg.match(/<path/g) ?? [];
      // Outline + fill per script run, so at least 2 per word.
      assert.ok(
        paths.length >= words.length,
        `expected >= ${words.length} paths, got ${paths.length}`,
      );
      assert.doesNotMatch(svg, /NaN|Infinity|undefined/, 'invalid numbers in SVG');
    });

    test(`${code} (${cfg.name}): every word appears in the layout`, async () => {
      const style = resolveStyle('default', 1920);
      const svg = await renderCueSvg(mkCue(words), {
        width: 1080, height: 1920, style, activeWordIndex: -1,
      });
      // Two <g> groups: outlines then fills. Each word contributes to both.
      const fills = svg.split('<g>')[2] ?? '';
      const fillPaths = (fills.match(/<path/g) ?? []).length;
      assert.ok(
        fillPaths >= words.length,
        `${code}: ${fillPaths} fill paths for ${words.length} words — a word may be missing`,
      );
    });
  }
});

describe('per-language Auto Trim', () => {
  test('Hindi: cuts hesitation "matlab", keeps the real word', () => {
    const t = mkTranscript([
      ['aaj', 0.5, 0.9], ['baat', 0.95, 1.4],
      ['matlab', 2.4, 2.9],           // after a 1s pause → hesitation
      ['iska', 3.0, 3.4], ['matlab', 3.45, 3.9], ['hai', 3.95, 4.2], // mid-flow → real word
    ], 'hi');
    const cuts = autoTrim(t).cuts.filter((c) => c.reason === 'filler');
    assert.ok(cuts.some((c) => c.start >= 2.3 && c.start <= 2.5), 'hesitation matlab not cut');
    assert.ok(!cuts.some((c) => c.start >= 3.4 && c.start <= 3.5), 'real-word matlab was cut');
  });

  test('Telugu: cuts "ante" after a pause, keeps it mid-flow', () => {
    const t = mkTranscript([
      ['నేను', 0.2, 0.6], ['చెప్తాను', 0.65, 1.2],
      ['అంటే', 2.2, 2.6],
      ['ఇది', 2.7, 3.0], ['అంటే', 3.05, 3.4], ['ముఖ్యం', 3.45, 3.9],
    ], 'te');
    const cuts = autoTrim(t).cuts.filter((c) => c.reason === 'filler');
    assert.ok(cuts.some((c) => c.start >= 2.1 && c.start <= 2.3), 'hesitation ante not cut');
    assert.ok(!cuts.some((c) => c.start >= 3.0 && c.start <= 3.1), 'real-word ante was cut');
  });

  for (const code of ['hi', 'mr', 'te', 'kn', 'ta', 'ml', 'bn', 'gu', 'pa', 'en']) {
    test(`${code}: English fillers are caught in code-switched speech`, () => {
      assert.equal(
        matchFiller('um', code).isFiller, true,
        `"um" should be a filler in ${code} — code-switched speech mixes English`,
      );
    });
  }

  test('languages without a lexicon still trim silence and do not crash', () => {
    const t = mkTranscript([['ମୁଁ', 0.2, 0.6], ['କହିବି', 3.0, 3.6]], 'or');
    const r = autoTrim(t);
    assert.ok(r.cuts.some((c) => c.reason === 'silence'), 'silence should still be found');
    assert.equal(r.cuts.filter((c) => c.reason === 'filler').length, 0);
  });

  test('unknown language falls back to English fillers without throwing', () => {
    const t = mkTranscript([['hello', 0.1, 0.5], ['um', 0.6, 0.8], ['world', 0.9, 1.3]], 'xx');
    assert.doesNotThrow(() => autoTrim(t));
  });
});

describe('mixed-script (code-switched) rendering', () => {
  const CASES: Array<[string, string[]]> = [
    ['Hinglish', ['ye', 'बहुत', 'important', 'बात', 'है']],
    ['Tenglish', ['idi', 'చాలా', 'important', 'విషయం']],
    ['Kanglish', ['idu', 'ತುಂಬಾ', 'important', 'ವಿಷಯ']],
  ];

  for (const [label, words] of CASES) {
    test(`${label}: both scripts shape without tofu`, async () => {
      const s = await shapeText(words.join(' '), 72, { bold: true });
      assert.ok(s.runs.length >= 2, `${label} should split into multiple script runs`);
      for (const r of s.runs) {
        assert.equal(
          r.glyphs.filter((g) => g.glyphId === 0).length, 0,
          `${label}: tofu in the ${r.script} run`,
        );
      }
    });

    test(`${label}: each run uses a font covering its script`, async () => {
      const s = await shapeText(words.join(' '), 72, { bold: true });
      for (const r of s.runs) {
        if (r.script === 'Latin') continue;
        assert.match(
          r.font.path, new RegExp(r.script, 'i'),
          `${label}: ${r.script} run used ${r.font.path}`,
        );
      }
    });
  }
});
