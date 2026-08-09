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

### One command for Hinglish reels

```bash
npm run caption:hinglish -- ./my-video.mp4      # macOS / Linux
npm run caption:hinglish -- .\my-video.mp4      # Windows PowerShell
```

Builds, loads `.env`, transcribes with ElevenLabs in code-switching mode, romanises via
Sarvam with English protected, runs Auto Trim, renders portrait with the bold style, and
writes `outputs/my-video-hinglish.mp4`. Paths with spaces work — quote them.
See [Windows and macOS setup](#windows-and-macos-setup).

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

## Windows and macOS setup

The same commands work on both. Nothing here is shell-specific: the workflow is a Node
script that spawns processes with argument arrays, so there is no shell to mis-quote your
filenames.

### Windows (PowerShell) — one-time setup

```powershell
npm install
npm run build
npm run doctor
Copy-Item .env.example .env
notepad .env                 # paste ELEVENLABS_API_KEY and SARVAM_API_KEY
```

Then, for every video:

```powershell
npm run caption:hinglish -- .\my-video.mp4
npm run caption:hinglish -- "C:\Users\me\Videos\My Video (final).mp4"
```

FFmpeg, if you do not already have it:

```powershell
winget install Gyan.FFmpeg   # then reopen the terminal so PATH updates
```

**You do not need to set `FONT_DIR` on Windows.** The Noto fonts in `assets/fonts/` are
found automatically after `npm run build`. If you do set it, separate directories with
`;` — the PATH separator for your platform, which the engine reads from Node rather than
assuming:

```powershell
$env:FONT_DIR = "C:\fonts;D:\more-fonts"
```

### macOS / Linux — one-time setup

```bash
brew install node ffmpeg      # macOS; on Ubuntu: sudo apt install ffmpeg
npm install
npm run build
npm run doctor
cp .env.example .env
$EDITOR .env
```

```bash
npm run caption:hinglish -- ./my-video.mp4
npm run caption:hinglish -- "./My Video (final).mp4"
export FONT_DIR=/path/to/fonts:/another/path      # ":" here, ";" on Windows
```

### What the workflow checks before it spends anything

It fails early, with the reason named, on: a missing input file, a missing `ffmpeg` or
`ffprobe`, a failed build, a missing or blank `ELEVENLABS_API_KEY` or `SARVAM_API_KEY`, and
an output that ffprobe cannot validate. **Error messages name the missing variable and
never print its value.**

### Fonts

The repo ships Noto fonts for every supported script. If `npm run doctor` reports missing
fonts:

```bash
npm run fonts:install             # downloads static .ttf via @expo-google-fonts
```

Google Fonts' web CDN serves **woff2, which will not work** — FreeType and opentype.js
need `.ttf` or `.otf`.

### API keys

Put them in `.env` (copied from `.env.example`), or export them — a real environment
variable always beats the file, so a stale `.env` cannot silently override the key you
just exported.

```bash
ELEVENLABS_API_KEY=...    # recommended: word timestamps + Indic code-switching
SARVAM_API_KEY=...        # Hinglish transliteration; also benchmarking / data residency
DEEPGRAM_API_KEY=...      # backup; added Telugu + Kannada Jan 2026
ANTHROPIC_API_KEY=...     # only for --clips
ASR_PROVIDER=elevenlabs
OUTPUT_DIR=outputs
```

No key is needed for `doctor`, `languages`, `--dry-run`, or `--transcript-in`.

Keys are never written to logs, JSON output, error messages or rendered files. Error text
is passed through a redactor before printing, so a provider that echoes a rejected key
back in its error body cannot leak it into your terminal.

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

### Roman output (Hinglish, Kannglish, Tenglish, Tanglish, Manglish)

```bash
node dist/src/cli.js render input.mp4 --transcript t.json --language hi --script roman -o out.mp4
```

Indic-script words become readable Roman; **English words are left exactly as they
are**. Not translation, and not scholarly transliteration.

**Roman output is `detected source language + Roman script`.** It is not one mode, and it
is not always Hinglish — *Hinglish is the name of this combination for Hindi only*. Kannada
romanised is still Kannada; it just uses Latin letters. The pipeline keeps the detected
language attached to the transcript and to every word, and names it in the run summary, so
"the output is in Latin letters" can never be mistaken for "the output is Hindi".

| Source | Input | Output | Called |
|---|---|---|---|
| `hi` | `आज meeting बहुत important है` | `Aaj meeting bahut important hai` | Hinglish |
| `kn` | `ಇದು ಒಂದು important meeting` | `Idu ondu important meeting` | Kannglish |
| `te` | `ఇది ఒక important meeting` | `Idi oka important meeting` | Tenglish |
| `ta` | `இது ஒரு important project` | `Idhu oru important project` | Tanglish |
| `ml` | `ഇത് ഒരു important project` | `Ithu oru important project` | Manglish |
| `en` | `already in English` | unchanged — a reported no-op | — |

Each language is romanised **with its own rules**: `hi/mr/ne` may use the built-in
Devanagari engine, and `kn/te/ta/ml/bn/gu/pa/or/as` go to a model backend with their own
`source_language_code`. Kannada, Telugu, Tamil and Malayalam are never routed through Hindi
logic — the Devanagari engine explicitly refuses them rather than passing text through
untouched, and the test suite fails if that ever changes.

What it will **not** do:

- translate — `बहुत` → `bahut`, never `very`
- reverse-translate — `meeting` stays `meeting`, never `मीटिंग`
- emit ISO diacritics — `bahut khaas hai`, not `bahuta khāsa hai`

Word count, order, punctuation, numbers, **timestamps** and the **source language** are
unchanged: the same audio, the same word boundaries, only the spelling. The pipeline
asserts this rather than trusting it, and fails if a backend violates it.

Every Roman run prints which language it actually ran as:

```
Detected language:  Kannada (kn)
Output script:      Roman
Transliteration:    Kannada → Roman (Kannglish)
Provider:           sarvam
English protection: enabled
```

#### You do not need to know the language first

```bash
node dist/src/cli.js input.mp4 \
  --language auto \
  --script roman \
  --transliterate sarvam \
  --roman-fallback error
```

`--language auto` (or omitting `--language`) decides from the ASR result:

1. **the provider's own language tag**, normalised — `hin→hi`, `kan→kn`, `tam→ta`,
   `tel→te`, `mal→ml`, `mar→mr`, `ben→bn`, `guj→gu`, `pan→pa`, `ori→or`, `asm→as`,
   `nep→ne`, `eng→en`. That tag is an acoustic judgement and is the only signal that can
   separate Hindi from Marathi.
2. **the dominant script**, as corroboration — and as the answer when the provider said
   nothing, or said something the script contradicts.

**An explicit `--language kn` always wins.** If it disagrees with the script, the run says
so and obeys you anyway.

**Script is not language, and the tool does not pretend otherwise.** Devanagari is written
by hi, mr, ne, sa, kok and mai; Bengali script by bn and as. When only script evidence is
available the alternatives are named and the confidence is capped:

```
Detected language: Hindi (hi)   [asr, confidence 1.00]
  also plausible: mr, ne, sa, kok, mai — same script
```

Low confidence is called out explicitly rather than buried.

#### Provider capability

Checked **before** any request, so an unsupported language fails in a second rather than
after an upload:

| Backend | Languages | Needs |
|---|---|---|
| `local` | hi, mr, ne, sa, kok, mai — Devanagari only | nothing |
| `sarvam` | hi, mr, ne, te, kn, ta, ml, bn, gu, pa, or, as | `SARVAM_API_KEY` |
| `http` | whatever your endpoint covers | `TRANSLITERATE_URL` |
| `native` | **nothing** — performs no transliteration | fallback only |

`--transliterate native` is rejected. Keeping the original script is reachable only via
`--roman-fallback native`, so it is always a decision you made and were told about.

#### When Roman output is not available: `--roman-fallback`

```bash
--roman-fallback error     # default: stop, with instructions
--roman-fallback native    # keep the ORIGINAL script, continue, and report it
--roman-fallback http      # use TRANSLITERATE_URL instead
```

**Never silent.** Asking for Roman and quietly getting Kannada back is worse than an error,
because the render succeeds and looks fine to anyone who cannot read the script. Every run
prints:

```
Detected language: Kannada (kn)
Roman provider:    native
Code-switching:    disabled
English protection: enabled
Transliteration:   1 batch(es)
Fallback:          native  (the "local" transliterator does not cover "kn")
! SOME OUTPUT IS STILL IN THE ORIGINAL SCRIPT despite --script roman.
```

#### Kannada, Telugu, Tamil and the rest: the Sarvam-only languages

**Kannada now has an offline engine.** `src/transliterate/kannada.ts` romanises Kannada
with its own rules — deterministic, no key, no network. It is a separate engine from the
Devanagari one, not a configuration of it: Kannada keeps its inherent vowel where Hindi
deletes it (`ಪುಸ್ತಕ` → `pustaka`, never `pustak`), so the two cannot share rules. That
absence of schwa deletion is also what makes Kannada tractable offline.

So the error above no longer kills a Kannada render: a batch Sarvam cannot align now
degrades to offline Kannada rules. It is rule-based, so it cannot recover English spelling
from English written in Kannada script — add glossary entries for those — and it has not
been through native-speaker review. It is a fallback that keeps a render accurate and
readable, not a replacement for the model backend.

`te ta ml bn gu pa or as` still have **no offline transliterator** — Sarvam is the only
backend. Sarvam occasionally returns a different number of tokens than the words sent in a
batch. That output cannot be aligned to word timings, so it is discarded; the strict check
never bends. Previously there was nothing to fall back to and the whole render died on one
bad batch:

```
Sarvam failed on batch 1 of 1:
Sarvam returned a token count that does not match the 62 words sent in batch 1, twice.
There is no offline transliterator for "kn" to fall back to.
```

**Why it happened.** Sarvam romanises a *string*, not an array, so a batch goes out as one
pipe-delimited request and the reply has to split back into exactly the same number of
pieces. 62 words means 61 delimiters the model has to preserve; the more words per request,
the likelier one gets merged, dropped or invented. Re-sending the identical request — the
old retry — mostly re-rolls the same dice.

**Smaller requests, first.** Batches are now capped at **25 words** as well as 900
characters. The character budget alone optimised the wrong quantity: alignment risk tracks
the *number of delimiters*, not the number of characters, so a character-only budget packed
short-word languages — Kannada, Telugu, Tamil, Malayalam — the most densely, which is
exactly where alignment fails most. Tune with `SARVAM_MAX_WORDS_PER_BATCH`.

**What happens now.** After the one cheap retry, the batch is **bisected** and asked again
in smaller requests, recursively. A single-word request carries no delimiter at all, so its
reply cannot be mis-split: the leaves of that recursion are correct by construction rather
than by luck. In practice a mis-delimited batch now comes back fully romanised for a
handful of extra requests, and only words that fail even *alone* reach the fallback policy
below — so one stubborn word costs one word, not the 61 it was packed with.

Nothing was loosened to achieve this. Mismatched output is still discarded, never padded,
truncated or paired up with timings by guesswork.

```
alignment  batch(es) 1 came back mis-delimited and were split into smaller requests
           — 14 extra request(s), 62 word(s) recovered
```

Bisection is bounded: at most 48 extra requests per batch by default, since the recovery
costs real API calls. Tune or disable it with `SARVAM_MAX_SUBDIVISION_REQUESTS` (`0` turns
it off and restores the old fail-the-batch behaviour).

For the words that still cannot be aligned:

```bash
# stop on a mismatch (default, unchanged behaviour)
node dist/src/cli.js talk.mp4 --script roman --transliterate sarvam --language auto

# keep the failed batch in Kannada, romanise the rest, and name what happened
node dist/src/cli.js talk.mp4 --script roman --transliterate sarvam \
  --language auto --roman-fallback native

# send the failed batch to your own service instead
export TRANSLITERATE_URL=https://your-service/transliterate
node dist/src/cli.js talk.mp4 --script roman --transliterate sarvam \
  --language auto --roman-fallback http
```

Only the affected **words** degrade — the rest of the batch keeps its model-quality
romanisation — and the report names them:

```
! batch 3/7: 2 of 14 word(s) could not be aligned, even one word per request
  — no offline transliterator for "kn", so these 2 word(s) KEEP THEIR NATIVE SCRIPT
```

`--roman-fallback http` now applies to this case too. It previously only influenced which
backend was *chosen*, so when Sarvam was picked and then failed mid-run, the flag the error
message recommended had no effect on the failure it was being recommended for.

#### The order of preference, and why

When romanisation is in trouble the engine always prefers, in this order:

1. **model output that aligns** — the best answer;
2. **offline rules for that language** — Devanagari for `hi/mr/ne/sa/kok/mai`, Kannada for
   `kn`. Lower quality on English loanwords, but correct;
3. **the original script**, via `--roman-fallback native` — accurate, just not Roman;
4. **an error**.

What it will never do is produce Roman captions it cannot stand behind. Mismatched output
is discarded rather than padded, truncated or paired up with timings by guesswork, because
a caption track that drifts out of sync looks fine to whoever renders it and is useless to
whoever watches it. **Accurate native-script captions beat incorrect Roman ones**, and both
beat a silent failure — which is why `--roman-fallback native` prints:

```
! SOME OUTPUT IS STILL IN THE ORIGINAL SCRIPT despite --script roman.
  Batch(es) 3 kept native script.
```

The render continues and the video is produced either way.

Word count, word order and every timestamp are unchanged either way. English Latin tokens
are never sent to the API and come back byte-identical.

#### Code-switched examples

| Input | Output |
|---|---|
| `आज meeting बहुत important है` | `Aaj meeting bahut important hai` |
| `ಇದು ಒಂದು important meeting` | Kannada romanised; `important meeting` untouched |
| `இது ஒரு important project` | Tamil romanised; `important project` untouched |

Numbers, punctuation, names, brands, URLs and hashtags are preserved — anything not in an
Indic script is never sent to a backend.

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
#    [{ "id": "filler-3", "category": "filler", "confidence": 0.62,
#       "sourceWords": ["matlab"], "label": "filler: \"matlab\"",
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
real words were removed, then listed **least confident first** — with forty proposals, the
handful worth arguing with are at the bottom of the confidence range, not the top of the
timeline:

```
  5 cut(s) proposed, 0 restored, 5 active
     silence          3 cut(s)  4.6s
     filler           2 cut(s)  0.7s
     TOTAL            5 cut(s)  5.3s  (14.0s → 8.7s)
  cuts, least confident first:
  filler-3         4.20-4.70   62%  filler        “matlab”
  filler-1         2.10-2.35   95%  filler        “um”
  silence-0        0.00-1.80   99%  silence       (silence)
```

#### Cut confidence

Every cut carries `confidence` (0–1), `category` and `sourceWords` — the actual text it
removes, so you do not have to open the transcript to see what a cut does. Confidence is
**deterministic, not learned**:

| Category | Score |
|---|---|
| silence | scales with gap length past the threshold, capped at 0.99 |
| filler, non-word (`um`, `hmm`) | 0.95 |
| filler, real word cut on pause evidence (`matlab`, `आ`) | 0.55–0.85, rising with pause length |
| false start | 0.3–0.9, rising with run length and seam-gap length |
| low confidence | `1 − word.confidence` |

The real-word tier is capped **below** the non-word tier on purpose: no amount of pause
makes deleting a real word as safe as deleting a grunt. Nothing scores 1.0.

```bash
--min-cut-confidence 0.9    # only propose cuts this confident (default: 0)
```

Default 0 proposes everything and lets review decide — hiding a proposal is worse than
showing one you reject in a click. Raise it for an unattended run. A suppressed cut is
never proposed at all, which is different from `restored`: that keeps something the engine
*did* propose.

Merged overlapping cuts take the **minimum** confidence of their parts, so a certain
silence cut cannot launder a doubtful filler cut into looking safe.

Older `cuts.json` files without these fields still load — a review only needs `id` and
`restored`; everything else is recomputed.

Source words are never deleted — cuts mark `keep: false` and are fully reversible.
Restoring every cut reproduces the original duration exactly. Options:
`--trim-silence <sec>` (default 0.7), `--keep-fillers` (silence only).

#### What Auto Trim will not cut

An audit found real words in the unconditional-cut tier. `हूँ` ("am"), `haan` ("yes"),
`આ` ("this"), `ఆ`/`ಆ`/`ആ` ("that"), `এ` ("this") and `ਆ` ("come") were being removed with
no supporting evidence, so `मैं ठीक हूँ` became `मैं ठीक`. The English list was correct —
`a` was never in it — which is exactly why it survived: the language everyone tests in was
fine.

The rule now: **a token may only be cut on sight if it is not a word.** "um", "hmm" and
"erm" qualify. Everything else is `ambiguous` and needs a real pause beside it. Two
related fixes:

- A **missing neighbour is no longer treated as an infinite pause**, so an ambiguous filler
  at the first or last word is no longer cut automatically. Leading and trailing dead air
  is a recording artefact, not evidence of hesitation.
- A repeated run is only a false start when the speaker **broke at the seam**
  (`falseStartRequiresPause`). "thank you thank you" and `बहुत बहुत धन्यवाद` are emphasis,
  and are kept; "I think that— *pause* —I think that we should" is a retake, and is cut.

#### Smooth cuts

```bash
--cut-handles <sec>   # audio kept either side of a speech cut  (default 0.04)
--cut-fade <sec>      # fade at each join                       (default 0.012)
```

- **Handles** are applied to the cut list *before* captions are timed, so audio and text
  come from the same boundaries. They only ever remove less than proposed, so they cannot
  introduce a mid-word cut.
- **Frame snapping** aligns every boundary to the video frame grid (start up, end down), so
  the video trim, the audio trim and the caption times agree.
- **Fades** are a level shape, not a timing change — `afade`, never `acrossfade`, because
  crossfading would shorten the total and desynchronise every caption. The clip does not
  fade up at its own start or down at its own end.

Measured, not assumed: rendered MP4s show the video stream running ~70 ms longer than the
audio stream. That is present with Auto Trim **disabled** and stays constant from 1 to 8
cuts, so it is an encoder tail rather than cut-induced drift. Cuts do not accumulate A/V
error.

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

#### Replacing a video keeps the same filename — and that used to be dangerous

Re-export a clip from your editor, keep the name, reuse yesterday's `transcript.json`, and
you get captions from the previous take with every timestamp subtly wrong. Nothing warns
you, because the filename matched.

So every transcript and cut list written by this tool carries an `_engine` block recording
the **sha256, byte size and duration** of the media it came from, plus a hash of the
options that shaped it:

```json
"_engine": {
  "kind": "transcript",
  "input": { "sha256": "03ae425c…", "sizeBytes": 98342, "durationSec": 6, "name": "take.mp4" },
  "configHash": "7bf9d58992d626ef"
}
```

Reusing it against different bytes is refused:

```
Error: Refusing to reuse a transcript that does not match this input.
  Reason: content hash differs (cached 03ae425c8ddd…, current 8dc76edb46d4…)
```

The config hash covers only what changes the *transcript* — provider, language,
code-switching, keyterms. Style, aspect and output path deliberately do not invalidate
something you paid for.

- Files written by earlier versions carry no stamp. They still load, with a warning.
- `--allow-stale` overrides the refusal when you know better.
- `CAPTION_ENGINE_FAST_HASH=1` hashes size plus head/middle/tail instead of every byte —
  much faster on very large files, no longer a true content hash.

Cut files are now written as `{ "_engine": …, "cuts": [ … ] }`. The old bare-array form
still loads unchanged.

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

### Fonts

Fonts are **discovered, not hard-coded**. Drop a `.ttf` or `.otf` into
`assets/fonts/` (or any directory in `FONT_DIR`) and it becomes selectable with no code
change. Regular and bold faces of the same family are grouped automatically, so
`--active-bold` uses a **real bold face** — weight is never faked with an SVG stroke.

```bash
node dist/src/cli.js fonts                       # list discovered families
node dist/src/cli.js in.mp4 --font "Noto Sans Kannada"
FONT_DIR=/my/fonts node dist/src/cli.js in.mp4 --font "My Brand Sans"
```

An unknown `--font` is an **error listing every available family** — never a silent
substitution, because a silent substitution is how you ship a caption full of empty boxes.
Glyph fallback is separate and applies only to characters the selected font genuinely
lacks: the shaper detects `.notdef` on a shaped run and retries with a font that covers
the script.

### Active-word highlighting

```bash
node dist/src/cli.js in.mp4 \
  --highlight active-word --active-scale 1.12 --active-color '#FFD400' --active-bold
```

Timing comes from **real ASR word timestamps**, never from dividing a line's duration by
its word count. A word becomes active at its own `start` and stays active until the *next*
word starts, which removes the flicker that appears in ASR gaps without shifting a single
timestamp. Overlapping provider timings are clamped, never re-ordered.

**Lines do not jump.** Every word reserves the widest state it can ever occupy — resting,
toned, bold, and scaled — so the layout of a cue is identical for every frame of that cue,
regardless of which word is currently highlighted. Without that, `--active-bold` would
shove the whole line sideways each time the highlight advanced.

### Local audio prosody (`--prosody` / `--tone-style auto`)

Opt-in styling driven by how a word was **spoken**, measured locally.

```bash
node dist/src/cli.js render in.mp4 --transcript t.json --tone-style auto --diagnostics
node dist/src/cli.js render in.mp4 --transcript t.json --prosody --tone-scope word
node dist/src/cli.js in.mp4 --tone-style none        # explicit off (the default)
```

**One tone per caption line, by default.** Classified per word, tone changes about five
times a second on real speech — measured on a real clip the sequence ran
`excited, neutral, emphatic, neutral, soft, soft, fast…`. Restyling every ~200 ms reads as
twitching, not expression. So the **line carries the mood and the active word carries the
beat**: `--tone-scope cue` (default) gives a line one confidence-weighted majority tone,
and a line whose words disagree keeps the base style entirely. `--tone-scope word` restores
per-word tone if you want maximum responsiveness and can live with the flicker.

**How it works.** FFmpeg decodes the audio to 16 kHz mono PCM; everything after that is
our own TypeScript. Per word we measure loudness (RMS/peak dB relative to the speaker's own
median), speaking rate, pauses, voiced ratio, and **F0 — the fundamental frequency —
using a YIN pitch detector** (`src/media/pitch.ts`): difference function, cumulative mean
normalisation, absolute-threshold pick, and parabolic interpolation for sub-sample
resolution. Pitch is reported relative to the speaker's own median in **semitones**,
because Hz is not perceptually linear and comparing speakers in Hz makes every
low-voiced person look monotone.

A conservative classifier turns those into one of `neutral · calm · excited · emphatic ·
fast · soft`, with a confidence, and `config/caption-theme.json` maps tones to styles.
Results are cached locally per input, so re-rendering does not re-analyse.

**No network, no key, no upload.** FFmpeg is used purely as a decoder.

**Honest limits — read these.**

- This is **not emotion recognition.** "Excited" means *louder and higher-pitched than this
  speaker usually is*. That correlates with excitement, and also with a passing truck, a
  laugh, and a badly placed microphone.
- F0 is undefined for unvoiced sounds (`s`, `f`, `sh`, stops). Words with no usable reading
  show `—` in diagnostics. **Absent is not "low pitch."**
- Music, overlapping speakers and heavy noise produce confident-looking garbage. Every
  frame carries a clarity score and low-clarity frames are discarded rather than trusted.
- Below `minConfidence` a word keeps the base style. The default theme is deliberately
  restrained: if a viewer can tell which rule fired, the rule is too loud.
- Nothing changes without `--prosody`. With the flag absent, output is byte-identical to a
  build without this feature.

### Configuring `config/caption-theme.json`

```json
{
  "version": 1,
  "minConfidence": 0.6,
  "tones": {
    "excited":  { "bold": true, "scale": 1.08, "color": "#FFD166" },
    "emphatic": { "bold": true, "scale": 1.05 },
    "soft":     { "scale": 0.98, "color": "#B8C4D0" },
    "fast":     { "scale": 0.97 },
    "calm":     { "color": "#DCE6F0" },
    "neutral":  {}
  }
}
```

Every field is optional; anything omitted inherits the base caption style. `fontFamily`
must name a discovered family. `scale` is bounded to 0.5–2 and is **validated at load
time**, because tone scale and `--active-scale` multiply and an unbounded value would
overflow the width the layout reserved. Point elsewhere with `--caption-theme <file>`.

The same file also configures the active word and the classifier itself:

```json
{
  "active":     { "color": "#FFD54A", "scale": 1.08 },
  "thresholds": { "excitedPitch": 2, "excitedEnergy": 0.6, "fastRate": 3.2 }
}
```

CLI flags beat `active`. `thresholds` merge over the built-in defaults, so you can retune
one rule without restating the other nine. Units are **semitones relative to the speaker's
own median pitch** and energy in units of the clip's own spread — never absolute Hz or dB,
which mean nothing across different recordings.

> **Fonts you must add yourself.** Tone-driven *font* switching is implemented and works,
> but only fonts present in `assets/fonts/` are selectable, and the repo vendors the Noto
> family only. The shipped theme therefore varies weight, scale and colour. Drop
> `Inter-*.ttf`, `Poppins-*.ttf`, `Anton-Regular.ttf` etc. into `assets/fonts/`, confirm
> with `caption-engine fonts`, then set `"fontFamily"` per tone.

Resolution order is `base style → tone → active-word state`. The active state wins: tone
describes how a word was spoken and is fixed for the cue, while the highlight changes
frame to frame, so the transient signal must stay visible.

### Diagnostics

`--diagnostics` prints the transliteration table and, with `--prosody`, a per-word table of
measurements and the style they resolved to:

```
   idx  word                 start     end   rms dB   F0 Hz   rate  tone      conf  font                 style
     0  ಇದು                   1.25    1.60    -18.2     172   2.80  emphatic  0.72  Noto Sans Kannada    bold 1.05x #FFFFFF [tone]
     1  ಒಂದು                  1.62    1.90    -24.6       —   2.80  neutral   0.51  Noto Sans Kannada    bold 1.00x #FFFFFF
```

Measurements and style decisions only — no paths beyond the font family, no environment,
no credentials. Safe to paste into a bug report.

### Testing without spending anything

None of these contact a paid API:

```bash
npm run build      # tsc
npm test           # full suite; every fetch is stubbed
npm run doctor     # functional probes only — checks key PRESENCE, never calls
npx tsc --noEmit   # typecheck (there is no separate lint script)
```

For end-to-end work use a saved transcript. The `render` subcommand sets an internal
`noAsr` flag, so it **structurally cannot** reach an ASR provider:

```bash
node dist/src/cli.js render in.mp4 --transcript t.json --prosody --diagnostics -o out.mp4
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
npm test                    # 768 tests
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
  config/
    env.ts            .env loading + presence-only secret reporting
    fingerprint.ts    input/config hashing, artifact stamps, stale-reuse refusal
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
  regional fillers and may flag words that are not fillers. The unconditional-cut tier has
  been audited and now contains only non-words, but the `ambiguous` lists still need a
  speaker's eye. Budget one day per language — see
  [docs/NATIVE_REVIEW.md](docs/NATIVE_REVIEW.md).
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
