import type { CaptionCue, CaptionStyle, VideoMeta, Word } from '../types.js';
import { DEFAULT_STYLE } from './group.js';
import { activeWordWindows } from './active.js';

/**
 * ASS (Advanced SubStation Alpha) generation with per-word active highlighting.
 *
 * Why ASS and not SRT: SRT has no styling. ASS supports colour, outline,
 * positioning, and — critically — per-word timing via \k karaoke tags, which is
 * how the "active word lights up" effect is produced. FFmpeg burns it in with
 * the `subtitles` filter, no browser or render farm needed.
 *
 * KNOWN CEILING: ASS cannot do per-word scale/slide/blur entrance animations
 * (the Submagic look). It does colour swaps and position, not motion. When you
 * outgrow this, move to Remotion — but ship this first: it renders in seconds,
 * costs nothing but CPU, and covers the majority of what creators actually use.
 *
 * Indic scripts: rendering depends on libass having a font with the right
 * glyphs AND correct complex-script shaping (conjuncts, matras). Test Devanagari,
 * Telugu and Kannada output visually before trusting it — this is the #1 place
 * Indic captions break, and it fails silently as boxes or broken conjuncts.
 */

/**
 * How the "current word" is emphasised.
 *
 *  'active-word' — only the word being spoken is highlighted; it reverts to the
 *                  normal colour afterwards. This is the look short-form viewers
 *                  expect, and what competitors call "active-word templates".
 *                  Costs one Dialogue line per word — worth it for exactness.
 *
 *  'karaoke'     — a progressive fill: words turn the active colour as they are
 *                  spoken and STAY that colour. One Dialogue line per cue, so
 *                  smaller files, but it's a different (and less popular) effect.
 *                  Implemented with native ASS \kf, which transitions
 *                  SecondaryColour → PrimaryColour.
 *
 *  'none'        — static text.
 */
export type HighlightMode = 'active-word' | 'karaoke' | 'none';

export interface AssOptions {
  style: CaptionStyle;
  video: Pick<VideoMeta, 'width' | 'height'>;
  highlight: HighlightMode;
  /** Scale the active word, e.g. 1.15 for a subtle pop. 1 = no scaling. */
  activeScale: number;
  /** Render only the active word with a real bold face when supported. */
  activeBold: boolean;
  maxLines: number;
  /** @deprecated use `highlight`. Kept so existing callers don't break. */
  activeWordHighlight?: boolean;
}

export function buildAss(cues: CaptionCue[], opts: Partial<AssOptions> = {}): string {
  const style = { ...DEFAULT_STYLE, ...opts.style };
  const video = opts.video ?? { width: 1080, height: 1920 };
  const highlight: HighlightMode =
    opts.highlight ?? (opts.activeWordHighlight === false ? 'none' : 'active-word');
  const activeScale = opts.activeScale ?? 1;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'WrapStyle: 2', // no automatic wrapping — we control line breaks ourselves
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine(style, video, highlight, opts.activeBold ?? false),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const maxLines = opts.maxLines ?? 2;
  const events = cues.flatMap((cue) => {
    switch (highlight) {
      case 'active-word':
        return activeWordLines(cue, style, maxLines, activeScale, opts.activeBold ?? false);
      case 'karaoke':
        return [karaokeLine(cue, style, maxLines)];
      default:
        return [dialogue(cue.start, cue.end, plainText(cue, style, maxLines))];
    }
  });

  return [...header, ...events, ''].join('\n');
}

function styleLine(
  style: CaptionStyle,
  video: Pick<VideoMeta, 'height'>,
  highlight: HighlightMode,
  activeBold: boolean,
): string {
  // The colour roles DEPEND ON THE MODE — this is the subtle part.
  //
  // ASS \k transitions SecondaryColour → PrimaryColour as each syllable is sung.
  // So in 'karaoke' mode, Primary must be the ACTIVE colour and Secondary the
  // resting colour. Reversed (the intuitive-looking assignment) the text starts
  // highlighted and fades to normal — the opposite of the intent.
  //
  // In 'active-word' and 'none' modes there is no \k transition; the base text
  // is the resting colour and inline \c tags do the highlighting, so Primary
  // must be the resting colour or every word renders highlighted.
  const isKaraoke = highlight === 'karaoke';
  const primary = toAssColour(isKaraoke ? style.activeColor : style.primaryColor);
  const secondary = toAssColour(style.primaryColor);
  const outline = toAssColour(style.outlineColor);

  // Alignment 2 = bottom-centre; we position vertically with MarginV from the bottom.
  const marginV = Math.round(video.height * (1 - style.positionY));

  return [
    'Style: Default',
    style.fontFamily,
    String(style.fontSizePx),
    primary,
    secondary,
    outline,
    '&H00000000', // back colour (unused with BorderStyle 1)
    activeBold ? '0' : '-1', // preserve historical bold unless active-only bold was requested
    '0', // italic
    '0', // underline
    '0', // strikeout
    '100', // ScaleX
    '100', // ScaleY
    '0', // spacing
    '0', // angle
    '1', // BorderStyle: outline + drop shadow
    String(style.outlineWidthPx),
    '0', // shadow
    '2', // alignment: bottom-centre
    '80', // MarginL
    '80', // MarginR
    String(marginV),
    '1', // encoding
  ].join(',');
}

function dialogue(start: number, end: number, text: string): string {
  return `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`;
}

