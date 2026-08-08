import opentype from 'opentype.js';
import { resolveFont, fontDataFor, type ResolvedFont } from './fonts.js';
import { splitScriptRuns, isRtlScript, type ScriptName } from './script.js';
import { ShapingError } from '../errors.js';

/**
 * Text shaping via HarfBuzz (WASM), glyph outlines via opentype.js.
 *
 * WHY THIS EXISTS — the single most important design decision in the renderer.
 *
 * FFmpeg's text paths (libass `subtitles`, and `drawtext`) do NOT reliably apply
 * complex-script shaping. Measured on Ubuntu 22.04 / FFmpeg 4.4.2 / libass 0.15.2,
 * with HarfBuzz present and the correct Noto font selected, `विद्या` rendered as
 * `वद्िया` — the pre-base matra was not reordered — and `क्षेत्र` came out
 * decomposed instead of ligated. Telugu and Kannada conjuncts were unstacked.
 * Newer libass (0.17.x, typical on macOS/Homebrew) generally gets this right,
 * so the failure is host-dependent, which is worse than a consistent failure:
 * the same code silently produces correct output on one machine and garbage on
 * another.
 *
 * Rather than depend on the host, we shape here — HarfBuzz is the same engine
 * every correct implementation uses — and hand FFmpeg pre-shaped vector outlines
 * that require no text intelligence to draw. Output is then identical everywhere.
 *
 * Verified against Pillow+Raqm (independent HarfBuzz rasteriser) for Devanagari,
 * Telugu, Kannada, Tamil, Malayalam, Bengali, Gujarati and Gurmukhi.
 */

// harfbuzzjs is an async ESM module; the import is resolved once and cached.
type HbModule = typeof import('harfbuzzjs');
let hbPromise: Promise<HbModule> | null = null;

async function hb(): Promise<HbModule> {
  if (!hbPromise) {
    hbPromise = import('harfbuzzjs').then((m) => m) as Promise<HbModule>;
  }
  return hbPromise;
}

/** Warm the WASM module up-front so first-render latency is predictable. */
export async function initShaper(): Promise<void> {
  await hb();
}

interface FontHandles {
  hbFont: unknown;
  hbFace: unknown;
  ot: opentype.Font;
  unitsPerEm: number;
  ascender: number;
  descender: number;
}

const fontCache = new Map<string, FontHandles>();

async function loadFont(f: ResolvedFont): Promise<FontHandles> {
  const cached = fontCache.get(f.path);
  if (cached) return cached;

  const H = await hb();
  const raw = fontDataFor(f);
  const u8 = new Uint8Array(raw);

  let handles: FontHandles;
  try {
    const blob = new (H as any).Blob(u8);
    const face = new (H as any).Face(blob, 0);
    const hbFont = new (H as any).Font(face);
    const ot = opentype.parse(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    );
    const unitsPerEm = ot.unitsPerEm || 1000;
    hbFont.setScale(unitsPerEm, unitsPerEm);
    handles = {
      hbFont,
      hbFace: face,
      ot,
      unitsPerEm,
      ascender: ot.ascender,
      descender: ot.descender,
    };
  } catch (e) {
    throw new ShapingError(
      `Failed to load font ${f.path}: ${e instanceof Error ? e.message : String(e)}`,
      'The file may be corrupt, or a format opentype.js cannot parse (e.g. a .ttc collection). Try a plain .ttf or .otf.',
    );
  }

  fontCache.set(f.path, handles);
  return handles;
}

export interface ShapedGlyph {
  glyphId: number;
  /** Pen position in font units, relative to the run origin. */
  x: number;
  y: number;
  xAdvance: number;
  /** Index into the ORIGINAL string — lets us map glyphs back to words. */
  cluster: number;
}

export interface ShapedRun {
  glyphs: ShapedGlyph[];
  script: ScriptName;
  font: ResolvedFont;
  handles: FontHandles;
  /** Total advance width in font units. */
  width: number;
}

export interface ShapedText {
  runs: ShapedRun[];
  /** Total advance width in PIXELS at the requested size. */
  width: number;
  /** Ascent/descent in PIXELS, from the tallest font used. */
  ascent: number;
  descent: number;
  fontSize: number;
}

/** Shape one single-script run. */
async function shapeRun(
  text: string,
  script: ScriptName,
  fontSize: number,
  opts: { bold?: boolean; fontPath?: string },
): Promise<ShapedRun> {
  const H = await hb();
  const font = resolveFont(script, { bold: opts.bold, override: opts.fontPath });
  const handles = await loadFont(font);

  const buf = new (H as any).Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  (H as any).shape(handles.hbFont, buf);

  const infos = buf.getGlyphInfos();
  const positions = buf.getGlyphPositions();

  const glyphs: ShapedGlyph[] = [];
  let penX = 0;
  let penY = 0;
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    const pos = positions[i];
    glyphs.push({
      glyphId: info.codepoint,
      x: penX + (pos.xOffset ?? 0),
      y: penY + (pos.yOffset ?? 0),
      xAdvance: pos.xAdvance ?? 0,
      cluster: info.cluster ?? 0,
    });
    penX += pos.xAdvance ?? 0;
    penY += pos.yAdvance ?? 0;
  }

  // Free the WASM-side buffer; leaking these across a long render is a real leak.
  if (typeof buf.destroy === 'function') buf.destroy();

  return { glyphs, script, font, handles, width: penX };
}

