import type { CaptionCue, CaptionStyle, Word } from '../types.js';
import { shapeText, shapedToSvgRuns, type ShapedText } from '../text/shaper.js';
import { primaryScript, isRtlScript } from '../text/script.js';
import { activeWordWindows, resolveWordStyle } from './active.js';
import type { ToneStyle } from './tone-style.js';
import {
  type AnimationTemplate, type FrameMotion, type WordMotionState, type DecorationSpec,
  planMotionSlices, resolveWordMotion, resolveCueEdgeMotion, effectiveMaxScale,
} from './animation.js';

/**
 * Caption rendering as SVG, using pre-shaped vector outlines.
 *
 * Text arrives here already shaped by HarfBuzz (src/text/shaper.ts) and is
 * emitted as `<path>` geometry. The renderer downstream therefore needs no text
 * intelligence at all — no font matching, no shaping, no fallback logic — which
 * is precisely why output is identical on every host. See the shaper's header
 * for the measurements that motivated this.
 *
 * Trade-off, stated honestly: because glyphs become outlines, the SVG is larger
 * than a text-based subtitle and cannot be re-typeset downstream. That is the
 * right trade for burned-in captions. For editable captions we still emit ASS
 * and SRT (src/captions/ass.ts), where the host application does its own
 * shaping.
 */

export interface SvgRenderOptions {
  width: number;
  height: number;
  style: CaptionStyle;
  /** Which word to highlight (index within the cue). -1 for none. */
  activeWordIndex?: number;
  /** Scale applied to the active word. 1 = none. */
  activeScale?: number;
  /** Use the real bold face only for the active word. */
  activeBold?: boolean;
  maxLines?: number;
  /** Emit a transparent background (for overlay) or opaque (for previews). */
  background?: string;
  /**
   * Per-word tone styles, keyed by index within the cue.
   *
   * Absent (the default) means no prosody styling ran and every word resolves
   * exactly as it did before tone existed — that is what keeps the no-flag
   * render byte-identical.
   */
  toneStyles?: ReadonlyMap<number, ToneStyle>;
  /**
   * Kinetic captions: the template/intensity active for this ENTIRE render.
   * Fixed for the whole render (never per-frame) because it feeds reservedWidth
   * (below) — a value that changed frame to frame would make the layout itself
   * jitter, which is exactly the bug reservedWidth exists to prevent. Absent
   * (the default) reproduces pre-animation output exactly: no reservation
   * change, no transform, nothing rendered differently.
   */
  motion?: { template: AnimationTemplate; intensity: number };
  /**
   * Where THIS SPECIFIC FRAME sits within the motion timeline — varies frame to
   * frame, unlike `motion` above. Comes from `CaptionFramePlan.motion`, set by
   * `planCaptionFrames`. Absent means "render the settled/static state",
   * which is also what happens when `motion` itself is absent.
   */
  frameMotion?: FrameMotion;
}

interface LaidOutWord {
  word: Word;
  index: number;
  shaped: ShapedText;
  x: number;
  width: number;
  /** Reserved width across resting and active states; keeps every frame stable. */
  reservedWidth: number;
}

interface LaidOutLine {
  words: LaidOutWord[];
  width: number;
  y: number;
}

/**
 * Inter-word gap.
 *
 * Starts from the font's own measured space advance, then applies a floor. The
 * raw advance (~0.26em in Noto Sans) is tuned for running prose; short-form
 * captions are read at a glance and at speed, and words that nearly touch read
 * as one token. 0.34em tested clearly better across Devanagari, Telugu and
 * Kannada, whose glyphs carry very little side bearing of their own.
 */
async function spaceWidth(fontSize: number, bold: boolean): Promise<number> {
  const a = await shapeText('a a', fontSize, { bold });
  const b = await shapeText('aa', fontSize, { bold });
  const measured = a.width - b.width;
  return Math.max(measured > 0 ? measured : 0, fontSize * 0.34);
}