/**
 * 'active-word': one Dialogue line per word, each showing the whole cue with a
 * single word emphasised.
 *
 * Why not do this with \k: ASS karaoke is a one-way transition (unsung → sung).
 * It cannot express "highlight this word, then put it back", which is exactly
 * the effect short-form captions use. Emitting per-word lines is more verbose
 * but renders precisely what's intended, in any libass build.
 */
function activeWordLines(
  cue: CaptionCue,
  style: CaptionStyle,
  maxLines: number,
  activeScale: number,
  activeBold: boolean,
): string[] {
  const lines = layoutLines(cue.words, style.maxCharsPerLine, maxLines);
  const active = toAssColour(style.activeColor);
  const out: string[] = [];

  for (const window of activeWordWindows(cue)) {
    const wi = window.index;

    let idx = 0;
    const body = lines
      .map((line) =>
        line
          .map((w) => {
            const label = escapeAss(style.uppercase ? w.text.toUpperCase() : w.text);
            const isActive = idx++ === wi;
            if (!isActive) return label;
            const scale =
              activeScale !== 1
                ? `\\fscx${Math.round(activeScale * 100)}\\fscy${Math.round(activeScale * 100)}`
                : '';
            const bold = activeBold ? '\\b1' : '';
            // Reset colour and scale after the word so the rest of the line is
            // unaffected — omitting the reset bleeds the highlight across the cue.
            const reset = (activeScale !== 1 ? '\\fscx100\\fscy100' : '') + (activeBold ? '\\b0' : '');
            return `{\\c${active}${scale}${bold}}${label}{\\c${toAssColour(style.primaryColor)}${reset}}`;
          })
          .join(' '),
      )
      .join('\\N');

    out.push(dialogue(window.start, window.end, body));
  }

  // Cover any gap before the first word / after the last with a plain line, so
  // the caption doesn't blink out between words.
  const first = cue.words[0];
  if (first && first.start > cue.start + 0.01) {
    out.unshift(dialogue(cue.start, first.start, plainText(cue, style, maxLines)));
  }
  const last = cue.words[cue.words.length - 1];
  if (last && last.end < cue.end - 0.01) {
    out.push(dialogue(last.end, cue.end, plainText(cue, style, maxLines)));
  }

  return out;
}

/**
 * 'karaoke': native ASS \kf progressive fill, one line per cue.
 *
 * \k durations are CENTISECONDS and RELATIVE, accumulating across the line — an
 * error compounds, so it looks right at the start of a cue and drifts by the end.
 * The cursor below keeps the sum honest. Colours come from the style
 * (Secondary → Primary); do NOT add inline \c tags here, they override the
 * karaoke transition and flatten every word to one colour.
 */
function karaokeLine(cue: CaptionCue, style: CaptionStyle, maxLines: number): string {
  const lines = layoutLines(cue.words, style.maxCharsPerLine, maxLines);

  let cursor = cue.start;
  const body = lines
    .map((line) =>
      line
        .map((w) => {
          const lead = Math.max(0, Math.round((w.start - cursor) * 100));
          const dur = Math.max(1, Math.round((w.end - Math.max(w.start, cursor)) * 100));
          cursor = Math.max(cursor, w.end);
          const label = escapeAss(style.uppercase ? w.text.toUpperCase() : w.text);
          const leadTag = lead > 0 ? `{\\k${lead}}` : '';
          return `${leadTag}{\\kf${dur}}${label}`;
        })
        .join(' '),
    )
    .join('\\N');

  return dialogue(cue.start, cue.end, body);
}

function plainText(cue: CaptionCue, style: CaptionStyle, maxLines: number): string {
  const lines = layoutLines(cue.words, style.maxCharsPerLine, maxLines);
  return lines
    .map((line) =>
      escapeAss(
        line.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text)).join(' '),
      ),
    )
    .join('\\N');
}

/** Break a cue's words into display lines without losing any word. */
function layoutLines(words: Word[], maxChars: number, maxLines: number): Word[][] {
  const lines: Word[][] = [];
  let cur: Word[] = [];
  let len = 0;

  for (const w of words) {
    const add = (cur.length ? 1 : 0) + w.text.length;
    if (len + add > maxChars && cur.length > 0) {
      lines.push(cur);
      cur = [w];
      len = w.text.length;
    } else {
      cur.push(w);
      len += add;
    }
  }
  if (cur.length) lines.push(cur);

  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).flat());
    return head;
  }
  return lines;
}

/** ASS time format: H:MM:SS.cc (centiseconds, single-digit hour). */
export function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = Math.floor(rest);
  const cs = Math.round((rest - whole) * 100);
  // Rounding can push cs to 100 — carry it rather than emitting ".100".
  const carry = cs === 100 ? 1 : 0;
  const cs2 = cs === 100 ? 0 : cs;
  return `${h}:${pad(m)}:${pad(whole + carry)}.${pad(cs2)}`;
}

/** ASS colours are &HAABBGGRR — alpha first, and BGR not RGB. Easy to get backwards. */
export function toAssColour(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = full.slice(0, 2);
  const g = full.slice(2, 4);
  const b = full.slice(4, 6);
  const a = alpha.toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function escapeAss(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// SRT — for the "export .srt" feature and for uploading to YouTube/Instagram.
// ---------------------------------------------------------------------------

export function buildSrt(cues: CaptionCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

export function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = Math.floor(rest);
  const ms = Math.round((rest - whole) * 1000);
  const carry = ms === 1000 ? 1 : 0;
  const ms3 = ms === 1000 ? 0 : ms;
  return `${pad(h)}:${pad(m)}:${pad(whole + carry)},${String(ms3).padStart(3, '0')}`;
}
