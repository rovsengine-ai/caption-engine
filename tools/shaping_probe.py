#!/usr/bin/env python3
"""
Decisive complex-script shaping check.

Compares three things for the same string + font:
  1. HarfBuzz glyph order/positions (ground truth for the shaping plan)
  2. PIL + Raqm rendering (a known-good HarfBuzz-backed rasteriser)
  3. libass rendering via FFmpeg (what the product actually ships)

If (3) differs materially from (2), libass shaping is broken on this host and
Indic captions cannot be trusted, regardless of what the ASS file contains.

The specific failure this catches: pre-base matras (Devanagari ि U+093F,
Bengali ি, etc.) must be REORDERED to the left of their base consonant. A
shaper that skips reordering produces text that looks almost right and is
wrong — e.g. विद्या rendering as वद्िया.

Usage:
  python3 tools/shaping_probe.py                     # run the built-in suite
  python3 tools/shaping_probe.py --out-dir /tmp/x
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import uharfbuzz as hb
except ImportError:
    hb = None

try:
    from PIL import Image, ImageDraw, ImageFont, features
except ImportError:
    print("ERROR: Pillow required. pip install Pillow --break-system-packages")
    sys.exit(2)


# (label, font family for libass, font file substring, text, expects_reordering)
CASES = [
    ("devanagari-matra", "Noto Sans Devanagari", "NotoSansDevanagari", "विद्या", True),
    ("devanagari-conj", "Noto Sans Devanagari", "NotoSansDevanagari", "क्षेत्र", False),
    ("devanagari-tri", "Noto Sans Devanagari", "NotoSansDevanagari", "त्रिशूल", True),
    ("devanagari-sent", "Noto Sans Devanagari", "NotoSansDevanagari", "आज का वीडियो", False),
    ("telugu", "Noto Sans Telugu", "NotoSansTelugu", "చెప్తాను", False),
    ("kannada", "Noto Sans Kannada", "NotoSansKannada", "ಹೇಳ್ತೀನಿ", False),
    ("tamil", "Noto Sans Tamil", "NotoSansTamil", "சொல்கிறேன்", False),
    ("malayalam", "Noto Sans Malayalam", "NotoSansMalayalam", "പറയാം", False),
    ("bengali", "Noto Sans Bengali", "NotoSansBengali", "বলছি", True),
    ("gujarati", "Noto Sans Gujarati", "NotoSansGujarati", "કહીશ", False),
    ("gurmukhi", "Noto Sans Gurmukhi", "NotoSansGurmukhi", "ਦੱਸਾਂਗਾ", False),
]

FONT_SIZE = 96
PAD = 40


def _norm(s: str) -> str:
    """Strip separators, weight names and digits so distributions that name files
    NotoSansDevanagari-Regular / NotoSansDevanagari_400Regular both match."""
    s = s.lower()
    for junk in ("-", "_", " ", "regular", "400", "700", "bold"):
        s = s.replace(junk, "")
    return s


def find_font(substr: str) -> Path | None:
    """Locate a font file, preferring fontconfig, falling back to a directory scan.

    Matching is deliberately loose on weight/separator because font packaging
    varies wildly between distros, Homebrew, and npm font packages.
    """
    want = _norm(substr)
    candidates: list[str] = []
    try:
        out = subprocess.run(
            ["fc-list", "--format", "%{file}\n"], capture_output=True, text=True, timeout=30
        ).stdout
        candidates.extend(out.splitlines())
    except Exception:
        pass

    for d in (
        Path.home() / ".local/share/fonts",
        Path.home() / ".fonts",
        Path("/usr/share/fonts"),
        Path("/Library/Fonts"),
        Path.home() / "Library/Fonts",
    ):
        if d.is_dir():
            candidates.extend(str(p) for p in d.rglob("*.ttf"))
            candidates.extend(str(p) for p in d.rglob("*.otf"))

    # Prefer a Regular weight when several files match the same family.
    matches = [c for c in candidates if c and want in _norm(Path(c).stem)]
    if not matches:
        return None
    for m in matches:
        if "regular" in Path(m).stem.lower() or "400" in Path(m).stem:
            return Path(m)
    return Path(matches[0])


def hb_shape(font_path: Path, text: str) -> list[dict]:
    """Ground-truth shaping plan from HarfBuzz."""
    if hb is None:
        return []
    blob = hb.Blob.from_file_path(str(font_path))
    face = hb.Face(blob)
    font = hb.Font(face)
    font.scale = (FONT_SIZE * 64, FONT_SIZE * 64)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf)
    return [
        {"gid": i.codepoint, "cluster": i.cluster, "x_adv": p.x_advance, "x_off": p.x_offset}
        for i, p in zip(buf.glyph_infos, buf.glyph_positions)
    ]


def render_pil(font_path: Path, text: str, w: int, h: int) -> Image.Image:
    """Known-good reference rendering (Pillow + Raqm → HarfBuzz)."""
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(str(font_path), FONT_SIZE)
    kwargs = {}
    if features.check("raqm"):
        kwargs["features"] = []  # force the Raqm/HarfBuzz layout engine
    d.text((PAD, PAD), text, font=f, fill=255, **kwargs)
    return img


def render_libass(family: str, text: str, w: int, h: int, workdir: Path) -> Image.Image | None:
    """What the product actually ships: libass via FFmpeg's subtitles filter."""
    ass = workdir / "probe.ass"
    png = workdir / "probe.png"
    # Alignment 7 = top-left, so the origin matches the PIL draw position.
    ass.write_text(
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {w}\nPlayResY: {h}\n"
        "WrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: P,{family},{FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        f"Dialogue: 0,0:00:00.00,0:00:05.00,P,,0,0,0,,{{\\pos({PAD},{PAD})}}{text}\n",
        encoding="utf-8",
    )
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"color=c=black:s={w}x{h}:d=1",
         "-vf", f"subtitles='{ass}'", "-frames:v", "1", str(png)],
        capture_output=True, text=True, timeout=120,
    )
    if r.returncode != 0 or not png.exists():
        return None
    return Image.open(png).convert("L")


