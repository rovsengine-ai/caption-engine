# Implementation plan — remaining work

Written after the foundation pass (605 tests, 603 pass). **The project is not production-ready.**
It is a solid core with real gaps; this plan closes them in the order you set.

Ground rules for every step below: no paid API call without asking first; nothing deleted;
existing tests stay green; each step is a separate reviewable change.

---

## Sequencing risk — read before starting

Two ordering problems in the list as given:

1. **Step 6 (cost limits) must land with or before step 5 (Gemini).** As written, step 5
   ships a provider that can call a paid API with no cap, and step 6 adds the cap
   afterwards. The window between them is exactly when an accidental full-video run costs
   real money. **Recommendation: fold the cost cap and dry-run estimator into step 5, and
   leave step 6 as caching only.**
2. **Step 3 (schema validation) is the safety net for step 5's output.** It is already
   ahead of it in your order, which is right — keep it there.

Everything else is correctly ordered: 1 → 2 gives measurement before behaviour change,
7 is independent, 8 depends on nothing but takes calendar time and should start early in
parallel.

---

## Step 1 — `confidence` and `sourceWords` on cut records

**Why:** a reviewer cannot triage 40 proposed cuts without knowing which ones the engine is
unsure about, and `wordIndices` alone means opening the transcript to see what a cut removes.

**Files**

| File | Change |
|---|---|
| `src/types.ts` | `Cut` gains `confidence: number`, `sourceWords: string[]`, `category` alias for `reason` |
| `src/autotrim/index.ts` | populate both in all four detectors; carry them through `mergeOverlapping`, `applyHandles`, `snapCutsToFrames` |
| `src/cli/run.ts` | show confidence in the cut listing; sort the review list by ascending confidence |
| `src/cli/args.ts` | `--min-cut-confidence <0..1>` to suppress low-confidence proposals |
| `README.md` | document the new fields |

**Confidence model** — deterministic, not learned:

- silence: `min(1, gapLength / (2 × maxSilenceSec))` — a 3 s gap is certain, a 0.75 s gap is not
- filler, `always` tier: `0.95`
- filler, `ambiguous` tier: scaled by how much pause corroborates it
- false start: scaled by seam-gap length
- low confidence: `1 − word.confidence`

**Tests** (`test/autotrim-safety.test.ts`, extended)

- every cut from every detector carries `confidence` in `[0,1]` and non-empty `sourceWords`
- `sourceWords` matches the text at `wordIndices`, in order
- merged cuts take the **minimum** confidence of their parts and the union of their words
- handles and frame snapping preserve both fields
- `--min-cut-confidence 0.9` drops the ambiguous ones and keeps the `always` fillers
- a `cuts.json` from the previous version still loads (no `confidence` present)

**Acceptance**

- [ ] `npm test` green; no existing test modified except to add assertions
- [ ] `--cuts-out` JSON contains `confidence` and `sourceWords` on every cut
- [ ] old bare-array **and** old stamped cut files still load, with a warning, not an error
- [ ] cut listing prints confidence and the removed words
- [ ] restoring every cut still reproduces the original duration exactly

---

## Step 2 — real WER/CER and timestamp evaluation

**The honest constraint:** WER against ground truth needs human reference transcripts, and
timestamp error needs human-aligned word boundaries. I cannot manufacture either. What I
*can* build is a harness that measures everything not requiring ground truth, and accepts
ground truth when you supply it.

Split into two tiers:

**Tier A — no ground truth needed, runs in CI, no API cost.** Fixtures are committed ASR
output JSON (text only, no audio, no keys). Measures what *our pipeline* does to a
transcript:

- timestamp drift introduced by transliteration (must be exactly zero — already asserted,
  now quantified)
- timestamp drift introduced by Auto Trim + handles + snapping vs. the analytical expectation
- caption-line readability: chars/line, words/cue, lines/cue against the style budget
- filler detection precision/recall against a hand-labelled fixture
- English-preservation rate, proper-name preservation rate

**Tier B — needs ground truth you provide.** A `test/fixtures/eval/` directory of
`{name}.asr.json` + `{name}.reference.txt` pairs. WER/CER computed with standard
Levenshtein at word and character level, plus per-category breakdown (names, numbers,
brands, English-in-Indic). Tests **skip when absent** so CI stays green.

