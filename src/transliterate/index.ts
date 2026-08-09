import type { Transcript, Word } from '../types.js';
import { CaptionEngineError } from '../errors.js';
import {
  resolveTransliterator, NativeScriptPassthrough, type TransliterationProvider,
} from './providers.js';
import { explainUnsupported } from './capabilities.js';
import { isIndicScript } from './script-utils.js';
import {
  loadGlossary, mergeGlossaries, applyGlossary, type Glossary, type GlossaryHit,
} from './glossary.js';

/**
 * Native script → natural mixed Hinglish.
 *
 *   आज मेरा cheat day है, but कल से diet start करूंगा
 *   → Aaj mera cheat day hai, but kal se diet start karunga
 *
 * WHAT IT IS NOT
 *   - not translation:        बहुत → bahut, never "very"
 *   - not reverse translation: "meeting" stays "meeting", never मीटिंग
 *   - not scholarly transliteration: "bahut khaas hai", not "bahuta khāsa hai"
 *
 * THE PIPELINE, in order, and why the order matters:
 *
 *   1. GLOSSARY. Runs FIRST and locks what it decides. This is what turns
 *      ASR-written "चीट डे" back into "cheat day" instead of "cheet de".
 *      Phrase-level and longest-first, so multi-word English survives whole.
 *   2. LANGUAGE/SCRIPT ROUTING. Tokens the ASR tagged as English, and tokens
 *      already in Latin, are protected — never sent to a transliterator.
 *   3. BACKEND. Only unlocked Indic tokens go to the provider.
 *   4. MERGE. Results are spliced back by index, so token count, order and
 *      timestamps are structurally unchanged.
 *
 * Every stage records what it did (see `TokenDiagnostic`) so an ASR error is
 * always distinguishable from a transliteration error.
 */

export * from './providers.js';
export * from './capabilities.js';
export * from './detect.js';
export * from './script-utils.js';
export * from './glossary.js';
export { transliterateText, transliterateToken, hasDevanagari } from './devanagari.js';

/** Why a token ended up the way it did. */
export type TokenStage =
  | 'glossary-map'      // rewritten by a glossary mapping
  | 'glossary-protect'  // locked by the protect list
  | 'asr-english'       // ASR tagged it English → left alone
  | 'already-latin'     // not Indic script → left alone
  | 'transliterated'    // sent to the backend and changed
  | 'unchanged';        // sent to the backend and came back identical

export interface TokenDiagnostic {
  index: number;
  original: string;
  final: string;
  stage: TokenStage;
  /** Per-token language from the ASR, when the provider supplied one. */
  language?: string;
  start: number;
  end: number;
}

export interface RomanisationResult {
  transcript: Transcript;
  provider: string;
  /** True when the backend needs no network/credentials. */
  offline: boolean;
  converted: number;
  preserved: number;
  glossaryHits: GlossaryHit[];
  diagnostics: TokenDiagnostic[];
  glossarySize: number;
  /** Set when the fallback policy had to be used. null on the normal path. */
  fallbackUsed: RomanFallback | null;
  /** Why the fallback was needed. Always accompanies fallbackUsed. */
  fallbackReason: string | null;
  /** True when the output is still in the original script despite --script roman. */
  keptNativeScript: boolean;
  /**
   * Set by backends that split the work into several API requests. Present so
   * a partial degradation is visible: if two batches out of thirty fell back to
   * the offline engine, the run still succeeded but the output is not uniformly
   * model-quality, and the user deserves to know which parts.
   */
  batching?: {
    batches: number;
    requests: number;
    retries: number;
    fallbackBatches: number;
    tokensViaApi: number;
    tokensViaFallback: number;
    /** Words left in their original script by --roman-fallback native. */
    tokensViaNative: number;
    /** Which batches those were. Named, so the report can point at them. */
    nativeBatches: number[];
    largestInputChars: number;
    /** Extra requests spent bisecting batches whose reply would not align. */
    subdivisionRequests: number;
    /** Which batches had to be bisected. */
    subdividedBatches: number[];
    /** Words bisection rescued that would previously have failed the run. */
    tokensViaSubdivision: number;
    notes: string[];
  };
}

export interface RomanisationOptions {
  provider?: string;
  language?: string;
  /** Extra glossary file merged on top of the built-in one. */
  glossaryPath?: string;
  /** Load the built-in glossary. Default true. */
  useDefaultGlossary?: boolean;
  /**
   * Treat every Latin-script token as protected even without a glossary entry.
   * Default true — the whole point of mixed Hinglish is that English survives.
   */
  protectEnglish?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * What to do when Roman output is impossible for this language/backend.
   *
   * 'error'  (default) refuse, with instructions. Backwards compatible.
   * 'native' keep the original script and continue, REPORTED not silent.
   * 'http'   use TRANSLITERATE_URL instead.
   */
  fallback?: RomanFallback;
}

