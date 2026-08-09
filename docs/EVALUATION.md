# Evaluation

```bash
npm run evaluate            # human-readable
npm run evaluate -- --json  # machine-readable
```

The harness reports numbers, never a verdict. Nothing it prints entitles anyone
to call this system "accurate".

## Two tiers, and why the split matters

The most common way an evaluation harness lies is by reporting a number whose
basis the reader misunderstands. So the report is split, and each half states
what it does and does not measure.

| | Tier A | Tier B |
|---|---|---|
| Measures | what **our code** does to a transcript | how well the **ASR** heard the audio |
| Needs | nothing | a human reference transcript |
| Cost | zero | one ASR call, once per clip |
| In CI | yes | only if you supply fixtures |
| Answers | "did we break the timing / cut a real word / overflow a line?" | "what is the WER?" |

Tier A cannot tell you whether captions are correct. Tier B cannot tell you
whether the pipeline preserved them. You need both, and conflating them is how
projects end up quoting a 3% WER from someone else's clean-read benchmark as if
it described their product.

## Tier A — runs everywhere, free

### Timestamp drift

Not timestamp *accuracy* — that needs human-aligned word boundaries, which is far
more work than writing a reference transcript and is not attempted here.

What is measured is whether **our own stages** move a word off wherever the ASR
put it:

- **Transliteration must move nothing.** Same audio, same boundaries, only
  spelling. The target is exactly `0.0000s`, not "small".
- **Auto Trim must move each surviving word back by exactly the duration of the
  active cuts preceding it.** Any deviation is a `shiftTime` bug, and it appears
  to a viewer as captions drifting further out of sync the longer they watch.

The check has teeth: a test deliberately sabotages one timestamp and asserts the
harness catches it, so it cannot pass vacuously.

### Caption readability

Each cue is checked against the constraints its own style declares —
`maxCharsPerLine`, `maxWordsPerCue` — plus reading rate. 20 characters/second is
the widely used subtitling ceiling; it is reported, not enforced, because it is
a guideline rather than physics. Lines are wrapped exactly as the renderer wraps
them, so the count reflects what will actually appear.

### Filler precision and recall

Scored against hand-labelled fixtures in `test/fixtures/eval/*.fillers.json`.

**Precision and recall are never averaged into an F-score.** The two failures
are not equally bad:

- a **recall** miss leaves a filler in — the video is slightly less tight;
- a **precision** miss deletes a real word — the sentence is broken and the
  creator may not notice before publishing.

A single number would hide which one moved. Every false positive is printed **by
name**, because "precision 0.94" is not actionable and "cut the word *right*" is.

## Tier B — you supply the ground truth

Real WER needs a human reference. Nothing can synthesise one, so this section
reports **NOT MEASURED** until you add fixtures — it never estimates.

Drop two files in `test/fixtures/eval/`:

| File | Contents |
|---|---|
| `<name>.asr.json` | transcript saved with `--transcript-out` |
| `<name>.reference.txt` | what was actually said, plain text |

Both are gitignored. Transcribe once; the pair is reusable forever at no further
cost.

Optionally add `"knownNames": ["Aarav", "Zomato"]` to the `.asr.json` for
per-category scoring. Without it, names are guessed from capitalisation, which
over-counts in some languages and cannot work at all in scripts without case.

### Definitions, since WER is routinely misreported

```
WER = (S + D + I) / N          N = words in the REFERENCE
```

- **WER can exceed 1.0.** A hypothesis longer than the reference accrues
  insertions with no matching denominator. 1.4 is not a bug.
- **WER is asymmetric.** Swapping reference and hypothesis changes the
  denominator and therefore the answer.
- **An empty reference has no rate.** The harness returns `null`, never 0, so
  "measured nothing" cannot average in as a perfect score.
- **CER counts Unicode code points**, not UTF-16 units, so one visual mistake in
  Devanagari costs one error rather than two.
- Case and *edge* punctuation are normalised away — an ASR writing `Hello,` for
  `hello` has not made a recognition error. Punctuation *inside* a token is kept:
  `don't` ≠ `dont`, `2.5` ≠ `25`.

### Sample size

WER on 30 words has an error bar wider than most differences worth detecting.
Aim for **≥500 reference words per language**, across more than one speaker and
recording condition. The harness prints the sample size beside every rate and
warns explicitly below 500.

## Exit code

`npm run evaluate` exits non-zero when it finds a regression: a known-bad
spelling, a filler false positive, non-zero transliteration drift, a
mispredicted trim shift, or a malformed fixture. It is usable as a CI gate.

A non-zero exit means the harness found something, which is what it is for.
