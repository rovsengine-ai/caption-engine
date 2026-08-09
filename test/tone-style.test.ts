import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCaptionTheme, loadCaptionTheme, toneStyleFor, dominantTone,
  formatProsodyDiagnostics, NEUTRAL_THEME, DEFAULT_THRESHOLDS, type CaptionTheme,
} from '../src/captions/tone-style.js';
import { resolveWordStyle } from '../src/captions/active.js';
import { classifyProsody, type ProsodyFeatures } from '../src/media/prosody.js';
import { DEFAULT_STYLE } from '../src/captions/style.js';
import { listFontFamilies } from '../src/text/fonts.js';
import { CaptionEngineError } from '../src/errors.js';
import { parseArgs } from '../src/cli/args.js';

/**
 * Tone → style resolution, and the guarantee that none of it fires by default.
 *
 * Entirely offline: themes are JSON, the classifier is pure, and style
 * resolution is arithmetic. Nothing here touches audio, FFmpeg or a network.
 */

const BASE = { ...DEFAULT_STYLE, fontFamily: 'Noto Sans', primaryColor: '#FFFFFF', activeColor: '#FFD400' };

function theme(over: Partial<CaptionTheme> = {}): CaptionTheme {
  return {
    version: 1,
    minConfidence: 0.6,
    tones: { excited: { bold: true, scale: 1.08, color: '#FFD166' }, fast: { scale: 0.97 } },
    thresholds: DEFAULT_THRESHOLDS,
    source: 'test',
    ...over,
  };
}

describe('the default path is untouched', () => {
  test('with no tone, resolveWordStyle behaves exactly as before', () => {
    const resting = resolveWordStyle(BASE, false);
    const active = resolveWordStyle(BASE, true, { activeScale: 1.08 });
    assert.equal(resting.bold, true, 'default output is the bold face');
    assert.equal(resting.color, BASE.primaryColor);
    assert.equal(resting.scale, 1);
    assert.equal(active.color, BASE.activeColor);
    assert.equal(active.scale, 1.08);
    assert.equal(active.fontFamily, BASE.fontFamily);
  });

  test('--prosody defaults to off', () => {
    const parsed = parseArgs(['input.mp4']);
    assert.equal(parsed.command, 'run');
    if (parsed.command !== 'run') return;
    assert.equal(parsed.options.prosody, false);
    assert.equal(parsed.options.captionTheme, undefined);
  });

  test('the built-in neutral theme can never style anything', () => {
    for (const tone of ['neutral', 'calm', 'excited', 'emphatic', 'fast', 'soft'] as const) {
      assert.equal(toneStyleFor(NEUTRAL_THEME, tone, 1), undefined);
    }
  });
});

describe('the --active-bold fix', () => {
  // The bug: `active ? (activeBold || true) : !activeBold`. The left branch is
  // unconditionally true, so the active word was ALWAYS bold and the flag only
  // ever changed resting words. Weight must track the flag on both sides.
  test('without the flag, every word uses the bold face', () => {
    assert.equal(resolveWordStyle(BASE, false, {}).bold, true);
    assert.equal(resolveWordStyle(BASE, true, {}).bold, true);
  });

  test('with the flag, resting words are regular and the active word is bold', () => {
    assert.equal(resolveWordStyle(BASE, false, { activeBold: true }).bold, false);
    assert.equal(resolveWordStyle(BASE, true, { activeBold: true }).bold, true);
  });

  test('the flag creates a real weight CONTRAST, not just a bold active word', () => {
    const resting = resolveWordStyle(BASE, false, { activeBold: true });
    const active = resolveWordStyle(BASE, true, { activeBold: true });
    assert.notEqual(
      resting.bold, active.bold,
      '--active-bold is pointless unless the two states differ',
    );
  });

  test('scale only applies to the active word', () => {
    assert.equal(resolveWordStyle(BASE, false, { activeScale: 1.3 }).scale, 1);
    assert.equal(resolveWordStyle(BASE, true, { activeScale: 1.3 }).scale, 1.3);
  });
});

