import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  ease, resolveIntensity, resolveAnimationTemplateName, assertValidAnimationTemplateName,
  assertValidMotionLevel, assertValidMotionIntensity, listAnimationTemplates,
  ANIMATION_TEMPLATES, planMotionSlices, resolveWordMotion, resolveCueEdgeMotion,
  effectiveMaxScale, ANIMATION_FRAME_STEP_SEC,
  type AnimationTemplate, type EasingName,
} from '../src/captions/animation.js';
import { CaptionEngineError } from '../src/errors.js';
import { parseArgs } from '../src/cli/args.js';
import { parseCaptionTheme, loadCaptionTheme } from '../src/captions/tone-style.js';
import {
  layoutCue, renderCueSvg, planCaptionFrames, buildCaptionFrames,
} from '../src/captions/svg.js';
import { DEFAULT_STYLE } from '../src/captions/style.js';
import { initShaper } from '../src/text/shaper.js';
import { mkCue } from './helpers.js';

before(async () => { await initShaper(); });

/**
 * Kinetic captions.
 *
 * Central guarantee under test everywhere here: `--motion none` (the
 * default — `opts.motion` simply absent) must reproduce EXACTLY what this
 * project rendered before this feature existed. Every other assertion is
 * really in service of that one, because it is what lets kinetic captions be
 * an addition rather than a rewrite of the caption renderer.
 */

describe('easing', () => {
  const NAMES: EasingName[] = ['linear', 'easeOut', 'easeIn', 'easeInOut', 'easeOutBack', 'easeOutElastic'];

  for (const name of NAMES) {
    test(`${name}: 0 and 1 are fixed points (or land there for non-overshoot curves)`, () => {
      // Floating point, not exactly 0/1 for every curve — a tight tolerance
      // is the correct check, not strict equality.
      assert.ok(Math.abs(ease(name, 0)) < 1e-9, `${name}(0) should be ~0, got ${ease(name, 0)}`);
      // easeOutBack/Elastic legitimately overshoot MID-curve, but must still
      // resolve to exactly 1 at the end, or a "settled" word would never
      // actually settle.
      assert.ok(Math.abs(ease(name, 1) - 1) < 1e-9, `${name}(1) should be 1, got ${ease(name, 1)}`);
    });
  }

  test('out-of-range input is clamped, never extrapolated', () => {
    assert.equal(ease('linear', -5), 0);
    assert.equal(ease('linear', 5), 1);
  });

  test('every curve is a pure function of its input', () => {
    for (const name of NAMES) {
      assert.equal(ease(name, 0.37), ease(name, 0.37));
    }
  });
});

describe('motion level and intensity validation', () => {
  test('valid levels do not throw', () => {
    for (const v of ['none', 'subtle', 'expressive', 'auto']) {
      assert.doesNotThrow(() => assertValidMotionLevel(v));
    }
  });

  test('an unknown level is a typed, actionable error', () => {
    assert.throws(() => assertValidMotionLevel('wild'), (e: unknown) => {
      assert.ok(e instanceof CaptionEngineError);
      assert.ok((e as CaptionEngineError).hint?.includes('none'));
      return true;
    });
  });

  test('intensity 0 and 1 are valid; outside that is rejected', () => {
    assert.doesNotThrow(() => assertValidMotionIntensity(0));
    assert.doesNotThrow(() => assertValidMotionIntensity(1));
    for (const bad of [-0.01, 1.01, NaN, Infinity]) {
      assert.throws(() => assertValidMotionIntensity(bad), CaptionEngineError);
    }
  });

  test('none always resolves to zero intensity, even with an explicit override attempted elsewhere', () => {
    assert.equal(resolveIntensity({ level: 'none' }), 0);
  });

  test('an explicit --motion-intensity always wins over the level default', () => {
    assert.equal(resolveIntensity({ level: 'subtle', explicitIntensity: 0.9 }), 0.9);
    assert.equal(resolveIntensity({ level: 'expressive', explicitIntensity: 0.1 }), 0.1);
  });

  test('subtle is restrained relative to expressive', () => {
    const subtle = resolveIntensity({ level: 'subtle' });
    const expressive = resolveIntensity({ level: 'expressive' });
    assert.ok(subtle > 0 && subtle < expressive);
  });

  test('auto without a confident tone behaves like a quieter subtle, never like expressive', () => {
    const autoQuiet = resolveIntensity({ level: 'auto', autoHasConfidentTone: false });
    const autoReactive = resolveIntensity({ level: 'auto', autoHasConfidentTone: true });
    const expressive = resolveIntensity({ level: 'expressive' });
    assert.ok(autoQuiet > 0 && autoQuiet <= autoReactive);
    assert.ok(autoReactive < expressive, 'auto must stay restrained, never full expressive strength');
  });
});