def ink_profile(img: Image.Image) -> tuple[int, list[int]]:
    """Total ink and its horizontal distribution — a shaping-order fingerprint."""
    px = img.load()
    w, h = img.size
    cols = [0] * w
    total = 0
    for x in range(w):
        c = 0
        for y in range(h):
            if px[x, y] > 96:
                c += 1
        cols[x] = c
        total += c
    return total, cols


def first_ink_x(cols: list[int]) -> int:
    for x, v in enumerate(cols):
        if v > 0:
            return x
    return -1


NORM_H = 120  # common height both renderings are scaled to before comparing


def _ink_bbox(img: Image.Image, thresh: int = 96):
    """Bounding box of visible ink. None when the image is blank."""
    bw = img.point(lambda v: 255 if v > thresh else 0)
    return bw.getbbox()


def _normalise(img: Image.Image) -> Image.Image | None:
    """Crop to ink and scale to a fixed height.

    This is the crux of a fair comparison. libass sizes text by ASS script units
    and positions via alignment/\\pos; Pillow uses FreeType pixel size and a
    top-left origin. Those differ systematically, which would swamp the signal we
    actually care about. Cropping to the ink box and normalising height removes
    position and scale, leaving GLYPH ARRANGEMENT — which is what shaping decides.
    """
    box = _ink_bbox(img)
    if box is None:
        return None
    crop = img.crop(box)
    if crop.height == 0 or crop.width == 0:
        return None
    w = max(1, round(crop.width * (NORM_H / crop.height)))
    return crop.resize((w, NORM_H), Image.LANCZOS)


