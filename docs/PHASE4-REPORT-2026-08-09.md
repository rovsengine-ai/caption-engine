# Phase 4 — two-pass filler and silence analysis. Session report, 2026-08-09

Baseline `43317b9` → head `b8ef6e9`. Six commits.

---

## 0. Read this first

**Your real transcript is on GitHub.** `verify-sarvam.json` (1.8 MB),
`transcript.json`, `verify-sarvam.srt` and `current-data.json` contain speech
transcribed from a personal recording — "From my childhood, maine apni mother ko
beemaar dekha." They entered history in the initial commit `a5ff2d2` and are
present on `origin/main` at `github.com/rovsengine-ai/caption-engine`.

Commit `69dc4af` stops them being carried forward. It does **not** remove them
from history, and I did not try: that needs a history rewrite, which your rules
prohibit and which would be the wrong call to make unilaterally on a pushed
branch. Decide whether the repository is private, and whether the recording is
sensitive, before doing anything else.

**Your git index was armed to delete 3,164 lines.** 21 files — the whole
evaluation harness and the language-detection work from `4ac638c` and `43317b9` —
were staged as deletions while still present on disk. A commit would have
removed them from the repository. Repaired in this session; nothing was lost.

---

## 1. Files changed

```
.gitignore                    +6      /input* anchored, .git-deltest
src/types.ts                  +41     decision, decisionReason, evidence on Cut
src/autotrim/fillers.ts       +69/-8  never tier; matchNeverCut; never wins in matchFiller
src/autotrim/index.ts         +111    two-pass routing; merge and secondsRemoved fixes
src/cli/args.ts               +41     five new flags and their help
src/cli/run.ts                +79     audio pass, evidence mode, cache key
src/config/fingerprint.ts     +10     audioAnalysis and fillerConfidence in the cuts key
```

## 2. Files added

```
src/media/audio-analysis.ts    466   FFmpeg silencedetect/volumedetect/astats + queries
src/autotrim/analysis.ts       338   Pass 1 — evidence
src/autotrim/decide.ts         311   Pass 2 — verdict
test/filler-analysis.test.ts   467   56 tests
docs/AUDIT-2026-08-09.md             pre-work audit
docs/THIRD-PARTY-NOTICES.md          MIT attribution for the /ez-derived parsers
```

28 further paths were removed from the **index only** (`git rm --cached`) —
13 `dbg*.mjs`, 5 `scratch/*.mjs`, and six generated data files. All 28 verified
still present on disk.

## 3. Files deliberately not touched

`src/render/*`, `src/text/shaper.ts`, `src/text/fonts.ts`, `src/captions/svg.ts`,
`src/captions/ass.ts`, `assets/fonts/**`, `src/asr/*`, `.env`. The renderer is
stable and I cannot exercise its resvg path in my environment (§8).

## 4. Tests

| | |
|---|---|
| Baseline | 768 tests · 766 pass · 0 fail · 2 skip |
| Now | **824 tests · 822 pass · 0 fail · 2 skip** |
| Added | 56 |
| Build | `tsc -p tsconfig.json` exit 0 |
| Doctor | 24/25 pass, 1 warn (resvg, environment-specific) |
| Evaluate | exit 0, Tier A only |

Every run had `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `SARVAM_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `KIMI_API_KEY` and `TRANSLITERATE_URL`
blanked on the command line.

## 5. What actually changed in behaviour

Run against a locally generated 6-second clip and a synthetic transcript:

```
idx  token  lex     dur   conf  gapB  gapA  qB    qA    voiced  elong
1    is     never   0.15  0.96  0.02  0.02  0.00  0.00  1.00
2    a      never   0.08  0.41  0.02  0.02  0.00  0.00  1.00
4    aaa    none    0.75  0.22  0.35  0.75  0.03  0.70  0.00    yes
5    um     always  0.20  0.30  0.75  0.15  0.00  0.00  1.00

[keep       ] a     0.00  "a" is in the never-cut list for en
[propose-cut] aaa   0.90  elongated "aaa" — a held sound, not the word "a"
[propose-cut] um    0.95  unambiguous hesitation noise
```

- **`a` is structurally protected.** A new `never` lexicon tier is checked before
  every other rule and short-circuits `matchFiller`, so callers written before
  the tier existed inherit the guard. Note the article above is short (80 ms),
  low-confidence (0.41) and adjacent to a pause — the exact combination that
  manufactures a confident wrong cut.
- **`aaa` is now detected.** No lexicon can enumerate every spelling an ASR
  invents for a drawl, so elongation is structural: a run of 3+ identical
  characters where the run *constitutes* the token. Containing one is not enough
  — `zzzznotafiller` holds a run of four and is not a hesitation.
- **Silence is measured, not inferred.** Three local FFmpeg passes replace
  ASR-gap arithmetic. An ASR gap is the absence of a label, which a breath or a
  failed word produces just as readily as real silence. The noise floor is
  derived from the file's own `mean_volume`, because −35 dB is dead air on a
  close mic and mid-sentence on a phone across a room.
- **Three-way verdict.** `review-required` cuts are emitted with
  `restored: true` — visible in `--cuts-out`, not applied.

Two latent bugs surfaced and were fixed: `mergeOverlapping` would absorb a
review cut into an active one (applying it unreviewed), and `secondsRemoved`
counted restored cuts. Neither was reachable before `restored` could start true.

## 6. Evidence for the accuracy claims

**Caption accuracy: no new measurement, and I will not state a figure.** Nothing
in this session touched recognition. Tier B (WER/CER) is still empty because it
needs your recordings plus human reference transcripts.

**Filler precision/recall: 88.9% / 100%, unchanged.** Measured against two
hand-labelled fixtures totalling 8 fillers. That is a regression floor, not a
metric — 9 proposals is too small a sample to move meaningfully, and the number
did not move.