/**
 * Extra gap so a scaled active word cannot collide with its neighbours.
 *
 * Layout must be IDENTICAL for every frame of a cue — the active word changes
 * frame to frame, and if positions depended on which word is active, the whole
 * line would jitter horizontally as the highlight moves. So the headroom is
 * computed from the widest word in the cue and applied uniformly, independent
 * of which word is currently highlighted.
 */
function activeScaleHeadroom(widths: number[], activeScale: number): number {
  if (activeScale <= 1 || widths.length === 0) return 0;
  return ((activeScale - 1) * Math.max(...widths)) / 2;
}

/**
 * Lay out a cue into lines that fit the frame.
 *
 * Wrapping is by MEASURED PIXEL WIDTH, not character count. Character counting
 * is wrong for Indic text, where one visual cluster can be 4-6 codepoints, and
 * for mixed Hinglish lines where scripts have very different advance widths.
 */
export async function layoutCue(
  cue: CaptionCue,
  opts: SvgRenderOptions,
): Promise<LaidOutLine[]> {
  const { style, width, maxLines = 2 } = opts;
  const bold = !opts.activeBold;
  const fontSize = style.fontSizePx;
  const maxWidth = width * 0.86; // side margins
  const baseSp = await spaceWidth(fontSize, bold);
  // Fixed for the whole render (see SvgRenderOptions.motion) — the peak an
  // animated word can EVER scale to, so its reserved slot never runs out
  // mid-animation regardless of which frame is being generated.
  const motionMaxScale = opts.motion ? effectiveMaxScale(opts.motion.template, opts.motion.intensity) : 1;

  const shapedWords: LaidOutWord[] = [];
  for (let i = 0; i < cue.words.length; i++) {
    const w = cue.words[i]!;
    const text = style.uppercase ? w.text.toUpperCase() : w.text;
    // The word's tone is fixed for the whole cue, so it participates in BOTH
    // measurements. Reserving only the untoned width would let a toned word
    // overflow the space kept for it and shove the line sideways.
    const tone = opts.toneStyles?.get(i);
    const perWord = { ...opts, ...(tone ? { tone } : {}) };
    const resting = resolveWordStyle(style, false, perWord);
    const active = resolveWordStyle(style, true, perWord);
    const shaped = await shapeText(text, fontSize, {
      bold: resting.bold, fontFamily: resting.fontFamily,
    });
    // Reserve the widest state this word can ever occupy. Layout is then
    // identical for every frame of the cue, which is what stops the line from
    // jumping as the highlight moves across it.
    const restingWidth = shaped.width * resting.scale;
    const activeWidth = await measureForActive(text, fontSize, active);
    // The third term covers a kinetic entrance/emphasis overshoot (e.g. "pop"
    // templates scale past their settled size before easing back) — without
    // it an animated word could momentarily exceed the space every OTHER
    // frame of the cue already reserved for it, which is the sideways-jump
    // this whole mechanism exists to prevent.
    const reservedWidth = Math.max(restingWidth, activeWidth, restingWidth * motionMaxScale);
    shapedWords.push({ word: w, index: i, shaped, x: 0, width: shaped.width, reservedWidth });
  }

  const sp =
    baseSp + activeScaleHeadroom(shapedWords.map((w) => w.reservedWidth), 1);

  const lines: LaidOutLine[] = [];
  let cur: LaidOutWord[] = [];
  let curW = 0;

  for (const sw of shapedWords) {
    const add = (cur.length ? sp : 0) + sw.reservedWidth;
    if (curW + add > maxWidth && cur.length > 0) {
      lines.push({ words: cur, width: curW, y: 0 });
      cur = [sw];
      curW = sw.reservedWidth;
    } else {
      cur.push(sw);
      curW += add;
    }
  }
  if (cur.length) lines.push({ words: cur, width: curW, y: 0 });

  // Never drop words: fold any overflow beyond maxLines into the last line.
  // A too-long line is a cosmetic problem; a missing word is a correctness bug.
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const rest = lines.slice(maxLines - 1);
    const merged: LaidOutWord[] = rest.flatMap((l) => l.words);
    const mergedW = merged.reduce((n, w, i) => n + w.reservedWidth + (i ? sp : 0), 0);
    head.push({ words: merged, width: mergedW, y: 0 });
    lines.length = 0;
    lines.push(...head);
  }

  // Position each line: centred horizontally, stacked from the anchor.
  const lineHeight = fontSize * 1.38; // Tamil/Malayalam stack tall; 1.28 collided
  const totalH = lines.length * lineHeight;
  const anchorY = opts.height * style.positionY;
  const startY = anchorY - totalH / 2 + fontSize * 0.5;

  lines.forEach((line, li) => {
    line.y = startY + li * lineHeight;
    const rtl = isRtlScript(primaryScript(line.words.map((w) => w.word.text).join(' ')));
    let x = (opts.width - line.width) / 2;
    const ordered = rtl ? [...line.words].reverse() : line.words;
    for (const w of ordered) {
      w.x = x;
      x += w.reservedWidth + sp;
    }
  });

  return lines;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render one caption frame to SVG.
 *
 * Every word is drawn twice: once as a thick stroke (the outline) and once as
 * fill. Drawing ALL outlines before ANY fill matters — otherwise a neighbouring
 * word's outline paints over the previous word's fill wherever they overlap,
 * which is visible on tight kerning and looks like corrupted glyphs.
 */
