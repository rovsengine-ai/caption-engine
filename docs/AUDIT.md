# caption-engine — Pre-work Audit

Date: 2026-08-09 · Commit: `a5ff2d2` (single commit, "Initial caption engine project") · Branch `main`, clean tree.

**How this was verified:** the repo was copied to a scratch dir (`/tmp/ce`) inside a Linux sandbox, `npm ci` +
`tsc` + full test suite + `doctor` + `evaluate` were run there. The repo checkout itself was **not modified** and
**no `node_modules` was written into it** — installing Linux-native `@resvg/resvg-js` binaries into your macOS
checkout would have broken your local build.

---

## 0. Headline findings (read these first)

1. **The project is in much better shape than the brief assumes.** Build is clean, 490 tests pass (488 pass, 2 skip,
   0 fail), `doctor` reports 24/25 checks green. Roughly **60% of the "Phase 1" and "Phase 2" requirements are
   already implemented and tested.** Several requirements in the brief describe things that already exist.
2. **The README is more accurate than the brief suspects, not less.** The one factual error found is that it
   *understates* the test count ("437 tests" — actual is 490). Its "Known limitations" section is unusually candid
   and matches the code.
3. **The remaining work is genuinely large.** Phase 4 (visual shot analysis with a provider cascade + caching) and
   Phase 5 (9-template data-driven caption system with per-script font-coverage validation) are each multi-day
   builds from zero. Phases 1–7 together are realistically **4–8 weeks of focused engineering**, not one session.
4. **Several Phase 7 acceptance items cannot be executed by me at all.** No ASR/LLM API keys are available, the
   repo contains **no test media** (`*.mp4`/`*.wav` are gitignored), and Windows behaviour cannot be run on this
   machine. I can build the code and unit-test it; I cannot prove "test a Hindi video" or "open in QuickTime".
5. **`node_modules/` and `dist/` do not exist in the checkout** — the project has never been installed/built here,
   or was cleaned. Nothing is broken; it just means nothing local has been run recently.
6. **Repo hygiene is poor and it is committed.** 20 debug scratch files (`dbg.mjs` … `dbg13.mjs`, `tl.mjs`,
   `memcheck.mjs`, `resvgtest.mjs`, `scratch/*.mjs`), stale outputs (`transcript.json`, `cuts.json`,
   `captions.srt`, `current-data.json`, `verify-sarvam.*`), and a `.gitignore.save` leftover are all tracked in git.

---

## 1. Verified working (with the test that proves it)

| Capability | Evidence |
|---|---|
| TypeScript build | `tsc -p tsconfig.json` → exit 0, no errors |
| Test suite | `node --test dist/test/*.test.js` → **490 tests, 488 pass, 0 fail, 2 skip** |
| Doctor / functional probes | `doctor` → 24/25 pass; real SVG rasterisation, real Devanagari caption render, encoder probes |
| Word-level ASR adapters | `test/asr.test.ts` (196 ln) — ElevenLabs + Deepgram normalise to one schema |
| Sarvam correctly *rejected* for word timings | `assertWordTimings()` throws; `hasWordTimings:false` |
| Audio extraction from video | `src/media/extract.ts`, exercised in `test/pipeline.test.ts` |
| 13 languages, verified rendering | `test/languages.test.ts`, `test/shaper.test.ts`, `test/rasteriser.test.ts` |
| HarfBuzz shaping + opentype outlines + resvg raster | `test/shaper.test.ts` (205 ln), `test/rasteriser.test.ts` (386 ln), `test/nukta.test.ts` |
| Vendored fonts, 12 families | `assets/fonts/` — 24 `.ttf`, all resolve in `doctor` |
| Native + Roman/Hinglish output | `test/hinglish.test.ts` (330 ln), `test/transliterate.test.ts` (414 ln) |
| English-word protection | `--protect-english` default on; `evaluate` → **13/13 English phrases preserved** |
| Glossary, phrase-first, token-count-safe | `src/transliterate/glossary.ts`; asserted in tests |
| Sarvam batching under 1000-char cap | `test/sarvam-batching.test.ts` (**786 ln** — the most thorough file in the repo), exercised over real HTTP against `tools/fake-sarvam-server.mjs` |
| Diagnostics table (original → final → stage) | `--diagnostics`; sample in README lines 333-338 |
| Key terms / code-switching hints to ASR | `--keyterms`, `--keyterms-file`, `--code-switching` |
| MP4 / SRT / ASS / JSON export | `src/captions/ass.ts`, `test/captions.test.ts` |
| Portrait / landscape / square / original | `OUTPUT_PRESETS` in `src/captions/style.ts` |
| Auto Trim propose → review → restore | `src/autotrim/index.ts`, `test/autotrim.test.ts`; restoring all cuts reproduces original duration exactly |
| Transcript reuse, structurally cannot call ASR | `render` subcommand rejects `--provider`; test asserts *no ASR host is contacted* and *the transcript path in run.ts contains no ASR call* |
| Long-video chunking (≤80 overlays / ≤45 s) | `src/render/chunker.ts`, `test/chunked-render.test.ts` (381 ln) |
| Atomic output + ffprobe validation | `src/render/validate.ts` — size, container, duration, streams, codec, `yuv420p`; temp-then-rename |
| Evaluation harness (small, honest) | `npm run evaluate` → 6/6 exact, 13/13 English preserved, 7/7 timestamps identical, 0 Auto-Trim false positives |

