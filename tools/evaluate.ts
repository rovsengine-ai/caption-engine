/**
 * Measurable evaluation of Hinglish quality and Auto Trim behaviour.
 *
 * Deliberately reports NUMBERS, not a verdict. Nothing here entitles anyone to
 * say the system is "accurate" — it says how it scored on a small, fixed,
 * hand-written set, which is a floor, not a guarantee. Real content will differ.
 *
 *   npm run build && node dist/tools/evaluate.js
 *   node dist/tools/evaluate.js --json
 */
import { toRomanScript } from '../src/transliterate/index.js';
import { loadGlossary } from '../src/transliterate/glossary.js';
import { autoTrim, applyTrim, applyHandles, snapCutsToFrames } from '../src/autotrim/index.js';
import { listLanguages } from '../src/config/languages.js';
import { groupIntoCues } from '../src/captions/group.js';
import { resolveStyle } from '../src/captions/style.js';
import { wordErrorRate, characterErrorRate, categoryBreakdown, tokenise } from '../src/eval/wer.js';
import { measureDrift, measureTrimDrift } from '../src/eval/timestamps.js';
import { measureReadability } from '../src/eval/readability.js';
import { scoreFillerFixture, aggregateFillerScores } from '../src/eval/fillers.js';
import { loadFillerFixtures, loadGroundTruth } from '../src/eval/fixtures.js';
import type { Transcript } from '../src/types.js';

const pct = (n: number | null): string => (n === null ? '   n/a' : `${(n * 100).toFixed(1)}%`);
const rate = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(4));

interface Case {
  label: string;
  /** Words as the ASR produced them. `en` marks a token the ASR tagged English. */
  words: Array<[string, string?]>;
  expected: string;
  /** English phrases that must appear verbatim in the output. */
  mustContain?: string[];
  /** Strings that must NOT appear (known-bad transliterations). */
  mustNotContain?: string[];
  /** True when the ASR itself is wrong — measures ASR error, not ours. */
  asrError?: boolean;
}

const CASES: Case[] = [
  {
    label: 'cheat day (ASR wrote English in Devanagari)',
    words: [['आज'], ['मेरा'], ['चीट'], ['डे'], ['है,'], ['बट'], ['कल'], ['से'],
      ['डाइट'], ['स्टार्ट'], ['करूंगा']],
    expected: 'Aaj mera cheat day hai, but kal se diet start karunga',
    mustContain: ['cheat day', 'diet', 'start'],
    mustNotContain: ['cheet', 'daait', 'varkaaut'],
    asrError: true,
  },
  {
    label: 'cheat day (ASR kept English in Latin — the good case)',
    words: [['आज'], ['मेरा'], ['cheat'], ['day'], ['है']],
    expected: 'Aaj mera cheat day hai',
    mustContain: ['cheat day'],
    mustNotContain: ['cheet'],
  },
  {
    label: 'meeting / important',
    words: [['आज'], ['meeting'], ['बहुत'], ['important'], ['है']],
    expected: 'Aaj meeting bahut important hai',
    mustContain: ['meeting', 'important'],
  },
  {
    label: 'diet start (Latin)',
    words: [['मैं'], ['कल'], ['से'], ['diet'], ['start'], ['करूंगा']],
    expected: 'Main kal se diet start karunga',
    mustContain: ['diet', 'start'],
  },
  {
    label: 'brands and acronyms',
    words: [['मैंने'], ['2'], ['GB'], ['का'], ['YouTube'], ['वीडियो'], ['देखा']],
    expected: 'Maine 2 GB ka YouTube video dekha',
    mustContain: ['GB', 'YouTube', 'video'],
    mustNotContain: ['veediyo', 'yootyoob'],
  },
  {
    label: 'pure Hindi (no English at all)',
    words: [['मैं'], ['आज'], ['आपको'], ['एक'], ['बात'], ['बताता'], ['हूँ']],
    expected: 'Main aaj aapko ek baat batata hoon',
  },
  {
    label: 'workout / gym',
    words: [['रोज'], ['वर्कआउट'], ['और'], ['जिम'], ['जरूरी'], ['है']],
    expected: '',
    mustContain: ['workout', 'gym'],
    mustNotContain: ['varkaaut', 'jim '],
    asrError: true,
  },
];