**Files**

| File | Change |
|---|---|
| `src/eval/wer.ts` | new — Levenshtein WER/CER, alignment, per-category slicing |
| `src/eval/readability.ts` | new — line/cue metrics against a style |
| `src/eval/timestamps.ts` | new — drift measurement across pipeline stages |
| `tools/evaluate.ts` | rewrite to report both tiers; keep the current output as one section |
| `test/fixtures/eval/` | new — Tier A fixtures (committed), Tier B slot (gitignored) |
| `docs/EVALUATION.md` | new — how to add a ground-truth pair |

**Tests** — `test/eval.test.ts`

- WER on known pairs: identical → 0; one substitution in ten words → 0.1; insertions and
  deletions counted correctly; empty reference handled
- CER on Devanagari counts codepoints, not UTF-16 units (a matra must not count double)
- category slicing picks out names/numbers correctly
- readability flags a cue that exceeds `maxCharsPerLine`
- timestamp drift is exactly 0 through transliteration
- filler P/R computed correctly against a labelled fixture
- Tier B tests skip cleanly with a clear message when fixtures are absent

**Acceptance**

- [ ] `npm run evaluate` prints WER/CER, timestamp drift, readability, filler P/R
- [ ] every number has a stated basis; nothing is labelled "accuracy" without a reference
- [ ] Tier A runs with no API key and no audio
- [ ] adding one Tier B pair changes the report without any code change
- [ ] report states sample size next to every metric

---

## Step 3 — runtime schema validation for all model/provider responses

**Files**

| File | Change |
|---|---|
| `src/schema/validate.ts` | new — tiny structural validator (no new dependency) |
| `src/clips/score.ts` | `parseClipResponse` validates before coercing; retries once on failure |
| `src/asr/elevenlabs.ts`, `deepgram.ts`, `sarvam.ts` | validate the provider payload shape |
| `src/transliterate/providers.ts` | validate the Sarvam response shape |

**Dependency decision:** hand-rolled validator rather than `zod`. The repo has three runtime
dependencies and vendors its fonts on purpose; adding a validation framework for four
schemas is not worth it. The validator is ~120 lines, returns `{ok, value}` or
`{ok:false, path, expected, got}`, and produces the error message directly.
*Tradeoff:* less expressive than `zod`, and I have to maintain it. Say the word if you'd
rather take the dependency.

**Behaviour on invalid output:** retry once with a stricter prompt suffix, then fail with a
named error — never silently return `[]`. The current `catch { continue }` in `findClips`
is replaced with per-chunk error collection surfaced in the result.

**Tests** — `test/schema.test.ts`, `test/clips.test.ts`

- valid payload passes; each required field missing fails with that field named
- wrong type, out-of-range score, extra unknown fields, `null`, empty array
- prose-wrapped and code-fenced JSON still extracts
- truncated JSON fails cleanly rather than throwing
- a malformed response retries exactly once, then errors
- a chunk failure is reported, not swallowed; partial results state how many chunks failed
- ASR adapters reject a payload missing `words`

**Acceptance**

- [ ] no model or provider response reaches business logic unvalidated
- [ ] no code path returns an empty result set that is indistinguishable from failure
- [ ] every validation error names the field and the expected type
- [ ] zero new runtime dependencies (unless you choose otherwise)

---

## Step 4 — visual shot analysis, local only

**No API calls in this step.** Purely local, so it is fully testable and free.

**Files**

| File | Change |
|---|---|
| `src/shots/detect.ts` | new — scene boundaries via FFmpeg `select='gt(scene,threshold)'` + `showinfo` |
| `src/shots/frames.ts` | new — representative frame extraction per shot |
| `src/shots/signals.ts` | new — duration, motion, blur (Laplacian variance), brightness, audio energy (`ebur128`), perceptual hash |
| `src/shots/score.ts` | new — deterministic weighted ranking, near-duplicate grouping by pHash Hamming distance |
| `src/shots/report.ts` | new — reviewable shot report, same restore/review model as cuts |
| `src/cli/args.ts`, `src/cli.ts` | `analyze` and `review-shots` subcommands |

**Why FFmpeg rather than OpenCV/PySceneDetect:** FFmpeg is already a hard dependency and
already probed by `doctor`. Adding Python or a native CV binding would break the
"no compiler, no system libraries" property the renderer works hard to keep.

