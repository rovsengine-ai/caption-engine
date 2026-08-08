# caption-engine

Word-timed captions, Auto Trim and clip finding for Indic and Hinglish video.
TypeScript + FFmpeg. No web framework, no cloud service required beyond the ASR provider.

```bash
npm install
npm run build
npm run doctor                                     # functional checks, not version strings

node dist/src/cli.js input.mp4  --language hi --output out.mp4
node dist/src/cli.js input.wav  --language en --format srt --output captions.srt

# Render again from a saved transcript — structurally cannot call a paid API
node dist/src/cli.js render input.mp4 --transcript transcript.json --output out.mp4
```

## What it does

- **Input**: MP4, MOV, MKV, WebM, AVI, M4V, MPG, WMV, FLV, TS · WAV, MP3, M4A, AAC, FLAC, OGG, OPUS, AIFF, CAF
- Audio is extracted automatically (16 kHz mono) before transcription — never uploads the video
- **Word-level timestamps** from ElevenLabs Scribe v2 or Deepgram Nova-3
- **13 languages with verified rendering**, native script or the option of Roman/Hinglish output
- **Auto Trim**: silences, filler words, false starts — every cut reviewable and restorable
- **Exports**: burned-in MP4, SRT, ASS, JSON
- **Portrait / landscape / square / original** output
- **Long-form clip detection** (optional, needs an LLM key)

## The important thing to understand about Indic rendering

**FFmpeg does not reliably shape complex scripts, and the failure is silent.**

Measured on this project's dev host (Ubuntu 22.04, FFmpeg 4.4.2, libass 0.15.2), with
HarfBuzz present and the correct Noto font selected:

| Input | libass rendered | Correct |
|---|---|---|
| `विद्या` | `वद्िया` — matra on the wrong consonant | `विद्या` |
| `क्षेत्र` | decomposed, no ligature | `क्षेत्र` |
| `చెప్తాను` | conjunct unstacked | `చెప్తాను` |

`drawtext` failed identically. Newer libass (0.17.x, typical on macOS/Homebrew) usually
gets this right — which is *worse* than a consistent failure, because the same code
produces correct output on one machine and garbage on another, with no error either way.

**So caption-engine does its own shaping.** Text is shaped with HarfBuzz (`harfbuzzjs`),
converted to vector outlines (`opentype.js`), and handed to FFmpeg as SVG that requires no
text intelligence to draw. Output is byte-identical on every host. Verified against
Pillow+Raqm — an independent HarfBuzz rasteriser — for all supported scripts.

Fonts are **vendored into `assets/fonts/`** for the same reason: a machine with a
different "Noto Sans Devanagari" would produce different glyph widths and different line
breaks.

## How long videos are rendered (chunking)

Captions are composited as PNG overlays. The obvious implementation — one
`-i overlay.png` plus one `overlay` filter per caption frame, in a single
FFmpeg process — **breaks on real videos**:

| Overlays | `ulimit -n 256` (macOS default) |
|---|---|
| 200 | exit 0, valid file |
| **400** | **exit 1, `Too many open files`, 0-byte file left behind** |

A 465-second video with ~2,300 words produces well over a thousand frames, so
FFmpeg exhausts its file descriptors, reports
`Error binding filtergraph inputs/outputs: Resource temporarily unavailable`,
and leaves a truncated file that then fails to open with `moov atom not found`.
On Linux with a large `ulimit -n` the same code renders happily — which is why
this survived development and broke on a real machine.

Rendering is therefore three passes:

1. **Base** — Auto Trim segments, crop, scale. Few inputs. Produces the output
   timeline with audio intact.
2. **Chunks** — split into **≤80 overlays / ≤45s** pieces; each is one FFmpeg
   process rendering **video only**. Caption times are rebased to each chunk;
   a caption spanning a boundary is emitted in both, clipped.
3. **Concat + mux** — stream-copy the chunks together and mux the base audio back.

Audio is never chunked or re-encoded, so there are no seams and no drift.

Tune if needed:

```bash
CAPTION_ENGINE_MAX_OVERLAYS=40 CAPTION_ENGINE_MAX_CHUNK_SECONDS=20 node dist/src/cli.js ...
--preset ultrafast --crf 30     # much faster on long videos
```

## Output is atomic — no corrupt files, ever

Every render goes to a hidden temp file, is validated with ffprobe (non-zero
size, readable container, positive duration, expected streams/size/pixel
format), and only then renamed into place. A failed render leaves **nothing** at
the output path, so "moov atom not found" cannot happen again. The engine also
refuses to write to the input path.