interface CaseResult {
  label: string;
  output: string;
  expected: string;
  exactMatch: boolean | null;
  phrasesPreserved: number;
  phrasesTotal: number;
  badSpellings: string[];
  tokenCountStable: boolean;
  timingsIdentical: boolean;
  asrError: boolean;
  glossaryHits: number;
}

async function runCase(c: Case): Promise<CaseResult> {
  const words = c.words.map(([text, lang], i) => ({
    text,
    start: Number((i * 0.4).toFixed(3)),
    end: Number((i * 0.4 + 0.35).toFixed(3)),
    confidence: 1,
    type: 'word' as const,
    keep: true,
    ...(lang ? { language: lang } : {}),
  }));
  const t: Transcript = {
    words, language: 'hi', duration: words.length * 0.4 + 1,
    provider: 'fixture', hasWordTimings: true,
  };

  const r = await toRomanScript(t, { provider: 'local' });
  const output = r.transcript.words.map((w) => w.text).join(' ');

  const phrases = c.mustContain ?? [];
  const preserved = phrases.filter((p) => output.toLowerCase().includes(p.toLowerCase()));
  const bad = (c.mustNotContain ?? []).filter((b) =>
    output.toLowerCase().includes(b.toLowerCase()));

  const timingsIdentical = r.transcript.words.every(
    (w, i) => w.start === words[i]!.start && w.end === words[i]!.end,
  );

  return {
    label: c.label,
    output,
    expected: c.expected,
    exactMatch: c.expected ? output === c.expected : null,
    phrasesPreserved: preserved.length,
    phrasesTotal: phrases.length,
    badSpellings: bad,
    tokenCountStable: r.transcript.words.length === words.length,
    timingsIdentical,
    asrError: Boolean(c.asrError),
    glossaryHits: r.glossaryHits.filter((h) => h.kind === 'mapping').length,
  };
}

/** Auto Trim false positives: words a human would clearly have kept. */
function evaluateAutoTrim(): {
  proposed: number; falsePositives: string[]; byReason: Record<string, number>;
} {
  // "matlab" appears twice: once as hesitation (after a pause) and once as the
  // real word "meaning". Cutting the second is a false positive.
  const words = [
    ['aaj', 0.5, 0.9], ['main', 0.95, 1.3], ['aapko', 1.35, 1.8],
    ['matlab', 2.8, 3.2],                       // hesitation → correct to cut
    ['iska', 3.3, 3.7], ['matlab', 3.75, 4.2],  // real word → must NOT be cut
    ['hai', 4.25, 4.5], ['success', 4.55, 5.1],
    ['um', 5.6, 5.8],                            // filler → correct to cut
  ] as Array<[string, number, number]>;

  const t: Transcript = {
    words: words.map(([text, start, end]) => ({
      text, start, end, confidence: 1, type: 'word' as const, keep: true, language: 'hi',
    })),
    language: 'hi', duration: 7, provider: 'fixture', hasWordTimings: true,
  };

  const trim = autoTrim(t);
  const cuts = trim.cuts.filter((c) => !c.restored);
  const byReason: Record<string, number> = {};
  for (const c of cuts) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;

  // The real-word "matlab" sits at 3.75-4.2.
  const falsePositives = cuts
    .filter((c) => c.reason === 'filler' && c.start >= 3.7 && c.start <= 3.8)
    .map((c) => c.label);

  return { proposed: cuts.length, falsePositives, byReason };
}

/**
 * Tier A: timestamp drift through our own stages.
 *
 * Transliteration must move nothing at all. Auto Trim must move surviving words
 * by exactly the duration of the cuts that precede them. Both are checkable
 * without any reference data, and both are where sync bugs actually come from.
 */
async function evaluateTimestamps() {
  const words = [
    ['आज', 0.40, 0.80], ['meeting', 0.90, 1.50], ['बहुत', 1.60, 2.00],
    ['important', 2.10, 2.80], ['है', 2.90, 3.10],
    ['um', 3.90, 4.15],
    ['कल', 4.20, 4.50], ['से', 4.55, 4.75], ['शुरू', 4.80, 5.20],
  ] as Array<[string, number, number]>;

  const base: Transcript = {
    words: words.map(([text, start, end]) => ({
      text, start, end, confidence: 0.97, type: 'word' as const,
    })),
    language: 'hi', duration: 9, provider: 'fixture', hasWordTimings: true,
  };

  const romanised = await toRomanScript(base, { language: 'hi', protectEnglish: true });
  const translit = measureDrift(base, romanised.transcript);

  const trim = autoTrim(base);
  const shaped = snapCutsToFrames(applyHandles(trim, 0.04), 30);
  const trimmed = applyTrim(base, shaped);
  const trimDrift = measureTrimDrift(base, trimmed, shaped);

  return { translit, trimDrift, cuts: shaped.cuts.length };
}

