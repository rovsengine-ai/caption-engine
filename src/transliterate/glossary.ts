import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptionEngineError } from '../errors.js';
import { primaryScript, scriptForLanguage } from '../text/script.js';

/**
 * Hinglish glossary: phrase-level protection and reverse-loanword mapping.
 *
 * THE PROBLEM THIS SOLVES, concretely.
 *
 * ASR often writes English words in Devanagari when the surrounding speech is
 * Hindi. "cheat day" comes back as "चीट डे". Phonetic transliteration then does
 * exactly what it is supposed to and produces "cheet de" — the rules are right,
 * the input was already lossy. There is NO rule that recovers English
 * orthography from Hindi phonology: चीट could legitimately romanise as cheet,
 * chit, or cheat. Only a mapping knows which.
 *
 * So the glossary does two jobs:
 *
 *   1. MAP   चीट डे → cheat day     (Devanagari-written English → real spelling)
 *   2. PROTECT  "cheat day"          (a Latin phrase no backend may alter)
 *
 * Matching is PHRASE-level and longest-first, so "cheat day" wins over a
 * hypothetical entry for "day" alone, and multi-word phrases survive intact.
 *
 * TOKEN-COUNT INVARIANT: a mapping must produce exactly as many output tokens as
 * it consumed. That is what lets the result be spliced back over the original
 * words with their timestamps untouched. Entries that violate it are rejected
 * when the glossary loads, not silently at render time.
 */

export interface GlossaryEntry {
  /** Source tokens, normalised for matching. */
  from: string[];
  /** Replacement tokens. Same length as `from`. */
  to: string[];
  /** Where it came from, for diagnostics. */
  source: string;
}

export interface Glossary {
  /** Devanagari (or any script) → English mappings, longest phrase first. */
  mappings: GlossaryEntry[];
  /** Latin phrases that must pass through untouched. */
  protectedPhrases: string[][];
  /** Number of entries loaded, for reporting. */
  size: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Case/punctuation-insensitive key for matching. */
export function normaliseForMatch(token: string): string {
  return token
    .toLowerCase()
    .replace(/[.,!?;:"'`()[\]{}।॥…]/g, '')
    .trim();
}

/**
 * Parse a glossary file.
 *
 * Format, one entry per line:
 *   चीट डे => cheat day      mapping (source script → English)
 *   cheat day                protect only (never altered by any backend)
 *   # comment
 *
 * Deliberately plain text: this file is meant to be edited by whoever is doing
 * the native-speaker review, not by a programmer.
 */
export function parseGlossary(text: string, source = 'inline'): Glossary {
  const mappings: GlossaryEntry[] = [];
  const protectedPhrases: string[][] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, lineNo) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;

    const arrow = line.includes('=>') ? '=>' : line.includes('\t') ? '\t' : null;
    if (arrow) {
      const [lhs, rhs] = line.split(arrow);
      const from = (lhs ?? '').trim().split(/\s+/).filter(Boolean).map(normaliseForMatch);
      const to = (rhs ?? '').trim().split(/\s+/).filter(Boolean);

      if (from.length === 0 || to.length === 0) {
        throw new CaptionEngineError(
          `Glossary ${source}:${lineNo + 1} — both sides of "=>" must be non-empty.`,
          `Got: ${raw}`,
        );
      }
      if (from.length !== to.length) {
        // Enforced, not warned: a mapping that changes token count would break
        // the one-to-one alignment with word timestamps.
        throw new CaptionEngineError(
          `Glossary ${source}:${lineNo + 1} — "${lhs!.trim()}" has ${from.length} token(s) ` +
            `but "${rhs!.trim()}" has ${to.length}. They must match.`,
          `Each source token maps to one output token so word timings stay aligned.\n` +
            `If you need a different split, write it as separate entries.`,
        );
      }
      mappings.push({ from, to, source: `${source}:${lineNo + 1}` });
    } else {
      const phrase = line.split(/\s+/).filter(Boolean);
      if (phrase.length > 0) protectedPhrases.push(phrase);
    }
  });

  // Longest first so "cheat day" beats "day".
  mappings.sort((a, b) => b.from.length - a.from.length);
  protectedPhrases.sort((a, b) => b.length - a.length);

  return { mappings, protectedPhrases, size: mappings.length + protectedPhrases.length };
}