**Tests** — `test/shots.test.ts`, using FFmpeg-generated fixtures (`testsrc`, colour bars,
a synthesised hard cut, a synthesised slow dissolve)

- a hard cut is detected at the right timestamp ±1 frame
- a static clip yields exactly one shot
- an identical shot repeated twice is grouped as a duplicate; a visually different one is not
- pHash is stable across re-encode and rejects a genuinely different frame
- blur/brightness/motion signals move in the expected direction on synthesised inputs
- shots align to frame boundaries and never overlap
- report round-trips: mark `keep:false`, reload, selection preserved

**Acceptance**

- [ ] `caption-engine analyze video.mp4` produces a shot report with **zero API calls**
- [ ] `review-shots` prints the report and stops before editing anything
- [ ] duplicate detection is visual (pHash), not transcript text
- [ ] runs on a 10-minute video within a stated time budget, memory flat
- [ ] no frames left on disk after a run unless `--keep-frames`

---

## Step 5 — Gemini provider (+ Kimi optional), with cost control folded in

**This is the first step that spends money. I will not run a paid call without asking.**

**Files**

| File | Change |
|---|---|
| `src/analysis/provider.ts` | new — `AnalysisProvider` interface: `local`, `gemini`, `kimi` |
| `src/analysis/gemini.ts` | new — Gemini 2.5 Flash-Lite default, 2.5 Flash quality fallback |
| `src/analysis/kimi.ts` | new — experimental, never selected by default |
| `src/analysis/cost.ts` | new — pre-flight estimate, hard cap, refusal before the first call |
| `src/config/env.ts` | add the six `ANALYSIS_*` / provider keys to the secret list |
| `.env.example`, `README.md` | document every new variable |

Env: `GEMINI_API_KEY`, `GEMINI_ANALYSIS_MODEL`, `KIMI_API_KEY`, `KIMI_ANALYSIS_MODEL`,
`ANALYSIS_PROVIDER`, `ANALYSIS_MAX_COST` (default **$0.10**), `ANALYSIS_MAX_FRAMES`
(default **60**), `ANALYSIS_CACHE_DIR`.

**Cost safety, non-negotiable:**

- `analyze` prints frame count, token estimate and dollar estimate, then **requires
  `--yes`** or an interactive confirmation before any request
- exceeding `ANALYSIS_MAX_COST` aborts before the first call, naming the limit
- the running total is checked between calls; a mid-run overrun stops and returns partials
- `--dry-run` produces the full estimate and makes no request

**Tests** — `test/analysis.test.ts`, all against a **fake HTTP server**, as
`sarvam-batching.test.ts` already does for Sarvam

- provider selected from env, overridden by flag, never hardcoded
- an unconfigured provider fails with instructions rather than silently using local
- cost estimate matches a fixed frame/token input
- a run projected over the cap aborts with zero requests made
- a mid-run overrun stops and returns partial results marked as partial
- responses are schema-validated (step 3); invalid → one retry → named failure
- `401/403` does not retry and does not fall back; `429/5xx` retries with backoff
- Kimi is never chosen unless explicitly requested

**Acceptance**

- [ ] every test passes with **zero real API calls**
- [ ] a real end-to-end call happens only after you approve it, on one short clip, with the
      cost printed before and the actual spend reported after
- [ ] no provider name, model name or endpoint hardcoded outside its own module

---

## Step 6 — analysis caching

**Files:** `src/analysis/cache.ts` (new), `src/config/fingerprint.ts` (extend).

Key = input sha256 + frame hash + prompt version + model name + analysis config hash.
Reuses the existing `ArtifactStamp` machinery, so the input-replacement rule already proven
for transcripts and cuts applies unchanged.

**Tests** — `test/analysis-cache.test.ts`

- identical input + config → cache hit, zero requests
- changed video, same filename → miss (the rule that already works for transcripts)
- changed prompt version, model, or frame selection → miss
- corrupt or truncated cache entry → miss, not a crash
- `ANALYSIS_CACHE_DIR` respected; a read-only cache dir degrades to no-cache with a warning
- cache never stores an API key

**Acceptance**