export type RomanFallback = 'error' | 'native' | 'http';

/** Did the ASR explicitly mark this word as English? */
function isAsrEnglish(w: Word): boolean {
  const l = (w.language ?? '').toLowerCase();
  return l === 'en' || l.startsWith('en-');
}

/**
 * Romanise a transcript.
 *
 * Timings are never touched: the Roman and native forms describe the SAME audio,
 * so toggling script must not shift a single caption by a millisecond.
 */
export async function romaniseTranscript(
  transcript: Transcript,
  provider: TransliterationProvider,
  opts: RomanisationOptions = {},
): Promise<RomanisationResult> {
  const protectEnglish = opts.protectEnglish ?? true;
  const language = opts.language ?? transcript.language;

  // ---- 1. Glossary -------------------------------------------------------
  const glossaries: Glossary[] = [];
  if (opts.useDefaultGlossary !== false) glossaries.push(loadGlossary());
  if (opts.glossaryPath) glossaries.push(loadGlossary(opts.glossaryPath));
  const glossary = glossaries.length
    ? mergeGlossaries(...glossaries)
    : { mappings: [], protectedPhrases: [], size: 0 };

  const original = transcript.words.map((w) => w.text);
  const { tokens: afterGlossary, locked, hits } = applyGlossary(original, glossary);

  const stages: TokenStage[] = original.map(() => 'unchanged');
  for (const h of hits) {
    for (let k = 0; k < h.length; k++) {
      stages[h.index + k] = h.kind === 'mapping' ? 'glossary-map' : 'glossary-protect';
    }
  }

  // ---- 2. Route ----------------------------------------------------------
  // Decide, per token, whether the backend may see it at all.
  const sendIndices: number[] = [];
  transcript.words.forEach((w, i) => {
    if (locked.has(i)) return;

    if (protectEnglish && isAsrEnglish(w)) {
      stages[i] = 'asr-english';
      return;
    }
    if (!isIndicScript(afterGlossary[i]!)) {
      stages[i] = 'already-latin';
      return;
    }
    sendIndices.push(i);
  });

  // ---- 3. Backend --------------------------------------------------------
  const finalTokens = [...afterGlossary];
  if (sendIndices.length > 0) {
    const payload = sendIndices.map((i) => afterGlossary[i]!);
    const converted = await provider.romanise(payload, language);

    if (converted.length !== payload.length) {
      throw new CaptionEngineError(
        `Transliteration provider "${provider.name}" returned ${converted.length} tokens ` +
          `for ${payload.length} inputs. Word timings would desynchronise.`,
        'This is a provider bug. Use --transliterate local, which is token-exact.',
      );
    }

    sendIndices.forEach((srcIdx, k) => {
      const out = converted[k] ?? afterGlossary[srcIdx]!;
      finalTokens[srcIdx] = out;
      stages[srcIdx] = out === afterGlossary[srcIdx] ? 'unchanged' : 'transliterated';
    });
  }

  // ---- 4. Verify and merge ----------------------------------------------
  // Assert the invariants rather than trusting them. A backend that "helpfully"
  // rewrites an English word is doing reverse translation, which is precisely
  // what mixed Hinglish must not do.
  transcript.words.forEach((w, i) => {
    const isProtected =
      stages[i] === 'asr-english' || stages[i] === 'already-latin' ||
      stages[i] === 'glossary-protect';
    if (isProtected && finalTokens[i] !== afterGlossary[i]) {
      throw new CaptionEngineError(
        `Provider "${provider.name}" altered protected token "${w.text}" → "${finalTokens[i]}".`,
        'English words and glossary phrases must pass through untouched.',
      );
    }
  });

  let convertedCount = 0;
  let preservedCount = 0;
  const diagnostics: TokenDiagnostic[] = [];

  const words: Word[] = transcript.words.map((w, i) => {
    const finalText = finalTokens[i] ?? w.text;
    const stage = stages[i]!;
    if (stage === 'transliterated' || stage === 'glossary-map') convertedCount++;
    else preservedCount++;

    diagnostics.push({
      index: i,
      original: w.text,
      final: finalText,
      stage,
      language: w.language,
      start: w.start,
      end: w.end,
    });

    // start/end copied verbatim — never recomputed.
    return { ...w, roman: finalText, start: w.start, end: w.end };
  });

  return {
    transcript: { ...transcript, words },
    provider: provider.name,
    offline: provider.offline,
    converted: convertedCount,
    preserved: preservedCount,
    glossaryHits: hits,
    diagnostics,
    glossarySize: glossary.size,
    batching: readBatchStats(provider),
    // romaniseTranscript is given a provider; it does not choose one, so it
    // knows nothing about policy. toRomanScript fills these in.
    fallbackUsed: provider.name === 'native' ? 'native' : null,
    fallbackReason: null,
    // Individual Sarvam batches may have kept native script even when the run
    // as a whole succeeded. Either way the caller is looking at some original
    // script and must say so — this is what makes "never silently native"
    // enforceable rather than aspirational.
    keptNativeScript:
      provider.name === 'native' || (readBatchStats(provider)?.tokensViaNative ?? 0) > 0,
  };
}

