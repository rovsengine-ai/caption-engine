/**
 * Word and character error rate.
 *
 * WER is the standard ASR metric and it is routinely misreported, so the
 * definitions used here are written down rather than assumed:
 *
 *   WER = (S + D + I) / N        N = words in the REFERENCE, not the hypothesis
 *
 * Consequences that matter when reading the output:
 *
 *  - WER can exceed 1.0. A hypothesis longer than the reference accrues
 *    insertions with no matching denominator. A rate of 1.4 is not a bug.
 *  - WER is asymmetric. Swapping reference and hypothesis gives a different
 *    number, because the denominator changes.
 *  - An empty reference has no defined rate. This module returns `null` rather
 *    than 0 or Infinity, so a caller cannot average it into a summary and quietly
 *    report a good score for having measured nothing.
 *
 * CER is the same computation over characters. For Indic scripts it operates on
 * Unicode code points, not UTF-16 code units: `Array.from` rather than
 * `split('')`, because a Devanagari matra outside the BMP would otherwise count
 * as two errors for one visual mistake.
 */

export type EditOp = 'equal' | 'sub' | 'del' | 'ins';

export interface AlignedPair {
  op: EditOp;
  /** Reference token. Undefined for an insertion. */
  ref?: string;
  /** Hypothesis token. Undefined for a deletion. */
  hyp?: string;
  /** Index into the reference sequence, when this consumes one. */
  refIndex?: number;
}

export interface ErrorRate {
  /** null when the reference is empty — no rate is defined. */
  rate: number | null;
  substitutions: number;
  deletions: number;
  insertions: number;
  hits: number;
  /** Reference length: the denominator. */
  referenceLength: number;
  hypothesisLength: number;
  alignment: AlignedPair[];
}

/**
 * Levenshtein alignment with backtrace.
 *
 * Full O(n·m) table. Real transcripts here are hundreds to a few thousand
 * tokens, where this is instant; a banded or Hirschberg variant would only be
 * worth the complexity at a scale this tool does not operate at.
 */
export function align(reference: string[], hypothesis: string[]): AlignedPair[] {
  const n = reference.length;
  const m = hypothesis.length;

  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) cost[i]![0] = i;
  for (let j = 0; j <= m; j++) cost[0]![j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = reference[i - 1] === hypothesis[j - 1];
      cost[i]![j] = Math.min(
        cost[i - 1]![j - 1]! + (same ? 0 : 1), // match or substitute
        cost[i - 1]![j]! + 1,                  // delete from reference
        cost[i]![j - 1]! + 1,                  // insert into hypothesis
      );
    }
  }

  // Backtrace. Ties prefer diagonal (sub/equal) then deletion, so the alignment
  // is deterministic — an unstable alignment makes per-category slicing jitter
  // between runs on identical input.
  const out: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = reference[i - 1] === hypothesis[j - 1];
      if (cost[i]![j] === cost[i - 1]![j - 1]! + (same ? 0 : 1)) {
        out.push({
          op: same ? 'equal' : 'sub',
          ref: reference[i - 1],
          hyp: hypothesis[j - 1],
          refIndex: i - 1,
        });
        i--; j--;
        continue;
      }
    }
    if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      out.push({ op: 'del', ref: reference[i - 1], refIndex: i - 1 });
      i--;
      continue;
    }
    out.push({ op: 'ins', hyp: hypothesis[j - 1] });
    j--;
  }
  return out.reverse();
}

function rateFrom(alignment: AlignedPair[], referenceLength: number, hypothesisLength: number): ErrorRate {
  let substitutions = 0, deletions = 0, insertions = 0, hits = 0;
  for (const a of alignment) {
    if (a.op === 'sub') substitutions++;
    else if (a.op === 'del') deletions++;
    else if (a.op === 'ins') insertions++;
    else hits++;
  }
  return {
    rate: referenceLength === 0 ? null : (substitutions + deletions + insertions) / referenceLength,
    substitutions, deletions, insertions, hits,
    referenceLength, hypothesisLength,
    alignment,
  };
}

/**
 * Normalisation applied before scoring.
 *
 * Case and surrounding punctuation are removed, because an ASR that writes
 * "Hello," where the reference says "hello" has not made a recognition error and
 * counting it as one makes the metric useless for comparing providers.
 * Punctuation *inside* a token is kept: "don't" and "dont" are different, and
 * so are "2.5" and "25".
 */