let clipIdCounter = 0;

/**
 * Kinetic captions render entirely as extra structure ADDED to this function —
 * `defs`/`decorations` stay empty arrays and `cueAttrs` stays `''` whenever
 * `opts.motion` is absent, which is what makes `--motion none` produce the
 * exact same SVG string this function has always produced (see the guard on
 * `motionActive` below). Nothing about the no-motion path changed.
 */
export async function renderCueSvg(
  cue: CaptionCue,
  opts: SvgRenderOptions,
): Promise<string> {
  const { style, width, height } = opts;
  const activeIdx = opts.activeWordIndex ?? -1;
  const activeScale = opts.activeScale ?? 1;
  const lines = await layoutCue(cue, opts);

  const motionActive = Boolean(opts.motion);
  const template = opts.motion?.template;
  const frameMotion = opts.frameMotion;

  const outlines: string[] = [];
  const fills: string[] = [];
  const decorations: string[] = [];
  const defs: string[] = [];

  // Cue-level entrance/exit: a single fade/slide applied uniformly to
  // everything in this frame. Resolved once, reused for the decoration,
  // outline and fill groups below.
  let cueAttrs = '';
  if (motionActive && template && frameMotion?.cueEdge) {
    const cueMotion = resolveCueEdgeMotion(template, frameMotion.cueEdge, frameMotion.cueProgress ?? 1, frameMotion.intensity);
    const dyPx = cueMotion.translateYFrac * style.fontSizePx;
    const parts: string[] = [];
    if (dyPx !== 0) parts.push(`transform="translate(0,${dyPx.toFixed(2)})"`);
    if (cueMotion.opacity !== 1) parts.push(`opacity="${cueMotion.opacity.toFixed(3)}"`);
    if (parts.length > 0) cueAttrs = ` ${parts.join(' ')}`;
  }

  for (const line of lines) {
    for (const lw of line.words) {
      const isActive = lw.index === activeIdx;
      const tone = opts.toneStyles?.get(lw.index);
      const finalStyle = resolveWordStyle(style, isActive, {
        activeScale, activeBold: opts.activeBold, ...(tone ? { tone } : {}),
      });
      const text = style.uppercase ? lw.word.text.toUpperCase() : lw.word.text;
      // `lw.shaped` was shaped in the RESTING state. Reuse it only when the
      // final state matches; otherwise re-shape with the real face, because
      // faking weight with a stroke thickens the outline as well as the glyph
      // and looks wrong on Indic conjuncts in particular.
      const resting = resolveWordStyle(style, false, {
        activeScale, activeBold: opts.activeBold, ...(tone ? { tone } : {}),
      });
      const shaped =
        finalStyle.bold === resting.bold && finalStyle.fontFamily === resting.fontFamily
          ? lw.shaped
          : await shapeText(text, style.fontSizePx, {
              bold: finalStyle.bold, fontFamily: finalStyle.fontFamily,
            });
      const runs = shapedToSvgRuns(shaped);
      if (runs.length === 0) continue;
      const colour = finalStyle.color;

      // Kinetic per-word transform — active word only, and only while motion
      // is on. `wordMotion` is undefined for every other word and every
      // non-motion render, which is what keeps them on the plain path below.
      const wordMotion: WordMotionState | undefined =
        motionActive && isActive && template && frameMotion
          ? resolveWordMotion(template, frameMotion)
          : undefined;
      const extraScale = wordMotion?.scale ?? 1;
      const dxPx = (wordMotion?.translateXFrac ?? 0) * style.fontSizePx;
      const dyPx = (wordMotion?.translateYFrac ?? 0) * style.fontSizePx;

      // Word-level placement. Scaling happens about the word's own centre so
      // it grows in place rather than drifting right.
      const left = lw.x + (lw.reservedWidth - shaped.width) / 2 + dxPx;
      const baselineY = line.y + dyPx;
      const totalScale = finalStyle.scale * extraScale;
      let wordTransform = `translate(${left.toFixed(2)},${baselineY.toFixed(2)})`;
      if (totalScale !== 1) {
        const cx = shaped.width / 2;
        wordTransform =
          `translate(${(left + cx).toFixed(2)},${baselineY.toFixed(2)}) ` +
          `scale(${totalScale}) translate(${(-cx).toFixed(2)},0)`;
      }

      // Decoration + clip geometry, in the same absolute coordinate system
      // the glyph paths are drawn in (see runTransform below) — computed once
      // per word rather than per run, since every run of a word shares it.
      const wordWidthPx = shaped.width * totalScale;
      const decoBox = wordMotion
        ? {
            x: left - wordWidthPx * 0.06,
            y: baselineY - shaped.ascent * totalScale - shaped.ascent * 0.08,
            width: wordWidthPx * 1.12,
            height: (shaped.ascent + shaped.descent) * totalScale * 1.18,
          }
        : null;

      if (wordMotion?.decoration.backplate && decoBox) {
        const rx = Math.min(decoBox.height / 2.4, decoBox.width / 6);
        decorations.push(
          `<rect x="${decoBox.x.toFixed(1)}" y="${decoBox.y.toFixed(1)}" ` +
            `width="${decoBox.width.toFixed(1)}" height="${decoBox.height.toFixed(1)}" ` +
            `rx="${rx.toFixed(1)}" fill="${esc(style.outlineColor)}" opacity="0.82"/>`,
        );
      }
      if (wordMotion?.decoration.underline && decoBox) {
        const uy = baselineY + shaped.descent * totalScale * 0.55;
        decorations.push(
          `<rect x="${decoBox.x.toFixed(1)}" y="${uy.toFixed(1)}" ` +
            `width="${decoBox.width.toFixed(1)}" height="${Math.max(2, style.outlineWidthPx * 0.6).toFixed(1)}" ` +
            `rx="2" fill="${esc(colour)}"/>`,
        );
      }

      let clipId: string | null = null;
      if (wordMotion?.revealFrac !== undefined && decoBox) {
        clipId = `ce-reveal-${clipIdCounter++}`;
        const clipW = Math.max(0, decoBox.width * wordMotion.revealFrac);
        defs.push(
          `<clipPath id="${clipId}"><rect x="${decoBox.x.toFixed(1)}" y="${decoBox.y.toFixed(1)}" ` +
            `width="${clipW.toFixed(1)}" height="${decoBox.height.toFixed(1)}"/></clipPath>`,
        );
      }

      const wordOutlineParts: string[] = [];
      const wordFillParts: string[] = [];

      for (const r of runs) {
        // Path data is in FONT UNITS; this transform carries it to pixels.
        // Keeping the scale here (rather than baking it into coordinates)
        // avoids the quantisation that collapsed thin contours — see
        // runToFontUnitPath() for the full account.
        const runTransform =
          `${wordTransform} translate(${r.originX.toFixed(3)},0) scale(${r.scale.toFixed(6)})`;

        if (wordMotion?.decoration.glow) {
          // Approximated with wider, low-opacity duplicate strokes rather than
          // an SVG <filter> Gaussian blur — resvg's filter support was not
          // verified for this project, and a stroke-based glow needs no
          // filter at all, so it works on every rasteriser this project
          // supports without a runtime capability check.
          const glowW = (style.outlineWidthPx * 5) / r.scale;
          decorations.push(
            `<path d="${r.d}" transform="${runTransform}" fill="none" ` +
              `stroke="${esc(colour)}" stroke-width="${glowW.toFixed(1)}" ` +
              `stroke-linejoin="round" stroke-linecap="round" opacity="0.28"/>`,
          );
        }
        if (wordMotion?.decoration.shadow) {
          decorations.push(
            `<path d="${r.d}" transform="translate(3,3) ${runTransform}" fill="#000000" opacity="0.35"/>`,
          );
        }

        if (style.outlineWidthPx > 0) {
          // stroke-width is in the LOCAL (font-unit) system, so convert.
          const sw = (style.outlineWidthPx * 2) / r.scale;
          wordOutlineParts.push(
            `<path d="${r.d}" transform="${runTransform}" fill="none" ` +
              `stroke="${esc(style.outlineColor)}" stroke-width="${sw.toFixed(1)}" ` +
              `stroke-linejoin="round" stroke-linecap="round"/>`,
          );
        }

        if (wordMotion?.sweepFrac !== undefined && decoBox) {
          // Karaoke sweep: the RESTING colour paints the whole glyph first,
          // then the active colour is painted again on top, clipped to the
          // swept fraction — a progressive fill, without re-shaping anything.
          const sweepId = `ce-sweep-${clipIdCounter++}`;
          const sweepW = Math.max(0, decoBox.width * wordMotion.sweepFrac);
          defs.push(
            `<clipPath id="${sweepId}"><rect x="${decoBox.x.toFixed(1)}" y="${decoBox.y.toFixed(1)}" ` +
              `width="${sweepW.toFixed(1)}" height="${decoBox.height.toFixed(1)}"/></clipPath>`,
          );
          wordFillParts.push(`<path d="${r.d}" transform="${runTransform}" fill="${esc(resting.color)}"/>`);
          wordFillParts.push(
            `<g clip-path="url(#${sweepId})"><path d="${r.d}" transform="${runTransform}" fill="${esc(colour)}"/></g>`,
          );
        } else {
          wordFillParts.push(`<path d="${r.d}" transform="${runTransform}" fill="${esc(colour)}"/>`);
        }
      }

      const wrapOpacity = wordMotion && wordMotion.opacity !== 1 ? wordMotion.opacity : undefined;
      const wrapClip = clipId ? ` clip-path="url(#${clipId})"` : '';
      const wrapOpacityAttr = wrapOpacity !== undefined ? ` opacity="${wrapOpacity.toFixed(3)}"` : '';
      const needsWrap = wrapClip !== '' || wrapOpacityAttr !== '';

      outlines.push(needsWrap ? `<g${wrapClip}${wrapOpacityAttr}>${wordOutlineParts.join('')}</g>` : wordOutlineParts.join(''));
      fills.push(needsWrap ? `<g${wrapClip}${wrapOpacityAttr}>${wordFillParts.join('')}</g>` : wordFillParts.join(''));
    }
  }

  const bg = opts.background
    ? `<rect width="100%" height="100%" fill="${esc(opts.background)}"/>`
    : '';
  const defsBlock = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '';
  const decorBlock = decorations.length > 0 ? `<g${cueAttrs}>${decorations.join('')}</g>` : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    defsBlock +
    bg +
    decorBlock +
    `<g${cueAttrs}>${outlines.join('')}</g><g${cueAttrs}>${fills.join('')}</g>` +
    `</svg>`
  );
}