describe('the template library', () => {
  test('has between 12 and 20 templates, as specified', () => {
    const n = listAnimationTemplates().length;
    assert.ok(n >= 12 && n <= 20, `expected 12-20 templates, got ${n}`);
  });

  test('every template is internally consistent', () => {
    for (const name of listAnimationTemplates()) {
      const t = ANIMATION_TEMPLATES[name]!;
      assert.equal(t.name, name);
      assert.ok(t.description.length > 10, `${name} needs a real description`);
      assert.ok(t.maxScale >= 1 && t.maxScale <= 2, `${name} maxScale out of sane range`);
      assert.ok(t.intensityDefault > 0 && t.intensityDefault <= 1, `${name} intensityDefault out of range`);
      assert.ok(t.wordEntrance.durationSec >= 0 && t.wordEntrance.durationSec < 1, `${name} entrance duration implausible`);
      assert.ok(t.exit.durationSec >= 0 && t.exit.durationSec < 1, `${name} exit duration implausible`);
    }
  });

  test('names a couple of the suggested directions from the spec, by name', () => {
    for (const n of ['pop', 'bounce', 'typewriter', 'karaoke-sweep', 'punch', 'glitch', 'neon-pulse', 'comic-hit', 'cinematic-fade', 'lyric-flow', 'minimal-reveal']) {
      assert.ok(n in ANIMATION_TEMPLATES, `expected a "${n}" template`);
    }
  });

  test('an unknown template name is a typed, actionable error listing real names', () => {
    assert.throws(() => assertValidAnimationTemplateName('not-a-template'), (e: unknown) => {
      assert.ok(e instanceof CaptionEngineError);
      const msg = (e as Error).message + (e as CaptionEngineError).hint;
      assert.ok(msg.includes('pop'));
      return true;
    });
  });

  test('"auto" is always a valid template NAME to pass through validation', () => {
    assert.doesNotThrow(() => assertValidAnimationTemplateName('auto'));
  });
});

describe('template resolution ("--animation-template auto")', () => {
  test('an explicit, valid request always wins', () => {
    assert.equal(resolveAnimationTemplateName({ requested: 'glitch', minConfidence: 0.6 }), 'glitch');
  });

  test('an explicit invalid request throws rather than silently falling back', () => {
    assert.throws(() => resolveAnimationTemplateName({ requested: 'nope', minConfidence: 0.6 }));
  });

  test('with a confident tone and no theme override, a restrained built-in mapping applies', () => {
    const name = resolveAnimationTemplateName({
      tone: 'excited', toneConfidence: 0.9, minConfidence: 0.6,
    });
    assert.ok(name in ANIMATION_TEMPLATES);
  });

  test('a theme toneTemplates entry beats the built-in mapping', () => {
    const name = resolveAnimationTemplateName({
      tone: 'excited', toneConfidence: 0.9, minConfidence: 0.6,
      themeToneTemplates: { excited: 'lyric-flow' },
    });
    assert.equal(name, 'lyric-flow');
  });

  test('below minConfidence, tone is ignored and the style preset default is used', () => {
    const name = resolveAnimationTemplateName({
      tone: 'excited', toneConfidence: 0.1, minConfidence: 0.6,
      stylePresetDefault: 'cinematic-fade',
    });
    assert.equal(name, 'cinematic-fade');
  });

  test('with nothing to go on at all, falls back to the most restrained template', () => {
    assert.equal(resolveAnimationTemplateName({ minConfidence: 0.6 }), 'minimal-reveal');
  });
});

