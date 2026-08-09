import type { CaptionCue, CaptionStyle } from '../types.js';
import type { ToneStyle } from './tone-style.js';

/** One exact active-word window, derived only from ASR word timestamps. */
export interface ActiveWordWindow {
  index: number;
  start: number;
  end: number;
}

/**
 * A word remains active until the following word begins. This avoids a flicker
 * in the ASR gap while preserving the original timestamp boundaries. The
 * result is shared by SVG and ASS so exports cannot disagree about emphasis.
 */
export function activeWordWindows(cue: CaptionCue): ActiveWordWindow[] {
  const out: ActiveWordWindow[] = [];
  for (let index = 0; index < cue.words.length; index++) {
    const word = cue.words[index]!;
    const next = cue.words[index + 1];
    const start = Math.max(cue.start, word.start);
    const end = Math.min(cue.end, next ? Math.max(word.end, next.start) : cue.end);
    if (end > start) out.push({ index, start, end });
  }
  // Invalid/overlapping provider timings never create overlapping visual
  // overlays. This is clamp-only: it cannot shift a timestamp forward.
  for (let i = 0; i < out.length - 1; i++) {
    out[i]!.end = Math.min(out[i]!.end, out[i + 1]!.start);
  }
  return out.filter((w) => w.end - w.start > 0.001);
}

export interface FinalWordStyle {
  fontFamily: string;
  bold: boolean;
  color: string;
  scale: number;
}

/**
 * Resolve base style, tone style and active-word emphasis into one renderable
 * style.
 *
 * ORDER, and why it is this way:
 *
 *   base caption style  →  tone style  →  active-word state
 *
 * Tone describes how a word was SPOKEN and is fixed for the whole time that
 * word is on screen. Active-word state describes WHEN it is being spoken and
 * changes frame to frame. The transient signal must therefore win: if a tone
 * had the final say, the highlight would be invisible on exactly the loud words
 * a viewer is most likely to be looking at.
 *
 * Tone contributes nothing unless a theme actually supplies a value, so with no
 * tone (the default) this reduces to precisely the previous behaviour.
 */
export function resolveWordStyle(
  style: CaptionStyle,
  active: boolean,
  opts: {
    activeScale?: number;
    activeBold?: boolean;
    /** Partial style from the caption theme for this word's classified tone. */
    tone?: ToneStyle;
  } = {},
): FinalWordStyle {
  const activeBold = opts.activeBold ?? false;
  const tone = opts.tone ?? {};

  // Default (no --active-bold): every word uses the bold face, which is the
  // historical SVG output and what short-form captions want.
  //
  // With --active-bold the flag earns its name: resting words drop to the
  // regular face so that the active word's real bold face is a visible
  // contrast. Previously this read `active ? (activeBold || true) : ...`, where
  // `activeBold || true` is unconditionally true — so the active word was
  // always bold and the flag only ever changed resting words. Weight now
  // genuinely tracks the flag on both sides.
  const baseBold = activeBold ? active : true;
  const bold = tone.bold ?? baseBold;

  // Tone scale and active scale MULTIPLY. Layout reserves the widest state a
  // word can reach (see reservedWidth in svg.ts), so both must be visible to
  // the measurement pass or a scaled word would overflow the space kept for it.
  const activeScale = active ? (opts.activeScale ?? 1) : 1;
  const scale = (tone.scale ?? 1) * activeScale;

  return {
    fontFamily: tone.fontFamily ?? style.fontFamily,
    bold: active ? (activeBold ? true : bold) : bold,
    // The active colour is the whole point of the highlight; a tone colour must
    // not override it, or the word being spoken would blend into its neighbours.
    color: active ? style.activeColor : tone.color ?? style.primaryColor,
    scale,
  };
}