/**
 * A frame's timing and identity, WITHOUT its SVG.
 *
 * Frame planning is separated from SVG generation for memory reasons. The
 * filter graph needs every frame's start/end up front, but each SVG is only
 * needed for the moment it is rasterised. Measured on a 30-minute video (4,500
 * frames), holding all the SVG text at once costs ~106 MB of heap and grows
 * linearly — a two-hour lecture would approach half a gigabyte. Planning first
 * and generating lazily keeps peak memory flat regardless of length.
 */
export interface CaptionFramePlan {
  start: number;
  end: number;
  cueIndex: number;
  activeWordIndex: number;
  /** Frame size the SVG will declare. The rasteriser verifies its output matches. */
  width: number;
  height: number;
  /** Set only when kinetic captions are enabled; absent reproduces pre-animation frame plans exactly. */
  motion?: FrameMotion;
}

export interface CaptionFrame extends CaptionFramePlan {
  svg: string;
}

/**
 * Expand cues into the sequence of distinct visual states to render.
 *
 * With active-word highlighting a cue becomes one frame per word. Frames are
 * clamped to the cue and to each other so no two overlap — overlapping overlays
 * would double-draw and produce visibly heavier text.
 */
export interface PlanCaptionFramesOptions {
  width: number;
  height: number;
  highlight: 'active-word' | 'none';
  /**
   * Kinetic captions. Absent, or intensity 0, reproduces the exact frame plan
   * this function has always produced — no extra frames, no `motion` field on
   * any of them. This is what makes `--motion none` byte-identical to the
   * pre-animation renderer rather than merely "close".
   */
  motion?: { template: AnimationTemplate; intensity: number };
  /**
   * Cue-local words classified as strong, high-confidence emphasis, as
   * `"${cueIndex}:${wordIndex}"` keys — computed by the caller from the SAME
   * prosody data already used for tone styling (see src/cli/run.ts), so
   * "emphasis" here always means the identical thing --prosody already
   * decided, never a second, disagreeing classification.
   */
  emphasisWords?: ReadonlySet<string>;
}