/**
 * Shape mixed-script text (e.g. Hinglish: Latin + Devanagari in one line).
 * Each script run gets a font that actually covers it.
 */
export async function shapeText(
  text: string,
  fontSize: number,
  opts: { bold?: boolean; fontPath?: string } = {},
): Promise<ShapedText> {
  const runs = splitScriptRuns(text);
  if (runs.length === 0) {
    return { runs: [], width: 0, ascent: fontSize * 0.8, descent: fontSize * 0.2, fontSize };
  }

  const shaped: ShapedRun[] = [];
  for (const r of runs) {
    shaped.push(await shapeRun(r.text, r.script, fontSize, opts));
  }

  // RTL runs render right-to-left within the line.
  const anyRtl = shaped.some((r) => isRtlScript(r.script));
  const ordered = anyRtl ? [...shaped].reverse() : shaped;

  let widthPx = 0;
  let ascent = 0;
  let descent = 0;
  for (const r of ordered) {
    const scale = fontSize / r.handles.unitsPerEm;
    widthPx += r.width * scale;
    ascent = Math.max(ascent, r.handles.ascender * scale);
    descent = Math.max(descent, Math.abs(r.handles.descender) * scale);
  }

  return { runs: ordered, width: widthPx, ascent, descent, fontSize };
}

/**
 * Convert shaped glyphs to SVG path data IN FONT UNITS.
 *
 * PRECISION — this caused a real, subtle rendering bug worth recording.
 *
 * The obvious implementation asks opentype.js for outlines already scaled to
 * the pixel size (`glyph.getPath(x, y, fontSize)`), then serialises with
 * `toPathData(2)`. That quantises every coordinate to 1/100 px. At some sizes
 * the rounding makes adjacent control points of a thin feature coincide,
 * producing a degenerate or self-intersecting contour. Under the SVG default
 * nonzero fill rule such a contour can cancel the region it bounds, and the
 * glyph loses its body — Devanagari "का" rendered as a small hook at 72px while
 * being perfect at 40, 96 and 120px. Scaling the broken path up did not fix it,
 * which is what proved the fault was in the geometry rather than rasterisation.
 *
 * So: emit outlines at their native font-unit resolution (integers, no
 * quantisation error) and let a single SVG transform apply the scale. Output is
 * also smaller, since font-unit integers serialise shorter than scaled decimals.
 */
export function runToFontUnitPath(run: ShapedRun): string {
  const upem = run.handles.unitsPerEm;
  let d = '';
  for (const g of run.glyphs) {
    const glyph = run.handles.ot.glyphs.get(g.glyphId);
    if (!glyph) continue;
    // fontSize === unitsPerEm ⇒ scale factor 1, i.e. raw font units.
    // SVG y grows downward, so a positive HarfBuzz yOffset moves the glyph up.
    const path = glyph.getPath(g.x, -g.y, upem);
    const pd = path.toPathData(1);
    if (pd && pd !== 'Z') d += pd + ' ';
  }
  return d.trim();
}

export interface SvgGlyphRun {
  /** Path data in FONT UNITS. Apply `transform` to place it. */
  d: string;
  /** Scale from font units to pixels. */
  scale: number;
  /** X origin in pixels for this run within the line. */
  originX: number;
}

/**
 * Full shaped line → per-run path data plus the transform needed to place it.
 *
 * Runs are returned separately because each may come from a different font with
 * a different unitsPerEm, so they cannot share one scale factor.
 */
export function shapedToSvgRuns(shaped: ShapedText): SvgGlyphRun[] {
  const out: SvgGlyphRun[] = [];
  let x = 0;
  for (const run of shaped.runs) {
    const scale = shaped.fontSize / run.handles.unitsPerEm;
    const d = runToFontUnitPath(run);
    if (d) out.push({ d, scale, originX: x });
    x += run.width * scale;
  }
  return out;
}

/**
 * Convenience: a single pixel-space path string.
 *
 * Prefer shapedToSvgRuns() for rendering — this exists for callers that need
 * one flat path and can tolerate the quantisation described above.
 */
export function shapedToSvgPath(shaped: ShapedText): string {
  const parts: string[] = [];
  for (const run of shaped.runs) {
    const scale = shaped.fontSize / run.handles.unitsPerEm;
    const upem = run.handles.unitsPerEm;
    for (const g of run.glyphs) {
      const glyph = run.handles.ot.glyphs.get(g.glyphId);
      if (!glyph) continue;
      const originX = parts.length === 0 ? 0 : 0;
      void originX;
      const path = glyph.getPath(g.x, -g.y, upem);
      // 3 decimals in font units ≈ 0.0002px at typical sizes — well below any
      // rounding that could collapse a contour.
      const pd = path.toPathData(3);
      if (pd && pd !== 'Z') parts.push(pd);
    }
    void scale;
  }
  return parts.join(' ');
}

/** Advance width in pixels, without building paths. Used for layout/wrapping. */
export async function measureText(
  text: string,
  fontSize: number,
  opts: { bold?: boolean; fontPath?: string } = {},
): Promise<number> {
  const s = await shapeText(text, fontSize, opts);
  return s.width;
}

export function clearShaperCache(): void {
  fontCache.clear();
}
