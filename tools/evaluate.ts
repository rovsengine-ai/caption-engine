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
import { autoTrim } from '../src/autotrim/index.js';
import { listLanguages } from '../src/config/languages.js';
import type { Transcript } from '../src/types.js';

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

async function main() {
  const asJson = process.argv.includes('--json');
  const results: CaseResult[] = [];
  for (const c of CASES) results.push(await runCase(c));

  const trim = evaluateAutoTrim();
  const glossary = loadGlossary();
  const langs = listLanguages();

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
    process.stdout.write(JSON.stringify({ summary, results, trim }, null, 2) + '\n');
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
  console.log(
    '\n  These numbers describe a small hand-written set. They are a regression\n' +
    '  floor, not evidence of accuracy on real content. Hindi romanisation and\n' +
    '  the filler lexicons remain UNREVIEWED by a native speaker — see\n' +
    '  docs/NATIVE_REVIEW.md.\n',
  );

  if (badTotal > 0 || trim.falsePositives.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('evaluation failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