/** Tier A: does the grouper stay inside the style's own budget? */
function evaluateReadability() {
  const sentence = (
    'aaj main aapko ek bahut hi interesting project dikhata hoon jo maine ' +
    'pichhle mahine banaya tha aur yeh kaafi useful nikla'
  ).split(' ');

  const t: Transcript = {
    words: sentence.map((text, i) => ({
      text, start: 0.3 + i * 0.42, end: 0.3 + i * 0.42 + 0.36,
      confidence: 0.96, type: 'word' as const,
    })),
    language: 'hi', duration: sentence.length * 0.42 + 1, provider: 'fixture', hasWordTimings: true,
  };

  const out: Record<string, ReturnType<typeof measureReadability>> = {};
  for (const preset of ['default', 'bold', 'classic']) {
    const style = resolveStyle(preset, 1920);
    const cues = groupIntoCues(t, {
      maxWordsPerCue: style.maxWordsPerCue,
      maxCharsPerLine: style.maxCharsPerLine,
    });
    out[preset] = measureReadability(cues, style);
  }
  return out;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const results: CaseResult[] = [];
  for (const c of CASES) results.push(await runCase(c));

  const trim = evaluateAutoTrim();
  const glossary = loadGlossary();
  const langs = listLanguages();

  // ---- Tier A: no ground truth needed, no API cost -----------------------
  const timestamps = await evaluateTimestamps();
  const readability = evaluateReadability();
  const fillerLoad = loadFillerFixtures();
  const fillerScores = aggregateFillerScores(
    fillerLoad.fixtures.map((f) => scoreFillerFixture(f)),
  );

  // ---- Tier B: ground truth, only if supplied ----------------------------
  const gt = loadGroundTruth();
  const werResults = gt.pairs.map((p) => {
    const reference = tokenise(p.reference);
    const w = wordErrorRate(reference, p.hypothesis);
    const c = characterErrorRate(p.reference, p.hypothesis.join(' '));
    return {
      name: p.name,
      language: p.language ?? 'unknown',
      wer: w.rate,
      cer: c.rate,
      referenceWords: w.referenceLength,
      substitutions: w.substitutions,
      deletions: w.deletions,
      insertions: w.insertions,
      categories: categoryBreakdown(
        w.alignment,
        reference,
        p.knownNames ? new Set(p.knownNames) : undefined,
      ),
    };
  });

  const exact = results.filter((r) => r.exactMatch === true).length;
  const exactTotal = results.filter((r) => r.exactMatch !== null).length;
  const phrasesPreserved = results.reduce((n, r) => n + r.phrasesPreserved, 0);
  const phrasesTotal = results.reduce((n, r) => n + r.phrasesTotal, 0);
  const badTotal = results.reduce((n, r) => n + r.badSpellings.length, 0);
  const asrErrors = results.filter((r) => r.asrError).length;

  const summary = {
    provider: 'local (offline rules + glossary)',
    glossaryEntries: glossary.size,
    cases: results.length,
    exactMatch: `${exact}/${exactTotal}`,
    englishPhrasesPreserved: `${phrasesPreserved}/${phrasesTotal}`,
    knownBadSpellings: badTotal,
    tokenCountStable: `${results.filter((r) => r.tokenCountStable).length}/${results.length}`,
    timingsIdentical: `${results.filter((r) => r.timingsIdentical).length}/${results.length}`,
    casesWhereAsrWasWrong: asrErrors,
    autoTrimProposed: trim.proposed,
    autoTrimFalsePositives: trim.falsePositives.length,
    nativeSpeakerReviewed: langs.filter((l) => l.nativeReviewed).map((l) => l.code),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify({
      summary, results, trim,
      tierA: { timestamps, readability, fillers: fillerScores, fixtureProblems: fillerLoad.problems },
      tierB: { supplied: gt.pairs.length, dir: gt.dir, results: werResults, problems: gt.problems },
    }, null, 2) + '\n');
    return;
  }

  console.log('\ncaption-engine — Hinglish & Auto Trim evaluation');
  console.log('='.repeat(78));
  console.log(`provider: ${summary.provider}   glossary: ${glossary.size} entries\n`);

  for (const r of results) {
    const flag = r.exactMatch === null ? '·' : r.exactMatch ? 'ok' : 'DIFF';
    console.log(`  [${flag}] ${r.label}${r.asrError ? '   (ASR wrote English in Devanagari)' : ''}`);
    console.log(`        got : ${r.output}`);
    if (r.expected && !r.exactMatch) console.log(`        want: ${r.expected}`);
    if (r.phrasesTotal) {
      console.log(`        english phrases preserved: ${r.phrasesPreserved}/${r.phrasesTotal}` +
        (r.glossaryHits ? `   (${r.glossaryHits} via glossary)` : ''));
    }
    if (r.badSpellings.length) console.log(`        BAD SPELLINGS: ${r.badSpellings.join(', ')}`);
    console.log();
  }

  console.log('-'.repeat(78));
  console.log('  Transliteration');
  console.log(`    exact match on fixed set     ${summary.exactMatch}`);
  console.log(`    English phrases preserved    ${summary.englishPhrasesPreserved}`);
  console.log(`    known-bad spellings emitted  ${summary.knownBadSpellings}`);
  console.log('  Alignment safety');
  console.log(`    token count stable           ${summary.tokenCountStable}`);
  console.log(`    timestamps identical         ${summary.timingsIdentical}`);
  console.log('  ASR');
  console.log(`    cases where ASR itself erred ${summary.casesWhereAsrWasWrong}/${results.length}`);
  console.log(`      (glossary repaired these; --code-switching + --keyterms prevents them)`);
  console.log('  Auto Trim');
  console.log(`    cuts proposed                ${trim.proposed} ` +
    `(${Object.entries(trim.byReason).map(([k, v]) => `${k}:${v}`).join(' ')})`);
  console.log(`    false positives              ${trim.falsePositives.length}` +
    (trim.falsePositives.length ? ` — ${trim.falsePositives.join(', ')}` : ''));
  console.log('  Review status');
  console.log(`    native-speaker reviewed      ${summary.nativeSpeakerReviewed.join(', ') || 'none'}`);
  console.log('='.repeat(78));

  // ---- Tier A ------------------------------------------------------------
  console.log('\nTIER A — pipeline behaviour   (no ground truth, no audio, no API cost)');
  console.log('-'.repeat(78));
  console.log('  These measure what THIS CODE does to a transcript.');
  console.log('  They say nothing about ASR accuracy — see TIER B.\n');

  console.log('  Timestamp drift');
  console.log(`    transliteration              max ${timestamps.translit.maxAbsSec.toFixed(4)}s ` +
    `over ${timestamps.translit.count} words   (must be 0.0000)`);
  console.log(`    Auto Trim re-timing          max ${timestamps.trimDrift.maxAbsSec.toFixed(4)}s ` +
    `over ${timestamps.trimDrift.keptWords} kept words, ${timestamps.cuts} cut(s)`);
  console.log(`    mispredicted shifts          ${timestamps.trimDrift.mispredicted}   (must be 0)`);

  console.log('  Caption readability             cues  flagged  mean cps  p95 cps  over-budget');
  for (const [preset, r] of Object.entries(readability)) {
    console.log(
      `    ${preset.padEnd(28)}${String(r.cues).padStart(4)}` +
      `${String(r.flagged).padStart(9)}${r.meanCharsPerSecond.toFixed(1).padStart(10)}` +
      `${r.p95CharsPerSecond.toFixed(1).padStart(9)}${String(r.overLineBudget + r.overWordBudget).padStart(13)}`,
    );
  }

  console.log('  Filler detection');
  if (fillerLoad.fixtures.length === 0) {
    console.log('    no fixtures found in test/fixtures/eval/');
  } else {
    console.log(`    precision                    ${pct(fillerScores.precision)}   ` +
      `(${fillerScores.truePositives}/${fillerScores.truePositives + fillerScores.falsePositives} proposed were real fillers)`);
    console.log(`    recall                       ${pct(fillerScores.recall)}   ` +
      `(${fillerScores.truePositives}/${fillerScores.truePositives + fillerScores.falseNegatives} labelled fillers found)`);
    console.log(`    sample                       ${fillerScores.fixtures} fixture(s), ` +
      `${fillerScores.truePositives + fillerScores.falseNegatives} labelled fillers`);
    if (fillerScores.falsePositiveWords.length) {
      console.log(`    REAL WORDS CUT               ${fillerScores.falsePositiveWords.join(', ')}`);
    }
    if (fillerScores.missedWords.length) {
      console.log(`    fillers missed               ${fillerScores.missedWords.join(', ')}`);
    }
    for (const f of fillerScores.perFixture) {
      console.log(`      ${f.fixture.padEnd(24)} ${f.language}  P ${pct(f.precision)}  R ${pct(f.recall)}`);
    }
  }
  for (const p of fillerLoad.problems) console.log(`    FIXTURE PROBLEM  ${p.file}: ${p.problem}`);

  console.log('\n  Precision and recall are NOT averaged into an F-score. A recall miss');
  console.log('  leaves a filler in; a precision miss deletes a real word. Those are not');
  console.log('  worth the same, and a single number would hide which one moved.');

  // ---- Tier B ------------------------------------------------------------
  console.log('\nTIER B — recognition accuracy   (needs ground truth you supply)');
  console.log('-'.repeat(78));
  if (gt.pairs.length === 0) {
    console.log('  NOT MEASURED — no ground-truth pairs supplied.');
    console.log(`  WER and CER require a human reference transcript. Nothing can`);
    console.log(`  synthesise one, so this section is empty rather than estimated.`);
    console.log(`\n  To populate it, add to ${gt.dir}:`);
    console.log('    <name>.asr.json        a transcript saved with --transcript-out');
    console.log('    <name>.reference.txt   what was actually said');
    console.log('  See test/fixtures/eval/README.md. Both are gitignored.');
  } else {
    console.log('  pair                     lang    WER      CER    ref words   S/D/I');
    for (const r of werResults) {
      console.log(
        `  ${r.name.padEnd(24)} ${(r.language ?? '?').padEnd(6)} ` +
        `${rate(r.wer).padStart(6)}  ${rate(r.cer).padStart(6)}  ` +
        `${String(r.referenceWords).padStart(9)}   ${r.substitutions}/${r.deletions}/${r.insertions}`,
      );
      for (const c of r.categories) {
        if (c.total === 0) continue;
        console.log(`      ${c.category.padEnd(10)} ${pct(c.accuracy)}  (${c.correct}/${c.total})` +
          (c.errors.length ? `   e.g. ${c.errors.slice(0, 3).map((e) => `${e.ref}→${e.hyp ?? '∅'}`).join(', ')}` : ''));
      }
    }
    const totalRef = werResults.reduce((n, r) => n + r.referenceWords, 0);
    if (totalRef < 500) {
      console.log(`\n  SAMPLE TOO SMALL: ${totalRef} reference words. A WER computed on fewer`);
      console.log('  than ~500 words has an error bar wider than most differences worth');
      console.log('  detecting. Treat it as a smoke test, not a measurement.');
    }
  }
  for (const p of gt.problems) console.log(`  FIXTURE PROBLEM  ${p.file}: ${p.problem}`);

  console.log('\n' + '='.repeat(78));
  console.log(
    '\n  Tier A describes a small hand-written set. It is a regression floor,\n' +
    '  not evidence of accuracy on real content. Tier B is empty until you\n' +
    '  supply references. Hindi romanisation and the filler lexicons remain\n' +
    '  UNREVIEWED by a native speaker — see docs/NATIVE_REVIEW.md.\n',
  );

  const regressions =
    badTotal > 0 ||
    trim.falsePositives.length > 0 ||
    fillerScores.falsePositives > 0 ||
    timestamps.translit.maxAbsSec > 0 ||
    timestamps.trimDrift.mispredicted > 0 ||
    fillerLoad.problems.length > 0 ||
    gt.problems.length > 0;
  if (regressions) process.exitCode = 1;
}

main().catch((e) => {
  console.error('evaluation failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