def compare(a: Image.Image, b: Image.Image) -> dict:
    """Compare two renderings structurally rather than pixel-exactly.

    Antialiasing, hinting and rasteriser differences make exact equality the
    wrong bar. After normalisation we check:
      - aspect ratio of the ink box  (a reordered/dropped glyph changes width)
      - column ink profile correlation (where ink sits horizontally)
      - mean absolute pixel difference
    A pre-base matra rendered on the wrong side moves a whole glyph and is
    clearly visible in all three.
    """
    na, nb = _normalise(a), _normalise(b)
    if na is None or nb is None:
        return {"ok": False, "reason": "no ink in one rendering"}

    ar_a = na.width / NORM_H
    ar_b = nb.width / NORM_H
    aspect_ratio = min(ar_a, ar_b) / max(ar_a, ar_b)

    # Resample both to identical width so profiles are directly comparable.
    w = min(na.width, nb.width)
    ra = na.resize((w, NORM_H), Image.LANCZOS)
    rb = nb.resize((w, NORM_H), Image.LANCZOS)

    _, ca = ink_profile(ra)
    _, cb = ink_profile(rb)

    ma = sum(ca) / len(ca)
    mb = sum(cb) / len(cb)
    num = sum((ca[i] - ma) * (cb[i] - mb) for i in range(w))
    da = sum((v - ma) ** 2 for v in ca) ** 0.5
    db = sum((v - mb) ** 2 for v in cb) ** 0.5
    corr = num / (da * db) if da and db else 0.0

    pa, pb = ra.load(), rb.load()
    diff = sum(abs(pa[x, y] - pb[x, y]) for x in range(w) for y in range(NORM_H))
    mad = diff / (w * NORM_H * 255)

    return {
        "ok": aspect_ratio > 0.90 and corr > 0.85 and mad < 0.18,
        "aspect_ratio": round(aspect_ratio, 4),
        "profile_corr": round(corr, 4),
        "mad": round(mad, 4),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    outdir = Path(args.out_dir) if args.out_dir else Path(tempfile.mkdtemp(prefix="shaping-"))
    outdir.mkdir(parents=True, exist_ok=True)

    if not args.json:
        print(f"HarfBuzz module : {'yes' if hb else 'NO (pip install uharfbuzz)'}")
        print(f"Pillow Raqm     : {features.check('raqm')}")
        print(f"Output dir      : {outdir}\n")
        print(f"{'case':<20} {'font':<8} {'hb':<10} {'libass vs reference':<28} verdict")
        print("-" * 92)

    results = []
    for label, family, file_substr, text, expects_reorder in CASES:
        fp = find_font(file_substr)
        rec: dict = {"case": label, "text": text, "family": family}

        if fp is None:
            rec.update({"status": "MISSING_FONT", "ok": False})
            results.append(rec)
            if not args.json:
                print(f"{label:<20} {'MISSING':<8} {'-':<10} {'-':<28} FONT NOT INSTALLED")
            continue

        glyphs = hb_shape(fp, text)
        rec["hb_glyphs"] = len(glyphs)

        # Reordering evidence: HarfBuzz emits glyphs whose cluster indices are
        # not monotonically increasing when a pre-base matra moves left.
        clusters = [g["cluster"] for g in glyphs]
        reordered = any(clusters[i] > clusters[i + 1] for i in range(len(clusters) - 1))
        rec["hb_reordered"] = reordered

        w = PAD * 2 + FONT_SIZE * (len(text) + 3)
        h = PAD * 2 + int(FONT_SIZE * 2.2)

        ref = render_pil(fp, text, w, h)
        got = render_libass(family, text, w, h, outdir)

        if got is None:
            rec.update({"status": "LIBASS_FAILED", "ok": False})
            results.append(rec)
            if not args.json:
                print(f"{label:<20} {'ok':<8} {len(glyphs):<10} {'render failed':<28} FAIL")
            continue

        ref.save(outdir / f"{label}.reference.png")
        got.save(outdir / f"{label}.libass.png")

        cmp = compare(ref, got)
        rec.update({"status": "OK" if cmp["ok"] else "MISMATCH", **cmp})


        results.append(rec)
        if not args.json:
            summary = (f"corr={cmp.get('profile_corr')} ar={cmp.get('aspect_ratio')} "
                       f"mad={cmp.get('mad')}")
            verdict = "PASS" if rec.get("ok") else rec["status"]
            print(f"{label:<20} {'ok':<8} {len(glyphs):<10} {summary:<28} {verdict}")

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        bad = [r for r in results if not r.get("ok")]
        print("-" * 92)
        print(f"{len(results) - len(bad)}/{len(results)} passed")
        if bad:
            print("\nFAILURES:")
            for r in bad:
                print(f"  {r['case']:<20} {r['status']}  \"{r['text']}\"")
            print(f"\nCompare images side by side in: {outdir}")
    return 0 if all(r.get("ok") for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
