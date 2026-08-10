import { CaptionEngineError } from '../errors.js';
import type { Tone } from '../media/prosody.js';

/**
 * Kinetic captions — the animation model.
 *
 * DELIBERATELY SEPARATE FROM svg.ts. This module knows nothing about SVG,
 * fonts, or shaping — it is pure timing/easing/template data and deterministic
 * math. `src/captions/svg.ts` is the only consumer: it turns the `MotionSlice`s
 * this module produces into extra sampled frames, and turns the `WordMotionState`
 * this module computes into an SVG transform + decoration. That split keeps
 * this file fully unit-testable without a rasteriser, a font, or a video.
 *
 * WHY SAMPLED FRAMES, NOT BROWSER/CSS ANIMATION. The renderer's whole reason to
 * exist (see src/text/shaper.ts) is that FFmpeg/libass do not reliably shape
 * Devanagari/Telugu/Kannada/etc, so captions are pre-shaped with HarfBuzz and
 * handed to FFmpeg as flat PNG overlays. Motion therefore has to be baked into
 * MORE overlays, each one a static frame at a sampled point in the animation —
 * there is no other place for it to live in this pipeline, and no CSS/browser
 * step exists to add one to.
 *
 * DETERMINISM. Every number here is a pure function of (word start/end,
 * word index, template, intensity, progress). No Math.random(), no Date.now().
 * Where a template wants per-word variation (glitch jitter), it comes from a
 * cheap string hash of the word's own text + index — the same word always
 * jitters the same way, on any machine, on any run.
 */

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

export type EasingName = 'linear' | 'easeOut' | 'easeIn' | 'easeInOut' | 'easeOutBack' | 'easeOutElastic';

/** All curves take/return 0..1. Input is clamped, so a caller can never pass a stray value through to a transform. */
export function ease(name: EasingName, tRaw: number): number {
  const t = Math.min(1, Math.max(0, tRaw));
  switch (name) {
    case 'linear': return t;
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case 'easeOutBack': {
      // Slight overshoot past 1 then settle — the "pop" feel. c1/c3 are the
      // standard easing-function constants for a back-out curve.
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    }
    case 'easeOutElastic': {
      if (t === 0 || t === 1) return t;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
    }
  }
}