The evaluation harness still reports one real word cut: English **`right`**. It
is in the `ambiguous` tier and gets cut when a pause corroborates it. I did not
silence this by adding `right` to `never` or by nudging a threshold — tuning
against a 2-fixture metric would be fitting to noise, and `right` genuinely is a
filler in "right, so anyway". It needs a real labelled sample to settle.

## 7. Local-only vs needs a key

**Local, no network, no key:** every part of Phase 4. Audio analysis is FFmpeg
`volumedetect`, `silencedetect` and `astats`. Elongation, lexicons, verdicts and
scoring are pure functions. `--analyze-filler-candidates` makes zero network
calls.

**Needs an optional key:** ASR (ElevenLabs, Deepgram, Sarvam) and Sarvam
transliteration — unchanged, and not exercised this session.

## 8. Limits and remaining risk

- **`voicedRatio` is an energy threshold, not voice activity.** Music, keyboard
  noise and traffic read as voiced; a whisper below the floor reads as unvoiced.
  It is a corroborating signal and a bad sole authority, which is why no verdict
  rests on it alone. A trained VAD (Silero, WebRTC) would be a real improvement.
- **Three extra FFmpeg passes.** Real wall-clock time on a 60-minute file.
  `--no-audio-analysis` skips them at the cost of weaker evidence.
- **The one-window boundary tolerance** in `quietBefore`/`quietAfter` forgives a
  single loud 25 ms window at a word edge. Principled — the window containing a
  word boundary holds that word's tail — but it is a tolerance, and a 25 ms
  fragment of real speech could in principle be read as quiet.
- **Filler lexicons remain unreviewed by native speakers for 11 of 12
  languages.** The `never` entries I added for hi/te/kn/ta/mr are basic copulas,
  postpositions and negation. They are defensible from grammar, not from a
  speaker's judgement. **These need review: hi, te, kn, ta, ml, bn, mr, gu, pa,
  or, as, ne.** Only `en` is reviewed.
- **resvg is untested in my environment.** `node_modules` was installed on macOS
  and only ships `resvg-js-darwin-arm64`, so my Linux sandbox falls back to
  FFmpeg. I changed nothing in the renderer, but re-run the render tests on your
  Mac to be certain.
- **`.git/_quarantine/` holds 20 files** — stale lock files and probe artefacts I
  moved aside because the sandbox mount blocks `unlink`. Safe to delete on your
  Mac: `rm -rf .git/_quarantine`.
- **13.13 MiB of garbage objects** remain in `.git/objects` from an interrupted
  `git add`. Plain `git gc` (not `--prune=now`) clears them safely after two
  weeks.

## 9. Commands

**macOS**

```bash
cd /Users/vaibhav/Documents/GitHub/caption-engine
npm run build && npm test && npm run doctor && npm run evaluate

# see the evidence behind every filler candidate — cuts nothing, renders nothing
node dist/src/cli.js "./input.mp4" --auto-trim --analyze-filler-candidates

# propose cuts for review, then apply the reviewed list
node dist/src/cli.js "./input.mp4" --auto-trim --review-cuts --cuts-out cuts.json
node dist/src/cli.js "./input.mp4" --auto-trim --cuts-in cuts.json --output trimmed.mp4

# faster, weaker evidence
node dist/src/cli.js "./input.mp4" --auto-trim --no-audio-analysis

rm -rf .git/_quarantine        # remove the quarantined lock files
```

**Windows (PowerShell)**

```powershell
cd C:\Users\vaibhav\Documents\GitHub\caption-engine
npm run build; npm test; npm run doctor; npm run evaluate

node dist\src\cli.js ".\input.mp4" --auto-trim --analyze-filler-candidates
node dist\src\cli.js ".\input.mp4" --auto-trim --review-cuts --cuts-out cuts.json
node dist\src\cli.js ".\input.mp4" --auto-trim --cuts-in cuts.json --output trimmed.mp4

Remove-Item -Recurse -Force .git\_quarantine
```

## 10. Commits

```
69dc4afb07829212523c1c7608891ca570dbe8ec  hygiene: untrack scratch and generated data
e7ddae4069f6aeca3eebc06dfeffb947de561dcc  docs: pre-work audit at 43317b9
1cabe070fe44b04ba529948ebdcdc462c6a2ca16  audio: measure silence and energy from the waveform
cfcace0207e4c4fcff0b020e928719e20a783a87  autotrim: two-pass filler analysis
f493f103771ceb18b2a90cd369814e7f66b276d6  cli: expose the two-pass filler analysis
b8ef6e975ec4079b97ec88c7e0954b9056608edb  test: 56 cases for the two-pass filler analysis
```

## 11. Confirmations

- **No paid API call was made.** Every key was blanked on every command line;
  no ASR, transliteration or LLM endpoint was contacted.
- **No network request of any kind** was made by the code under test. All FFmpeg
  work was local; all media was generated locally with `lavfi`.
- **No API key, media, transcript, cache or generated output was committed by
  me.** Verified by scanning the full `43317b9..HEAD` diff for key patterns and
  for media/transcript/cache paths: none found. `.env` remains untracked.
- **Nothing was deleted.** All 28 untracked paths verified present on disk;
  stale locks were moved to quarantine, not removed.
- **No accuracy claim is made** beyond the two hand-labelled fixtures, and no
  claim of correctness is made for any language without native-speaker review.

## 12. Not done

Phases 5–11 are untouched: visual-aware trim, J/L cuts, local shot analysis,
Gemini/Kimi adapters, the template system. Phase 4 was one subsystem and it
consumed the session. The order in `docs/AUDIT-2026-08-09.md` §9 still holds,
with Phase 4 now complete.