describe('tone and active state combine', () => {
  const tone = { bold: true, scale: 1.08, color: '#FFD166' };

  test('a tone colours a resting word', () => {
    const s = resolveWordStyle(BASE, false, { tone });
    assert.equal(s.color, '#FFD166');
  });

  test('but never overrides the ACTIVE colour', () => {
    // The highlight is the one thing the viewer tracks. A tone colour winning
    // here would make the spoken word blend into its neighbours.
    const s = resolveWordStyle(BASE, true, { tone });
    assert.equal(s.color, BASE.activeColor);
  });

  test('tone scale and active scale multiply', () => {
    const s = resolveWordStyle(BASE, true, { tone, activeScale: 1.1 });
    assert.ok(Math.abs(s.scale - 1.08 * 1.1) < 1e-9);
  });

  test('a tone font family is honoured', () => {
    const s = resolveWordStyle(BASE, false, { tone: { fontFamily: 'Custom Face' } });
    assert.equal(s.fontFamily, 'Custom Face');
  });

  test('a tone that sets nothing changes nothing', () => {
    const plain = resolveWordStyle(BASE, false);
    const withEmpty = resolveWordStyle(BASE, false, { tone: {} });
    assert.deepEqual(withEmpty, plain);
  });

  test('--active-bold still wins on the active word over a non-bold tone', () => {
    const s = resolveWordStyle(BASE, true, { activeBold: true, tone: { bold: false } });
    assert.equal(s.bold, true, 'the highlight must stay legible');
  });
});

describe('theme parsing rejects nonsense loudly', () => {
  test('valid JSON parses', () => {
    const t = parseCaptionTheme(
      JSON.stringify({ version: 1, minConfidence: 0.7, tones: { calm: { scale: 1.02 } } }),
      'inline',
    );
    assert.equal(t.minConfidence, 0.7);
    assert.equal(t.tones.calm?.scale, 1.02);
  });

  test('malformed JSON names the file', () => {
    assert.throws(() => parseCaptionTheme('{ not json', 'my-theme.json'), /my-theme\.json/);
  });

  test('an unknown tone is an error, not silently ignored', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ tones: { furious: {} } }), 'x'),
      /unknown tone "furious"/,
    );
  });

  test('a bad colour is rejected, and the hint says what is valid', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ tones: { calm: { color: 'red' } } }), 'x'),
      (e: unknown) => {
        assert.ok(e instanceof CaptionEngineError);
        assert.match((e as Error).message, /tone "calm" has colour "red"/);
        assert.match(String((e as CaptionEngineError).hint ?? ''), /#RRGGBB/);
        return true;
      },
    );
  });

  test('an out-of-range scale is rejected at load, not at render time', () => {
    // Tone scale multiplies with --active-scale, so an unbounded value silently
    // overflows the width the layout reserved.
    for (const scale of [9, 0.1]) {
      assert.throws(
        () => parseCaptionTheme(JSON.stringify({ tones: { calm: { scale } } }), 'x'),
        (e: unknown) => {
          assert.ok(e instanceof CaptionEngineError);
          assert.match((e as Error).message, new RegExp(`has scale ${scale}`));
          assert.match(String((e as CaptionEngineError).hint ?? ''), /Scale must be between/);
          return true;
        },
      );
    }
  });

  test('a missing explicit theme file is an error', () => {
    assert.throws(() => loadCaptionTheme('/nope/does-not-exist.json'), /not found/);
  });

  test('the shipped config/caption-theme.json is valid and covers every tone', () => {
    const t = loadCaptionTheme();
    assert.ok(t.version >= 1);
    for (const tone of ['neutral', 'calm', 'excited', 'emphatic', 'fast', 'soft'] as const) {
      assert.ok(tone in t.tones, `shipped theme is missing "${tone}"`);
    }
  });

  test('every font named by the shipped theme actually exists', () => {
    // A theme that names a missing font would fail mid-render, after the user
    // has already waited for ASR.
    const t = loadCaptionTheme();
    const available = listFontFamilies().map((f) => f.toLocaleLowerCase());
    for (const [tone, style] of Object.entries(t.tones)) {
      if (style?.fontFamily) {
        assert.ok(
          available.includes(style.fontFamily.toLocaleLowerCase()),
          `tone "${tone}" names font "${style.fontFamily}", which is not installed`,
        );
      }
    }
  });
});

describe('confidence gating', () => {
  test('a low-confidence classification keeps the base style', () => {
    assert.equal(toneStyleFor(theme(), 'excited', 0.4), undefined);
  });

  test('a confident classification applies', () => {
    assert.deepEqual(toneStyleFor(theme(), 'excited', 0.9), {
      bold: true, scale: 1.08, color: '#FFD166',
    });
  });

  test('a tone with no entry in the theme applies nothing', () => {
    assert.equal(toneStyleFor(theme(), 'soft', 0.99), undefined);
  });

  test('the gate is exactly at minConfidence', () => {
    assert.equal(toneStyleFor(theme({ minConfidence: 0.6 }), 'fast', 0.6)?.scale, 0.97);
    assert.equal(toneStyleFor(theme({ minConfidence: 0.6 }), 'fast', 0.5999), undefined);
  });
});