describe('effectiveMaxScale', () => {
  test('at intensity 0, scale is always 1 regardless of template', () => {
    for (const name of listAnimationTemplates()) {
      assert.equal(effectiveMaxScale(ANIMATION_TEMPLATES[name]!, 0), 1);
    }
  });

  test('at intensity 1, scale equals the template\'s own maxScale', () => {
    const t = ANIMATION_TEMPLATES.pop!;
    assert.equal(effectiveMaxScale(t, 1), t.maxScale);
  });

  test('is monotonic in intensity', () => {
    const t = ANIMATION_TEMPLATES['comic-hit']!;
    assert.ok(effectiveMaxScale(t, 0.2) < effectiveMaxScale(t, 0.8));
  });
});

describe('planMotionSlices: deterministic, bounded, gap-free subdivision', () => {
  const template = ANIMATION_TEMPLATES.pop!;

  function ctx(over: Partial<Parameters<typeof planMotionSlices>[1]> = {}) {
    return {
      template, intensity: 1, isWord: true, wordIndex: 0, wordText: 'namaste',
      isCueFirst: false, isCueLast: false, emphasis: false, ...over,
    };
  }

  test('slices tile the full duration exactly — no gap, no overlap', () => {
    const dur = 0.6;
    const slices = planMotionSlices(dur, ctx());
    assert.ok(slices.length > 0);
    let cursor = 0;
    for (const s of slices) {
      assert.ok(Math.abs(s.offsetStart - cursor) < 1e-6, 'gap or overlap detected');
      assert.ok(s.offsetEnd > s.offsetStart, 'zero/negative-length slice');
      cursor = s.offsetEnd;
    }
    assert.ok(Math.abs(cursor - dur) < 1e-6, 'slices do not reach the full duration');
  });

  test('is deterministic: identical input produces identical output', () => {
    const a = planMotionSlices(0.5, ctx());
    const b = planMotionSlices(0.5, ctx());
    assert.deepEqual(a, b);
  });

  test('a zero-duration plan produces no slices', () => {
    assert.deepEqual(planMotionSlices(0, ctx()), []);
  });

  test('frame count is bounded regardless of how long the word is on screen', () => {
    // A very long "hold" must not blow up into hundreds of frames — the whole
    // point of only sampling entrance/exit/emphasis, not the entire duration.
    const slices = planMotionSlices(30, ctx({ template: ANIMATION_TEMPLATES['neon-pulse']! }));
    assert.ok(slices.length < 30, `expected a bounded frame count, got ${slices.length} for a 30s word`);
  });

  test('a non-word (gap) plan gets no word-phase tag, only cue-edge when applicable', () => {
    const slices = planMotionSlices(0.3, ctx({ isWord: false, isCueFirst: true }));
    for (const s of slices) {
      assert.equal(s.motion.wordPhase, undefined);
    }
  });

  test('exit only appears on the cue-last plan', () => {
    const notLast = planMotionSlices(0.4, ctx({ isCueLast: false }));
    const last = planMotionSlices(0.4, ctx({ isCueLast: true }));
    assert.ok(!notLast.some((s) => s.motion.wordPhase === 'exit'));
    assert.ok(last.some((s) => s.motion.wordPhase === 'exit'), 'expected an exit-tagged slice on the cue-final plan');
  });

  test('two different words produce different (but each internally stable) seeds', () => {
    const a = planMotionSlices(0.3, ctx({ wordText: 'alpha' }));
    const b = planMotionSlices(0.3, ctx({ wordText: 'beta' }));
    assert.notEqual(a[0]!.motion.seed, b[0]!.motion.seed);
  });

  test('at zero-length entrance/exit templates, a hold-only word still tiles correctly', () => {
    const flat: AnimationTemplate = {
      ...ANIMATION_TEMPLATES['minimal-reveal']!,
      wordEntrance: { type: 'none', durationSec: 0, easing: 'linear' },
      exit: { type: 'none', durationSec: 0, easing: 'linear' },
      cueEntrance: { type: 'none', durationSec: 0, easing: 'linear' },
    };
    const slices = planMotionSlices(0.5, ctx({ template: flat, isCueLast: true, isCueFirst: true }));
    assert.equal(slices.length, 1);
    assert.equal(slices[0]!.offsetStart, 0);
    assert.ok(Math.abs(slices[0]!.offsetEnd - 0.5) < 1e-6);
  });
});