export function normaliseForScoring(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[.,!?;:"'`()[\]{}«»।॥\s]+/u, '')
    .replace(/[.,!?;:"'`()[\]{}«»।॥\s]+$/u, '')
    .trim();
}

export function tokenise(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normaliseForScoring)
    .filter((t) => t !== '');
}

/** Word error rate between two token sequences. */
export function wordErrorRate(reference: string[], hypothesis: string[]): ErrorRate {
  const r = reference.map(normaliseForScoring).filter((t) => t !== '');
  const h = hypothesis.map(normaliseForScoring).filter((t) => t !== '');
  return rateFrom(align(r, h), r.length, h.length);
}

/**
 * Character error rate.
 *
 * Operates on Unicode code points. Whitespace is collapsed but not removed —
 * word boundaries are part of what is being measured.
 */
export function characterErrorRate(reference: string, hypothesis: string): ErrorRate {
  const chars = (s: string) => Array.from(s.trim().replace(/\s+/gu, ' '));
  const r = chars(reference);
  const h = chars(hypothesis);
  return rateFrom(align(r, h), r.length, h.length);
}

// ---------------------------------------------------------------------------
// Per-category slicing
// ---------------------------------------------------------------------------

export type TokenCategory = 'name' | 'number' | 'latin' | 'indic' | 'other';

/**
 * Classify a reference token so error rates can be reported per category.
 *
 * An aggregate WER hides the failure that actually matters to a creator: names
 * and brands being wrong. Those are the tokens a viewer notices and the ones a
 * glossary can fix, so they get counted separately.
 *
 * "Name" is heuristic — capitalised, alphabetic, not sentence-initial. That
 * over-counts in German and under-counts in scripts without case, which is why
 * a caller supplying an explicit name list always overrides this.
 */
export function classifyToken(
  token: string,
  opts: { index?: number; knownNames?: Set<string> } = {},
): TokenCategory {
  const t = normaliseForScoring(token);
  if (t === '') return 'other';
  if (opts.knownNames?.has(t)) return 'name';
  if (/^[+-]?[\d,.]+$/u.test(t)) return 'number';
  // Capitalised mid-sentence: likely a proper noun.
  if (opts.index !== undefined && opts.index > 0 && /^\p{Lu}/u.test(token) && /^\p{L}+$/u.test(t)) {
    return 'name';
  }
  if (/^[\p{Script=Latin}\d'’-]+$/u.test(t)) return 'latin';
  if (/\p{Script=Devanagari}|\p{Script=Telugu}|\p{Script=Tamil}|\p{Script=Kannada}|\p{Script=Malayalam}|\p{Script=Bengali}|\p{Script=Gujarati}|\p{Script=Gurmukhi}|\p{Script=Oriya}|\p{Script=Arabic}/u.test(t)) {
    return 'indic';
  }
  return 'other';
}

export interface CategoryBreakdown {
  category: TokenCategory;
  /** Reference tokens in this category — the denominator. */
  total: number;
  correct: number;
  /** null when the category does not appear in the reference. */
  accuracy: number | null;
  /** What the hypothesis said instead, for the ones it got wrong. */
  errors: Array<{ ref: string; hyp: string | null }>;
}

/**
 * Accuracy per token category, computed from an existing alignment.
 *
 * Only reference-consuming operations count: an insertion has no reference
 * token, so it belongs to no category and is excluded here. It is still counted
 * in the overall WER — this breakdown explains the substitutions and deletions,
 * it does not replace the headline number.
 */
export function categoryBreakdown(
  alignment: AlignedPair[],
  reference: string[],
  knownNames?: Set<string>,
): CategoryBreakdown[] {
  const names = knownNames
    ? new Set(Array.from(knownNames, (n) => normaliseForScoring(n)))
    : undefined;

  const acc = new Map<TokenCategory, CategoryBreakdown>();
  const get = (c: TokenCategory) => {
    let e = acc.get(c);
    if (!e) { e = { category: c, total: 0, correct: 0, accuracy: null, errors: [] }; acc.set(c, e); }
    return e;
  };

  for (const a of alignment) {
    if (a.op === 'ins' || a.ref === undefined) continue;
    const original = a.refIndex !== undefined ? reference[a.refIndex] ?? a.ref : a.ref;
    const cat = classifyToken(original, { index: a.refIndex, knownNames: names });
    const e = get(cat);
    e.total++;
    if (a.op === 'equal') e.correct++;
    else e.errors.push({ ref: a.ref, hyp: a.hyp ?? null });
  }

  for (const e of acc.values()) e.accuracy = e.total === 0 ? null : e.correct / e.total;
  return [...acc.values()].sort((a, b) => b.total - a.total);
}
