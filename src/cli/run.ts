import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';

import type { CliOptions } from './args.js';
import type { Transcript, Cut, TrimResult, ClipCandidate } from '../types.js';
import { CaptionEngineError, InvalidTranscriptError, NoWordTimingsError } from '../errors.js';
import { probeMedia, assertHasAudio, type MediaInfo } from '../media/probe.js';
import { extractAudio } from '../media/extract.js';
import { assertBinary, FFMPEG, FFPROBE } from '../media/ffmpeg.js';
import { providerFromEnv, assertWordTimings, type AsrProvider } from '../asr/index.js';
import {
  autoTrim, applyTrim, applyHandles, snapCutsToFrames, keepSegments,
  DEFAULT_TRIM_OPTIONS, DEFAULT_CUT_HANDLE_SEC,
} from '../autotrim/index.js';
import { groupIntoCues } from '../captions/group.js';
import { buildAss, buildSrt } from '../captions/ass.js';
import { planCaptionFrames, renderPlannedFrame } from '../captions/svg.js';
import { resolveStyle, resolveOutput } from '../captions/style.js';
import { renderVideo } from '../render/pipeline.js';
import { initShaper } from '../text/shaper.js';
import { getLanguage } from '../config/languages.js';
import {
  fingerprintInput,
  makeStamp,
  verifyStamp,
  explainVerdict,
  transcriptConfigHash,
  cutsConfigHash,
  type ArtifactStamp,
  type InputFingerprint,
} from '../config/fingerprint.js';

