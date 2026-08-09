# Evaluation fixtures

Two tiers. The split is the point: it keeps every number in the report attached
to a stated basis.

## Tier A — committed, free, no ground truth needed

`*.fillers.json` — hand-labelled token sequences. No audio, no API key, no cost.
Runs in CI on every `npm test` and `npm run evaluate`.

These measure **what our pipeline does to a transcript**: filler precision and
recall, timestamp drift, caption readability. They say nothing whatsoever about
ASR accuracy, because there is no reference for what was actually said.

Shape:

```json
{
  "name": "hinglish-mixed",
  "language": "hi",
  "durationSec": 14.0,
  "words": [
    { "text": "matlab", "start": 4.90, "end": 5.25, "isFiller": true }
  ]
}
```

`isFiller` is a human judgement: would an editor cut this token? The valuable
fixtures are the near-misses — the same word used once as hesitation and once as
a real word, at different points in the same file.

## Tier B — ground truth, supplied by you

Real WER and CER need a human reference. Nothing can synthesise one. Drop two
files in this directory:

| File | Contents |
|---|---|
| `<name>.asr.json` | a transcript saved with `--transcript-out` |
| `<name>.reference.txt` | what was actually said, plain text |

Then `npm run evaluate` reports WER, CER and per-category accuracy for that pair.
No code change needed. **`*.asr.json` and `*.reference.txt` are gitignored** —
these come from your own recordings and stay on your machine.

Optional, inside the `.asr.json`, for per-category scoring:

```json
{ "knownNames": ["Aarav", "Zomato", "Bengaluru"], "words": [ ... ] }
```

Without it, names are guessed by capitalisation, which over-counts in some
languages and cannot work at all in scripts without case.

### Producing a pair

```bash
node dist/src/cli.js podcast.mp4 --transcript-out test/fixtures/eval/podcast.asr.json \
  --format json -o /tmp/throwaway.json
# then write test/fixtures/eval/podcast.reference.txt by listening to the audio
```

Transcribe once; the pair is then reusable forever with no further API cost.

### How much is enough

WER on a 30-word clip has an error bar wider than most differences you would
want to detect. Aim for **at least 500 reference words per language**, spread
over more than one speaker and recording condition. The harness prints the
sample size next to every rate so an under-powered number is visible as such.

## What neither tier measures

Timestamp *accuracy*. Checking whether the ASR put a word at the right moment
needs human-aligned boundaries, which is far more work than writing a reference
transcript. The harness measures timestamp **drift** instead — whether our own
stages move a word off wherever the ASR put it — which is fully checkable and
catches the bug that actually occurs.