describe('the classifier uses pitch when it has it', () => {
  const base: ProsodyFeatures = {
    rmsDb: -20, energyVariationDb: 2, energyRelative: 0,
    speakingRate: 2.5, pauseBefore: 0, pauseAfter: 0, voicedRatio: 0.8,
  };

  test('a missing F0 lowers confidence rather than being read as flat pitch', () => {
    const withPitch = classifyProsody({ ...base, f0Hz: 150, pitchRelative: 0, pitchVariation: 0.5 });
    const without = classifyProsody(base);
    assert.ok(
      withPitch.confidence > without.confidence,
      'a measured F0 is extra evidence and must raise confidence',
    );
  });

  test('loud AND high reads as excited', () => {
    const r = classifyProsody({
      ...base, energyRelative: 1.0, f0Hz: 220, pitchRelative: 3.5, pitchVariation: 3,
    });
    assert.equal(r.tone, 'excited');
  });

  test('quiet AND low reads as soft', () => {
    const r = classifyProsody({
      ...base, energyRelative: -0.9, f0Hz: 95, pitchRelative: -3, pitchVariation: 1,
    });
    assert.equal(r.tone, 'soft');
  });

  test('flat pitch at a moderate rate reads as calm', () => {
    const r = classifyProsody({
      ...base, energyRelative: -0.1, speakingRate: 1.8,
      f0Hz: 150, pitchRelative: 0.2, pitchVariation: 0.6,
    });
    assert.equal(r.tone, 'calm');
  });

  test('near-silence is always neutral and never confident', () => {
    const r = classifyProsody({ ...base, rmsDb: -91, voicedRatio: 0.05 });
    assert.equal(r.tone, 'neutral');
    assert.ok(r.confidence < 0.45);
  });

  test('classification is deterministic', () => {
    const f = { ...base, energyRelative: 1.2, f0Hz: 210, pitchRelative: 3, pitchVariation: 4 };
    assert.deepEqual(classifyProsody(f), classifyProsody(f));
  });

  test('confidence never exceeds 1', () => {
    const r = classifyProsody({
      ...base, energyRelative: 99, energyVariationDb: 99,
      f0Hz: 300, pitchRelative: 40, pitchVariation: 40,
    });
    assert.ok(r.confidence <= 1);
  });
});

describe('diagnostics output', () => {
  const row = {
    index: 0, word: 'ಇದು', start: 1.25, end: 1.6, rmsDb: -18.2,
    f0Hz: 172.4, speakingRate: 2.8, tone: 'emphatic', confidence: 0.72,
    font: 'Noto Sans Kannada', bold: true, scale: 1.05, color: '#FFFFFF', styled: true,
  };

  test('renders the measurements and the resolved style', () => {
    const out = formatProsodyDiagnostics([row]);
    assert.match(out, /ಇದು/);
    assert.match(out, /172/, 'F0 must be shown');
    assert.match(out, /emphatic/);
    assert.match(out, /0\.72/);
    assert.match(out, /Noto Sans Kannada/);
    assert.match(out, /bold/);
  });

  test('an unmeasured F0 shows as a dash, never as 0 Hz', () => {
    const out = formatProsodyDiagnostics([{ ...row, f0Hz: null }]);
    assert.match(out, /—/);
    assert.ok(!/\b0\s+Hz/.test(out));
  });

  test('it is truncated rather than dumping a whole transcript', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...row, index: i }));
    const out = formatProsodyDiagnostics(many, 10);
    assert.match(out, /… and 90 more/);
  });
});


describe('per-cue tone smoothing', () => {
  // Word-level tone changes roughly five times a second on real speech, which
  // reads as flicker. A line holds ONE tone; the active word supplies the beat.
  const w = (tone: string, confidence: number) =>
    ({ tone, confidence }) as { tone: Parameters<typeof toneStyleFor>[1] & string; confidence: number };

  test('the majority tone wins', () => {
    const d = dominantTone(
      [w('excited', 0.9), w('excited', 0.8), w('soft', 0.7)],
      { minConfidence: 0.6 },
    );
    assert.equal(d?.tone, 'excited');
    assert.equal(d?.support, 3);
  });

  test('voting is confidence-weighted, not a headcount', () => {
    // Two barely-confident words must not outvote one strongly-confident one
    // by enough to flip a line on weak evidence.
    const d = dominantTone(
      [w('excited', 0.95), w('excited', 0.95), w('soft', 0.61), w('soft', 0.61)],
      { minConfidence: 0.6 },
    );
    assert.equal(d?.tone, 'excited');
    assert.ok(d!.share > 0.5);
  });

  test('unconfident words do not vote at all', () => {
    const d = dominantTone(
      [w('excited', 0.9), w('soft', 0.2), w('fast', 0.1)],
      { minConfidence: 0.6 },
    );
    assert.equal(d?.tone, 'excited');
    assert.equal(d?.support, 1, 'only the confident word should have voted');
  });

  test('a line with nothing confident yields no tone', () => {
    assert.equal(dominantTone([w('excited', 0.2), w('soft', 0.1)], { minConfidence: 0.6 }), null);
  });

  test('an empty line yields no tone', () => {
    assert.equal(dominantTone([], { minConfidence: 0.6 }), null);
  });

  test('a split line reports a low share, so gating keeps the base style', () => {
    const d = dominantTone(
      [w('excited', 0.8), w('soft', 0.8), w('fast', 0.8), w('calm', 0.8)],
      { minConfidence: 0.6 },
    );
    assert.ok(d !== null);
    assert.ok(d!.share <= 0.3, 'a four-way split must not look confident');
    assert.equal(
      toneStyleFor(theme(), d!.tone, d!.share), undefined,
      'a disagreeing line must fall back to the base style',
    );
  });

  test('a unanimous line reports share 1', () => {
    const d = dominantTone([w('fast', 0.9), w('fast', 0.7)], { minConfidence: 0.6 });
    assert.equal(d?.share, 1);
  });

  test('ties resolve deterministically, never by insertion order', () => {
    const a = dominantTone([w('soft', 0.8), w('excited', 0.8)], { minConfidence: 0.6 });
    const b = dominantTone([w('excited', 0.8), w('soft', 0.8)], { minConfidence: 0.6 });
    assert.equal(a?.tone, b?.tone, 'the same evidence must always give the same caption');
  });
});