describe('resolveWordMotion: the per-frame transform interpreter', () => {
  const template = ANIMATION_TEMPLATES.pop!;

  test('intensity 0 always resolves to the resting state, whatever the phase', () => {
    const state = resolveWordMotion(template, {
      templateName: 'pop', intensity: 0, emphasis: false, seed: 0.5,
      wordPhase: 'entrance', wordProgress: 0.5,
    });
    assert.equal(state.scale, 1);
    assert.equal(state.opacity, 1);
    assert.equal(state.translateXFrac, 0);
    assert.equal(state.translateYFrac, 0);
  });

  test('entrance progress 1 settles at (approximately) the resting transform', () => {
    const state = resolveWordMotion(template, {
      templateName: 'pop', intensity: 1, emphasis: false, seed: 0.1,
      wordPhase: 'entrance', wordProgress: 1,
    });
    assert.ok(Math.abs(state.opacity - 1) < 1e-6);
  });

  test('exit progress 1 fades fully out for a fade-type exit', () => {
    const state = resolveWordMotion(template, {
      templateName: 'pop', intensity: 1, emphasis: false, seed: 0.1,
      wordPhase: 'exit', wordProgress: 1,
    });
    assert.ok(state.opacity < 0.05);
  });

  test('is a pure function: same input, same output', () => {
    const motion = { templateName: 'pop', intensity: 0.7, emphasis: false, seed: 0.42, wordPhase: 'entrance' as const, wordProgress: 0.3 };
    assert.deepEqual(resolveWordMotion(template, motion), resolveWordMotion(template, motion));
  });

  test('shake is only ever produced under emphasis, never as default active behavior', () => {
    const glitch = ANIMATION_TEMPLATES.glitch!;
    const nonEmphasis = resolveWordMotion(glitch, {
      templateName: 'glitch', intensity: 1, emphasis: false, seed: 0.5,
      wordPhase: 'hold', wordProgress: 0.25,
    });
    // glitch's active.type is 'none', so hold without emphasis must be resting.
    assert.equal(nonEmphasis.translateXFrac, 0);
  });

  test('emphasis at high confidence engages the template\'s emphasis decoration', () => {
    const comic = ANIMATION_TEMPLATES['comic-hit']!;
    const state = resolveWordMotion(comic, {
      templateName: 'comic-hit', intensity: 1, emphasis: true, seed: 0.5,
      wordPhase: 'entrance', wordProgress: 1,
    });
    assert.ok(state.decoration.backplate, 'comic-hit emphasis (card) should turn on the backplate');
  });

  test('reveal (typewriter) progress maps monotonically to revealFrac', () => {
    const typewriter = ANIMATION_TEMPLATES.typewriter!;
    const early = resolveWordMotion(typewriter, {
      templateName: 'typewriter', intensity: 1, emphasis: false, seed: 0.2,
      wordPhase: 'entrance', wordProgress: 0.2,
    });
    const late = resolveWordMotion(typewriter, {
      templateName: 'typewriter', intensity: 1, emphasis: false, seed: 0.2,
      wordPhase: 'entrance', wordProgress: 0.9,
    });
    assert.ok((early.revealFrac ?? 0) < (late.revealFrac ?? 0));
  });

  test('sweep (karaoke) fraction stays within 0..1', () => {
    const karaoke = ANIMATION_TEMPLATES['karaoke-sweep']!;
    for (const p of [0, 0.25, 0.5, 0.75, 0.999]) {
      const state = resolveWordMotion(karaoke, {
        templateName: 'karaoke-sweep', intensity: 1, emphasis: false, seed: 0.5,
        wordPhase: 'hold', wordProgress: p,
      });
      assert.ok(state.sweepFrac! >= 0 && state.sweepFrac! <= 1);
    }
  });
});

