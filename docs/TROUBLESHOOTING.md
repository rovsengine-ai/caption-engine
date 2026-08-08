# Troubleshooting

Run `npm run doctor` first. It checks Node, FFmpeg, encoders, SVG support, every font, and
live shaping, and prints a fix for anything that fails.

---

## Rendering & fonts

### Captions show empty boxes (tofu)

A font for that script is missing.

```bash
npm run doctor            # look for "FAIL font: <Script>"
npm run fonts:install
```

If that fails (no network), download Noto for the script and point at it:

```bash
export FONT_DIR=/path/to/fonts
```

Fonts must be `.ttf` or `.otf`. **woff2 from the Google Fonts CDN will not work.**

### Vowel marks on the wrong consonant, or conjuncts split apart

If you see `वद्िया` instead of `विद्या`, complex-script shaping is failing.

**In a burned-in MP4 this should be impossible** — caption-engine shapes with HarfBuzz and
emits vector outlines. If you see it there, run:

```bash
npm run shaping:probe     # needs python3 + Pillow; compares our shaping vs libass
npm test                  # the shaping assertions run here too
```

**In an `.ass`/`.srt` file played elsewhere, this is expected on some hosts.** The player
does its own shaping. Use the burned-in MP4 for guaranteed output, or update libass (0.17+).

### Captions clipped at the frame edge, or lines overlapping

- `--font-size` too large for the output: lower it, or raise `--max-words`
- `--position-y` too close to 0 or 1: 0.72 is the reels-safe default
- Very long single words cannot be wrapped; they are kept whole rather than dropped

### Text is too small or too large

Styles are defined at 1080×1920 and scale with output height. `--aspect landscape`
(1920×1080) therefore produces smaller text. Override with `--font-size`.

---

## FFmpeg