**Nothing in this table should be rewritten.** It is the stable core.

---

## 2. Gaps, by phase

Legend: ✅ done · 🟡 partial · ❌ missing

### Phase 1 — Caption accuracy
| Req | State | Notes |
|---|---|---|
| 1. Preserve original/normalized/displayed token + confidence + times | 🟡 | Diagnostics *display* the chain but it is not persisted as structured fields on the word record |
| 2–3. Preserve Latin English, never transliterate it | ✅ | Default on, measured 13/13 |
| 4. Hindi/Hinglish for ASR-phonetic Devanagari | 🟡 | Glossary handles known cases; unknown loanwords still phonetic (documented honestly) |
| 5. Glossary phrase-first, token-count-safe | ✅ | |
| 6. User-editable glossary files | ✅ | `--hinglish-glossary`, `HINGLISH_GLOSSARY` |
| 7. Diagnostics original → normalized → displayed → reason | 🟡 | Missing the *normalized* column and machine-readable output |
| 8. Optional user vocabulary | ✅ | `--keyterms` / `--keyterms-file` |
| 9. Confidence warnings for names/brands/uncertain | ❌ | Confidence exists on words; no warning surface |
| 10. No accuracy claims + measurable eval | 🟡 | `evaluate` exists but measures **no WER/CER, no proper-name accuracy, no timestamp error, no readability, no filler P/R**, and runs on 7 hand-written cases with no audio fixture |

### Phase 2 — Professional Auto Trim
| Detector | State |
|---|---|
| Silence / dead air | ✅ |
| Fillers (um/uh/er/…) | ✅ `src/autotrim/fillers.ts`, 182 ln, per-language lexicons |
| False starts | ✅ |
| Repeated takes | ✅ (short repeated run detection) |
| **Repeated single words** | ❌ |
| **Repeated phrases (non-adjacent)** | ❌ |
| Long pauses (distinct from silence) | 🟡 folded into silence |
| Duplicate visual shots | ❌ (needs Phase 4) |
| Cut record has `id, start, end, reason, label, wordIndices, restored` | ✅ |
| **Cut record has `category`, `confidence`, `sourceWords`** | ❌ — `reason` ≈ category, but no confidence and no source-word text |
| Never cut mid-word | ✅ cuts are word-index aligned |
| Restorable / dry-run / review mode | ✅ `--review-cuts`, `--cuts-out`, `--cuts-in` |
| Before/after duration stats | ✅ printed per category |
| "don't blindly remove the word *a*" | ✅ handled — `fillers.ts` header documents this trap explicitly |
| Grammatical-breakage reporting | ❌ |

### Phase 3 — Smooth cuts
| Req | State |
|---|---|
| Snap to word/silence boundaries | ✅ |
| Configurable audio handles | ❌ |
| Short audio crossfades | ❌ — cuts are hard `atrim`/`concat`, no `afade` anywhere |
| Ambience preservation | ❌ |
| Click / level-jump avoidance | ❌ |
| J-cuts / L-cuts | ❌ |
| A/V sync maintained | ✅ audio never chunked or re-encoded |
| ffprobe validation of duration/streams/codec/container | ✅ |
| No zero-byte / corrupt output | ✅ atomic temp-then-rename |
| Tests: short/long/audio-only/portrait/adjacent cuts | 🟡 short, long, chunked covered; **adjacent-cuts and audio-only-render cases not explicitly tested** |

### Phase 4 — Visual shot analysis
**Effectively 0% built.** `src/clips/` is *transcript*-only LLM highlight scoring against Anthropic
(`claude-sonnet-4-5`, hardcoded in `src/clips/llm.ts`). It has a reusable shape — `LlmComplete` injection,
`chunkTranscript`, `parseClipResponse`, `dedupeCandidates`, deterministic `score` — which is a decent scaffold,
but there is **no scene detection, no frame extraction, no motion/blur/brightness/audio-energy signals, no
perceptual hashing, no Gemini or Kimi provider, no JSON schema validation, no cost cap, and no cache.**
None of `GEMINI_API_KEY`, `KIMI_API_KEY`, `ANALYSIS_PROVIDER`, `ANALYSIS_MAX_COST`, `ANALYSIS_MAX_FRAMES`,
`ANALYSIS_CACHE_DIR` are referenced anywhere in `src/`.