export function planCaptionFrames(
  cues: CaptionCue[],
  opts: PlanCaptionFramesOptions,
): CaptionFramePlan[] {
  const plans: CaptionFramePlan[] = [];
  const dims = { width: opts.width, height: opts.height };
  const cueByIndex = new Map(cues.map((c) => [c.index, c] as const));
  // Which plan is first/last WITHIN ITS CUE, tracked in cue-local build order
  // (not the later global time-sort) so it is correct even if two cues'
  // frames end up interleaved or a plan gets clamped to zero length below.
  const cueFirst = new Map<number, CaptionFramePlan>();
  const cueLast = new Map<number, CaptionFramePlan>();

  for (const cue of cues) {
    const cuePlans: CaptionFramePlan[] = [];
    if (opts.highlight === 'none' || cue.words.length === 0) {
      cuePlans.push({ start: cue.start, end: cue.end, cueIndex: cue.index, activeWordIndex: -1, ...dims });
    } else {
      // Lead-in before the first word starts, so the cue doesn't pop in mid-word.
      const first = cue.words[0]!;
      if (first.start > cue.start + 0.02) {
        cuePlans.push({ start: cue.start, end: first.start, cueIndex: cue.index, activeWordIndex: -1, ...dims });
      }
      for (const active of activeWordWindows(cue)) {
        cuePlans.push({ start: active.start, end: active.end, cueIndex: cue.index, activeWordIndex: active.index, ...dims });
      }
    }
    if (cuePlans.length > 0) {
      cueFirst.set(cue.index, cuePlans[0]!);
      cueLast.set(cue.index, cuePlans[cuePlans.length - 1]!);
    }
    plans.push(...cuePlans);
  }

  plans.sort((a, b) => a.start - b.start);
  for (let i = 0; i < plans.length - 1; i++) {
    if (plans[i]!.end > plans[i + 1]!.start) plans[i]!.end = plans[i + 1]!.start;
  }
  const trimmed = plans.filter((f) => f.end - f.start > 0.001);

  if (!opts.motion || opts.motion.intensity <= 0) return trimmed;

  // ---- Kinetic expansion: subdivide entrance/hold/exit windows into extra,
  // ---- motion-tagged frames. Everything above this line is untouched by
  // ---- --motion, which is the guarantee that makes --motion none exact. ----
  const { template, intensity } = opts.motion;
  const out: CaptionFramePlan[] = [];
  for (const p of trimmed) {
    const isWord = p.activeWordIndex !== -1;
    const cue = cueByIndex.get(p.cueIndex);
    const wordText = isWord ? cue?.words[p.activeWordIndex]?.text ?? '' : '';
    const emphasis = isWord && (opts.emphasisWords?.has(`${p.cueIndex}:${p.activeWordIndex}`) ?? false);
    const slices = planMotionSlices(p.end - p.start, {
      template, intensity, isWord, wordIndex: p.activeWordIndex, wordText,
      isCueFirst: cueFirst.get(p.cueIndex) === p, isCueLast: cueLast.get(p.cueIndex) === p,
      emphasis,
    });
    if (slices.length === 0) { out.push(p); continue; }
    for (const s of slices) {
      out.push({
        start: Number((p.start + s.offsetStart).toFixed(4)),
        end: Number((p.start + s.offsetEnd).toFixed(4)),
        cueIndex: p.cueIndex, activeWordIndex: p.activeWordIndex, width: p.width, height: p.height,
        motion: s.motion,
      });
    }
  }
  return out.filter((f) => f.end - f.start > 0.0001);
}