### `ffmpeg: not found`

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Ubuntu
```

Or point at a specific binary: `export FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg`.

### `Failed to rasterise caption frame N`

**This should no longer happen.** Captions are rasterised by resvg (a bundled native
library), not by FFmpeg, so it does not depend on your FFmpeg build.

If you still see it:

```bash
node dist/src/cli.js doctor        # look at the "SVG rasteriser" and "caption render" lines
```

The error names the failing frame, the rasteriser used, and writes the offending SVG to a
file so you can reproduce it by hand. Then try:

```bash
node dist/src/cli.js render in.mp4 --transcript t.json --rasteriser ffmpeg -o out.mp4
```

**Historical note.** Before this was fixed, rasterisation went through FFmpeg's SVG
demuxer, which needs a librsvg-enabled build. Ubuntu's `ffmpeg` has one; **Homebrew's core
`ffmpeg` does not** — SVG input requires the `homebrew-ffmpeg` tap with `--with-librsvg`.
Every frame failed on macOS. You do not need to install that tap any more.

If resvg itself is missing (no prebuilt binary for your platform):

```bash
npm install @resvg/resvg-js
node dist/src/cli.js doctor
```

### Which FFmpeg is actually being used?

```bash
which -a ffmpeg                    # every candidate on PATH
command -v ffmpeg                  # the one your shell picks
node dist/src/cli.js doctor        # the one the APP resolves, symlinks followed
```

`doctor` reports the resolved real path, whether it came from `FFMPEG_PATH`, an absolute
path or `PATH`, and warns when more than one FFmpeg is on PATH — a common cause of "it
works in my terminal but not in the app".

Override explicitly:

```bash
export FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
export FFPROBE_PATH=/opt/homebrew/bin/ffprobe
```

### `Stream specifier ... not found` / filter graph errors

The full command is printed in the error. Copy it and run it directly to see FFmpeg's own
diagnostics. Report the filter graph if it looks malformed.

### `Unknown encoder 'libx264'`

Your build lacks H.264. `brew reinstall ffmpeg`, or on Ubuntu install the full `ffmpeg`
package rather than a minimal one.

### Render is very slow

Time scales with caption frames — one PNG per word state. Options:

- `--highlight none` — one frame per cue instead of per word
- `--max-words 6` — fewer, longer cues
- `--crf 26` and `--aspect original` — less encoding work
- Reuse the transcript (`--transcript-in`) so you only pay ASR once

---

## Transcription

### `No API key for ASR provider`

```bash
export ELEVENLABS_API_KEY="..."
```

Or `--provider deepgram`. Not needed with `--transcript-in`, `--dry-run`, or `doctor`.

### `Provider "sarvam" did not return real per-word timestamps`

Expected. Sarvam's REST API returns sentence-level timestamps, which cannot drive
word-timed captions. Use `--provider elevenlabs` or `--provider deepgram`.

### Captions are out of sync with speech

1. Confirm the provider returned real word timings — check `hasWordTimings` in
   `--transcript-out` output.
2. If you used `--auto-trim`, captions are re-timed onto the trimmed timeline. Rendering
   trimmed captions over untrimmed video will drift. Use one command for both.
3. Variable-frame-rate phone footage can drift. Normalise first:
   `ffmpeg -i in.mp4 -vsync cfr -r 30 fixed.mp4`

### Wrong language detected

Pass `--language hi` explicitly. **But for code-switched speech (Hinglish, Tenglish),
auto-detect is usually better** — forcing a language can push the provider to transliterate
English words into the Indic script, which is the exact failure Scribe v2's code-switch
handling avoids.

### Accuracy is poor on real recordings

Published WER figures come from clean read speech. For noisy audio:

- Extract and normalise first: the extractor has a `normalize` option (`dynaudnorm`)
- Compare providers on *your* audio — quality varies a lot by accent and recording setup
- Do not assume benchmark numbers transfer

---

## Auto Trim

### It cut a word that was not a filler

Some words are both. Hindi `matlab` and Telugu `ante` mean "meaning" as well as being
hesitation sounds. They are only cut when flanked by a pause, but the heuristic is not
perfect.

Restore it:

```bash
node dist/src/cli.js in.mp4 --auto-trim --cuts-out cuts.json --format json -o t.json
# set "restored": true on that cut
node dist/src/cli.js in.mp4 --auto-trim --cuts-in cuts.json -o out.mp4
```

Or `--keep-fillers` to trim silence only.

### It missed obvious fillers

The lexicons are not native-speaker reviewed. Add your own to
`src/autotrim/fillers.ts` — `always` for unambiguous, `ambiguous` for real words that are
sometimes fillers. See [NATIVE_REVIEW.md](NATIVE_REVIEW.md).

### Cuts sound abrupt

Raise `--trim-silence` (default 0.7) so only longer pauses are removed. Padding around each
cut is 0.12s (`paddingSec` in `src/autotrim/index.ts`).

---

## Input files

### `Unsupported input format`

The file was not readable by ffprobe. Check it plays, then convert:

```bash
ffmpeg -i input.xyz output.mp4
```

### `has no audio stream — there is nothing to transcribe`

Captions come from speech. The file is video-only.

### `Could not determine duration`

Usually a truncated or still-being-written file. Remux:

```bash
ffmpeg -i broken.mp4 -c copy fixed.mp4
```

### Paths with spaces or special characters

Supported and tested (spaces, apostrophes, colons, commas, brackets, `$`, `%`, Unicode).
Quote them in your shell:

```bash
node dist/src/cli.js "my video's file.mp4" -o "out put/final.mp4"
```

---

## Still stuck

```bash
CAPTION_ENGINE_DEBUG=1 node dist/src/cli.js ... # stack traces
CAPTION_ENGINE_KEEP_TEMP=1 node dist/src/cli.js ... # keep intermediate SVG/PNG
node dist/src/cli.js input.mp4 --dry-run        # show the plan, do nothing
node dist/src/cli.js input.mp4 --verbose
```

`CAPTION_ENGINE_KEEP_TEMP=1` is the most useful: inspect the generated caption SVG/PNG
directly to see whether the problem is in shaping/layout or in the video compositing.