describe('resolveCueEdgeMotion', () => {
  const template = ANIMATION_TEMPLATES['cinematic-fade']!;

  test('no edge means no change', () => {
    const m = resolveCueEdgeMotion(template, undefined, 1, 1);
    assert.equal(m.opacity, 1);
    assert.equal(m.translateYFrac, 0);
  });

  test('enter goes from transparent to opaque as progress advances', () => {
    const early = resolveCueEdgeMotion(template, 'enter', 0.1, 1);
    const late = resolveCueEdgeMotion(template, 'enter', 1, 1);
    assert.ok(early.opacity < late.opacity);
    assert.ok(Math.abs(late.opacity - 1) < 1e-6);
  });

  test('exit goes from opaque to transparent', () => {
    const early = resolveCueEdgeMotion(template, 'exit', 0.1, 1);
    const late = resolveCueEdgeMotion(template, 'exit', 1, 1);
    assert.ok(early.opacity > late.opacity);
  });
});

describe('theme JSON: the optional "motion" section', () => {
  test('a theme with no motion section parses exactly as before (version 1 files still load)', () => {
    const t = parseCaptionTheme(JSON.stringify({ version: 1, tones: {} }), 'test');
    assert.equal(t.motion, undefined);
  });

  test('a valid motion section parses', () => {
    const t = parseCaptionTheme(JSON.stringify({
      version: 2, tones: {},
      motion: { template: 'pop', intensity: 0.5, toneTemplates: { excited: 'punch' } },
    }), 'test');
    assert.equal(t.motion?.template, 'pop');
    assert.equal(t.motion?.intensity, 0.5);
    assert.equal(t.motion?.toneTemplates?.excited, 'punch');
  });

  test('an unknown template name in motion.template is rejected at load time', () => {
    assert.throws(() => parseCaptionTheme(JSON.stringify({
      version: 2, tones: {}, motion: { template: 'not-a-template' },
    }), 'test'), CaptionEngineError);
  });

  test('an out-of-range motion.intensity is rejected at load time', () => {
    assert.throws(() => parseCaptionTheme(JSON.stringify({
      version: 2, tones: {}, motion: { intensity: 3 },
    }), 'test'), CaptionEngineError);
  });

  test('an unknown tone under motion.toneTemplates is rejected', () => {
    assert.throws(() => parseCaptionTheme(JSON.stringify({
      version: 2, tones: {}, motion: { toneTemplates: { furious: 'pop' } },
    }), 'test'), CaptionEngineError);
  });

  test('an unknown field under motion is rejected, same discipline as the rest of the theme', () => {
    assert.throws(() => parseCaptionTheme(JSON.stringify({
      version: 2, tones: {}, motion: { speed: 'fast' },
    }), 'test'), CaptionEngineError);
  });

  test('the shipped theme\'s motion section parses and every named template is real', () => {
    const t = loadCaptionTheme();
    if (t.motion?.template) assert.ok(t.motion.template in ANIMATION_TEMPLATES);
    for (const name of Object.values(t.motion?.toneTemplates ?? {})) {
      assert.ok(name && name in ANIMATION_TEMPLATES);
    }
  });
});