async function measureForActive(
  text: string,
  fontSize: number,
  active: ReturnType<typeof resolveWordStyle>,
): Promise<number> {
  const width = await shapeText(text, fontSize, { bold: active.bold, fontFamily: active.fontFamily });
  return width.width * active.scale;
}

/**
 * Tone styles for a whole transcript: cue index → word index → style.
 *
 * Two levels because `toneStyles` on a render call is per-cue (word indices are
 * cue-local), while the caller holds one map for the entire video.
 */
export type ToneStylesByCue = ReadonlyMap<number, ReadonlyMap<number, ToneStyle>>;

/** Generate the SVG for one planned frame, on demand. */
export async function renderPlannedFrame(
  cues: CaptionCue[],
  plan: CaptionFramePlan,
  opts: SvgRenderOptions & { toneStylesByCue?: ToneStylesByCue },
): Promise<string> {
  const cue = cues.find((c) => c.index === plan.cueIndex);
  if (!cue) throw new Error(`No cue with index ${plan.cueIndex}`);
  const forCue = opts.toneStylesByCue?.get(plan.cueIndex);
  return renderCueSvg(cue, {
    ...opts,
    activeWordIndex: plan.activeWordIndex,
    ...(forCue ? { toneStyles: forCue } : {}),
    ...(plan.motion ? { frameMotion: plan.motion } : {}),
  });
}

/**
 * Eager variant: plan and generate every SVG up front.
 *
 * Convenient for tests and short clips. For real renders prefer
 * planCaptionFrames() + renderPlannedFrame(), which keeps memory flat — see the
 * note on CaptionFramePlan.
 */
export async function buildCaptionFrames(
  cues: CaptionCue[],
  opts: SvgRenderOptions & { highlight: 'active-word' | 'none'; emphasisWords?: ReadonlySet<string> },
): Promise<CaptionFrame[]> {
  const plans = planCaptionFrames(cues, opts);
  const frames: CaptionFrame[] = [];
  for (const p of plans) {
    frames.push({ ...p, svg: await renderPlannedFrame(cues, p, opts) });
  }
  return frames;
}