/**
 * Pull batching stats off a provider that keeps them, without the pipeline
 * needing to know which backends batch. Structurally typed on purpose: adding a
 * batching backend later requires no change here.
 */
function readBatchStats(provider: TransliterationProvider): RomanisationResult['batching'] {
  const s = (provider as { stats?: Record<string, unknown> }).stats;
  if (!s || typeof s.batches !== 'number' || s.batches === 0) return undefined;
  return {
    batches: Number(s.batches) || 0,
    requests: Number(s.requests) || 0,
    retries: Number(s.retries) || 0,
    fallbackBatches: Number(s.fallbackBatches) || 0,
    tokensViaApi: Number(s.tokensViaApi) || 0,
    tokensViaNative: Number(s.tokensViaNative) || 0,
    nativeBatches: Array.isArray(s.nativeBatches) ? (s.nativeBatches as number[]) : [],
    tokensViaFallback: Number(s.tokensViaFallback) || 0,
    largestInputChars: Number(s.largestInputChars) || 0,
    subdivisionRequests: Number(s.subdivisionRequests) || 0,
    subdividedBatches: Array.isArray(s.subdividedBatches) ? (s.subdividedBatches as number[]) : [],
    tokensViaSubdivision: Number(s.tokensViaSubdivision) || 0,
    notes: Array.isArray(s.notes) ? (s.notes as string[]) : [],
  };
}

/** Back-compat wrapper. */
export async function addRomanisation(
  transcript: Transcript,
  provider: TransliterationProvider,
  opts: RomanisationOptions = {},
): Promise<RomanisationResult> {
  return romaniseTranscript(transcript, provider, opts);
}

/**
 * Switch the active script.
 *
 * `roman` REQUIRES romanisation to have run. Silently leaving Devanagari on
 * screen when Roman was requested is the worst outcome — it looks like it worked.
 */
export function withScript(transcript: Transcript, script: 'native' | 'roman'): Transcript {
  if (script === 'native') return transcript;

  const missing = transcript.words.filter(
    (w) => isIndicScript(w.text) && (w.roman === undefined || w.roman === ''),
  );
  if (missing.length > 0) {
    throw new CaptionEngineError(
      `Roman script requested but ${missing.length} word(s) have no romanisation ` +
        `(e.g. "${missing[0]!.text}").`,
      'Call romaniseTranscript() before withScript(). This is a pipeline bug.',
    );
  }

  const out = {
    ...transcript,
    words: transcript.words.map((w) => ({ ...w, text: w.roman ?? w.text })),
  };

  // Final guarantee: nothing Indic may survive into Roman output.
  const leftover = out.words.filter((w) => isIndicScript(w.text));
  if (leftover.length > 0) {
    throw new CaptionEngineError(
      `Roman output still contains ${leftover.length} Indic-script word(s), ` +
        `e.g. "${leftover[0]!.text}".`,
      'The transliteration backend returned unconverted text. ' +
        'Try --transliterate local, or add a glossary entry for it.',
    );
  }
  return out;
}

/** Resolve a provider, romanise, switch script, capitalise sentences. */
/**
 * Choose a backend, honouring the fallback policy.
 *
 * The policy only ever widens what is acceptable. It never relaxes the token
 * or timestamp checks, and it never turns a successful romanisation into a
 * native-script one — it applies solely when Roman output is genuinely
 * unavailable.
 */