function defaultGlossaryPath(): string | null {
  for (const up of [
    '../../../assets/hinglish-glossary.txt',
    '../../assets/hinglish-glossary.txt',
    '../assets/hinglish-glossary.txt',
  ]) {
    const p = resolve(__dirname, up);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadGlossary(path?: string): Glossary {
  if (path) {
    if (!existsSync(path)) {
      throw new CaptionEngineError(
        `Glossary file not found: ${path}`,
        `Format, one per line:\n` +
          `  चीट डे => cheat day     (map Devanagari-written English to real spelling)\n` +
          `  cheat day               (protect a Latin phrase)\n` +
          `  # comment`,
      );
    }
    return parseGlossary(readFileSync(path, 'utf8'), path);
  }

  const def = defaultGlossaryPath();
  if (!def) return { mappings: [], protectedPhrases: [], size: 0 };
  return parseGlossary(readFileSync(def, 'utf8'), def);
}

export interface GlossaryHit {
  /** Index of the first token matched. */
  index: number;
  length: number;
  from: string[];
  to: string[];
  kind: 'mapping' | 'protect';
}

/**
 * Apply the glossary to a token list.
 *
 * Returns replacement tokens (same length as input) plus a `locked` set marking
 * every index the glossary decided, so later transliteration must not touch
 * them. Locking is the whole point: without it a backend would happily
 * "romanise" the English we just restored.
 */
export function applyGlossary(
  tokens: string[],
  glossary: Glossary,
): { tokens: string[]; locked: Set<number>; hits: GlossaryHit[] } {
  const out = [...tokens];
  const locked = new Set<number>();
  const hits: GlossaryHit[] = [];
  const norm = tokens.map(normaliseForMatch);

  const matchAt = (i: number, phrase: string[]): boolean => {
    if (i + phrase.length > tokens.length) return false;
    for (let k = 0; k < phrase.length; k++) {
      if (norm[i + k] !== phrase[k]) return false;
    }
    // Do not re-decide tokens an earlier (longer) entry already claimed.
    for (let k = 0; k < phrase.length; k++) if (locked.has(i + k)) return false;
    return true;
  };

  // Mappings first (they rewrite), then protection (it only locks).
  for (const entry of glossary.mappings) {
    for (let i = 0; i < tokens.length; i++) {
      if (!matchAt(i, entry.from)) continue;
      for (let k = 0; k < entry.from.length; k++) {
        // Carry over any punctuation attached to the original token so
        // "डे," becomes "day," rather than losing the comma.
        out[i + k] = reattachPunctuation(tokens[i + k]!, entry.to[k]!);
        locked.add(i + k);
      }
      hits.push({ index: i, length: entry.from.length, from: entry.from, to: entry.to, kind: 'mapping' });
    }
  }

  for (const phrase of glossary.protectedPhrases) {
    const lower = phrase.map((p) => p.toLowerCase());
    for (let i = 0; i < tokens.length; i++) {
      if (!matchAt(i, lower)) continue;
      for (let k = 0; k < phrase.length; k++) locked.add(i + k);
      hits.push({ index: i, length: phrase.length, from: lower, to: lower, kind: 'protect' });
    }
  }

  return { tokens: out, locked, hits };
}

/** Preserve leading/trailing punctuation from the original token. */
function reattachPunctuation(original: string, replacement: string): string {
  const m = original.match(/^([^\p{L}\p{N}\p{M}]*)(.*?)([^\p{L}\p{N}\p{M}]*)$/u);
  const lead = m?.[1] ?? '';
  const trail = (m?.[3] ?? '').replace(/।/g, '.').replace(/॥/g, '.');
  return lead + replacement + trail;
}

/**
 * Keep only the entries that can apply to a given source language.
 *
 * The built-in glossary is a HINDI artefact: its mappings are keyed on
 * Devanagari-written English ("चीट डे => cheat day"). Those keys can never match
 * a Kannada or Tamil token, so leaving them in was harmless in practice — but it
 * reported 119 mappings as "loaded" on a Kannada run, which is the kind of
 * misleading number that makes people believe a Hindi code path is running when
 * it is not. It is also a real cross-language coupling waiting for the first
 * Latin-keyed mapping someone adds.
 *
 * The rule, deliberately narrow:
 *
 *   - a mapping whose source tokens are written in some OTHER Indic script is
 *     dropped: it belongs to a different language;
 *   - a mapping keyed on Latin, or on this language's own script, is kept;
 *   - protected phrases are ALWAYS kept. Protecting English is language-neutral
 *     — English survives inside Kannada speech for exactly the same reason it
 *     survives inside Hindi speech — and dropping them would break the one
 *     guarantee that has nothing to do with Hindi.
 */
export function glossaryForLanguage(g: Glossary, language: string): Glossary {
  const own = scriptForLanguage(language);
  const mappings = g.mappings.filter((entry) =>
    entry.from.every((tok) => {
      const s = primaryScript(tok);
      return s === 'Latin' || s === 'Common' || s === own;
    }),
  );
  return {
    mappings,
    protectedPhrases: g.protectedPhrases,
    size: mappings.length + g.protectedPhrases.length,
  };
}

/** Merge glossaries; later entries win on conflict. */
export function mergeGlossaries(...gs: Glossary[]): Glossary {
  const mappings = gs.flatMap((g) => g.mappings);
  const protectedPhrases = gs.flatMap((g) => g.protectedPhrases);
  mappings.sort((a, b) => b.from.length - a.from.length);
  protectedPhrases.sort((a, b) => b.length - a.length);
  return { mappings, protectedPhrases, size: mappings.length + protectedPhrases.length };
}