/** Deterministic pseudo-random in [0,1), seeded from text — never wall-clock, never Math.random. */
function hashUnit(seedText: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// ---------------------------------------------------------------------------
// Motion configuration
// ---------------------------------------------------------------------------

export type MotionLevel = 'none' | 'subtle' | 'expressive' | 'auto';
export const MOTION_LEVELS: MotionLevel[] = ['none', 'subtle', 'expressive', 'auto'];

/** Baseline intensity for a level when --motion-intensity is not given explicitly. */
const LEVEL_BASE_INTENSITY: Record<Exclude<MotionLevel, 'auto'>, number> = {
  none: 0,
  subtle: 0.45,
  expressive: 1,
};

export function assertValidMotionLevel(v: string): asserts v is MotionLevel {
  if (!MOTION_LEVELS.includes(v as MotionLevel)) {
    throw new CaptionEngineError(
      `Unknown --motion "${v}".`,
      `Valid: ${MOTION_LEVELS.join(', ')}\n` +
        'none        static rendering, byte-identical to no animation at all (default)\n' +
        'subtle      restrained motion, safe as a default look\n' +
        'expressive  full template strength\n' +
        'auto        motion level AND template chosen from tone/style when --prosody is on',
    );
  }
}

export function assertValidMotionIntensity(n: number): void {
  if (!Number.isFinite(n)) {
    throw new CaptionEngineError(
      `--motion-intensity must be a finite number, got ${JSON.stringify(n)}.`,
      'Choose a value between 0 (no motion) and 1 (full template strength).',
    );
  }
  if (n < 0 || n > 1) {
    throw new CaptionEngineError(
      `--motion-intensity must be between 0 and 1, got ${n}.`,
      '0 = no motion, 1 = full template strength. Values are clamped nowhere else ' +
        'in the pipeline, so an out-of-range value is rejected here instead of ' +
        'silently producing an oversized or inverted animation.',
    );
  }
}

// ---------------------------------------------------------------------------
// Animation templates — declarative, data-driven
// ---------------------------------------------------------------------------

export type CueEdgeType = 'none' | 'fade' | 'slide-up' | 'pop';
export type WordEntranceType = 'none' | 'pop' | 'fade' | 'slide-up' | 'slide-left' | 'slide-right' | 'rise' | 'reveal';
export type ActiveBehaviorType = 'none' | 'pulse' | 'sweep' | 'float' | 'glow-pulse';
export type EmphasisBehaviorType = 'none' | 'punch' | 'shake' | 'card' | 'glow';
export type ExitType = 'none' | 'fade' | 'hold';

export interface DecorationSpec {
  backplate: boolean;
  underline: boolean;
  glow: boolean;
  shadow: boolean;
}

const NO_DECORATION: DecorationSpec = { backplate: false, underline: false, glow: false, shadow: false };

export interface AnimationTemplate {
  name: string;
  description: string;
  cueEntrance: { type: CueEdgeType; durationSec: number; easing: EasingName };
  wordEntrance: { type: WordEntranceType; durationSec: number; easing: EasingName };
  /** Continuous behavior while a word is on screen, after its entrance completes. */
  active: { type: ActiveBehaviorType; cycleSec: number };
  /** Replaces wordEntrance/active for a word classified as strong, high-confidence emphasis. */
  emphasis: { type: EmphasisBehaviorType; minConfidence: number };
  exit: { type: ExitType; durationSec: number; easing: EasingName };
  decoration: DecorationSpec;
  /** Peak scale multiplier over resting size, at intensity = 1. Drives reservedWidth. */
  maxScale: number;
  /** This template's own baseline strength, 0..1, before --motion level/intensity scaling. */
  intensityDefault: number;
}

function tpl(t: Omit<AnimationTemplate, 'decoration'> & { decoration?: Partial<DecorationSpec> }): AnimationTemplate {
  return { ...t, decoration: { ...NO_DECORATION, ...t.decoration } };
}

/**
 * The template library. One interpreter (see `sampleWordEntrance` etc. below)
 * consumes ALL of these — there is no per-template bespoke code, so adding a
 * 17th template is a data entry, not a new code path to maintain.
 */
export const ANIMATION_TEMPLATES: Record<string, AnimationTemplate> = {
  pop: tpl({
    name: 'pop', description: 'Quick scale-up with a slight overshoot, then settle. The default "kinetic caption" feel.',
    cueEntrance: { type: 'fade', durationSec: 0.12, easing: 'easeOut' },
    wordEntrance: { type: 'pop', durationSec: 0.16, easing: 'easeOutBack' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'punch', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.1, easing: 'easeIn' },
    maxScale: 1.22, intensityDefault: 0.7,
  }),
  bounce: tpl({
    name: 'bounce', description: 'Elastic settle on entrance — a springy, playful arrival for each word.',
    cueEntrance: { type: 'slide-up', durationSec: 0.14, easing: 'easeOut' },
    wordEntrance: { type: 'pop', durationSec: 0.26, easing: 'easeOutElastic' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'punch', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.1, easing: 'easeIn' },
    maxScale: 1.28, intensityDefault: 0.75,
  }),
  'smooth-rise': tpl({
    name: 'smooth-rise', description: 'Restrained upward drift and fade — the safe, polished default direction.',
    cueEntrance: { type: 'slide-up', durationSec: 0.18, easing: 'easeOut' },
    wordEntrance: { type: 'rise', durationSec: 0.18, easing: 'easeOut' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'fade', durationSec: 0.14, easing: 'easeIn' },
    maxScale: 1.05, intensityDefault: 0.4,
  }),
  typewriter: tpl({
    name: 'typewriter', description: 'Each word is revealed by a growing clip, as if being typed in.',
    cueEntrance: { type: 'fade', durationSec: 0.1, easing: 'linear' },
    wordEntrance: { type: 'reveal', durationSec: 0.14, easing: 'linear' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'none', durationSec: 0, easing: 'linear' },
    maxScale: 1, intensityDefault: 0.6,
  }),
  'karaoke-sweep': tpl({
    name: 'karaoke-sweep', description: 'The active colour sweeps across each word left-to-right as it is spoken, like a karaoke bar.',
    cueEntrance: { type: 'fade', durationSec: 0.1, easing: 'easeOut' },
    wordEntrance: { type: 'fade', durationSec: 0.06, easing: 'linear' },
    active: { type: 'sweep', cycleSec: 0.6 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'fade', durationSec: 0.08, easing: 'easeIn' },
    maxScale: 1, intensityDefault: 0.6,
  }),
  punch: tpl({
    name: 'punch', description: 'A fast, hard scale hit with no overshoot — deliberately blunt, for strong statements.',
    cueEntrance: { type: 'fade', durationSec: 0.08, easing: 'easeOut' },
    wordEntrance: { type: 'pop', durationSec: 0.09, easing: 'easeOut' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'punch', minConfidence: 0.65 },
    exit: { type: 'fade', durationSec: 0.08, easing: 'easeIn' },
    maxScale: 1.18, intensityDefault: 0.8,
  }),
  'beat-sync': tpl({
    name: 'beat-sync', description: 'Tight, quick pops timed hard to each word start — built for fast speech.',
    cueEntrance: { type: 'fade', durationSec: 0.06, easing: 'easeOut' },
    wordEntrance: { type: 'pop', durationSec: 0.08, easing: 'easeOutBack' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'punch', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.06, easing: 'easeIn' },
    maxScale: 1.14, intensityDefault: 0.6,
  }),
  float: tpl({
    name: 'float', description: 'A gentle, continuous vertical drift while a word is held on screen.',
    cueEntrance: { type: 'fade', durationSec: 0.16, easing: 'easeOut' },
    wordEntrance: { type: 'fade', durationSec: 0.14, easing: 'easeOut' },
    active: { type: 'float', cycleSec: 1.4 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'fade', durationSec: 0.14, easing: 'easeIn' },
    maxScale: 1.04, intensityDefault: 0.4,
  }),
  slide: tpl({
    name: 'slide', description: 'Each word slides in from the side and settles into place.',
    cueEntrance: { type: 'slide-up', durationSec: 0.14, easing: 'easeOut' },
    wordEntrance: { type: 'slide-left', durationSec: 0.16, easing: 'easeOut' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'punch', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.1, easing: 'easeIn' },
    maxScale: 1.08, intensityDefault: 0.55,
  }),
  glitch: tpl({
    name: 'glitch', description: 'A brief, deterministic jitter on arrival — an energetic, digital-feeling hit.',
    cueEntrance: { type: 'fade', durationSec: 0.08, easing: 'linear' },
    wordEntrance: { type: 'pop', durationSec: 0.1, easing: 'linear' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'shake', minConfidence: 0.75 },
    exit: { type: 'fade', durationSec: 0.06, easing: 'linear' },
    maxScale: 1.1, intensityDefault: 0.55,
  }),
  'neon-pulse': tpl({
    name: 'neon-pulse', description: 'A soft glow behind each word that pulses gently while it is active.',
    cueEntrance: { type: 'fade', durationSec: 0.14, easing: 'easeOut' },
    wordEntrance: { type: 'fade', durationSec: 0.12, easing: 'easeOut' },
    active: { type: 'glow-pulse', cycleSec: 0.9 },
    emphasis: { type: 'glow', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.12, easing: 'easeIn' },
    maxScale: 1.08, intensityDefault: 0.55,
    decoration: { glow: true },
  }),
  'comic-hit': tpl({
    name: 'comic-hit', description: 'A rounded emphasis card pops in behind the word on a hard hit — expressive, energetic captions.',
    cueEntrance: { type: 'pop', durationSec: 0.1, easing: 'easeOutBack' },
    wordEntrance: { type: 'pop', durationSec: 0.12, easing: 'easeOutBack' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'card', minConfidence: 0.6 },
    exit: { type: 'fade', durationSec: 0.08, easing: 'easeIn' },
    maxScale: 1.3, intensityDefault: 0.8,
    decoration: { backplate: true },
  }),
  'cinematic-fade': tpl({
    name: 'cinematic-fade', description: 'Elegant, unhurried fades with almost no scale change — clean hierarchy, soft motion.',
    cueEntrance: { type: 'fade', durationSec: 0.35, easing: 'easeInOut' },
    wordEntrance: { type: 'fade', durationSec: 0.22, easing: 'easeInOut' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'fade', durationSec: 0.3, easing: 'easeInOut' },
    maxScale: 1.02, intensityDefault: 0.35,
  }),
  'lyric-flow': tpl({
    name: 'lyric-flow', description: 'A gentle rise and colour sweep, paced like a music-video lyric line.',
    cueEntrance: { type: 'slide-up', durationSec: 0.24, easing: 'easeInOut' },
    wordEntrance: { type: 'rise', durationSec: 0.2, easing: 'easeInOut' },
    active: { type: 'sweep', cycleSec: 0.8 },
    emphasis: { type: 'glow', minConfidence: 0.7 },
    exit: { type: 'fade', durationSec: 0.2, easing: 'easeInOut' },
    maxScale: 1.1, intensityDefault: 0.5,
  }),
  'minimal-reveal': tpl({
    name: 'minimal-reveal', description: 'Almost nothing — a very quick, quiet fade. For editorial captions that should not draw attention to themselves.',
    cueEntrance: { type: 'fade', durationSec: 0.1, easing: 'linear' },
    wordEntrance: { type: 'fade', durationSec: 0.08, easing: 'linear' },
    active: { type: 'none', cycleSec: 0.6 },
    emphasis: { type: 'none', minConfidence: 1.1 },
    exit: { type: 'fade', durationSec: 0.08, easing: 'linear' },
    maxScale: 1.01, intensityDefault: 0.25,
  }),
  'dynamic-word-focus': tpl({
    name: 'dynamic-word-focus', description: 'The active word grows and holds a backplate while it speaks, then releases — strong focus for high-retention reels.',
    cueEntrance: { type: 'fade', durationSec: 0.12, easing: 'easeOut' },
    wordEntrance: { type: 'pop', durationSec: 0.14, easing: 'easeOutBack' },
    active: { type: 'pulse', cycleSec: 0.7 },
    emphasis: { type: 'card', minConfidence: 0.65 },
    exit: { type: 'fade', durationSec: 0.1, easing: 'easeIn' },
    maxScale: 1.25, intensityDefault: 0.75,
    decoration: { backplate: true },
  }),
};

export const ANIMATION_TEMPLATE_NAMES = Object.keys(ANIMATION_TEMPLATES).sort();

export function listAnimationTemplates(): string[] {
  return ANIMATION_TEMPLATE_NAMES;
}

export function assertValidAnimationTemplateName(name: string): void {
  if (name === 'auto') return;
  if (!(name in ANIMATION_TEMPLATES)) {
    throw new CaptionEngineError(
      `Unknown --animation-template "${name}".`,
      `Valid: auto, ${ANIMATION_TEMPLATE_NAMES.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution: motion level -> intensity, tone/style -> template
// ---------------------------------------------------------------------------

/** Restrained, conservative pick per tone — used only when a theme/style does not name its own. */
const DEFAULT_TONE_TEMPLATE: Partial<Record<Tone, string>> = {
  excited: 'punch',
  emphatic: 'comic-hit',
  fast: 'beat-sync',
  soft: 'cinematic-fade',
  calm: 'minimal-reveal',
  neutral: 'smooth-rise',
};

export interface ResolveIntensityOptions {
  level: MotionLevel;
  explicitIntensity?: number;
  /** For 'auto': whether prosody produced a confident tone to react to. If not, 'auto' behaves like 'subtle'. */
  autoHasConfidentTone?: boolean;
}

/** `--motion-intensity`, if given, always wins. Otherwise each level has a restrained baseline. */
export function resolveIntensity(opts: ResolveIntensityOptions): number {
  if (opts.explicitIntensity !== undefined) return opts.explicitIntensity;
  if (opts.level === 'none') return 0;
  if (opts.level === 'auto') return opts.autoHasConfidentTone ? LEVEL_BASE_INTENSITY.subtle : LEVEL_BASE_INTENSITY.subtle * 0.6;
  return LEVEL_BASE_INTENSITY[opts.level];
}

export interface ResolveTemplateOptions {
  /** --animation-template value, or undefined if the flag was not given. */
  requested?: string;
  /** The --style preset's own suggested default, if any. */
  stylePresetDefault?: string;
  /** Per-tone overrides from the theme JSON ("motion.toneTemplates"). */
  themeToneTemplates?: Partial<Record<Tone, string>>;
  /** The cue/word's dominant tone, when --prosody produced one. */
  tone?: Tone;
  toneConfidence?: number;
  minConfidence: number;
}

/**
 * Pick a template name. Never returns an invalid name — validated the same way
 * whichever path produced it, so "auto" can never silently resolve to garbage.
 */
export function resolveAnimationTemplateName(opts: ResolveTemplateOptions): string {
  if (opts.requested && opts.requested !== 'auto') {
    assertValidAnimationTemplateName(opts.requested);
    return opts.requested;
  }
  // 'auto' (or unset): tone first, when confidently classified.
  if (opts.tone && opts.toneConfidence !== undefined && opts.toneConfidence >= opts.minConfidence) {
    const themed = opts.themeToneTemplates?.[opts.tone];
    if (themed && themed in ANIMATION_TEMPLATES) return themed;
    const builtin = DEFAULT_TONE_TEMPLATE[opts.tone];
    if (builtin) return builtin;
  }
  if (opts.stylePresetDefault && opts.stylePresetDefault in ANIMATION_TEMPLATES) return opts.stylePresetDefault;
  return 'minimal-reveal';
}

/** Effective peak scale for reservedWidth: blends template.maxScale toward 1 as intensity falls. */
export function effectiveMaxScale(template: AnimationTemplate, intensity: number): number {
  return 1 + (template.maxScale - 1) * Math.min(1, Math.max(0, intensity));
}

// ---------------------------------------------------------------------------
// Frame sampling — bounded, deterministic subdivision of a plan's time span
// ---------------------------------------------------------------------------

/** Sampling cadence for animated segments. ~24 samples/sec — enough to read as motion, not a slideshow. */
export const ANIMATION_FRAME_STEP_SEC = 1 / 24;
export const MAX_ENTRANCE_FRAMES = 4;
export const MAX_HOLD_FRAMES = 2;
export const MAX_EXIT_FRAMES = 3;

export type FramePhase = 'entrance' | 'hold' | 'exit';

export interface FrameMotion {
  templateName: string;
  intensity: number;
  emphasis: boolean;
  /** Set only on word-plan frames. */
  wordPhase?: FramePhase;
  wordProgress?: number;
  /** Set on the first/last sliced frame(s) of a cue, independent of wordPhase. */
  cueEdge?: 'enter' | 'exit';
  cueProgress?: number;
  /** Deterministic per-word value in [0,1), from a text hash — used by glitch/float/sweep. */
  seed: number;
}

export interface MotionSlice {
  /** Seconds, relative to the plan's own start. Slices tile [0, planDurationSec) exactly. */
  offsetStart: number;
  offsetEnd: number;
  motion: FrameMotion;
}

export interface PlanMotionContext {
  template: AnimationTemplate;
  intensity: number;
  isWord: boolean;
  /** -1 for a non-word (gap) plan. */
  wordIndex: number;
  wordText: string;
  isCueFirst: boolean;
  isCueLast: boolean;
  emphasis: boolean;
}

function seedFor(ctx: PlanMotionContext): number {
  return hashUnit(`${ctx.wordIndex}:${ctx.wordText}`);
}

function frameCountFor(durationSec: number, maxFrames: number, intensity: number): number {
  if (durationSec <= 0) return 0;
  const byStep = Math.round(durationSec / ANIMATION_FRAME_STEP_SEC);
  const cap = Math.max(1, Math.round(maxFrames * Math.min(1, Math.max(0.15, intensity))));
  return Math.min(Math.max(1, byStep), cap);
}

/**
 * Subdivide one frame plan's [0, planDurationSec) span into motion-tagged
 * slices: entrance, then hold (only sampled beyond one frame when the
 * template's active behavior wants continuous motion), then exit (only on
 * the cue's last plan). Always tiles the full span exactly — no gap, no
 * overlap — so nothing that rendered before this feature existed can go
 * missing now.
 */
export function planMotionSlices(planDurationSec: number, ctx: PlanMotionContext): MotionSlice[] {
  if (planDurationSec <= 0) return [];
  const { template, intensity } = ctx;
  const seed = seedFor(ctx);

  const entrance = ctx.emphasis ? { type: template.emphasis.type !== 'none' ? 'pop' as const : template.wordEntrance.type, durationSec: template.wordEntrance.durationSec, easing: template.wordEntrance.easing }
    : template.wordEntrance;
  const wantsEntrance = ctx.isWord && entrance.type !== 'none';
  const wantsExit = ctx.isCueLast && template.exit.type !== 'none';
  const wantsCueEdgeEnter = ctx.isCueFirst && template.cueEntrance.type !== 'none';
  const wantsCueEdgeExit = ctx.isCueLast && template.cueEntrance.type !== 'none'; // cue exit mirrors entrance duration
  const wantsHold = ctx.isWord && template.active.type !== 'none';

  const entranceDur = wantsEntrance ? Math.min(template.wordEntrance.durationSec, planDurationSec) : 0;
  const exitDur = wantsExit ? Math.min(template.exit.durationSec, Math.max(0, planDurationSec - entranceDur)) : 0;
  const holdDur = Math.max(0, planDurationSec - entranceDur - exitDur);

  const slices: MotionSlice[] = [];
  let cursor = 0;

  // ---- entrance ----
  if (entranceDur > 0) {
    const n = frameCountFor(entranceDur, MAX_ENTRANCE_FRAMES, intensity);
    for (let i = 0; i < n; i++) {
      const a = entranceDur * (i / n);
      const b = entranceDur * ((i + 1) / n);
      const progress = (i + 1) / n; // sample near the END of each step: entrance should visibly progress
      slices.push({
        offsetStart: cursor + a, offsetEnd: cursor + b,
        motion: {
          templateName: template.name, intensity, emphasis: ctx.emphasis, seed,
          wordPhase: 'entrance', wordProgress: progress,
          ...(wantsCueEdgeEnter ? { cueEdge: 'enter', cueProgress: Math.min(1, (cursor + b) / Math.max(template.cueEntrance.durationSec, 1e-6)) } : {}),
        },
      });
    }
    cursor += entranceDur;
  } else if (wantsCueEdgeEnter && ctx.isCueFirst) {
    // A cue-first plan with no word entrance (e.g. the lead-in gap, or a
    // template with wordEntrance:'none') still gets the cue-level fade/slide.
    const cueDur = Math.min(template.cueEntrance.durationSec, planDurationSec);
    if (cueDur > 0) {
      const n = frameCountFor(cueDur, MAX_ENTRANCE_FRAMES, intensity);
      for (let i = 0; i < n; i++) {
        const a = cueDur * (i / n);
        const b = cueDur * ((i + 1) / n);
        slices.push({
          offsetStart: cursor + a, offsetEnd: cursor + b,
          motion: { templateName: template.name, intensity, emphasis: false, seed, cueEdge: 'enter', cueProgress: (i + 1) / n },
        });
      }
      cursor += cueDur;
    }
  }

  // ---- hold ----
  const remainingForHold = planDurationSec - exitDur - cursor;
  if (remainingForHold > 0) {
    if (wantsHold && remainingForHold >= ANIMATION_FRAME_STEP_SEC * 2) {
      const n = frameCountFor(remainingForHold, MAX_HOLD_FRAMES, intensity);
      for (let i = 0; i < n; i++) {
        const a = remainingForHold * (i / n);
        const b = remainingForHold * ((i + 1) / n);
        const elapsedSec = cursor + (a + b) / 2;
        const cycleProgress = template.active.cycleSec > 0 ? (elapsedSec % template.active.cycleSec) / template.active.cycleSec : 0;
        slices.push({
          offsetStart: cursor + a, offsetEnd: cursor + b,
          motion: { templateName: template.name, intensity, emphasis: ctx.emphasis, seed, wordPhase: 'hold', wordProgress: cycleProgress },
        });
      }
    } else {
      slices.push({
        offsetStart: cursor, offsetEnd: cursor + remainingForHold,
        motion: {
          templateName: template.name, intensity, emphasis: ctx.emphasis, seed,
          ...(ctx.isWord ? { wordPhase: 'hold' as const, wordProgress: 0 } : {}),
        },
      });
    }
    cursor += remainingForHold;
  }

  // ---- exit ----
  if (exitDur > 0) {
    const n = frameCountFor(exitDur, MAX_EXIT_FRAMES, intensity);
    for (let i = 0; i < n; i++) {
      const a = exitDur * (i / n);
      const b = exitDur * ((i + 1) / n);
      const progress = (i + 1) / n;
      slices.push({
        offsetStart: cursor + a, offsetEnd: cursor + b,
        motion: {
          templateName: template.name, intensity, emphasis: ctx.emphasis, seed,
          ...(ctx.isWord ? { wordPhase: 'exit' as const, wordProgress: progress } : {}),
          ...(wantsCueEdgeExit ? { cueEdge: 'exit', cueProgress: progress } : {}),
        },
      });
    }
    cursor += exitDur;
  }

  // Numerical safety: floating point can leave a hairline gap or overlap at
  // the very end. Snap the last slice to the plan's real end exactly.
  if (slices.length > 0) slices[slices.length - 1]!.offsetEnd = planDurationSec;
  return slices;
}

// ---------------------------------------------------------------------------
// Per-frame transform resolution — the interpreter every template shares
// ---------------------------------------------------------------------------

export interface WordMotionState {
  /** Multiples of the word's own font size — svg.ts converts to px. */
  translateXFrac: number;
  translateYFrac: number;
  /** Multiplies the word's already-resolved scale (tone x active x this). */
  scale: number;
  opacity: number;
  /** 0..1 fraction of the word's width painted in the active colour (karaoke-sweep). Undefined = not applicable. */
  sweepFrac?: number;
  /** 0..1 fraction of the word's width visible at all (typewriter reveal). Undefined = fully visible. */
  revealFrac?: number;
  decoration: DecorationSpec;
}

const RESTING: WordMotionState = {
  translateXFrac: 0, translateYFrac: 0, scale: 1, opacity: 1, decoration: NO_DECORATION,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The single function that turns a template + phase + progress into a transform. Deterministic, pure. */
export function resolveWordMotion(template: AnimationTemplate, motion: FrameMotion): WordMotionState {
  const intensity = Math.min(1, Math.max(0, motion.intensity));
  if (intensity <= 0) return RESTING;

  const emphasisActive = motion.emphasis && template.emphasis.type !== 'none';
  const decoration = emphasisActive
    ? { ...template.decoration, backplate: template.decoration.backplate || template.emphasis.type === 'card', glow: template.decoration.glow || template.emphasis.type === 'glow' }
    : template.decoration;

  if (motion.wordPhase === 'entrance') {
    const t = ease(template.wordEntrance.easing, motion.wordProgress ?? 1);
    const type = emphasisActive && template.emphasis.type === 'punch' ? 'pop' : template.wordEntrance.type;
    return applyEntranceType(type, t, template, intensity, motion.seed, decoration);
  }

  if (motion.wordPhase === 'exit') {
    const t = ease(template.exit.easing, motion.wordProgress ?? 1);
    if (template.exit.type === 'hold') return { ...RESTING, decoration };
    // fade out: opacity 1 -> 0 as t goes 0 -> 1.
    return { ...RESTING, opacity: lerp(1, 0, t), decoration };
  }

  if (motion.wordPhase === 'hold') {
    if (emphasisActive && template.emphasis.type === 'shake') {
      const cyc = motion.wordProgress ?? 0;
      const jitter = 0.02 * intensity * Math.sin(cyc * Math.PI * 2 * 6) * (0.5 + hashUnit(String(motion.seed)));
      return { ...RESTING, translateXFrac: jitter, decoration };
    }
    return applyActiveType(template.active.type, motion.wordProgress ?? 0, intensity, decoration);
  }

  return { ...RESTING, decoration: motion.emphasis ? decoration : NO_DECORATION };
}

function applyEntranceType(
  type: WordEntranceType, t: number, template: AnimationTemplate, intensity: number, seed: number, decoration: DecorationSpec,
): WordMotionState {
  const peak = effectiveMaxScale(template, intensity);
  switch (type) {
    case 'none':
      return { ...RESTING, decoration };
    case 'pop': {
      // t goes 0..1 through easeOutBack, which itself overshoots past 1 —
      // scale from a small start up to the template's peak.
      const scale = lerp(0.55, peak, t);
      return { ...RESTING, scale, opacity: Math.min(1, t * 3), decoration };
    }
    case 'fade':
      return { ...RESTING, opacity: t, decoration };
    case 'slide-up':
      return { ...RESTING, translateYFrac: lerp(0.4, 0, t) * intensity, opacity: t, decoration };
    case 'rise':
      return { ...RESTING, translateYFrac: lerp(0.22, 0, t) * intensity, opacity: t, scale: lerp(0.96, 1, t), decoration };
    case 'slide-left':
      return { ...RESTING, translateXFrac: lerp(0.35, 0, t) * intensity, opacity: t, decoration };
    case 'slide-right':
      return { ...RESTING, translateXFrac: lerp(-0.35, 0, t) * intensity, opacity: t, decoration };
    case 'reveal':
      return { ...RESTING, revealFrac: t, opacity: 1, decoration };
  }
  void seed;
  return { ...RESTING, decoration };
}

function applyActiveType(type: ActiveBehaviorType, cycleProgress: number, intensity: number, decoration: DecorationSpec): WordMotionState {
  const s = Math.sin(cycleProgress * Math.PI * 2);
  switch (type) {
    case 'none':
      return { ...RESTING, decoration };
    case 'pulse':
      return { ...RESTING, scale: 1 + 0.06 * intensity * (0.5 + 0.5 * s), decoration };
    case 'float':
      return { ...RESTING, translateYFrac: 0.045 * intensity * s, decoration };
    case 'glow-pulse':
      return { ...RESTING, opacity: 1, decoration: { ...decoration, glow: true } };
    case 'sweep':
      return { ...RESTING, sweepFrac: (cycleProgress + 1) % 1, decoration };
  }
}

/** Cue-level entrance/exit wrapper — a single translate+opacity around the whole rendered cue. */
export function resolveCueEdgeMotion(
  template: AnimationTemplate, edge: 'enter' | 'exit' | undefined, progress: number, intensity: number,
): { translateYFrac: number; opacity: number } {
  if (!edge || intensity <= 0) return { translateYFrac: 0, opacity: 1 };
  const spec = template.cueEntrance;
  if (spec.type === 'none') return { translateYFrac: 0, opacity: 1 };
  const t = ease(spec.easing, progress);
  const opacity = edge === 'enter' ? t : 1 - t;
  if (spec.type === 'fade') return { translateYFrac: 0, opacity };
  if (spec.type === 'pop') return { translateYFrac: 0, opacity };
  // slide-up: enters from below, exits by settling (no motion on exit beyond fade).
  const translateYFrac = edge === 'enter' ? lerp(0.18, 0, t) * intensity : 0;
  return { translateYFrac, opacity };
}