- [ ] second identical `analyze` run makes zero requests and says so
- [ ] cache entries are inspectable JSON containing no secrets
- [ ] cache misses are explained, not silent

---

## Step 7 — data-driven caption templates

**Approach: additive.** Templates compile down to the existing `CaptionStyle`, so the
deterministic renderer and its ~100 rendering tests keep their meaning. This is a new layer,
not a rewrite of `resolveStyle`.

**Files**

| File | Change |
|---|---|
| `src/captions/template.ts` | new — `CaptionTemplate` type, loader, validator, compile-to-`CaptionStyle` |
| `src/captions/templates/*.json` | new — nine templates as data |
| `src/captions/style.ts` | `resolveStyle` delegates to the template layer; the five current preset names remain valid aliases |
| `src/types.ts` | `CaptionStyle` gains shadow, background box, animation, safe margins, max lines, fallback chain |
| `src/cli/args.ts`, `src/cli.ts` | `templates` subcommand: list, show, validate font coverage |

Templates: `clean`, `bold-social`, `karaoke`, `minimal`, `neon`, `classic`, `boxed`,
`creator-highlight`, `subtitle-safe`. Each with portrait and landscape variants and an
explicit per-script font fallback chain.

**Tests** — `test/templates.test.ts`, extending the existing rasteriser suite

- every template validates against the schema and compiles to a complete `CaptionStyle`
- the five legacy `--style` names still resolve to visually identical output (byte-compare
  the rendered PNG against the current renderer — this is the backwards-compatibility gate)
- every template × every supported script renders with **no `.notdef`**, for Devanagari,
  Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Gurmukhi, Odia, Arabic, Latin,
  punctuation, emoji, and mixed Latin/Indic
- a template naming a font lacking required glyphs **fails loudly**, never silently falls back
- safe margins respected at portrait, landscape and square
- `templates --validate-fonts` exits non-zero when coverage is missing

**Acceptance**

- [ ] nine templates, all rendering all scripts with no tofu
- [ ] existing `--style` output byte-identical (the regression gate)
- [ ] `caption-engine templates` lists them; `--validate-fonts` proves coverage
- [ ] no font is ever used that lacks the required glyphs

---

## Step 8 — native-speaker review workflow, Hindi and Hinglish first

**This is the one step I cannot complete.** I can build the workflow, generate the review
material and wire the results in; a Hindi speaker has to do the judging. Start it in
parallel with step 1 — it is calendar time, not engineering time.

**Files**

| File | Change |
|---|---|
| `tools/review-pack.ts` | new — generates a review pack from a transcript |
| `docs/NATIVE_REVIEW.md` | extend with the Hindi/Hinglish protocol and how to submit results |
| `test/fixtures/review/hi.reviewed.json` | new — the returned verdicts, committed |
| `src/autotrim/fillers.ts`, `src/transliterate/devanagari.ts` | apply the verdicts |
| `src/config/languages.ts` | flip `nativeReviewed: true` only when the file exists |

**The review pack** is a single self-contained HTML file the reviewer opens locally:
every filler candidate in context with keep/cut buttons, every romanisation side by side
with the Devanagari, and a free-text "how would you actually type this" box. Output is one
JSON file mailed back. No account, no server, no tooling on their side.

**Tests** — `test/review.test.ts`

- the pack contains every `always` and `ambiguous` token for the language, in real context
- a returned verdict file changes lexicon behaviour as recorded
- `nativeReviewed: true` cannot be set without a verdict file present (the existing
  languages test already guards the flag — extend it to require evidence)
- a malformed verdict file is rejected with the offending entry named

**Acceptance**

- [ ] a reviewer needs only a browser and 90 minutes
- [ ] Hindi and Hinglish `always`/`ambiguous` lists carry a recorded human verdict
- [ ] romanisation vowel-length rules carry a recorded human verdict
- [ ] `docs/NATIVE_REVIEW.md` status table updated from evidence, not assertion
- [ ] README stops describing Hindi romanisation as unreviewed **only** once it isn't

---

## What will still be missing afterwards

J-cuts and L-cuts. Full UAX#9 bidi for Urdu. Subject-tracking auto-reframe. Native review
for the eleven languages after Hindi. Real-device playback testing. Windows CI.

None of these block a first release; all of them should be written down rather than
discovered by a user.
