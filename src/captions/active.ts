import type { CaptionCue, CaptionStyle } from '../types.js';

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

/** Resolve tone/base styling and active emphasis into one renderable style. */
export function resolveWordStyle(
  style: CaptionStyle,
  active: boolean,
  opts: { activeScale?: number; activeBold?: boolean } = {},
): FinalWordStyle {
  // Historical SVG output is bold. An explicit --active-bold changes only the
  // optional mode: resting words become regular and the active word uses the
  // real bold face, so the flag has a visible, useful effect.
  const activeBold = opts.activeBold ?? false;
  return {
    fontFamily: style.fontFamily,
    bold: active ? (activeBold || true) : !activeBold,
    color: active ? style.activeColor : style.primaryColor,
    scale: active ? (opts.activeScale ?? 1) : 1,
  };
}
