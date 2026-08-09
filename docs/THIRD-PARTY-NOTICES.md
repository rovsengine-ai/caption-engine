# Third-party notices

Code in this repository that derives from someone else's work, what it derives
from, and the licence that permits it.

---

## ezsnippet / auto-cut-agent — MIT

**Used in:** `src/media/audio-analysis.ts`

`parseSilenceDetect`, `parseVolumeDetect` and `suggestNoiseFloor` are
TypeScript reimplementations of the approach in `extension/js/core.js` from
ezsnippet's auto-cut-agent. The behaviours taken are:

- parsing FFmpeg `silencedetect` stderr, including the case where a silence runs
  to end-of-file and FFmpeg logs no closing `silence_end`;
- parsing `volumedetect` stderr into mean/max dBFS;
- deriving a silence threshold from the file's own `mean_volume`, biased below
  the mean, clamped to a sane band, and never above `max_volume - 12`.

Not taken: the CEP panel UI, the ExtendScript host layer, and the
Premiere-timeline cut application, none of which apply to a file-based CLI.

Independently arrived at, not copied — noted here only so the resemblance is not
mistaken for undisclosed reuse: frame snapping with ceil-start / floor-end
(`snapCutsToFrames`) and a ~12 ms fade constant. Both predate this integration
in our history.

```
MIT License

Copyright (c) 2026 ezsnippet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ezsnippet / premiere-auto-captions — MIT, nothing used

Reviewed and **not** used. Its `correctionSystemPrompt()` states the same
invariants this project enforces structurally (never translate, merge, split,
reorder, drop or add cues; Hinglish stays in Latin script), but its
implementation is an LLM correction pass against a paid API, which is out of
scope for a local-first tool. Recorded so a later reader knows it was assessed
rather than missed.