describe('CLI: tone flags', () => {
  test('--tone-style auto enables prosody', () => {
    const p = parseArgs(['in.mp4', '--tone-style', 'auto']);
    assert.equal(p.command, 'run');
    if (p.command !== 'run') return;
    assert.equal(p.options.prosody, true);
  });

  test('--tone-style none disables it', () => {
    const p = parseArgs(['in.mp4', '--prosody', '--tone-style', 'none']);
    assert.equal(p.command, 'run');
    if (p.command !== 'run') return;
    assert.equal(p.options.prosody, false);
  });

  test('--tone-style rejects anything else', () => {
    assert.throws(() => parseArgs(['in.mp4', '--tone-style', 'maybe']), /must be auto or none/);
  });

  test('--tone-scope defaults to cue', () => {
    const p = parseArgs(['in.mp4']);
    assert.equal(p.command, 'run');
    if (p.command !== 'run') return;
    assert.equal(p.options.toneScope, 'cue');
  });

  test('--tone-scope word is accepted', () => {
    const p = parseArgs(['in.mp4', '--tone-scope', 'word']);
    assert.equal(p.command, 'run');
    if (p.command !== 'run') return;
    assert.equal(p.options.toneScope, 'word');
  });

  test('--tone-scope rejects anything else', () => {
    assert.throws(() => parseArgs(['in.mp4', '--tone-scope', 'line']), /must be cue or word/);
  });
});

describe('theme-configurable thresholds and active overrides', () => {
  test('thresholds merge over the defaults', () => {
    const t = parseCaptionTheme(JSON.stringify({ thresholds: { excitedPitch: 5 } }), 'x');
    assert.equal(t.thresholds.excitedPitch, 5);
    assert.equal(t.thresholds.softPitch, DEFAULT_THRESHOLDS.softPitch, 'others keep defaults');
  });

  test('an unknown threshold is rejected', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ thresholds: { loudness: 3 } }), 'x'),
      /unknown threshold "loudness"/,
    );
  });

  test('a non-numeric threshold is rejected', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ thresholds: { excitedPitch: 'high' } }), 'x'),
      /must be a finite number/,
    );
  });

  test('retuning a threshold changes the classification', () => {
    const features = {
      rmsDb: -20, energyVariationDb: 2, energyRelative: 1.0, speakingRate: 2.5,
      pauseBefore: 0, pauseAfter: 0, voicedRatio: 0.8,
      f0Hz: 200, pitchRelative: 3, pitchVariation: 2,
    };
    assert.equal(classifyProsody(features, DEFAULT_THRESHOLDS).tone, 'excited');
    assert.notEqual(
      classifyProsody(features, { ...DEFAULT_THRESHOLDS, excitedPitch: 10 }).tone, 'excited',
      'raising the bar must actually stop the rule firing',
    );
  });

  test('active overrides parse and validate', () => {
    const t = parseCaptionTheme(
      JSON.stringify({ active: { color: '#FFD54A', scale: 1.1, bold: true } }), 'x',
    );
    assert.equal(t.active?.color, '#FFD54A');
    assert.equal(t.active?.scale, 1.1);
    assert.equal(t.active?.bold, true);
  });

  test('a bad active colour is rejected', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ active: { color: 'gold' } }), 'x'),
      /active colour "gold"/,
    );
  });

  test('an out-of-range active scale is rejected', () => {
    assert.throws(
      () => parseCaptionTheme(JSON.stringify({ active: { scale: 5 } }), 'x'),
      /active scale 5/,
    );
  });
});