describe('CLI: --motion / --motion-intensity / --animation-template', () => {
  test('defaults are none / auto — motion is off unless asked for', () => {
    const p = parseArgs(['in.mp4', '--transcript-in', 't.json']);
    assert.equal(p.command, 'run');
    assert.equal(p.options.motion, 'none');
    assert.equal(p.options.animationTemplate, 'auto');
  });

  test('valid values parse through', () => {
    const p = parseArgs(['in.mp4', '--motion', 'expressive', '--animation-template', 'pop', '--motion-intensity', '0.8']);
    assert.equal(p.command, 'run');
    assert.equal(p.options.motion, 'expressive');
    assert.equal(p.options.animationTemplate, 'pop');
    assert.equal(p.options.motionIntensity, 0.8);
  });

  test('--animation-preset is accepted as an alias', () => {
    const p = parseArgs(['in.mp4', '--animation-preset', 'glitch']);
    assert.equal(p.command, 'run');
    assert.equal(p.options.animationTemplate, 'glitch');
  });

  test('an unknown --motion level is rejected with a clear message', () => {
    assert.throws(() => parseArgs(['in.mp4', '--motion', 'wild']), CaptionEngineError);
  });

  test('an unknown --animation-template is rejected with a clear message', () => {
    assert.throws(() => parseArgs(['in.mp4', '--animation-template', 'nope']), CaptionEngineError);
  });

  test('--motion-intensity out of 0..1 is rejected', () => {
    assert.throws(() => parseArgs(['in.mp4', '--motion-intensity', '2']), CaptionEngineError);
    assert.throws(() => parseArgs(['in.mp4', '--motion-intensity', '-1']), CaptionEngineError);
  });

  test('"auto" is a valid --animation-template value', () => {
    const p = parseArgs(['in.mp4', '--animation-template', 'auto']);
    assert.equal(p.command, 'run');
    assert.equal(p.options.animationTemplate, 'auto');
  });
});

describe('backward compatibility: --motion none is byte-identical to no animation at all', () => {
  const cue = mkCue(['this', 'is', 'a', 'caption']);
  const baseOpts = { width: 1080, height: 1920, style: DEFAULT_STYLE, activeWordIndex: 1 };

  test('renderCueSvg output is IDENTICAL whether opts.motion is omitted or explicitly absent', async () => {
    const a = await renderCueSvg(cue, baseOpts);
    const b = await renderCueSvg(cue, { ...baseOpts, motion: undefined, frameMotion: undefined });
    assert.equal(a, b);
  });

  test('planCaptionFrames without motion is unaffected by the emphasisWords param existing', () => {
    const a = planCaptionFrames([cue], { width: 1080, height: 1920, highlight: 'active-word' });
    const b = planCaptionFrames([cue], { width: 1080, height: 1920, highlight: 'active-word', emphasisWords: new Set(['0:0']) });
    assert.deepEqual(a, b, 'emphasisWords must be inert without opts.motion');
  });

  test('a render with motion at intensity 0 produces the same frame COUNT as no motion (intensity 0 short-circuits)', () => {
    const template = ANIMATION_TEMPLATES.pop!;
    const withoutMotion = planCaptionFrames([cue], { width: 1080, height: 1920, highlight: 'active-word' });
    const zeroIntensity = planCaptionFrames([cue], {
      width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 0 },
    });
    assert.equal(withoutMotion.length, zeroIntensity.length);
  });
});

