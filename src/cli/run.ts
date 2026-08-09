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
  analyseFillerCandidates, decideFillers, summariseVerdicts, formatEvidenceTable,
} from '../autotrim/index.js';
import { analyzeAudio, type AudioAnalysis } from '../media/audio-analysis.js';
import { analyzeProsody, type ProsodyAnalysis } from '../media/prosody.js';
import { loadProsodyCache, saveProsodyCache } from '../media/prosody-cache.js';
import {
  loadCaptionTheme, toneStyleFor, formatProsodyDiagnostics, NEUTRAL_THEME,
  type ToneStyle, type ProsodyDiagnosticRow,
} from '../captions/tone-style.js';
import { resolveWordStyle } from '../captions/active.js';
import { groupIntoCues } from '../captions/group.js';
import { buildAss, buildSrt } from '../captions/ass.js';
import { planCaptionFrames, renderPlannedFrame } from '../captions/svg.js';
import { resolveStyle, resolveOutput } from '../captions/style.js';
import { renderVideo } from '../render/pipeline.js';
import { initShaper } from '../text/shaper.js';
import { listFontFamilies } from '../text/fonts.js';
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

  // "auto" is not a language code — it is the instruction to detect one.
  const languageIsAuto = (opts.language ?? '').toLowerCase() === 'auto';
  if (opts.language && !languageIsAuto) {
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
  let detection: import('../transliterate/detect.js').LanguageDetection | undefined;
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
      language: languageIsAuto ? undefined : opts.language,
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

  // ---- Roman script -------------------------------------------------------
  //
  // Roman output is `detected source language + Roman script`. It is NOT a
  // single "Hinglish" mode — Hinglish is what that combination is called when
  // the source language is Hindi, and nothing more. Kannada romanised is still
  // Kannada.
  //
  // Applied BEFORE Auto Trim and cue grouping so every downstream output — SRT,
  // ASS, JSON and the burned-in MP4 — carries the same text. Doing it later
  // would romanise the video but leave the subtitle files in their native script.
  //
  // Timings are not touched: same audio, same word boundaries, only spelling.
  if (opts.script === 'roman') {
    log.step('Transliterating to Roman script');
    const { detectLanguage, isLowConfidence } = await import('../transliterate/detect.js');
    const { resolveTransliterator } = await import('../transliterate/providers.js');
    const { providerSupports, explainUnsupported } = await import('../transliterate/capabilities.js');

    // ---- Language ---------------------------------------------------------
    // An explicit --language always wins; "auto" or omitted means detect.
    const explicit = opts.language && opts.language.toLowerCase() !== 'auto'
      ? opts.language
      : undefined;
    detection = detectLanguage(transcript, { explicit });
    const romanLang = detection.language;

    const langName = getLanguage(romanLang)?.name ?? romanLang ?? 'unknown';
    log.info(
      `Detected language: ${langName} (${romanLang || '?'})   ` +
        `[${detection.source}${detection.source === 'explicit' ? '' : `, confidence ${detection.confidence.toFixed(2)}`}]`,
    );
    if (detection.alternatives.length > 0) {
      log.info(`  also plausible: ${detection.alternatives.join(', ')} — same script`);
    }
    for (const w of detection.warnings) log.warn(w);
    if (isLowConfidence(detection)) {
      log.warn(
        `Language detection confidence is ${detection.confidence.toFixed(2)}. ` +
          `Pass --language ${romanLang || '<code>'} to be certain.`,
      );
    }

    if (!romanLang) {
      if (opts.romanFallback === 'error') {
        throw new CaptionEngineError(
          'Roman output was requested but no language could be determined.',
          'Pass --language explicitly, e.g. --language hi, or use --roman-fallback native.',
        );
      }
      log.warn('No language could be determined — keeping NATIVE script.');
      transliterationSkipped = 'unknown';
    }

    // ---- Already Roman: nothing to transliterate ---------------------------
    // A Latin-script source language (English, most obviously) is already in
    // Roman letters. Demanding a transliteration backend for it would kill an
    // otherwise correct `--language auto` run the moment the video turned out
    // not to be Indic. toRomanScript returns the transcript untouched; the
    // capability probe below must not fire first.
    const { romanMode } = await import('../transliterate/roman-mode.js');
    if (romanLang && romanMode(romanLang).alreadyRoman) {
      log.info(
        `${getLanguage(romanLang)?.name ?? romanLang} is already written in Roman letters — ` +
          `nothing to transliterate.`,
      );
    }

    // ---- Provider capability, checked BEFORE any request ------------------
    if (!transliterationSkipped && !(romanLang && romanMode(romanLang).alreadyRoman)) {
      const chosen = opts.transliterate ?? 'auto';
      let available = false;
      let why = '';
      try {
        const probe = resolveTransliterator(
          opts.transliterate, romanLang, process.env,
          {
            allowNativeFallback: opts.romanFallback === 'native',
            fallbackPolicy: opts.romanFallback,
          },
        );
        available = probe.supports(romanLang);
        if (!available) why = `"${probe.name}" does not cover ${romanLang}`;
      } catch (e) {
        available = false;
        why = e instanceof Error ? e.message : String(e);
      }

      if (!available) {
        if (opts.romanFallback === 'error') {
          // Default. Refusing beats rendering something that looks fine to
          // anyone who cannot read the script.
          throw new CaptionEngineError(
            `Roman output is not available for "${romanLang}".`,
            `${why}\n\n${explainUnsupported(romanLang, chosen === 'auto' ? 'local' : chosen as never)}`,
          );
        }
        // 'native' and 'http' are NOT short-circuited here. Both are handled
        // inside toRomanScript so that every path — success, native fallback,
        // http fallback — produces the same run-summary block and the same
        // "output is still in the original script" warning. Skipping the call
        // would skip the reporting, which is the one thing that must not
        // happen when the user asked for Roman and is not getting it.
        log.warn(`Roman output unavailable (${why}) — applying --roman-fallback ${opts.romanFallback}.`);
      }
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
      // Detection already ran above and honoured any explicit --language.
      language: detection?.language ?? opts.language ?? transcript.language,
      glossaryPath: opts.glossary ?? process.env.HINGLISH_GLOSSARY,
      protectEnglish: opts.protectEnglish,
      fallback: opts.romanFallback,
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

    // ---- Run summary -------------------------------------------------------
    // One block the user can paste into a bug report, answering: what language
    // did it think this was, which mode did that put it in, which backend ran,
    // and did anything degrade?
    //
    // "Transliteration mode" is the line that matters most here. It names the
    // SOURCE language, so a Kannada video that was wrongly routed through Hindi
    // would be visible at a glance instead of hiding behind a generic label
    // that says "Hinglish" no matter what ran.
    const m = romanised.mode;
    log.info(`Detected language:  ${m.languageName} (${m.language || '?'})`);
    log.info(`Output script:      Roman`);
    log.info(`Transliteration:    ${m.label}`);
    log.info(`Provider:           ${romanised.provider}`);
    log.info(`English protection: ${opts.protectEnglish ? 'enabled' : 'DISABLED'}`);
    log.info(`Code-switching:     ${opts.codeSwitching ? 'enabled' : 'disabled'}`);
    log.info(`Batches:            ${romanised.batching?.batches ?? 1}`);
    log.info(`Fallback:           ${romanised.fallbackUsed ?? 'none'}` +
      (romanised.fallbackReason ? `  (${romanised.fallbackReason})` : ''));

    // The source language must survive romanisation. Changing the script does
    // not change the language, and anything downstream that keys off it (fonts,
    // filler lexicons, the JSON output) would silently misbehave if it did.
    if (detection?.language && transcript.language !== asrTranscript.language) {
      throw new CaptionEngineError(
        `Romanisation changed the transcript language from "${asrTranscript.language}" ` +
          `to "${transcript.language}".`,
        'Romanisation changes the script, never the source language. This is a pipeline bug.',
      );
    }

    // The single most important line in this block: the user asked for Roman
    // and some or all of the output is not Roman. Never let that pass quietly.
    if (romanised.keptNativeScript) {
      const nb = romanised.batching?.nativeBatches ?? [];
      log.warn(
        'SOME OUTPUT IS STILL IN THE ORIGINAL SCRIPT despite --script roman.' +
          (nb.length ? `  Batch(es) ${nb.join(', ')} kept native script.` : ''),
      );
    }

    const q = romanised.offline ? 'offline rules — lower quality on loanwords' : 'model';
    log.info(`provider   ${romanised.provider} (${q})`);
    log.info(
      `glossary   ${romanised.glossarySize} entries applicable to ${m.languageName}, ` +
        `${romanised.glossaryHits.length} phrase hit(s)`,
    );
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

      // Bisection is a success story, not a failure: these words would have
      // killed the run before. Reported all the same, because it means the
      // backend is mis-delimiting and it costs extra requests.
      if (b.subdividedBatches.length > 0) {
        log.info(
          `alignment  batch(es) ${b.subdividedBatches.join(', ')} came back mis-delimited and ` +
            `were split into smaller requests — ${b.subdivisionRequests} extra request(s), ` +
            `${b.tokensViaSubdivision} word(s) recovered`,
        );
      }

      if (b.fallbackBatches > 0) {
        const via = b.tokensViaFallback > 0
          ? `${b.tokensViaFallback} word(s) were romanised by the fallback provider`
          : '';
        const kept = b.tokensViaNative > 0
          ? `${b.tokensViaNative} word(s) kept their original script`
          : '';
        log.warn(
          `${b.fallbackBatches} batch fallback(s) while romanising with ${romanised.provider} — ` +
            [via, kept].filter(Boolean).join(', ') + '.',
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
      // Part of the cache key: the same input trimmed with and without measured
      // audio legitimately yields different cuts, so a --cuts-in written by one
      // must not be silently reused by the other.
      audioAnalysis: !opts.noAudioAnalysis,
      fillerConfidence: opts.fillerConfidence ?? null,
    });

    // Measured audio evidence. Local FFmpeg only — three extra passes over the
    // audio, which is why --no-audio-analysis exists for long files.
    let audio: AudioAnalysis | null = null;
    if (!opts.noAudioAnalysis) {
      log.info('measuring audio (silence, level, per-window energy)…');
      audio = await analyzeAudio(inputPath, info.durationSec);
      if (audio.available) {
        log.info(
          `noise floor ${audio.noiseDb} dB (from mean ${audio.volume.meanDb ?? '?'} dB), ` +
          `${audio.silences.length} silence region(s)`,
        );
      } else {
        log.warn(`audio analysis unavailable: ${audio.unavailableReason}`);
        log.warn('falling back to ASR-gap evidence; ambiguous fillers will be offered for review');
        audio = null;
      }
    } else {
      log.info('--no-audio-analysis: using ASR gaps only (weaker evidence)');
    }

    const trimOptions = {
      ...DEFAULT_TRIM_OPTIONS,
      maxSilenceSec: opts.trimSilence,
      removeFillers: !opts.keepFillers,
      removeFalseStarts: !opts.keepFillers,
      minCutConfidence: opts.minCutConfidence ?? DEFAULT_TRIM_OPTIONS.minCutConfidence,
      audio,
      minFillerDurationSec: opts.minFillerDuration ?? DEFAULT_TRIM_OPTIONS.minFillerDurationSec,
      maxFillerDurationSec: opts.maxFillerDuration ?? DEFAULT_TRIM_OPTIONS.maxFillerDurationSec,
      fillerConfidence: opts.fillerConfidence ?? DEFAULT_TRIM_OPTIONS.fillerConfidence,
    };

    // Evidence-only mode: print Pass 1 and stop. Nothing is cut, nothing is
    // rendered, so this is always safe to run on a file you care about.
    if (opts.analyzeFillerCandidates) {
      const evidence = analyseFillerCandidates(transcript, audio, {
        minFillerDurationSec: trimOptions.minFillerDurationSec,
        maxFillerDurationSec: trimOptions.maxFillerDurationSec,
      });
      const verdicts = decideFillers(evidence, {
        minFillerDurationSec: trimOptions.minFillerDurationSec,
        maxFillerDurationSec: trimOptions.maxFillerDurationSec,
        pauseWindowSec: trimOptions.ambiguousPauseWindowSec,
        lowConfidence: trimOptions.lowConfidenceThreshold,
        minAutoCutConfidence: trimOptions.fillerConfidence,
      });
      const s = summariseVerdicts(verdicts);
      log.step('Filler candidates (Pass 1 evidence)');
      console.log(formatEvidenceTable(evidence));
      log.step('Verdicts (Pass 2)');
      for (const v of verdicts) {
        console.log(
          `  [${v.decision.padEnd(15)}] ${String(v.evidence.originalToken).padEnd(14)} ` +
          `conf ${v.confidence.toFixed(2)}  ${v.reason}`,
        );
      }
      log.info(
        `${s.total} candidate(s): ${s.proposeCut} propose-cut, ` +
        `${s.reviewRequired} review-required, ${s.keep} keep`,
      );
      if (!audio) log.warn('measured without audio evidence — verdicts are weaker than they could be');
      return {
        input: inputPath, outputs: {}, workDir,
        tooling: { ffmpeg: FFMPEG, ffprobe: FFPROBE, rasteriser: usedRasteriser },
        transcript: {
          words: transcript.words.length,
          language: transcript.language,
          provider: transcript.provider,
          durationSec: transcript.duration,
        },
      };
    }

    const trim = autoTrim(transcript, trimOptions);
    if (opts.minCutConfidence) {
      log.info(`--min-cut-confidence ${opts.minCutConfidence}: lower-confidence proposals suppressed`);
    }

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

    // Least confident first. With forty proposals the reviewer's whole job is
    // finding the handful worth arguing with, and those are at the bottom of
    // the confidence range — not the top of the timeline.
    const listLimit = opts.reviewCuts ? active.length : 8;
    const byRisk = [...active].sort((a, b) => a.confidence - b.confidence);
    if (active.length > 0) log.info('  cuts, least confident first:');
    for (const c of byRisk.slice(0, listLimit)) {
      const words = c.sourceWords.length ? `“${c.sourceWords.join(' ')}”` : '(silence)';
      log.info(
        `  ${c.id.padEnd(16)} ${c.start.toFixed(2)}-${c.end.toFixed(2)}  ` +
          `${String(Math.round(c.confidence * 100)).padStart(3)}%  ` +
          `${c.category.padEnd(13)} ${words}`,
      );
    }
    if (active.length > listLimit) log.info(`  ... and ${active.length - listLimit} more`);

    const shaky = active.filter((c) => c.confidence < 0.6);
    if (shaky.length > 0 && !opts.reviewCuts) {
      log.warn(
        `${shaky.length} cut(s) below 60% confidence — review with --review-cuts, ` +
          `or suppress with --min-cut-confidence 0.6`,
      );
    }

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

  // ---- Local audio prosody -------------------------------------------------
  //
  // Opt-in via --prosody. Everything here is local: FFmpeg decodes the audio to
  // 16 kHz mono PCM and the F0 estimation is our own YIN implementation
  // (src/media/pitch.ts). No service is contacted and nothing is uploaded.
  //
  // With the flag absent, `toneStylesByCue` stays undefined and every word
  // resolves through exactly the same path it did before this feature existed.
  let prosody: ProsodyAnalysis | null = null;
  let theme = NEUTRAL_THEME;
  let toneStylesByCue: Map<number, Map<number, ToneStyle>> | undefined;

  if (opts.prosody) {
    log.step('Analysing local audio prosody (loudness + F0 pitch)');
    theme = loadCaptionTheme(opts.captionTheme);
    log.info(`theme ${theme.source} (minConfidence ${theme.minConfidence})`);

    const cacheKey = `${inputFp.sha256}-${theme.version}`;
    const cached = loadProsodyCache(cacheKey);
    if (cached) {
      prosody = cached;
      log.info('reusing cached prosody measurements (local cache, no re-analysis)');
    } else {
      // Pitch needs a fourth FFmpeg pass over the audio, hence its own call
      // rather than reusing Auto Trim's analysis.
      const withPitch = await analyzeAudio(inputPath, info.durationSec, { pitch: true });
      prosody = analyzeProsody(transcript, withPitch);
      if (prosody.available) saveProsodyCache(cacheKey, prosody);
    }

    if (!prosody.available) {
      log.warn(`prosody unavailable: ${prosody.reason ?? 'no measurement'} — captions use the base style`);
    } else {
      const voiced = prosody.words.filter((w) => w.features.f0Hz !== undefined).length;
      log.info(
        `${prosody.words.length} word(s) measured, ${voiced} with a usable F0 reading`,
      );
      if (voiced === 0) {
        log.warn(
          'no pitch could be measured — tone falls back to loudness and rate only, ' +
            'which is a weaker signal',
        );
      }
      const counts = new Map<string, number>();
      for (const w of prosody.words) counts.set(w.tone, (counts.get(w.tone) ?? 0) + 1);
      log.info(
        'tones: ' + [...counts.entries()].map(([t, n]) => `${t} ${n}`).join(', '),
      );

      // Map prosody (indexed over kept words) onto cue-local word indices.
      toneStylesByCue = new Map();
      const byTime = new Map<string, (typeof prosody.words)[number]>();
      for (const w of prosody.words) byTime.set(`${w.start}:${w.end}`, w);
      let styled = 0;
      for (const cue of cues) {
        const forCue = new Map<number, ToneStyle>();
        cue.words.forEach((word, i) => {
          const p = byTime.get(`${word.start}:${word.end}`);
          if (!p) return;
          const style = toneStyleFor(theme, p.tone, p.confidence);
          if (style) { forCue.set(i, style); styled++; }
        });
        if (forCue.size > 0) toneStylesByCue.set(cue.index, forCue);
      }
      log.info(`${styled} word(s) styled by tone (the rest keep the base style)`);

      // ---- --diagnostics: the full per-word table --------------------------
      // Works entirely offline: it needs a transcript and local audio, never
      // an API. Measurements and style decisions only — nothing secret.
      if (opts.showDiagnostics) {
        const baseStyle = resolveStyle(opts.style, resolveOutput(opts.aspect, info).height, {
          ...(opts.font !== undefined ? { fontFamily: opts.font } : {}),
          ...(opts.activeColor !== undefined ? { activeColor: opts.activeColor } : {}),
          ...(opts.fontSize !== undefined ? { fontSizePx: opts.fontSize } : {}),
        });
        const rows: ProsodyDiagnosticRow[] = prosody.words.map((w) => {
          const toneStyle = toneStyleFor(theme, w.tone, w.confidence);
          const resolved = resolveWordStyle(baseStyle, false, {
            activeScale: opts.activeScale,
            activeBold: opts.activeBold,
            ...(toneStyle ? { tone: toneStyle } : {}),
          });
          return {
            index: w.index,
            word: transcript.words[w.index]?.text ?? '',
            start: w.start,
            end: w.end,
            rmsDb: w.features.rmsDb,
            f0Hz: w.features.f0Hz ?? null,
            speakingRate: w.features.speakingRate,
            tone: w.tone,
            confidence: w.confidence,
            font: resolved.fontFamily,
            bold: resolved.bold,
            scale: resolved.scale,
            color: resolved.color,
            styled: toneStyle !== undefined,
          };
        });
        log.info('prosody diagnostics (local measurements → resolved style):');
        for (const line of formatProsodyDiagnostics(rows).split('\n')) log.info(line);
        log.info(
          '  F0 "—" means no usable pitch reading: unvoiced, too quiet, or too ' +
            'noisy. Absent is NOT low pitch.',
        );
      }
    }
  }

  const outBase = opts.output
    ? resolve(opts.output)
    : join(process.cwd(), `${basename(inputPath, extname(inputPath))}-captioned.mp4`);
  mkdirSync(dirname(outBase), { recursive: true });
  const stem = join(dirname(outBase), basename(outBase, extname(outBase)));

  // ---- Subtitle exports --------------------------------------------------
  const { width, height } = resolveOutput(opts.aspect, info);
  const style = resolveStyle(opts.style, height, {
    ...(opts.font !== undefined ? { fontFamily: opts.font } : {}),
    ...(opts.activeColor !== undefined ? { activeColor: opts.activeColor } : {}),
    ...(opts.fontSize !== undefined ? { fontSizePx: opts.fontSize } : {}),
    ...(opts.positionY !== undefined ? { positionY: opts.positionY } : {}),
    ...(opts.maxWordsPerCue !== undefined ? { maxWordsPerCue: opts.maxWordsPerCue } : {}),
  });
  if (opts.font && !listFontFamilies().some((name) => name.toLocaleLowerCase() === opts.font!.toLocaleLowerCase())) {
    throw new CaptionEngineError(
      `Font family "${opts.font}" was not found.`,
      `Available fonts: ${listFontFamilies().join(', ') || '(none)'}`,
    );
  }

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
        activeScale: opts.activeScale,
        activeBold: opts.activeBold,
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
        language: languageIsAuto ? workingTranscript.language : (opts.language ?? workingTranscript.language),
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
      activeBold: opts.activeBold,
      highlight: opts.highlight,
      // undefined unless --prosody ran, which is what keeps the default path
      // byte-identical to the pre-prosody renderer.
      ...(toneStylesByCue ? { toneStylesByCue } : {}),
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