### Phase 5 — Templates and fonts
5 presets exist (`default, bold, minimal, neon, classic`) as `Partial<CaptionStyle>` patches in
`src/captions/style.ts` — **not** a data-driven template system. Missing: `boxed`, `karaoke`,
`creator-highlight`, `subtitle-safe`, `bold social`; portrait/landscape variants; explicit script fallback chain
per template; `templates` CLI command; font-coverage validation command. Per-script glyph coverage *is* already
tested (`test/rasteriser.test.ts`, `test/languages.test.ts`) — that part can be reused rather than rebuilt.

### Phase 6 — CLI and product quality
Existing subcommands: `doctor`, `languages`, `render`, plus the default run.
Missing: `templates`, `analyze`, `review-cuts` (exists only as a **flag**, not a subcommand), `review-shots`,
`evaluate` (exists only as an npm script).
**No caching / input-hash system exists at all** — `createHash` appears nowhere in `src/`. The input-replacement
rule in the brief is currently unenforced: replacing a video while keeping the filename and passing the old
`--transcript-in` will silently reuse the stale transcript.

### Phase 6A — Windows + one-command Hinglish
| Req | State |
|---|---|
| **`FONT_DIR` split** | ❌ **Confirmed bug.** `src/text/fonts.ts:55` does `process.env.FONT_DIR.split(':')` — on Windows this shreds `C:\fonts` into `["C", "\fonts"]`. Must be `path.delimiter`. |
| Basename extraction | ❌ `src/text/fonts.ts:99` does `p.split('/').pop()` — breaks on `\` paths |
| Bundled-font auto-detect after build | ✅ already works (`resolve(__dirname, ...)` walk) |
| Windows tests | ❌ none |
| `npm run caption:hinglish` | ❌ does not exist |
| `.env` loading | ❌ **the code never loads `.env`** — `errors.ts` tells users to "set it in your `.env` file", but nothing reads one. Only real shell env vars work today. |
| `.env.example` per spec | 🟡 exists, but lacks `OUTPUT_DIR`, and lists `DEEPGRAM_API_KEY`/`ANTHROPIC_API_KEY` not in the spec (keep them — removing would be a regression) |
| `.env` gitignored | ✅ |
| Keys never logged | 🟡 believed true; **no test asserts it** |
| Safe env-validation function (existence only) | ❌ |

### Phase 7 — Testing and acceptance
Items 1–3 pass today (build, tests, doctor). Items **4–14 require media files and API keys that do not exist in
this repo or this environment**, and item 13 (QuickTime) requires macOS. These cannot be honestly signed off by me.

---

## 3. Risks and tradeoffs to decide before coding

1. **Phase 4 cost.** Even with Gemini 2.5 Flash-Lite, frame analysis on long videos is the only part of this
   product with unbounded spend. The brief's `ANALYSIS_MAX_COST` is the right instinct; I'd add a hard default
   (e.g. $0.10) and a mandatory dry-run that prints the estimate before any call.
2. **Phase 3 crossfades vs. the "timestamps never change" invariant.** Audio handles and crossfades move audio
   relative to word timings. Done carelessly this desynchronises captions — the one thing this codebase is
   currently rigorous about. Safest implementation: apply handles/fades **only inside cut regions**, never
   extending a cut past a word boundary, and re-assert the existing timing invariant in tests.
3. **Phase 5 refactor risk.** `resolveStyle` is used by the renderer, ASS export and CLI. A data-driven template
   system should be **additive** (templates compile down to the existing `CaptionStyle`) rather than a rewrite,
   so the 490 passing tests keep meaning something.
4. **Single-commit history.** There is no incremental history to bisect against. First action of any work should
   be a checkpoint commit so changes are reviewable.
5. **No test media.** Phases 3, 4 and 7 need fixtures. I can synthesise deterministic ones with FFmpeg
   (`testsrc`/`sine`, plus a few generated speech-like clips) — but synthetic audio cannot exercise real ASR
   quality. Real Hindi/Hinglish clips have to come from you.

---

## 4. Work completed after this audit (Phase 6A + hygiene)

### Changed
- `src/text/fonts.ts` — `FONT_DIR` now splits on `path.delimiter`; basenames split on both
  separators; Windows font stores (`LOCALAPPDATA`, `SystemRoot`, `USERPROFILE`) scanned;
  vendored-vs-system detection is separator- and case-tolerant.
- `src/cli.ts` — loads `.env` at startup; all error output passes through a secret redactor.
- `src/cli/run.ts` — fingerprints the input, stamps transcripts and cut lists, refuses stale reuse.
- `src/cli/args.ts` — new `--allow-stale`.
- `.env.example`, `.gitignore`, `README.md`, `package.json`.

### Added
- `src/config/env.ts` — zero-dep `.env` parser/loader (real env always wins), presence-only
  secret reporting, `requireEnv`, `redactSecrets`.
- `src/config/fingerprint.ts` — sha256 input fingerprints, stable config hashing, artifact
  stamps, verification with distinct verdicts.
- `scripts/caption-hinglish.mjs` + `npm run caption:hinglish`.
- `test/windows-paths.test.ts`, `test/env.test.ts`, `test/fingerprint.test.ts` — **+68 tests**.

### Verified
490 → **558 tests, 556 pass, 0 fail, 2 skip**. `tsc` clean. `doctor` 24/25 (25/25 with a key set).
Round-tripped a synthetic clip through render, Auto Trim review, all four output formats and
audio-only input; every MP4 ffprobes as h264/yuv420p/aac with a correct duration.

## 5. Production-readiness audit (second pass) and fixes

A follow-up audit of the work above found three defects, all reproduced before being fixed.

### Defect 1 — Auto Trim removed real words (severity: high)

Real words sat in the `always` tier, cut with no pause, duration or confidence evidence:

| Language | Token | Meaning | Before |
|---|---|---|---|
| hi | `हूँ` | "am" | `मैं बिल्कुल ठीक हूँ` → `मैं बिल्कुल ठीक` |
| hi | `haan` | "yes" | `haan bilkul sahi hai` → `bilkul sahi hai` |
| gu | `આ` | "this" | `આ ઘર બહુ સરસ છે` → `ઘર બહુ સરસ છે` |
| te/kn/ml | `ఆ` `ಆ` `ആ` | "that" | demonstrative removed |
| bn | `এ` | "this" | pronoun removed |
| pa | `ਆ` | "come" | verb removed |

English was unaffected — `a` was never in the list — which is why this survived.
**Fix:** every real word demoted to `ambiguous`; the `always` tier now documents the rule
that it may contain only non-words, enforced by a test.

### Defect 2 — edge-of-transcript fillers cut unconditionally

A missing neighbour produced `gapBefore/gapAfter = Infinity`, trivially satisfying the
near-pause guard, so any ambiguous filler at the first or last word was always cut.
**Fix:** a missing neighbour scores zero. Clip-boundary dead air is a recording artefact,
not evidence of hesitation.

### Defect 3 — intentional repetition treated as a retake

Any exactly-repeated 2–5 word run was cut. **Fix:** `falseStartRequiresPause` (default on)
requires a real break at the seam. Verified both ways: a 0.5 s break is cut, fluent
`thank you thank you` and `बहुत बहुत धन्यवाद` are kept.

### Smooth cuts added

`--cut-handles` (default 40 ms), `--cut-fade` (default 12 ms), and frame snapping. Handles
and snapping run on the cut list before captions are timed, so audio, video and text share
one set of boundaries; both only ever remove *less* than proposed. Fades use `afade`, never
`acrossfade`, so no duration changes.

### A/V sync — measured, not assumed

| Cuts | Video | Audio | Delta |
|---|---|---|---|
| 0 (no Auto Trim) | 6.000 s | 5.930 s | 0.070 s |
| 1 | 1.600 s | 1.536 s | 0.064 s |
| 4 | 4.267 s | 4.202 s | 0.065 s |
| 8 | 7.800 s | 7.722 s | 0.078 s |

The delta is present with cutting disabled and does not scale with cut count — an encoder
tail, not drift. **Cuts do not accumulate A/V error.**

### Also fixed
- `.gitignore`: `frames/`, `.cache/`, `*.clips.json`, `*.analysis.json`, loose images.
- `src/clips/llm.ts` no longer interpolates a raw provider body into an error; only the
  structured `error.message` is used, with token-shaped strings stripped.

### Still open after this pass
No visual duplicate-shot detection. No runtime schema validator on model output (parsing is
defensive but a malformed response silently yields `[]`). Clip scoring still swallows a
failed chunk. Cuts still lack `confidence` and `sourceWords`. No WER/CER harness. Windows
still unrun on Windows.

**Tests: 605 (603 pass, 2 skip, 0 fail).**

### Still untracked from the earlier commit
The 20 debug/scratch files are now in `.gitignore`, but `.gitignore` does not affect files
already tracked. To untrack them without deleting anything:

```bash
git rm -r --cached -q dbg*.mjs tl.mjs memcheck.mjs resvgtest.mjs scratch \
  transcript.json cuts.json captions.srt current-data.json verify-sarvam.json \
  verify-sarvam.srt .gitignore.save
```
