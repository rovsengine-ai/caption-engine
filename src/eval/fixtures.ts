import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FillerFixture } from './fillers.js';

/**
 * Fixture loading for the evaluation harness.
 *
 * Two tiers, deliberately separated:
 *
 *   Tier A — committed to the repo. Hand-labelled token sequences, no audio, no
 *            API key, no cost. Measures what OUR pipeline does to a transcript.
 *
 *   Tier B — ground truth, supplied by you. `<name>.asr.json` (a saved ASR
 *            output) plus `<name>.reference.txt` (what was actually said).
 *            Only these can produce a real WER, because only a human knows what
 *            was said. Absent by default; the harness reports "not supplied"
 *            rather than skipping quietly or inventing a number.
 *
 * The split exists so that no figure in the report can be mistaken for
 * something it is not. A Tier A run says nothing about ASR accuracy, and the
 * report says so on its face.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export function evalFixtureDir(): string {
  for (const up of ['../../../test/fixtures/eval', '../../test/fixtures/eval', '../test/fixtures/eval']) {
    const p = resolve(__dirname, up);
    if (existsSync(p)) return p;
  }
  return resolve(__dirname, '../../../test/fixtures/eval');
}

// ---------------------------------------------------------------------------
// Tier B — ground truth
// ---------------------------------------------------------------------------

export interface GroundTruthPair {
  name: string;
  /** Word texts as the ASR produced them. */
  hypothesis: string[];
  /** What was actually said, per a human. */
  reference: string;
  /** Optional: names/brands the reference contains, for per-category scoring. */
  knownNames?: string[];
  language?: string;
}

export interface FixtureProblem {
  file: string;
  problem: string;
}

export interface GroundTruthLoad {
  pairs: GroundTruthPair[];
  problems: FixtureProblem[];
  dir: string;
}

/**
 * Load every `<name>.asr.json` that has a matching `<name>.reference.txt`.
 *
 * A malformed or half-supplied pair is reported, never skipped silently — a
 * fixture you thought was being scored but is not is worse than no fixture.
 */
export function loadGroundTruth(dir = evalFixtureDir()): GroundTruthLoad {
  const out: GroundTruthLoad = { pairs: [], problems: [], dir };
  if (!existsSync(dir)) return out;

  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }

  for (const file of entries.filter((f) => f.endsWith('.asr.json')).sort()) {
    const name = file.slice(0, -'.asr.json'.length);
    const refFile = `${name}.reference.txt`;
    const refPath = join(dir, refFile);

    if (!existsSync(refPath)) {
      out.problems.push({ file, problem: `no matching ${refFile} — cannot score without a reference` });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      out.problems.push({ file, problem: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const doc = parsed as { words?: Array<{ text?: unknown }>; language?: unknown; knownNames?: unknown };
    if (!Array.isArray(doc.words)) {
      out.problems.push({ file, problem: 'no "words" array — expected a saved transcript' });
      continue;
    }
    const hypothesis = doc.words
      .map((w) => (typeof w?.text === 'string' ? w.text : ''))
      .filter((t) => t.trim() !== '');
    if (hypothesis.length === 0) {
      out.problems.push({ file, problem: 'transcript contains no word text' });
      continue;
    }

    const reference = readFileSync(refPath, 'utf8').trim();
    if (reference === '') {
      out.problems.push({ file: refFile, problem: 'reference is empty — no error rate is defined' });
      continue;
    }

    out.pairs.push({
      name,
      hypothesis,
      reference,
      language: typeof doc.language === 'string' ? doc.language : undefined,
      knownNames: Array.isArray(doc.knownNames)
        ? doc.knownNames.filter((n): n is string => typeof n === 'string')
        : undefined,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tier A — committed filler fixtures
// ---------------------------------------------------------------------------

export interface FillerFixtureLoad {
  fixtures: FillerFixture[];
  problems: FixtureProblem[];
}

export function loadFillerFixtures(dir = evalFixtureDir()): FillerFixtureLoad {
  const out: FillerFixtureLoad = { fixtures: [], problems: [] };
  if (!existsSync(dir)) return out;

  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }

  for (const file of entries.filter((f) => f.endsWith('.fillers.json')).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      out.problems.push({ file, problem: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const doc = parsed as Partial<FillerFixture>;
    if (!Array.isArray(doc.words) || typeof doc.language !== 'string') {
      out.problems.push({ file, problem: 'expected { language, durationSec, words[] }' });
      continue;
    }
    const bad = doc.words.findIndex(
      (w) => typeof w?.text !== 'string' || typeof w?.start !== 'number' ||
             typeof w?.end !== 'number' || typeof w?.isFiller !== 'boolean',
    );
    if (bad >= 0) {
      out.problems.push({ file, problem: `word ${bad} missing text/start/end/isFiller` });
      continue;
    }
    out.fixtures.push({
      name: doc.name ?? file.replace(/\.fillers\.json$/, ''),
      language: doc.language,
      durationSec: doc.durationSec ?? (doc.words[doc.words.length - 1]?.end ?? 0) + 0.5,
      words: doc.words,
    });
  }

  return out;
}