## How captions get rasterised (and why FFmpeg does NOT need librsvg)

Caption SVGs are converted to PNG by **[resvg](https://github.com/yisibl/resvg-js)**, a
Rust library with prebuilt binaries for macOS (Intel + Apple Silicon), Linux and Windows.
No system libraries, no compiler, no fonts.

This replaced an earlier design that used FFmpeg's SVG demuxer, which **requires FFmpeg to
be built with librsvg**:

| Platform | FFmpeg has librsvg? | Old design |
|---|---|---|
| Ubuntu (`apt install ffmpeg`) | yes (`--enable-librsvg`) | worked |
| **macOS (`brew install ffmpeg`)** | **no** | **failed on every frame** |

Homebrew's core `ffmpeg` formula does not depend on librsvg — SVG input needs the
third-party `homebrew-ffmpeg` tap with `--with-librsvg`. The failure surfaced as
`Failed to rasterise caption frame 0`, and the old doctor check passed anyway because it
only grepped FFmpeg's version banner for the string "svg".

Now:

- **FFmpeg is used only for video and audio** — decode, trim, crop, scale, composite, encode.
  It never parses SVG and never draws text.
- **`doctor` runs a real functional probe**: it rasterises an actual SVG, verifies the PNG
  exists with the expected dimensions, and renders a real Devanagari caption end to end.
  No check can be satisfied by a version string.
- FFmpeg remains available as a fallback (`--rasteriser ffmpeg`) but is **only selected if
  it passes the same functional probe**. On a librsvg-enabled build both produce
  pixel-identical output (verified byte-for-byte).

`.ass` and `.srt` exports are still produced for editors (Premiere, After Effects,
Resolve), where the host application does its own shaping. **For guaranteed rendering, use
the burned-in MP4.**

## Install

### macOS

```bash
brew install node ffmpeg          # Node 20+, FFmpeg for video/audio only
git clone <this-repo> && cd caption-engine
npm install                       # installs resvg with a prebuilt darwin-arm64 binary
npm run build
npm run fonts:install             # only if assets/fonts/ is empty
npm run doctor                    # functionally probes everything
```

Homebrew's plain `ffmpeg` is all you need — **librsvg is NOT required**, because captions
are rasterised by resvg, not FFmpeg. FFmpeg needs only H.264 and AAC, which the core
formula includes.

Verify what the app will actually use:

```bash
which -a ffmpeg                          # every ffmpeg on PATH
node dist/src/cli.js doctor              # resolved binary + real functional probes
```

`doctor` prints the resolved real path of the FFmpeg it will run (following symlinks,
honouring `FFMPEG_PATH`), flags when several are on PATH, and rasterises a real Devanagari
caption end to end.

### Ubuntu / Debian

```bash
sudo apt update && sudo apt install -y ffmpeg   # librsvg not required
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
npm install && npm run build && npm run doctor
```

### Fonts

The repo ships Noto fonts for every supported script. If `npm run doctor` reports missing
fonts:

```bash
npm run fonts:install             # downloads static .ttf via @expo-google-fonts
```

Or point at your own:

```bash
export FONT_DIR=/path/to/fonts:/another/path
```

Google Fonts' web CDN serves **woff2, which will not work** — FreeType and opentype.js
need `.ttf` or `.otf`.

### API keys

```bash
export ELEVENLABS_API_KEY="..."   # recommended: word timestamps + Indic code-switching
export DEEPGRAM_API_KEY="..."     # backup; added Telugu + Kannada Jan 2026
export SARVAM_API_KEY="..."       # benchmarking / India data residency only — see below
export ANTHROPIC_API_KEY="..."    # only for --clips
export ASR_PROVIDER=elevenlabs
```

No key is needed for `doctor`, `languages`, `--dry-run`, or `--transcript-in`.

## Usage

### Video → captioned vertical MP4

```bash
node dist/src/cli.js interview.mp4 \
  --language hi \
  --aspect portrait \
  --style bold \
  --output reel.mp4
```

### Audio → subtitles only (no video render)

```bash
node dist/src/cli.js podcast.wav --language en --format srt --output captions.srt
node dist/src/cli.js podcast.m4a --language te --format ass --output captions.ass
```

Audio input with `--format mp4` renders captions over a solid colour, sized to `--aspect`,
with the audio intact — useful for audiograms or for keying over an edit.

### Roman / Hinglish output

```bash
node dist/src/cli.js render input.mp4 --transcript t.json --language hi --script roman -o out.mp4
```

Indic-script words become readable Roman; **English words are left exactly as they
are**. This is mixed Hinglish, not translation and not scholarly transliteration:

| Input | Output |
|---|---|
| `आज meeting बहुत important है` | `Aaj meeting bahut important hai` |
| `मैं आज आपको एक project दिखाता हूँ` | `Main aaj aapko ek project dikhata hoon` |

What it will **not** do:

- translate — `बहुत` → `bahut`, never `very`
- reverse-translate — `meeting` stays `meeting`, never `मीटिंग`
- emit ISO diacritics — `bahut khaas hai`, not `bahuta khāsa hai`

Word count, order, punctuation, numbers and **timestamps** are unchanged: the same
audio, the same word boundaries, only the spelling. The pipeline asserts this rather
than trusting it, and fails if a backend violates it.

**Backends** (`--transliterate`):

| Name | Needs | Covers | Notes |
|---|---|---|---|
| `local` (default) | nothing | Devanagari: hi, mr, ne | Offline, deterministic. Real Hindi schwa deletion, not a character table. |
| `sarvam` | `SARVAM_API_KEY` | 12 Indic languages | Model-based; better on loanwords and unusual spellings. |
| `http` | `TRANSLITERATE_URL` | your endpoint | For self-hosted IndicXlit / Bhashini. |

There is **no no-op provider**. Asking for Roman and silently getting Devanagari back
is worse than an error, so requesting a backend that is not configured fails with
instructions.

#### How Sarvam requests are batched

Sarvam rejects a request whose `input` is longer than 1000 characters:

```
body.input: String should have at most 1000 characters
```

A 2,339-entry transcript joins to about 13,000 characters, so it is split into requests
of at most **900** characters. The rules that matter:

- **A word is never split.** A token too long to share a request is sent alone; one
  longer than the whole budget is romanised offline rather than truncated.
- **Only Indic-script tokens are sent.** English never leaves the machine, so the model
  cannot "correct" its spelling.
- **Every returned piece is mapped back to the index of the word it came from.** Word
  timings hang off those indices, so a batching bug would not crash — it would drift
  captions out of sync. The plan is asserted (complete, ordered, no duplicates) before
  any request goes out.
- **Failures degrade one batch at a time.** A malformed reply or wrong token count is
  retried once, then that batch alone falls back to the offline engine; the rest keep
  model output. `429`/`5xx`/network errors retry with exponential backoff and honour
  `Retry-After`. A `401`/`403` is *not* retried and does *not* fall back — a rejected key
  fails every batch identically, and hiding that behind a silent downgrade helps nobody.
- The run reports what happened: `batching 6 request(s), largest 900 chars`, plus a
  warning naming any batch that fell back.

Tuning, if a proxy imposes tighter limits:

```bash
export SARVAM_BASE_URL=https://...        # alternate endpoint
export SARVAM_MAX_INPUT_CHARS=600         # smaller batches
export SARVAM_CONCURRENCY=1               # serialise requests
export SARVAM_MAX_ATTEMPTS=5              # more retries
```

### The "cheat day" problem, and the glossary

The most common Hinglish failure is **not** in transliteration — it is upstream. ASR
frequently writes English words in Devanagari when the surrounding speech is Hindi:

```
you said:    "Aaj mera cheat day hai"
ASR wrote:   आज मेरा चीट डे है          ← "cheat day" spelled phonetically in Devanagari
naive result: aaj mera cheet de hai      ← rules are correct, input was already lossy
```

No rule can undo this: `चीट` is equally *cheet*, *chit* or *cheat*. Only a mapping knows.
So `assets/hinglish-glossary.txt` maps them back, phrase-first:

```
चीट डे => cheat day      # map Devanagari-written English to real spelling
डाइट => diet
cheat day                # protect a Latin phrase from any backend
```

Glossary phrases are matched longest-first, **locked** so no backend can touch them, and
required to keep the same token count so every word keeps its original timestamp.

```bash
--hinglish-glossary my-terms.txt    # merged over the built-in ~180 entries
--protect-english                   # never let a backend alter Latin tokens (default on)
--diagnostics                       # per-token table: original → final → stage
```

**Better still, prevent it at the ASR:**

```bash
--code-switching            # tell the ASR to expect Hinglish and keep English in Latin
--keyterms "cheat day,diet,workout"
--keyterms-file terms.txt
```

`--diagnostics` shows exactly which stage decided each token, so an ASR error is never
mistaken for a transliteration error:

```
   2  चीट   → cheat   [glossary-map]
   3  डे    → day     [glossary-map]
   6  कल    → kal     [transliterated]
   4  meeting → meeting [already-latin]
```

**Known limitation of `local`:** it is rules, not a model. Anything not in the glossary
transliterates phonetically. `--transliterate sarvam` handles unseen loanwords better.
The vowel-length rules and the glossary were assembled by hand and **have not been
native-speaker reviewed** — see [docs/NATIVE_REVIEW.md](docs/NATIVE_REVIEW.md).
Run `npm run evaluate` for a measured report rather than a claim.

### Captions only, no rendering

```bash
node dist/src/cli.js input.mp4 --format all --output out.mp4   # mp4 + srt + ass + json
node dist/src/cli.js input.mp4 --format json -o data.json      # transcript + cues + trim
```

### Auto Trim with review

Nothing is ever cut silently. The three-step flow:

```bash
# 1. Propose cuts
node dist/src/cli.js talk.mp4 --auto-trim --cuts-out cuts.json --format json -o t.json

# 2. Review cuts.json — set "restored": true on anything you want to KEEP
#    [{ "id": "filler-3", "reason": "filler", "label": "filler: \"matlab\"",
#       "start": 4.2, "end": 4.7, "restored": false }, ...]

# 3. Render with the review applied
node dist/src/cli.js talk.mp4 --auto-trim --cuts-in cuts.json --output trimmed.mp4
```

Or use `--review-cuts`, which proposes cuts, writes the file, and **stops before
rendering**:

```bash
node dist/src/cli.js talk.mp4 --transcript-in t.json --review-cuts --cuts-out cuts.json
```

Cuts are reported by category so you can sanity-check how much is silence versus how many
real words were removed:

```
  5 cut(s) proposed, 0 restored, 5 active
     silence          3 cut(s)  4.6s
     filler           2 cut(s)  0.7s
     TOTAL            5 cut(s)  5.3s  (14.0s → 8.7s)
```

Source words are never deleted — cuts mark `keep: false` and are fully reversible.
Restoring every cut reproduces the original duration exactly. Options:
`--trim-silence <sec>` (default 0.7), `--keep-fillers` (silence only).

### Reuse a transcript across renders (never pay for ASR twice)

ASR is the only part that costs money. Pay once, then use the `render` subcommand, which
**requires** a transcript and **rejects** `--provider` — there is no code path from it to a
paid API, and a second runtime guard rejects the run even if the flag were bypassed:

```bash
# Pay for ASR once
node dist/src/cli.js v.mp4 --transcript-out t.json --format json -o v.json

# Render as many variants as you like — no API calls
node dist/src/cli.js render v.mp4 --transcript t.json --aspect square              -o square.mp4
node dist/src/cli.js render v.mp4 --transcript t.json --aspect landscape --style neon -o wide.mp4
node dist/src/cli.js render v.mp4 --transcript t.json --format srt                 -o captions.srt
```

`--transcript-in` on the normal command does the same thing; `render` just makes the
guarantee explicit and enforceable.

### Long-form → clips

```bash
export ANTHROPIC_API_KEY="..."
node dist/src/cli.js podcast.mp4 --clips --format json -o podcast.json
# writes podcast.clips.json with scored candidates
```

### Styling

```
--style      default | bold | minimal | neon | classic
--aspect     portrait | landscape | square | original
--highlight  active-word | none
--active-scale 1.08      --font-size 72      --position-y 0.72
--max-words 4            --crop-focus 0.5
```

## Supported languages

`node dist/src/cli.js languages` prints the live table.

| Code | Language | Script | Rendering | Fillers | Native-reviewed |
|---|---|---|---|---|---|
| hi | Hindi | Devanagari | verified | yes | **no** |
| mr | Marathi | Devanagari | verified | yes | **no** |
| ne | Nepali | Devanagari | verified | no | **no** |
| te | Telugu | Telugu | verified | yes | **no** |
| kn | Kannada | Kannada | verified | yes | **no** |
| ta | Tamil | Tamil | verified | yes | **no** |
| ml | Malayalam | Malayalam | verified | yes | **no** |
| bn | Bengali | Bengali | verified | yes | **no** |
| as | Assamese | Bengali | verified | no | **no** |
| gu | Gujarati | Gujarati | verified | yes | **no** |
| pa | Punjabi | Gurmukhi | verified | yes | **no** |
| or | Odia | Oriya | verified | no | **no** |
| en | English | Latin | verified | yes | yes |
| ur | Urdu | Arabic | **untested** | no | **no** |

**"verified" means**: glyphs shape correctly with no `.notdef`, conjuncts ligate, pre-base
matras reorder, and a rendered frame contains real ink — all asserted in the test suite,
and cross-checked against an independent HarfBuzz rasteriser.

**"verified" does NOT mean** a native speaker has confirmed the output reads naturally.
See [docs/NATIVE_REVIEW.md](docs/NATIVE_REVIEW.md).

**Urdu is untested and experimental.** Run order is reversed for RTL, but the full
bidirectional algorithm (UAX#9) is not implemented, so mixed Urdu/English lines will be
wrong. Inspect output before relying on it.

## Provider notes

| Provider | Word timestamps | Notes |
|---|---|---|
| ElevenLabs Scribe v2 | **yes** | Recommended. Keeps English in Latin script inside Indic audio. |
| Deepgram Nova-3 | **yes** | Backup. Telugu + Kannada added Jan 2026. |
| Sarvam | **no** | REST returns sentence-level timestamps only. |

Sarvam **cannot back word-timed captions**. Its adapter normalises into the core schema
with `hasWordTimings: false`, marks interpolated timings low-confidence, and
`assertWordTimings()` throws before anything reaches the renderer. Keep it for accuracy
benchmarking and as an India-hosted data-residency option.

Published WER figures (~3.1% for Hindi/Telugu on FLEURS) come from **clean read speech**.
Real creator audio — phone mics, background music, street noise, strong regional accents —
will be materially worse. Measure it on your own clips.

## Development

```bash
npm test                    # 437 tests
npm run evaluate            # measured Hinglish + Auto Trim report
npm run test:render         # real FFmpeg renders + pixel assertions
npm run test:raster         # rasterisation: functional probes, transparency, all scripts
npm run visual              # contact sheet for every language → demo-out/visual/
npm run shaping:probe       # compare our shaping vs libass on this host (needs python3+Pillow)
npm run doctor
```

```
src/
  types.ts            core vendor-neutral transcript schema
  errors.ts           typed errors, each with an actionable hint
  asr/                ElevenLabs, Deepgram, Sarvam adapters
  text/               script detection, font registry, HarfBuzz shaper
  captions/           cue grouping, SVG renderer, ASS/SRT export, styles
  autotrim/           silence + filler + false-start detection, filler lexicons
  clips/              LLM-based highlight scoring
  media/              ffmpeg wrapper, probing, audio extraction
  render/
    rasteriser.ts     SVG→PNG: resvg primary, ffmpeg fallback, functional probes
    pipeline.ts       filter-graph construction and encoding
  cli/                argument parsing, doctor, orchestration
```

## Known limitations

- **Filler lexicons are not native-speaker reviewed** (except English). They will miss
  regional fillers and may flag words that are not fillers. Budget one day per language —
  see [docs/NATIVE_REVIEW.md](docs/NATIVE_REVIEW.md).
- **Romanisation vowel-length rules are hand-tuned and unreviewed.** The engine is real
  (schwa deletion, conjuncts, nukta, anusvara assimilation) and every rule has a
  regression test, but "is this how a Hindi speaker would type it?" needs a native
  speaker. Loanwords written in Devanagari need the lexicon or the Sarvam backend.
- **Sarvam transliteration is batched, and only the transport is verified end to end.**
  Sarvam caps `body.input` at 1000 characters, so tokens are packed into requests of at
  most 900 (see below). The batching, index mapping and failure handling are covered by
  tests and were exercised over real HTTP against a local server that enforces the same
  limit — but the project has no Sarvam key, so **Sarvam's actual model output has never
  been seen**. Quality claims for `--transliterate sarvam` are unverified.
- **Urdu/RTL is experimental** — no full bidi algorithm.
- **Clip scoring is unvalidated for Indian-language content.** The prompt explicitly warns
  against English hook conventions, but the scores are a hypothesis until measured against
  native-speaker judgement.
- **Auto-reframe is a static crop**, not subject tracking. `--crop-focus` sets it manually.
- Rendering time scales with the number of caption frames (one PNG per word state). A
  10-minute video with dense speech produces thousands of overlays. Caption SVGs are
  generated lazily so peak memory stays flat, but disk use during a render is roughly
  50-150 KB per frame in a temp directory (removed on exit, and on Ctrl-C).
- **Urdu/RTL remains experimental** — no full UAX#9 bidi algorithm.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Start with `npm run doctor`.