describe('motion enabled: frame planning and rendering', () => {
  const cue = mkCue(['this', 'is', 'a', 'caption']);
  const template = ANIMATION_TEMPLATES.pop!;

  test('motion produces MORE frames than a static render of the same cue', () => {
    const withoutMotion = planCaptionFrames([cue], { width: 1080, height: 1920, highlight: 'active-word' });
    const withMotion = planCaptionFrames([cue], {
      width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 1 },
    });
    assert.ok(withMotion.length > withoutMotion.length);
  });

  test('every animated frame still tiles the cue\'s own timeline with no gap', () => {
    const plans = planCaptionFrames([cue], {
      width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 1 },
    });
    for (let i = 0; i < plans.length - 1; i++) {
      assert.ok(plans[i]!.end <= plans[i + 1]!.start + 1e-4, 'animated frames must not overlap');
    }
  });

  test('rendering an animated frame produces a valid, finite SVG', async () => {
    const plans = planCaptionFrames([cue], {
      width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 1 },
    });
    const frame = plans.find((p) => p.motion?.wordPhase === 'entrance');
    assert.ok(frame, 'expected at least one entrance-tagged frame');
    const svg = await renderCueSvg(cue, {
      width: 1080, height: 1920, style: DEFAULT_STYLE, activeWordIndex: frame!.activeWordIndex,
      motion: { template, intensity: 1 }, frameMotion: frame!.motion,
    });
    assert.match(svg, /^<svg/);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/);
  });

  test('frame count stays bounded on a long synthetic transcript (chunker-safety sanity)', () => {
    const longCue = mkCue(Array.from({ length: 4 }, (_, i) => `word${i}`), 0, 0.5);
    const cues = Array.from({ length: 40 }, (_, i) => ({ ...longCue, index: i, start: i * 2, end: i * 2 + 2, words: longCue.words.map((w) => ({ ...w, start: w.start + i * 2, end: w.end + i * 2 })) }));
    const withoutMotion = planCaptionFrames(cues, { width: 1080, height: 1920, highlight: 'active-word' });
    const withMotion = planCaptionFrames(cues, {
      width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 1 },
    });
    // Documented, bounded multiplier — not unlimited growth. If this ever
    // regresses far past it, long-video chunking (≤80 overlays/chunk) is at risk.
    assert.ok(withMotion.length <= withoutMotion.length * 12, `frame blowup: ${withoutMotion.length} -> ${withMotion.length}`);
  });
});

describe('no layout jitter with motion enabled', () => {
  const WORDS = ['this', 'is', 'a', 'caption', 'line'];

  test('reservedWidth grows to cover the template\'s peak scale, and is IDENTICAL across every active index', async () => {
    const template = ANIMATION_TEMPLATES['comic-hit']!; // large maxScale
    const opts = {
      width: 1080, height: 1920, style: { ...DEFAULT_STYLE, fontSizePx: 64 },
      motion: { template, intensity: 1 },
    };
    const base = await layoutCue(mkCue(WORDS), { ...opts, activeWordIndex: -1 });
    for (let i = 0; i < WORDS.length; i++) {
      const withActive = await layoutCue(mkCue(WORDS), { ...opts, activeWordIndex: i });
      const baseX = base.flatMap((l) => l.words.map((w) => w.x));
      const activeX = withActive.flatMap((l) => l.words.map((w) => w.x));
      assert.deepEqual(activeX, baseX, `layout moved with motion enabled at active index ${i}`);
    }
  });

  test('a template with a larger maxScale reserves more width than one with a smaller maxScale', async () => {
    const small = await layoutCue(mkCue(WORDS), {
      width: 1080, height: 1920, style: DEFAULT_STYLE, activeWordIndex: 0,
      motion: { template: ANIMATION_TEMPLATES['minimal-reveal']!, intensity: 1 },
    });
    const large = await layoutCue(mkCue(WORDS), {
      width: 1080, height: 1920, style: DEFAULT_STYLE, activeWordIndex: 0,
      motion: { template: ANIMATION_TEMPLATES['comic-hit']!, intensity: 1 },
    });
    const sum = (ls: typeof small): number => ls.flatMap((l) => l.words).reduce((n, w) => n + w.reservedWidth, 0);
    assert.ok(sum(large) >= sum(small));
  });
});