function resolveWithPolicy(
  requested: string | undefined,
  language: string,
  policy: RomanFallback,
  env: NodeJS.ProcessEnv,
): { provider: TransliterationProvider; fallbackUsed: RomanFallback | null; fallbackReason: string | null } {
  const allowNative = policy === 'native';

  try {
    const p = resolveTransliterator(requested, language, env, {
      allowNativeFallback: allowNative,
      // The policy must reach the backend, not just the choice of backend: a
      // batching provider can support the language and still fail on one batch.
      fallbackPolicy: policy,
    });
    if (p.supports(language)) return { provider: p, fallbackUsed: null, fallbackReason: null };

    // Configured, but does not cover this language.
    const reason = `"${p.name}" does not support "${language}"`;
    return applyPolicy(language, policy, env, reason);
  } catch (err) {
    if (policy === 'error') throw err;
    return applyPolicy(language, policy, env, err instanceof Error ? err.message : String(err));
  }
}

function applyPolicy(
  language: string,
  policy: RomanFallback,
  env: NodeJS.ProcessEnv,
  reason: string,
): { provider: TransliterationProvider; fallbackUsed: RomanFallback | null; fallbackReason: string } {
  if (policy === 'http') {
    if (!env.TRANSLITERATE_URL) {
      throw new CaptionEngineError(
        `--roman-fallback http was requested, but TRANSLITERATE_URL is not set.`,
        `Set it, or choose a different policy:\n` +
          `  export TRANSLITERATE_URL=https://your-service/transliterate\n` +
          `  …or  --roman-fallback native   to keep the original script instead.`,
      );
    }
    return {
      provider: resolveTransliterator('http', language, env),
      fallbackUsed: 'http',
      fallbackReason: reason,
    };
  }

  if (policy === 'native') {
    return {
      provider: new NativeScriptPassthrough(),
      fallbackUsed: 'native',
      fallbackReason: reason,
    };
  }

  throw new CaptionEngineError(
    `Roman output is not available for "${language}".`,
    `${reason}\n\n${explainUnsupported(language, 'local')}`,
  );
}

export async function toRomanScript(
  transcript: Transcript,
  opts: RomanisationOptions = {},
): Promise<RomanisationResult> {
  const language = opts.language ?? transcript.language;
  const policy: RomanFallback = opts.fallback ?? 'error';
  const env = opts.env ?? process.env;

  // Resolve the backend under the fallback policy. Everything below this point
  // is unchanged: the policy decides WHICH provider runs, never whether the
  // alignment checks apply.
  const { provider, fallbackUsed, fallbackReason } = resolveWithPolicy(
    opts.provider, language, policy, env,
  );
  const result = await romaniseTranscript(transcript, provider, opts);

  // Native passthrough must not be dressed up as Roman: leave the script tag
  // and the capitalisation alone so downstream consumers, and the user reading
  // the JSON, can see what they actually got.
  if (fallbackUsed === 'native') {
    return { ...result, fallbackUsed, fallbackReason, keptNativeScript: true };
  }

  const switched = withScript(result.transcript, 'roman');
  return {
    ...result,
    transcript: capitaliseSentences(switched),
    fallbackUsed,
    fallbackReason,
    keptNativeScript: result.keptNativeScript,
  };
}

/**
 * Capitalise the first word and any word after terminal punctuation.
 *
 * Done at transcript level, not in the engine: the engine sees one token at a
 * time and cannot know it begins a sentence. Words the glossary produced with
 * deliberate internal casing (iPhone, YouTube) are left alone.
 */
export function capitaliseSentences(transcript: Transcript): Transcript {
  let startOfSentence = true;
  const words: Word[] = transcript.words.map((w) => {
    if (w.type !== 'word' || w.text.trim() === '') return w;
    const hasInternalCaps = /[a-z][A-Z]/.test(w.text);
    const text = startOfSentence && !hasInternalCaps ? upperFirst(w.text) : w.text;
    startOfSentence = /[.!?।॥]$/.test(w.text.trim());
    return { ...w, text };
  });
  return { ...transcript, words };
}

function upperFirst(s: string): string {
  const chars = [...s];
  const i = chars.findIndex((c) => /\p{L}/u.test(c));
  if (i < 0) return s;
  chars[i] = chars[i]!.toUpperCase();
  return chars.join('');
}

/** Render the token diagnostics as a readable table. */
export function formatDiagnostics(
  diags: TokenDiagnostic[],
  opts: { onlyChanged?: boolean; limit?: number } = {},
): string {
  const rows = opts.onlyChanged ? diags.filter((d) => d.original !== d.final) : diags;
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  const lines = shown.map(
    (d) =>
      `  ${String(d.index).padStart(4)}  ${d.original.padEnd(16)} → ${d.final.padEnd(16)}` +
      `  [${d.stage}${d.language ? ` lang=${d.language}` : ''}]`,
  );
  if (opts.limit && rows.length > opts.limit) {
    lines.push(`  … and ${rows.length - opts.limit} more`);
  }
  return lines.join('\n');
}
