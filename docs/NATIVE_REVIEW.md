# Native-speaker review checklist

Automated tests prove glyphs are present, conjuncts ligate, matras reorder, and rendered
frames contain ink. **They cannot prove the output reads naturally.** That needs a native
speaker.

This is the gap between "renders correctly" and "a creator would ship it."

Budget: **half a day per language**, two speakers where possible. Do it before marketing
support for a language.

---

## Current status

| Language | Rendering verified | Fillers reviewed | Romanisation reviewed |
|---|---|---|---|
| English | yes | **yes** | n/a |
| Hindi | yes | no | **implemented, NOT reviewed** |
| Marathi | yes | no | **implemented, NOT reviewed** |
| Telugu | yes | no | not implemented |
| Kannada | yes | no | not implemented |
| Tamil | yes | no | not implemented |
| Malayalam | yes | no | not implemented |
| Bengali | yes | no | not implemented |
| Gujarati | yes | no | not implemented |
| Punjabi | yes | no | not implemented |
| Odia | yes | no lexicon | not implemented |
| Assamese | yes | no lexicon | not implemented |
| Nepali | yes | no lexicon | **implemented, NOT reviewed** |
| Urdu | **NO** | no lexicon | not implemented |

When a review is completed, set `nativeReviewed: true` in `src/config/languages.ts`.
There is a test asserting only reviewed languages carry that flag.

---

## 1. Rendering review (30 min)

```bash
npm run visual        # writes demo-out/visual/<Language>.png
```

Show each frame to the reviewer. Ask them to check, **without prompting**:

- [ ] Every word is fully readable — no missing or partial characters
- [ ] Vowel marks (matras) sit on the correct consonant
- [ ] Conjuncts are joined, not split into separate letters
- [ ] Nothing looks like a wrong-but-similar character
- [ ] Word spacing looks natural — not cramped, not scattered
- [ ] Line breaks fall at sensible places
- [ ] The highlighted word is clearly distinguishable
- [ ] It looks like text a creator would publish, not "machine output"

**Ask specifically**: *"Would you post this?"* Reviewers tend to say "it's fine" to
technical questions and give the real answer to that one.

---

## 2. Filler-word review (2-3 hours)

The highest-value review. `src/autotrim/fillers.ts` was assembled from reference sources,
not from native speakers, so it will both miss real fillers and flag real words.

### Method

1. Collect **10-15 minutes of real creator audio** in the language — reels, podcasts,
   vlogs. Not scripted news reads; the fillers live in casual speech.
2. Transcribe it: `node dist/src/cli.js clip.mp4 --transcript-out t.json --format json -o t.json`
3. Have the reviewer mark every word they would cut as an editor.
4. Run Auto Trim and compare:
   ```bash
   node dist/src/cli.js clip.mp4 --transcript-in t.json --auto-trim --cuts-out cuts.json \
     --format json -o out.json
   ```

### Record

- **False negatives** — fillers the reviewer cut that we missed → add to `always`
- **False positives** — words we cut that the reviewer kept → move to `ambiguous`, or remove
- **Ambiguous words** — real words also used as hesitation. These are the dangerous ones:
  cutting them destroys sentences.

Known ambiguous cases already handled (only cut when flanked by a pause):

| Language | Word | Also means |
|---|---|---|
| Hindi | मतलब / matlab | "meaning", "that is" |
| Telugu | అంటే / ante | "meaning", "that is" |
| Kannada | ಅಂದರೆ / andre | "meaning" |
| Bengali | মানে / mane | "meaning" |
| Gujarati | મતલબ / matlab | "meaning" |
| Marathi | म्हणजे / mhanje | "meaning" |

Ask the reviewer for **regional variants**. Fillers differ between Hyderabad and
Vizag Telugu, between Mumbai and Nagpur Marathi. Note which region the reviewer speaks.

### Romanised fillers

Code-switched transcripts contain romanised fillers (`matlab`, `yaar`, `ante`). Spelling is
inconsistent in real usage — ask for the 2-3 spellings they would actually type.

---

## 3. Romanisation review — NOW NEEDED

`src/transliterate/devanagari.ts` is implemented and tested: Hindi schwa deletion,
conjuncts, nukta, anusvara place assimilation, and word-final vowel shortening.

**But the vowel-length and lexicon choices were made by hand, not by a native speaker.**
That is exactly the kind of judgement this checklist exists for. Run `--script roman` over
real content and review:

- [ ] Romanisation matches how people actually type, not a strict ISO transliteration
      (`bahut khaas hai`, not `bahuta khāsa hai`)
- [ ] English words inside code-switched text are left alone, not re-transliterated
- [ ] Proper nouns are recognisable
- [ ] Spelling is consistent across a video

This is judged in side-by-side screenshots against competitors, so it matters more than its
size in the codebase.

Specific things to challenge, all currently my judgement alone:

- `दिखाता → dikhata` (not `dikhaata`) — is the shortened medial right?
- `कहानी → kahani` but `बारी → baari` — is the 3-syllable cutoff sensible?
- `राजा → raja` (not `raaja`)
- `है → hai`, `हूँ → hoon`, `नहीं → nahi` — the whole LOANWORDS table in devanagari.ts
- Which English loanwords in Devanagari are common enough to add to the lexicon?

---

## 4. Clip scoring review (when using `--clips`)

"What makes a viral moment" is learned mostly from English content. There is no evidence it
transfers.

1. Take 20 long-form videos in the target language.
2. Have 2-3 native-speaker creators mark the moments **they** would clip.
3. Run `--clips` and measure overlap.
4. If agreement is poor, fix the **prompt** (`src/clips/score.ts`) with language-specific
   guidance and in-language few-shot examples — not the model.

Until this is done, treat scores as a ranked suggestion, never an automatic publish.

---

## Recording results

Update in the same PR:

- `src/autotrim/fillers.ts` — lexicon changes
- `src/config/languages.ts` — `nativeReviewed: true`, plus a `notes` line naming the region
- `test/languages.test.ts` — add regression cases for corrected words
- This file's status table

Add a test for every false positive found. Filler-list regressions are easy to reintroduce
and embarrassing in production.