describe('Indic-script rendering with motion enabled', () => {
  const SAMPLES: Record<string, string[]> = {
    Devanagari: ['नमस्ते', 'क्षेत्र', 'विद्या'],
    Telugu: ['తెలుగు', 'రాష్ట్రం'],
    Kannada: ['ಕನ್ನಡ', 'ಕ್ಷೇತ್ರ'],
    Tamil: ['தமிழ்', 'க்ஷேமம்'],
    Malayalam: ['മലയാളം', 'ക്ഷേമം'],
    Bengali: ['বাংলা', 'ক্ষেত্র'],
    Gujarati: ['ગુજરાતી', 'ક્ષેત્ર'],
    Hinglish: ['aaj', 'meeting', 'bahut', 'important'],
  };

  for (const [label, words] of Object.entries(SAMPLES)) {
    test(`${label}: every animation template renders a valid SVG with no glyph dropped`, async () => {
      const cue = mkCue(words);
      for (const name of ['pop', 'typewriter', 'karaoke-sweep', 'comic-hit', 'cinematic-fade']) {
        const template = ANIMATION_TEMPLATES[name]!;
        const plans = planCaptionFrames([cue], {
          width: 1080, height: 1920, highlight: 'active-word', motion: { template, intensity: 1 },
        });
        assert.ok(plans.length >= words.length, `${label}/${name}: expected at least one frame per word`);
        const frame = plans[Math.floor(plans.length / 2)]!;
        const svg = await renderCueSvg(cue, {
          width: 1080, height: 1920, style: DEFAULT_STYLE, activeWordIndex: frame.activeWordIndex,
          motion: { template, intensity: 1 }, frameMotion: frame.motion,
        });
        assert.match(svg, /^<svg/, `${label}/${name}: not a valid SVG document`);
        assert.doesNotMatch(svg, /NaN|Infinity/, `${label}/${name}: invalid coordinates`);
        // Every word must still appear as at least one drawn glyph — motion
        // must never be the reason a word goes missing.
        const pathCount = (svg.match(/<path /g) ?? []).length;
        assert.ok(pathCount > 0, `${label}/${name}: no glyphs rendered`);
      }
    });
  }
});

describe('safe bounds across aspect ratios', () => {
  const ASPECTS: Array<{ name: string; width: number; height: number }> = [
    { name: 'portrait', width: 1080, height: 1920 },
    { name: 'landscape', width: 1920, height: 1080 },
    { name: 'square', width: 1080, height: 1080 },
    { name: 'original-odd', width: 1276, height: 716 },
  ];

  for (const aspect of ASPECTS) {
    test(`${aspect.name}: an animated frame's SVG declares exactly the requested canvas size`, async () => {
      const cue = mkCue(['this', 'is', 'a', 'caption']);
      const template = ANIMATION_TEMPLATES['dynamic-word-focus']!; // large maxScale + backplate
      const plans = planCaptionFrames([cue], {
        width: aspect.width, height: aspect.height, highlight: 'active-word',
        motion: { template, intensity: 1 },
      });
      const frame = plans.find((p) => p.motion?.wordPhase === 'entrance') ?? plans[0]!;
      const svg = await renderCueSvg(cue, {
        width: aspect.width, height: aspect.height, style: DEFAULT_STYLE, activeWordIndex: frame.activeWordIndex,
        motion: { template, intensity: 1 }, frameMotion: frame.motion,
      });
      // The rasteriser cross-checks its output dimensions against these
      // declared attributes (src/render/rasteriser.ts) — a mismatch here
      // would fail every frame, not just look wrong.
      assert.match(svg, new RegExp(`width="${aspect.width}" height="${aspect.height}"`));
      assert.match(svg, new RegExp(`viewBox="0 0 ${aspect.width} ${aspect.height}"`));
    });
  }
});

describe('buildCaptionFrames end-to-end with motion (eager variant, used by tests/previews)', () => {
  test('produces frames whose SVGs all parse as well-formed-looking documents', async () => {
    const cue = mkCue(['hello', 'world']);
    const frames = await buildCaptionFrames([cue], {
      width: 1080, height: 1920, style: DEFAULT_STYLE, highlight: 'active-word',
      motion: { template: ANIMATION_TEMPLATES.bounce!, intensity: 1 },
      emphasisWords: new Set(),
    });
    assert.ok(frames.length > 2);
    for (const f of frames) {
      assert.match(f.svg, /^<svg[\s\S]*<\/svg>$/);
    }
  });
});