export interface Reporter {
  step(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  progress(pct: number, msg: string): void;
  done(msg: string): void;
}

export interface RunResult {
  input: string;
  outputs: Record<string, string>;
  /** Which binaries actually did the work, for reproducible bug reports. */
  tooling: { ffmpeg: string; ffprobe: string; rasteriser: string };
  transcript: { words: number; language: string; provider: string; durationSec: number };
  /** Present when --script roman ran. Separates ASR output from transliteration. */
  transliteration?: {
    provider: string;
    offline: boolean;
    converted: number;
    preserved: number;
    glossaryEntries: number;
    protectedPhrases: Array<{ from: string; to: string }>;
    diagnostics: Array<{ index: number; original: string; final: string; stage: string }>;
  };
  trim?: { cuts: number; restored: number; secondsRemoved: number; trimmedDuration: number };
  clips?: ClipCandidate[];
  workDir: string;
}

function validateTranscript(t: unknown): Transcript {
  if (!t || typeof t !== 'object') {
    throw new InvalidTranscriptError('Transcript file is not a JSON object.');
  }
  const tr = t as Partial<Transcript>;
  if (!Array.isArray(tr.words)) {
    throw new InvalidTranscriptError(
      'Transcript is missing a "words" array.',
      'Expected the schema written by --transcript-out.',
    );
  }
  for (let i = 0; i < tr.words.length; i++) {
    const w = tr.words[i] as Partial<Transcript['words'][number]>;
    if (typeof w?.text !== 'string' || typeof w?.start !== 'number' || typeof w?.end !== 'number') {
      throw new InvalidTranscriptError(
        `Word ${i} is malformed (needs text, start, end).`,
        `Got: ${JSON.stringify(w).slice(0, 120)}`,
      );
    }
    if (w.end < w.start) {
      throw new InvalidTranscriptError(
        `Word ${i} ("${w.text}") ends (${w.end}) before it starts (${w.start}).`,
      );
    }
  }
  if (typeof tr.duration !== 'number' || tr.duration <= 0) {
    throw new InvalidTranscriptError('Transcript has no positive "duration".');
  }
  return tr as Transcript;
}

/**
 * Gather domain vocabulary for the ASR.
 *
 * Combines --keyterms, --keyterms-file, and every English phrase in the
 * glossary. Reusing the glossary is deliberate: the terms you had to correct
 * afterwards are exactly the terms the ASR should have been biased towards in
 * the first place, so the two lists stay in sync for free.
 */
function collectKeyterms(opts: CliOptions): string[] {
  const terms = new Set<string>();
  for (const t of opts.keyterms ?? []) terms.add(t);

  if (opts.keytermsFile) {
    if (!existsSync(opts.keytermsFile)) {
      throw new CaptionEngineError(
        `Keyterms file not found: ${opts.keytermsFile}`,
        'One term per line; blank lines and # comments are ignored.',
      );
    }
    for (const line of readFileSync(opts.keytermsFile, 'utf8').split(/\r?\n/)) {
      const t = line.replace(/\s+#.*$/, '').trim();
      if (t && !t.startsWith('#')) terms.add(t);
    }
  }
  return [...terms];
}

/**
 * Refuse a cached artifact that was not derived from this exact input.
 *
 * The dangerous case is silent, not loud: you re-export a video under the same
 * filename and reuse yesterday's transcript, so the captions are from the
 * previous take and every timestamp is subtly wrong. That must be an error,
 * not a warning.
 *
 * A file with no stamp at all is only warned about — it was written by an
 * earlier version of this tool and refusing it would break existing workflows.
 */
function checkStamp(
  doc: unknown,
  kind: ArtifactStamp['kind'],
  input: InputFingerprint,
  cfgHash: string,
  file: string,
  allowStale: boolean | undefined,
  log: Reporter,
): void {
  const stamp = (doc as { _engine?: ArtifactStamp } | null)?._engine;
  const verdict = verifyStamp(stamp, input, cfgHash);
  if (verdict.ok) return;

  if (verdict.code === 'unstamped') {
    log.warn(
      `${basename(file)} has no input fingerprint (written by an older version). ` +
        `Cannot confirm it belongs to this ${input.name} — verify the result.`,
    );
    return;
  }

  if (allowStale) {
    log.warn(`--allow-stale: using ${basename(file)} anyway. ${verdict.detail}`);
    return;
  }

  const noun = kind === 'cuts' ? 'cut list' : kind;
  throw new CaptionEngineError(
    `Refusing to reuse a ${noun} that does not match this input.`,
    explainVerdict(verdict, file),
  );
}

/**
 * Extract the cut array from a reviewed cut file.
 *
 * Accepts both shapes: the current `{ _engine, cuts: [...] }` document and the
 * bare `[...]` array written by earlier versions. Reading old files must keep
 * working — the stamp is an addition, not a migration.
 */
export function cutsArrayOf(doc: unknown): Array<Partial<Cut>> {
  if (Array.isArray(doc)) return doc as Array<Partial<Cut>>;
  if (doc && typeof doc === 'object' && Array.isArray((doc as { cuts?: unknown }).cuts)) {
    return (doc as { cuts: Array<Partial<Cut>> }).cuts;
  }
  throw new CaptionEngineError(
    'Cut file must contain a JSON array of cuts, or an object with a "cuts" array.',
    'Use the file written by --cuts-out and edit "restored" fields.',
  );
}

/** Merge a reviewed cut list back onto freshly computed cuts, by id. */
function applyReviewedCuts(trim: TrimResult, reviewed: unknown): { restored: number } {
  const byId = new Map<string, boolean>();
  for (const c of cutsArrayOf(reviewed)) {
    if (typeof c?.id === 'string') byId.set(c.id, Boolean(c.restored));
  }
  let restored = 0;
  for (const c of trim.cuts) {
    const r = byId.get(c.id);
    if (r !== undefined) {
      c.restored = r;
      if (r) restored++;
    }
  }
  return { restored };
}

export async function runPipeline(opts: CliOptions, log: Reporter): Promise<RunResult> {
  assertBinary(FFMPEG);
  assertBinary(FFPROBE);

  const inputPath = resolve(opts.input);
  const workDir = opts.workDir
    ? (mkdirSync(opts.workDir, { recursive: true }), resolve(opts.workDir))
    : mkdtempSync(join(tmpdir(), 'caption-engine-work-'));

  log.step(`Inspecting ${basename(inputPath)}`);
  const info: MediaInfo = await probeMedia(inputPath);
  assertHasAudio(info);
  log.info(
    `${info.kind} · ${info.formatName} · ${info.durationSec.toFixed(1)}s` +
      (info.width ? ` · ${info.width}x${info.height}` : '') +
      (info.fps ? ` · ${info.fps}fps` : ''),
  );

  if (opts.language) {
    const lang = getLanguage(opts.language);
    if (!lang) {
      throw new CaptionEngineError(
        `Unsupported language code "${opts.language}".`,
        'Run "caption-engine languages" to see the supported list.',
      );
    }
    if (lang.rendering === 'untested') {
      log.warn(`Rendering for ${lang.name} is UNTESTED. ${lang.notes ?? ''}`);
    }
    if (lang.fillers === 'none' && opts.autoTrim && !opts.keepFillers) {
      log.warn(`No filler lexicon for ${lang.name} — Auto Trim will remove silence only.`);
    }
  }

  // Fingerprint the input once. Every cached artifact is stamped with this and
  // refused if it does not match, so replacing a video while keeping its
  // filename cannot silently reuse the previous take's transcript or cuts.
  const inputFp = await fingerprintInput(inputPath, { durationSec: info.durationSec });
  const trConfig = transcriptConfigHash({
    provider: opts.provider ?? process.env.ASR_PROVIDER ?? 'elevenlabs',
    language: opts.language,
    codeSwitching: opts.codeSwitching,
    keyterms: collectKeyterms(opts),
  });

  const outputs: Record<string, string> = {};
  let usedRasteriser = 'none (no video output)';
  // The transcript exactly as the ASR produced it, before any romanisation.
  let asrTranscript: Transcript | undefined;
  let transliterationReport: import('../transliterate/index.js').RomanisationResult | undefined;
  /** Set when --script roman was requested but the backend cannot handle the language. */
  let transliterationSkipped: string | undefined;
  const wantVideo = opts.format === 'mp4' || opts.format === 'all';
  const wantSrt = opts.format === 'srt' || opts.format === 'all';
  const wantAss = opts.format === 'ass' || opts.format === 'all';
  const wantJson = opts.format === 'json' || opts.format === 'all';

  if (opts.dryRun) {
    log.info('--dry-run: stopping before transcription. Planned work:');
    log.info(`  audio extraction : ${info.hasVideo ? 'yes' : 'yes (re-encode)'}`);
    log.info(`  provider         : ${opts.provider ?? process.env.ASR_PROVIDER ?? 'elevenlabs'}`);
    log.info(`  language         : ${opts.language ?? 'auto-detect'}`);
    log.info(`  auto trim        : ${opts.autoTrim ? 'yes' : 'no'}`);
    log.info(`  outputs          : ${[
      wantVideo && 'mp4', wantSrt && 'srt', wantAss && 'ass', wantJson && 'json',
    ].filter(Boolean).join(', ')}`);
    log.info(`  work dir         : ${workDir}`);
    return {
      input: inputPath, outputs, workDir,
      tooling: { ffmpeg: FFMPEG, ffprobe: FFPROBE, rasteriser: usedRasteriser },
      transcript: { words: 0, language: opts.language ?? 'auto', provider: 'none', durationSec: info.durationSec },
    };
  }

  // ---- Transcript --------------------------------------------------------
  let transcript: Transcript;
  if (opts.transcriptIn) {
    log.step(`Loading transcript from ${opts.transcriptIn}`);
    if (!existsSync(opts.transcriptIn)) {
      throw new CaptionEngineError(`Transcript file not found: ${opts.transcriptIn}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(opts.transcriptIn, 'utf8'));
    } catch (e) {
      throw new InvalidTranscriptError(
        `Could not parse ${opts.transcriptIn}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    checkStamp(parsed, 'transcript', inputFp, trConfig, opts.transcriptIn, opts.allowStale, log);
    transcript = validateTranscript(parsed);
    log.info(
      `${transcript.words.length} words · ${transcript.language}` +
        (transcript.detectedLanguageRaw && transcript.detectedLanguageRaw !== transcript.language
          ? ` (provider said "${transcript.detectedLanguageRaw}")`
          : '') +
        ` · ${transcript.provider}`,
    );
  } else {
    // Hard stop: the `render` subcommand must never reach a paid API. This is a
    // second, independent guard — arg parsing already requires a transcript —
    // so a future refactor cannot quietly reintroduce a billable call.
    if (opts.noAsr) {
      throw new CaptionEngineError(
        'Refusing to transcribe: this invocation is marked no-ASR but no transcript was loaded.',
        'Pass --transcript <file>, or use the normal form if you intend to transcribe.',
      );
    }

    const audioPath = join(workDir, 'audio.wav');
    log.step('Extracting audio (16 kHz mono)');
    await extractAudio(inputPath, audioPath);
    log.info(`→ ${audioPath}`);

    let provider: AsrProvider;
    const prevProvider = process.env.ASR_PROVIDER;
    try {
      if (opts.provider) process.env.ASR_PROVIDER = opts.provider;
      provider = providerFromEnv();
    } finally {
      if (opts.provider) {
        if (prevProvider === undefined) delete process.env.ASR_PROVIDER;
        else process.env.ASR_PROVIDER = prevProvider;
      }
    }

    log.step(`Transcribing with ${provider.name}`);
    if (!provider.supportsWordTimestamps) {
      log.warn(
        `${provider.name} does not return per-word timestamps. ` +
          `Word-timed captions will be rejected after transcription.`,
      );
    }
    const keyterms = collectKeyterms(opts);
    if (keyterms.length) log.info(`${keyterms.length} keyterm(s) sent to the ASR`);
    if (opts.codeSwitching) {
      log.info('code-switching mode: asking the ASR to keep English in Latin script');
    }

    transcript = await provider.transcribe(readFileSync(audioPath), {
      language: opts.language,
      codeSwitching: opts.codeSwitching,
      keyterms: keyterms.length ? keyterms : undefined,
      diarize: false,
    });
    for (const w of transcript.warnings ?? []) log.warn(w);
    const rawNote =
      transcript.detectedLanguageRaw && transcript.detectedLanguageRaw !== transcript.language
        ? ` (provider returned "${transcript.detectedLanguageRaw}", normalised to ISO-639-1)`
        : '';
    log.info(`${transcript.words.length} words · detected ${transcript.language}${rawNote}`);
  }

  try {
    assertWordTimings(transcript);
  } catch {
    throw new NoWordTimingsError(transcript.provider, (transcript.warnings ?? []).join(' '));
  }

  if (opts.transcriptOut) {
    mkdirSync(dirname(resolve(opts.transcriptOut)), { recursive: true });
    // `_engine` rides alongside the transcript rather than inside it, so the
    // schema validator and every existing consumer are unaffected.
    const stamped = { ...transcript, _engine: makeStamp('transcript', inputFp, trConfig) };
    writeFileSync(opts.transcriptOut, JSON.stringify(stamped, null, 2), 'utf8');
    outputs.transcript = resolve(opts.transcriptOut);
    log.info(`transcript → ${outputs.transcript}`);
  }

  // ---- Roman / Hinglish script -------------------------------------------
  //
  // Applied BEFORE Auto Trim and cue grouping so every downstream output — SRT,
  // ASS, JSON and the burned-in MP4 — carries the same text. Doing it later
  // would romanise the video but leave the subtitle files in Devanagari.
  //
  // Timings are not touched: same audio, same word boundaries, only spelling.
  if (opts.script === 'roman') {
    log.step('Transliterating to Roman (Hinglish)');
    const { toRomanScript, formatDiagnostics } = await import('../transliterate/index.js');
    const { resolveTransliterator } = await import('../transliterate/providers.js');
    const before = transcript.words.map((w) => ({ s: w.start, e: w.end }));

    // The detected language may be one the chosen backend cannot romanise
    // (e.g. auto-detected Telugu with the Devanagari-only local engine).
    // Refusing to render at all would be worse than showing native script, so
    // warn loudly and carry on rather than crashing on someone's long render.
    const romanLang = opts.language ?? transcript.language;
    let canRomanise = true;
    try {
      const probe = resolveTransliterator(opts.transliterate, romanLang);
      if (!probe.supports(romanLang)) canRomanise = false;
    } catch (e) {
      canRomanise = false;
      log.warn(e instanceof Error ? e.message : String(e));
    }

    if (!canRomanise) {
      log.warn(
        `Roman output is not available for "${romanLang}" with the selected backend — ` +
          `keeping NATIVE script instead of failing.`,
      );
      log.warn(
        'To get Roman output for this language, configure a model backend:\n' +
          '    export SARVAM_API_KEY=...   then add: --transliterate sarvam',
      );
      transliterationSkipped = romanLang;
    }
  }

  if (opts.script === 'roman' && !transliterationSkipped) {
    const { toRomanScript, formatDiagnostics } = await import('../transliterate/index.js');
    const before = transcript.words.map((w) => ({ s: w.start, e: w.end }));

    // Keep the pre-transliteration transcript so ASR errors stay separable from
    // transliteration errors. Without this, "cheet de" looks like a
    // transliteration bug when the ASR actually produced "चीट डे".
    asrTranscript = { ...transcript, words: transcript.words.map((w) => ({ ...w })) };

    const romanised = await toRomanScript(transcript, {
      provider: opts.transliterate,
      language: opts.language ?? transcript.language,
      glossaryPath: opts.glossary ?? process.env.HINGLISH_GLOSSARY,
      protectEnglish: opts.protectEnglish,
    });
    transcript = romanised.transcript;
    transliterationReport = romanised;

    // Assert the invariant rather than trusting it: a provider that drops or
    // reorders a token would silently desynchronise every caption.
    if (transcript.words.length !== before.length) {
      throw new CaptionEngineError(
        `Transliteration changed the word count (${before.length} → ${transcript.words.length}).`,
        'This is a provider bug. Use --transliterate local.',
      );
    }
    for (let i = 0; i < before.length; i++) {
      const w = transcript.words[i]!;
      if (w.start !== before[i]!.s || w.end !== before[i]!.e) {
        throw new CaptionEngineError(
          `Transliteration altered the timestamp of word ${i} ("${w.text}").`,
          'Romanisation must never change timings. This is a pipeline bug.',
        );
      }
    }

    const q = romanised.offline ? 'offline rules — lower quality on loanwords' : 'model';
    log.info(`provider   ${romanised.provider} (${q})`);
    log.info(`glossary   ${romanised.glossarySize} entries, ${romanised.glossaryHits.length} phrase hit(s)`);
    log.info(
      `tokens     ${romanised.converted} romanised, ${romanised.preserved} preserved ` +
        `(English/protected)`,
    );

    // A backend that split the transcript into requests reports what happened.
    // Batches that fell back are called out rather than averaged away: the run
    // succeeded, but those words are offline-quality, not model-quality.
    if (romanised.batching) {
      const b = romanised.batching;
      log.info(
        `batching   ${b.batches} request(s), largest ${b.largestInputChars} chars` +
          (b.retries ? `, ${b.retries} retr${b.retries === 1 ? 'y' : 'ies'}` : ''),
      );
      if (b.fallbackBatches > 0) {
        log.warn(
          `${b.fallbackBatches} of ${b.batches} batch(es) could not be romanised by ` +
            `${romanised.provider} — ${b.tokensViaFallback} word(s) fell back to the offline ` +
            `engine. Those words are lower quality on English loanwords.`,
        );
        for (const n of b.notes.slice(0, 5)) log.warn(`   ${n}`);
        if (b.notes.length > 5) log.warn(`   … and ${b.notes.length - 5} more`);
      }
    }

    const mapped = romanised.glossaryHits.filter((h) => h.kind === 'mapping');
    if (mapped.length) {
      log.info('protected English phrases:');
      for (const h of mapped.slice(0, 10)) {
        log.info(`   ${h.from.join(' ')} → ${h.to.join(' ')}`);
      }
      if (mapped.length > 10) log.info(`   … and ${mapped.length - 10} more`);
    }

    if (opts.showDiagnostics) {
      log.info('token diagnostics (original → final):');
      for (const line of formatDiagnostics(romanised.diagnostics).split('\n')) log.info(line);
    } else {
      const changed = romanised.diagnostics.filter((d) => d.original !== d.final).length;
      log.info(`${changed} token(s) changed — run with --diagnostics for the full table`);
    }

    const sample = transcript.words.slice(0, 10).map((w) => w.text).join(' ');
    if (sample) log.info(`e.g. "${sample}${transcript.words.length > 10 ? ' …' : ''}"`);
  }

  // ---- Auto Trim ---------------------------------------------------------
  let workingTranscript = transcript;
  let segments: Array<{ start: number; end: number }> | undefined;
  let trimSummary: RunResult['trim'];

  if (opts.autoTrim) {
    log.step('Auto Trim');
    const cutsCfg = cutsConfigHash({
      trimSilence: opts.trimSilence,
      keepFillers: opts.keepFillers,
      language: transcript.language,
    });
    const trim = autoTrim(transcript, {
      ...DEFAULT_TRIM_OPTIONS,
      maxSilenceSec: opts.trimSilence,
      removeFillers: !opts.keepFillers,
      removeFalseStarts: !opts.keepFillers,
    });

    let restored = 0;
    if (opts.cutsIn) {
      if (!existsSync(opts.cutsIn)) {
        throw new CaptionEngineError(`Cut file not found: ${opts.cutsIn}`);
      }
      const reviewed = JSON.parse(readFileSync(opts.cutsIn, 'utf8'));
      checkStamp(reviewed, 'cuts', inputFp, cutsCfg, opts.cutsIn, opts.allowStale, log);
      restored = applyReviewedCuts(trim, reviewed).restored;
      log.info(`applied review: ${restored} cut(s) restored`);
    }

    if (opts.cutsOut) {
      mkdirSync(dirname(resolve(opts.cutsOut)), { recursive: true });
      writeFileSync(
        opts.cutsOut,
        JSON.stringify({ _engine: makeStamp('cuts', inputFp, cutsCfg), cuts: trim.cuts }, null, 2),
        'utf8',
      );
      outputs.cuts = resolve(opts.cutsOut);
      log.info(`cut list → ${outputs.cuts}  (set "restored": true to keep a cut)`);
    }

    // Shape the cuts BEFORE reporting them.
    //
    // Handles and frame snapping both change how much is actually removed, so
    // computing the summary from the raw proposals would print numbers that do
    // not match the file the user ends up with. `--cuts-out` above deliberately
    // records the unshaped proposals: those are what the reviewer reasons about
    // and what `--cuts-in` matches by id.
    const handleSec = opts.cutHandles ?? DEFAULT_CUT_HANDLE_SEC;
    const shaped = snapCutsToFrames(applyHandles(trim, handleSec), info.fps);

    if (handleSec > 0 || info.fps) {
      const kept = trim.secondsRemoved - shaped.secondsRemoved;
      if (kept > 0.001) {
        log.info(
          `smooth cuts: ${(handleSec * 1000).toFixed(0)}ms handles` +
            (info.fps ? ` + ${info.fps}fps snapping` : '') +
            ` — keeping ${kept.toFixed(2)}s more audio`,
        );
      }
      const dropped = trim.cuts.length - shaped.cuts.length;
      if (dropped > 0) log.info(`  ${dropped} cut(s) too short to make safely — skipped`);
    }

    const active = shaped.cuts.filter((c) => !c.restored);
    // Recompute from the post-review, post-shaping cut set so the reported
    // numbers match what will actually be rendered.
    const removed = active.reduce((n, c) => n + (c.end - c.start), 0);

    // Break the summary down by reason. A bare total hides the thing users
    // actually want to sanity-check: how much is silence versus how many real
    // words were removed.
    const byReason = new Map<string, { n: number; secs: number }>();
    for (const c of active) {
      const e = byReason.get(c.reason) ?? { n: 0, secs: 0 };
      e.n++; e.secs += c.end - c.start;
      byReason.set(c.reason, e);
    }

    log.info(
      `${trim.cuts.length} cut(s) proposed, ${restored} restored, ${active.length} active`,
    );
    for (const reason of ['silence', 'filler', 'false_start', 'low_confidence']) {
      const e = byReason.get(reason);
      if (e) log.info(`   ${reason.padEnd(14)} ${String(e.n).padStart(3)} cut(s)  ${e.secs.toFixed(1)}s`);
    }
    log.info(
      `   ${'TOTAL'.padEnd(14)} ${String(active.length).padStart(3)} cut(s)  ${removed.toFixed(1)}s  ` +
        `(${transcript.duration.toFixed(1)}s → ${(transcript.duration - removed).toFixed(1)}s)`,
    );

    const listLimit = opts.reviewCuts ? active.length : 8;
    for (const c of active.slice(0, listLimit)) {
      log.info(`  ${c.id.padEnd(16)} ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ${c.reason.padEnd(13)} ${c.label}`);
    }
    if (active.length > listLimit) log.info(`  ... and ${active.length - listLimit} more`);

    if (opts.reviewCuts) {
      if (!opts.cutsOut) {
        throw new CaptionEngineError(
          '--review-cuts needs --cuts-out <file> to write the proposals to.',
          'Example:\n' +
            '  caption-engine in.mp4 --transcript-in t.json --review-cuts --cuts-out cuts.json',
        );
      }
      log.step('Review mode — stopping before render');
      log.info(`Edit ${outputs.cuts}: set "restored": true on any cut you want to KEEP.`);
      log.info('Then render with the reviewed list:');
      log.info(
        `  caption-engine ${basename(inputPath)} --transcript-in <transcript> ` +
          `--auto-trim --cuts-in ${opts.cutsOut} -o out.mp4`,
      );
      return {
        input: inputPath,
        outputs,
        workDir,
        tooling: { ffmpeg: FFMPEG, ffprobe: FFPROBE, rasteriser: 'none (review mode)' },
        transcript: {
          words: transcript.words.length,
          language: transcript.language,
          provider: transcript.provider,
          durationSec: transcript.duration,
        },
        trim: {
          cuts: trim.cuts.length,
          restored,
          secondsRemoved: Math.round(removed * 1000) / 1000,
          trimmedDuration: Math.round((transcript.duration - removed) * 1000) / 1000,
        },
      };
    }

    // Captions and segments both come from `shaped`, so audio, video and text
    // are derived from one set of frame-aligned boundaries.
    workingTranscript = applyTrim(transcript, shaped);
    segments = keepSegments(shaped);
    trimSummary = {
      cuts: trim.cuts.length,
      restored,
      secondsRemoved: Math.round(removed * 1000) / 1000,
      trimmedDuration: Math.round((transcript.duration - removed) * 1000) / 1000,
    };
  }

  // ---- Cues --------------------------------------------------------------
  log.step('Building caption cues');
  const cues = groupIntoCues(workingTranscript, {
    maxWordsPerCue: opts.maxWordsPerCue ?? 4,
  });
  if (cues.length === 0) {
    throw new CaptionEngineError(
      'No caption cues were produced — the transcript contains no usable words.',
      'The audio may be silent, music-only, or in a language the provider could not detect. ' +
        'Try specifying --language explicitly.',
    );
  }
  log.info(`${cues.length} cues`);

  const outBase = opts.output
    ? resolve(opts.output)
    : join(process.cwd(), `${basename(inputPath, extname(inputPath))}-captioned.mp4`);
  mkdirSync(dirname(outBase), { recursive: true });
  const stem = join(dirname(outBase), basename(outBase, extname(outBase)));

  // ---- Subtitle exports --------------------------------------------------
  const { width, height } = resolveOutput(opts.aspect, info);
  const style = resolveStyle(opts.style, height, {
    ...(opts.fontSize !== undefined ? { fontSizePx: opts.fontSize } : {}),
    ...(opts.positionY !== undefined ? { positionY: opts.positionY } : {}),
    ...(opts.maxWordsPerCue !== undefined ? { maxWordsPerCue: opts.maxWordsPerCue } : {}),
  });

  if (wantSrt) {
    const p = opts.format === 'srt' && opts.output ? outBase : `${stem}.srt`;
    writeFileSync(p, buildSrt(cues), 'utf8');
    outputs.srt = p;
    log.info(`srt → ${p}`);
  }
  if (wantAss) {
    const p = opts.format === 'ass' && opts.output ? outBase : `${stem}.ass`;
    writeFileSync(
      p,
      buildAss(cues, {
        video: { width, height },
        style,
        highlight: opts.highlight === 'none' ? 'none' : 'active-word',
      }),
      'utf8',
    );
    outputs.ass = p;
    log.info(`ass → ${p}`);
    log.info('  note: .ass relies on the player/editor for shaping. For guaranteed');
    log.info('        Indic rendering use the burned-in mp4.');
  }
  if (wantJson) {
    const p = opts.format === 'json' && opts.output ? outBase : `${stem}.json`;
    writeFileSync(
      p,
      JSON.stringify(
        {
          // Both transcripts, separately. If a word looks wrong, this tells you
          // immediately whether the ASR produced it or transliteration did.
          asrTranscript: asrTranscript ?? workingTranscript,
          transcript: workingTranscript,
          transliteration: transliterationReport
            ? {
                provider: transliterationReport.provider,
                offline: transliterationReport.offline,
                glossaryEntries: transliterationReport.glossarySize,
                diagnostics: transliterationReport.diagnostics,
              }
            : undefined,
          cues,
          trim: trimSummary,
        },
        null,
        2,
      ),
      'utf8',
    );
    outputs.json = p;
    log.info(`json → ${p}`);
  }

  // ---- Clips -------------------------------------------------------------
  let clips: ClipCandidate[] | undefined;
  if (opts.clips) {
    log.step('Finding clips');
    const { findClips } = await import('../clips/score.js');
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      log.warn('ANTHROPIC_API_KEY not set — skipping clip detection.');
    } else {
      const { makeAnthropicCompletion } = await import('../clips/llm.js');
      clips = await findClips(workingTranscript, makeAnthropicCompletion(key), {
        language: opts.language ?? workingTranscript.language,
      });
      log.info(`${clips.length} clip candidates`);
      for (const c of clips) {
        log.info(`  ${c.score.toString().padStart(3)}  ${c.start.toFixed(1)}-${c.end.toFixed(1)}s  ${c.title}`);
      }
      const p = `${stem}.clips.json`;
      writeFileSync(p, JSON.stringify(clips, null, 2), 'utf8');
      outputs.clips = p;
      log.info(`clips → ${p}`);
    }
  }

  // ---- Video -------------------------------------------------------------
  if (wantVideo) {
    await initShaper();

    // Prove the rasteriser works BEFORE generating frames. Previously this only
    // failed on the first rasterisation attempt, after all the SVG work — the
    // user saw "Failed to rasterise caption frame 0" with no idea why.
    const { selectRasteriser } = await import('../render/rasteriser.js');
    const { rasteriser, probes } = await selectRasteriser(opts.rasteriser);
    usedRasteriser = rasteriser.name;
    log.step('Checking render dependencies');
    log.info(`ffmpeg     ${FFMPEG}`);
    log.info(`rasteriser ${rasteriser.name} — ${rasteriser.description}`);
    for (const p of probes.filter((x) => !x.functional)) {
      log.info(`  (${p.name} unavailable: ${p.detail})`);
    }

    log.step(`Planning caption frames (${width}x${height})`);
    // Plan first, generate each SVG only as it is rasterised. Holding every SVG
    // costs ~106 MB of heap on a 30-minute video and scales linearly; this keeps
    // peak memory flat regardless of length.
    const svgOpts = {
      width, height, style,
      activeScale: opts.activeScale,
      highlight: opts.highlight,
    };
    const plans = planCaptionFrames(cues, { width, height, highlight: opts.highlight });
    log.info(`${plans.length} caption frames`);

    const frameSource = {
      count: plans.length,
      plans,
      async get(i: number) {
        const p = plans[i]!;
        return { ...p, svg: await renderPlannedFrame(cues, p, svgOpts) };
      },
    };

    const durationSec = trimSummary?.trimmedDuration ?? info.durationSec;
    const outPath = outBase.endsWith('.mp4') ? outBase : `${stem}.mp4`;

    log.step('Encoding video');
    await renderVideo({
      inputPath,
      outputPath: outPath,
      width, height,
      fps: opts.fps,
      segments,
      cutFadeSec: opts.cutFade,
      frames: frameSource,
      hasAudio: info.hasAudio,
      cropFocusX: opts.cropFocusX,
      crf: opts.crf,
      preset: opts.preset,
      durationSec,
      backgroundColor: info.hasVideo ? undefined : '#101418',
      onProgress: (pct, msg) => log.progress(pct, msg),
    });
    outputs.mp4 = outPath;
    log.info(`mp4 → ${outPath}`);
  }

  return {
    input: inputPath,
    outputs,
    tooling: { ffmpeg: FFMPEG, ffprobe: FFPROBE, rasteriser: usedRasteriser },
    workDir,
    transcript: {
      words: transcript.words.length,
      language: transcript.language,
      provider: transcript.provider,
      durationSec: transcript.duration,
    },
    transliteration: transliterationReport
      ? {
          provider: transliterationReport.provider,
          offline: transliterationReport.offline,
          converted: transliterationReport.converted,
          preserved: transliterationReport.preserved,
          glossaryEntries: transliterationReport.glossarySize,
          protectedPhrases: transliterationReport.glossaryHits
            .filter((h) => h.kind === 'mapping')
            .map((h) => ({ from: h.from.join(' '), to: h.to.join(' ') })),
          diagnostics: transliterationReport.diagnostics.filter((d) => d.original !== d.final),
        }
      : undefined,
    trim: trimSummary,
    clips,
  };
}
