import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { Reporter, RunResult } from '../cli/run.js';
import { runPipeline } from '../cli/run.js';
import type { CliOptions } from '../cli/args.js';
import type { CaptionCue, ClipCandidate, Cut, Transcript, TrimResult, Word, WordType } from '../types.js';
import { CaptionEngineError, InvalidTranscriptError } from '../errors.js';
import { loadEnv, redactSecrets } from '../config/env.js';
import { assertValidAnimationTemplateName } from '../captions/animation.js';
import { groupIntoCues } from '../captions/group.js';
import { buildAss, buildSrt } from '../captions/ass.js';
import { planCaptionFrames, renderPlannedFrame } from '../captions/svg.js';
import { OUTPUT_PRESETS, resolveStyle, type AspectPreset } from '../captions/style.js';
import { applyTrim, keepSegments } from '../autotrim/index.js';
import { renderVideo } from '../render/pipeline.js';
import { initShaper } from '../text/shaper.js';
import { probeMedia } from '../media/probe.js';
import { computeWaveformPeaks, parseWaveformDoc, type WaveformData } from '../media/waveform.js';
import { findClips, scoreTranscriptSegments } from '../clips/score.js';
import { makeAnthropicCompletion } from '../clips/llm.js';
import { uiOptionsToCli, TEMPLATE_GALLERY } from './options.js';

loadEnv();

export type ProgressEvent =
  | { type: 'queued'; message: string }
  | { type: 'step'; message: string }
  | { type: 'info'; message: string }
  | { type: 'warn'; message: string }
  | { type: 'progress'; pct: number; message: string }
  | { type: 'done'; message: string; outputs: Record<string, string>; result: JobPublicResult }
  | { type: 'error'; message: string; hint?: string };

export interface JobPublicResult {
  transcript: RunResult['transcript'];
  trim?: RunResult['trim'];
  transliteration?: RunResult['transliteration'];
  tooling: RunResult['tooling'];
  formats: string[];
  projectTitle?: string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  jobDir: string;
  inputPath: string;
  outputDir: string;
  workDir: string;
  outputs: Record<string, string>;
  requestedFormats: string[];
  events: ProgressEvent[];
  listeners: Set<(event: ProgressEvent) => void>;
  error?: string;
  result?: JobPublicResult;
  expiresAt: number;
  /** In-memory cut list for restore API (mirrors cuts.json when present). */
  cuts: Cut[];
  /** Viral clip candidates (mirrors clips.json when present). */
  clips: StoredClip[];
  projectTitle: string;
  originalName?: string;
  /**
   * Last UI/CLI field bag used to build CliOptions. Re-render merges
   * style/aspect overrides onto this so ASR is never re-invoked.
   */
  lastFields: Record<string, unknown>;
}

/** Clip candidate persisted for the web studio. */
export interface StoredClip extends ClipCandidate {
  id: string;
}

/** Public clip shape returned by the clips API. */
export interface PublicClip {
  id: string;
  title: string;
  hook: string;
  start: number;
  end: number;
  viralityScore: number;
  reasoning: string;
  transcriptExcerpt: string;
  durationSec: number;
  exported?: boolean;
  downloadUrl?: string;
}

export function toPublicClip(jobId: string, clip: StoredClip, outputs: Record<string, string>): PublicClip {
  const key = `clip-${clip.id.replace(/^clip-/, '')}`;
  const altKey = clip.id.startsWith('clip-') ? clip.id : `clip-${clip.id}`;
  const outKey = outputs[altKey] ? altKey : (outputs[key] ? key : undefined);
  return {
    id: clip.id.startsWith('clip-') ? clip.id : `clip-${clip.id}`,
    title: clip.title,
    hook: clip.title,
    start: clip.start,
    end: clip.end,
    viralityScore: clip.score,
    reasoning: clip.reason,
    transcriptExcerpt: clip.transcriptExcerpt,
    durationSec: Math.max(0, clip.end - clip.start),
    ...(outKey && existsSync(outputs[outKey]!)
      ? { exported: true, downloadUrl: `/api/download/${jobId}/${outKey}` }
      : { exported: false }),
  };
}

/** Body accepted by POST /api/jobs/:jobId/render. */
export interface ReRenderOptions {
  style?: string;
  aspect?: string;
  animationTemplate?: string;
  toneStyle?: string;
  /** FluxoCut gallery template id — preferred over raw `style` when present. */
  template?: string;
}

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_EVENTS_BUFFER = 500;
const jobs = new Map<string, JobRecord>();

function jobsRoot(): string {
  const root = join(tmpdir(), 'caption-engine-jobs');
  mkdirSync(root, { recursive: true });
  return root;
}

function emit(job: JobRecord, event: ProgressEvent): void {
  job.updatedAt = Date.now();
  job.events.push(event);
  if (job.events.length > MAX_EVENTS_BUFFER) {
    job.events.splice(0, job.events.length - MAX_EVENTS_BUFFER);
  }
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      /* ignore broken SSE clients */
    }
  }
}

function makeReporter(job: JobRecord): Reporter {
  return {
    step: (msg) => emit(job, { type: 'step', message: msg }),
    info: (msg) => emit(job, { type: 'info', message: msg }),
    warn: (msg) => emit(job, { type: 'warn', message: msg }),
    progress: (pct, msg) => emit(job, { type: 'progress', pct, message: msg }),
    done: (msg) => emit(job, { type: 'step', message: msg }),
  };
}

export function safeRm(path: string | undefined): void {
  if (!path) return;
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Scratch only — keep input + outputs for the editor until TTL. */
function cleanupIntermediates(job: JobRecord): void {
  safeRm(job.workDir);
}

export function destroyJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.listeners.clear();
  safeRm(job.jobDir);
  jobs.delete(jobId);
  return true;
}

export function getJob(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

export function subscribe(jobId: string, listener: (event: ProgressEvent) => void): ProgressEvent[] | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.listeners.add(listener);
  return [...job.events];
}

export function unsubscribe(jobId: string, listener: (event: ProgressEvent) => void): void {
  jobs.get(jobId)?.listeners.delete(listener);
}

function ensureExtension(filename: string | undefined, fallbackPath: string): string {
  const fromName = filename && filename.includes('.')
    ? extname(filename).toLowerCase()
    : '';
  if (fromName && /^\.[a-z0-9]{2,5}$/i.test(fromName)) return fromName;
  const fromPath = extname(fallbackPath).toLowerCase();
  return fromPath || '.mp4';
}

function loadCutsFromDisk(path: string | undefined): Cut[] {
  if (!path || !existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { cuts?: Cut[] };
    return Array.isArray(doc.cuts) ? doc.cuts : [];
  } catch {
    return [];
  }
}

function loadClipsFromDisk(path: string | undefined): StoredClip[] {
  if (!path || !existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const arr = Array.isArray(doc)
      ? doc
      : (doc && typeof doc === 'object' && Array.isArray((doc as { clips?: unknown }).clips)
        ? (doc as { clips: unknown[] }).clips
        : []);
    return arr
      .map((c, i) => normalizeStoredClip(c, i))
      .filter((c): c is StoredClip => c !== null);
  } catch {
    return [];
  }
}

function normalizeStoredClip(raw: unknown, index: number): StoredClip | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const start = Number(c.start);
  const end = Number(c.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const idRaw = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `clip-${index}`;
  const id = idRaw.startsWith('clip-') ? idRaw : `clip-${idRaw}`;
  return {
    id,
    start,
    end,
    score: Number.isFinite(Number(c.score)) ? Math.round(Number(c.score)) : 0,
    title: String(c.title ?? c.hook ?? 'Untitled clip').slice(0, 120),
    reason: String(c.reason ?? c.reasoning ?? '').slice(0, 400),
    transcriptExcerpt: String(c.transcriptExcerpt ?? '').slice(0, 600),
  };
}

function persistClips(job: JobRecord): void {
  const path = job.outputs.clips ?? join(job.outputDir, 'clips.json');
  atomicWriteText(path, JSON.stringify({ clips: job.clips }, null, 2));
  job.outputs.clips = path;
}

function clipWindowCuts(clip: StoredClip, duration: number): TrimResult {
  const cuts: Cut[] = [];
  if (clip.start > 0.02) {
    cuts.push({
      id: 'clip-pre',
      start: 0,
      end: clip.start,
      reason: 'silence',
      category: 'silence',
      label: 'before clip',
      wordIndices: [],
      sourceWords: [],
      confidence: 1,
      restored: false,
    });
  }
  if (clip.end < duration - 0.02) {
    cuts.push({
      id: 'clip-post',
      start: clip.end,
      end: duration,
      reason: 'silence',
      category: 'silence',
      label: 'after clip',
      wordIndices: [],
      sourceWords: [],
      confidence: 1,
      restored: false,
    });
  }
  const removed = cuts.reduce((n, c) => n + (c.end - c.start), 0);
  return {
    cuts,
    originalDuration: duration,
    secondsRemoved: removed,
    trimmedDuration: Math.max(duration - removed, 0),
  };
}

function resolveJobStyleName(job: JobRecord): string {
  const templateId = typeof job.lastFields.template === 'string'
    ? job.lastFields.template.trim().toLowerCase()
    : '';
  if (templateId) {
    const t = TEMPLATE_GALLERY.find((x) => x.id === templateId);
    if (t) return t.style;
  }
  const style = typeof job.lastFields.style === 'string' ? job.lastFields.style.trim() : '';
  return style || 'default';
}

export function listJobClips(jobId: string): PublicClip[] | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.clips.length === 0 && job.outputs.clips) {
    job.clips = loadClipsFromDisk(job.outputs.clips);
  }
  return job.clips.map((c) => toPublicClip(jobId, c, job.outputs));
}

/**
 * Run clip finding on the cached transcript.
 * Prefers LLM scoring when ANTHROPIC_API_KEY is set; falls back to rule-based.
 */
export async function generateJobClips(
  jobId: string,
): Promise<{ clips: PublicClip[]; source: 'llm' | 'rules'; count: number }> {
  const job = jobs.get(jobId);
  if (!job) throw new CaptionEngineError('Job not found.');
  if (job.status === 'running' || job.status === 'queued') {
    throw new CaptionEngineError(
      'Cannot find clips while a render is in progress.',
      'Wait for the current job to finish, then try again.',
    );
  }

  const doc = loadTranscriptDoc(job);
  const transcript: Transcript = {
    words: doc.words,
    language: doc.language,
    duration: doc.duration,
    provider: doc.provider,
    hasWordTimings: doc.hasWordTimings,
    ...(doc.model !== undefined ? { model: doc.model } : {}),
    ...(doc.detectedLanguageRaw !== undefined
      ? { detectedLanguageRaw: doc.detectedLanguageRaw }
      : {}),
  };

  let candidates: ClipCandidate[] = [];
  let source: 'llm' | 'rules' = 'rules';
  const key = process.env.ANTHROPIC_API_KEY;

  if (key) {
    try {
      candidates = await findClips(transcript, makeAnthropicCompletion(key), {
        language: transcript.language,
      });
      source = 'llm';
    } catch {
      candidates = scoreTranscriptSegments(transcript);
      source = 'rules';
    }
  } else {
    candidates = scoreTranscriptSegments(transcript);
    source = 'rules';
  }

  job.clips = candidates.map((c, i) => ({
    ...c,
    id: `clip-${i}`,
  }));
  persistClips(job);
  job.updatedAt = Date.now();
  job.expiresAt = Date.now() + JOB_TTL_MS;

  return {
    clips: job.clips.map((c) => toPublicClip(jobId, c, job.outputs)),
    source,
    count: job.clips.length,
  };
}

/**
 * Export one clip as a captioned 9:16 reel (1080×1920).
 * Uses chunked rendering; never calls ASR.
 */
export async function exportJobClip(
  jobId: string,
  clipId: string,
): Promise<{ ok: true; downloadUrl: string; outputKey: string }> {
  const job = jobs.get(jobId);
  if (!job) throw new CaptionEngineError('Job not found.');
  if (!existsSync(job.inputPath)) {
    throw new CaptionEngineError('Source video is no longer available for this job.');
  }

  if (job.clips.length === 0 && job.outputs.clips) {
    job.clips = loadClipsFromDisk(job.outputs.clips);
  }
  const normalizedId = clipId.startsWith('clip-') ? clipId : `clip-${clipId}`;
  const clip = job.clips.find((c) => c.id === normalizedId || c.id === clipId);
  if (!clip) {
    throw new CaptionEngineError(
      `Clip "${clipId}" not found.`,
      'Generate clips first, then export a candidate from the list.',
    );
  }
  if (clip.end - clip.start < 1) {
    throw new CaptionEngineError('Clip duration is too short to export.');
  }

  const doc = loadTranscriptDoc(job);
  const transcript: Transcript = {
    words: doc.words,
    language: doc.language,
    duration: doc.duration,
    provider: doc.provider,
    hasWordTimings: doc.hasWordTimings,
  };

  const trim = clipWindowCuts(clip, transcript.duration);
  const clipped = applyTrim(transcript, trim);
  const segments = keepSegments(trim);
  if (segments.length === 0) {
    throw new CaptionEngineError('Clip produced an empty keep-segment list.');
  }

  await initShaper();
  const cues = groupIntoCues(clipped, { maxWordsPerCue: 4 });
  const preset = OUTPUT_PRESETS.portrait;
  const styleName = resolveJobStyleName(job);
  const style = resolveStyle(styleName, preset.height, {});

  const plans = planCaptionFrames(cues, {
    width: preset.width,
    height: preset.height,
    highlight: 'active-word',
  });
  const svgOpts = {
    width: preset.width,
    height: preset.height,
    style,
    activeScale: 1.08,
    highlight: 'active-word' as const,
  };
  const frameSource = {
    count: plans.length,
    plans,
    async get(i: number) {
      const p = plans[i]!;
      return { ...p, svg: await renderPlannedFrame(cues, p, svgOpts) };
    },
  };

  mkdirSync(job.outputDir, { recursive: true });
  const outputKey = normalizedId;
  const outputPath = join(job.outputDir, `${outputKey}.mp4`);
  const info = await probeMedia(job.inputPath);

  await renderVideo({
    inputPath: job.inputPath,
    outputPath,
    width: preset.width,
    height: preset.height,
    segments,
    frames: frameSource,
    hasAudio: info.hasAudio,
    cropFocusX: 0.5,
    crf: 20,
    durationSec: clip.end - clip.start,
    backgroundColor: info.hasVideo ? undefined : '#101418',
  });

  job.outputs[outputKey] = outputPath;
  job.updatedAt = Date.now();
  job.expiresAt = Date.now() + JOB_TTL_MS;

  return {
    ok: true,
    downloadUrl: `/api/download/${jobId}/${outputKey}`,
    outputKey,
  };
}

function persistCuts(job: JobRecord): void {
  const path = job.outputs.cuts ?? join(job.outputDir, 'cuts.json');
  let stamp: unknown = undefined;
  if (existsSync(path)) {
    try {
      const prev = JSON.parse(readFileSync(path, 'utf8')) as { _engine?: unknown };
      stamp = prev._engine;
    } catch {
      /* ignore */
    }
  }
  writeFileSync(
    path,
    JSON.stringify({ ...(stamp ? { _engine: stamp } : {}), cuts: job.cuts }, null, 2),
    'utf8',
  );
  job.outputs.cuts = path;
}

export function listJobCuts(jobId: string): Cut[] | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  return job.cuts;
}

/**
 * Non-destructive restore / re-apply: flip `restored` on a cut by id.
 * Restored cuts are skipped at render time by the engine.
 */
export function setCutRestored(jobId: string, cutId: string, restored: boolean): Cut | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const cut = job.cuts.find((c) => c.id === cutId);
  if (!cut) return null;
  cut.restored = restored;
  persistCuts(job);
  job.updatedAt = Date.now();
  return cut;
}

export function readJobTranscript(jobId: string): unknown | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const path = job.outputs.transcript ?? join(job.outputDir, 'transcript.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Audio peak envelope for the timeline A1 track.
 * Cached as `work/waveform.json` so repeat GETs are instant.
 */
export async function getJobWaveform(jobId: string): Promise<WaveformData> {
  const job = jobs.get(jobId);
  if (!job) throw new CaptionEngineError('Job not found.');
  if (!existsSync(job.inputPath)) {
    throw new CaptionEngineError('Source video is no longer available for this job.');
  }

  const cachePath = job.outputs.waveform
    ?? join(job.workDir, 'waveform.json');

  if (existsSync(cachePath)) {
    try {
      const cached = parseWaveformDoc(JSON.parse(readFileSync(cachePath, 'utf8')));
      if (cached) {
        job.outputs.waveform = cachePath;
        return cached;
      }
    } catch {
      /* regenerate below */
    }
  }

  let durationSec = 0;
  try {
    const info = await probeMedia(job.inputPath);
    durationSec = info.durationSec;
  } catch {
    durationSec = 0;
  }
  if (!(durationSec > 0) && job.result?.transcript?.durationSec) {
    durationSec = Number(job.result.transcript.durationSec) || 0;
  }
  if (!(durationSec > 0)) {
    // Last resort: infer from transcript cache.
    const doc = readJobTranscript(jobId) as { duration?: number } | null;
    durationSec = Number(doc?.duration) || 1;
  }

  mkdirSync(job.workDir, { recursive: true });
  const waveform = await computeWaveformPeaks(job.inputPath, durationSec);
  atomicWriteText(cachePath, JSON.stringify(waveform));
  job.outputs.waveform = cachePath;
  job.updatedAt = Date.now();
  job.expiresAt = Date.now() + JOB_TTL_MS;
  return waveform;
}

export function setProjectTitle(jobId: string, title: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.projectTitle = title.trim().slice(0, 120) || job.projectTitle;
  if (job.result) job.result.projectTitle = job.projectTitle;
  return true;
}

// ---------------------------------------------------------------------------
// In-editor transcript editing
// ---------------------------------------------------------------------------

const MAX_WORD_TEXT_LEN = 200;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Body accepted by PATCH /api/jobs/:jobId/transcript. */
export type UpdateTranscriptBody =
  | { words: unknown[] }
  | { cues: unknown[] }
  | { wordIndex: number; text: string; start?: number; end?: number };

function sanitizeWordText(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new CaptionEngineError('Word text must be a string.');
  }
  const cleaned = raw.replace(CONTROL_CHARS, '').normalize('NFC');
  if (cleaned.length > MAX_WORD_TEXT_LEN) {
    throw new CaptionEngineError(
      `Word text is too long (max ${MAX_WORD_TEXT_LEN} characters).`,
    );
  }
  return cleaned;
}

function assertValidTiming(start: number, end: number, label: string): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new CaptionEngineError(`${label}: start and end must be finite numbers.`);
  }
  if (start < 0 || end < 0) {
    throw new CaptionEngineError(`${label}: timestamps must be >= 0.`);
  }
  if (start > end) {
    throw new CaptionEngineError(`${label}: start (${start}) must be <= end (${end}).`);
  }
}

function isWordType(v: unknown): v is WordType {
  return v === 'word' || v === 'spacing' || v === 'audio_event';
}

function parseWordPatch(raw: unknown, index: number, prev?: Word): Word {
  if (!raw || typeof raw !== 'object') {
    throw new CaptionEngineError(`Word ${index} is not an object.`);
  }
  const w = raw as Record<string, unknown>;
  const text = sanitizeWordText(w.text ?? prev?.text ?? '');
  const start = typeof w.start === 'number' ? w.start : prev?.start;
  const end = typeof w.end === 'number' ? w.end : prev?.end;
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new CaptionEngineError(`Word ${index} needs numeric start and end.`);
  }
  assertValidTiming(start, end, `Word ${index}`);

  const type: WordType = isWordType(w.type) ? w.type : (prev?.type ?? 'word');
  const confidence = typeof w.confidence === 'number' && Number.isFinite(w.confidence)
    ? Math.min(1, Math.max(0, w.confidence))
    : (prev?.confidence ?? 1);

  const next: Word = {
    text,
    start,
    end,
    confidence,
    type,
  };

  // Preserve downstream metadata unless the patch explicitly overrides it.
  if (typeof w.speakerId === 'string') next.speakerId = w.speakerId;
  else if (prev?.speakerId !== undefined) next.speakerId = prev.speakerId;

  if (typeof w.language === 'string') next.language = w.language;
  else if (prev?.language !== undefined) next.language = prev.language;

  if (typeof w.roman === 'string') {
    next.roman = sanitizeWordText(w.roman);
  } else if (Object.prototype.hasOwnProperty.call(w, 'roman') && w.roman == null) {
    // Explicit clear — leave roman unset.
  } else if (prev?.roman !== undefined) {
    // Text changed under romanisation: keep roman in sync with the correction
    // when the editor sent a plain text fix (typical proper-noun edit).
    if (prev.text !== text) next.roman = text;
    else next.roman = prev.roman;
  }

  if (typeof w.isFiller === 'boolean') next.isFiller = w.isFiller;
  else if (prev?.isFiller !== undefined) next.isFiller = prev.isFiller;

  if (typeof w.isFalseStart === 'boolean') next.isFalseStart = w.isFalseStart;
  else if (prev?.isFalseStart !== undefined) next.isFalseStart = prev.isFalseStart;

  if (typeof w.keep === 'boolean') next.keep = w.keep;
  else if (prev?.keep !== undefined) next.keep = prev.keep;

  return next;
}

function loadTranscriptDoc(job: JobRecord): Transcript & { _engine?: unknown } {
  const path = job.outputs.transcript ?? join(job.outputDir, 'transcript.json');
  if (!existsSync(path)) {
    throw new CaptionEngineError(
      'Cached transcript not found.',
      'Generate captions first before editing the transcript.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new InvalidTranscriptError(
      `Could not parse transcript: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Transcript).words)) {
    throw new InvalidTranscriptError('Transcript is missing a "words" array.');
  }
  return parsed as Transcript & { _engine?: unknown };
}

function atomicWriteText(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

function rebuildSubtitleFiles(job: JobRecord, transcript: Transcript): void {
  const cues = groupIntoCues(transcript);
  const aspectRaw = typeof job.lastFields.aspect === 'string'
    ? job.lastFields.aspect
    : 'portrait';
  const aspect = (['portrait', 'landscape', 'square', 'original'].includes(aspectRaw)
    ? aspectRaw
    : 'portrait') as AspectPreset;
  const preset = aspect === 'original'
    ? OUTPUT_PRESETS.portrait
    : OUTPUT_PRESETS[aspect];

  const script = job.lastFields.script === 'roman' ? 'roman' : 'native';
  const displayCues: CaptionCue[] = cues.map((cue) => ({
    ...cue,
    text: cue.words
      .map((w) => (script === 'roman' && w.roman ? w.roman : w.text))
      .join(' '),
    words: cue.words.map((w) => (
      script === 'roman' && w.roman ? { ...w, text: w.roman } : w
    )),
  }));

  const srtPath = job.outputs.srt ?? join(job.outputDir, 'captions.srt');
  atomicWriteText(srtPath, buildSrt(displayCues));
  job.outputs.srt = srtPath;

  const assPath = job.outputs.ass ?? join(job.outputDir, 'captions.ass');
  atomicWriteText(
    assPath,
    buildAss(displayCues, {
      video: { width: preset.width, height: preset.height },
      highlight: 'active-word',
    }),
  );
  job.outputs.ass = assPath;
}

function applyCuePatches(transcript: Transcript, cuesRaw: unknown[]): void {
  for (let ci = 0; ci < cuesRaw.length; ci++) {
    const raw = cuesRaw[ci];
    if (!raw || typeof raw !== 'object') {
      throw new CaptionEngineError(`Cue ${ci} is not an object.`);
    }
    const cue = raw as Record<string, unknown>;
    const indices: number[] = [];
    if (Array.isArray(cue.wordIndices)) {
      for (const idx of cue.wordIndices) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= transcript.words.length) {
          throw new CaptionEngineError(`Cue ${ci}: invalid wordIndex ${String(idx)}.`);
        }
        indices.push(idx as number);
      }
    } else if (Array.isArray(cue.words)) {
      for (const cw of cue.words as unknown[]) {
        if (!cw || typeof cw !== 'object') continue;
        const wi = (cw as { wordIndex?: unknown }).wordIndex;
        if (Number.isInteger(wi) && (wi as number) >= 0 && (wi as number) < transcript.words.length) {
          indices.push(wi as number);
        }
      }
    }
    if (indices.length === 0) {
      throw new CaptionEngineError(
        `Cue ${ci} needs wordIndices (or words[].wordIndex) to map edits onto the transcript.`,
      );
    }

    // Per-word patches inside the cue (spelling fixes).
    if (Array.isArray(cue.words)) {
      for (const cw of cue.words as unknown[]) {
        if (!cw || typeof cw !== 'object') continue;
        const patch = cw as Record<string, unknown>;
        const wi = patch.wordIndex;
        if (!Number.isInteger(wi)) continue;
        const idx = wi as number;
        if (idx < 0 || idx >= transcript.words.length) {
          throw new CaptionEngineError(`Cue ${ci}: wordIndex ${idx} out of range.`);
        }
        transcript.words[idx] = parseWordPatch(patch, idx, transcript.words[idx]);
      }
    }

    // Whole-cue text rewrite: redistribute tokens across mapped words.
    if (typeof cue.text === 'string') {
      const tokens = sanitizeWordText(cue.text).trim().split(/\s+/).filter(Boolean);
      const spoken = indices.filter((i) => transcript.words[i]?.type === 'word');
      const targets = spoken.length ? spoken : indices;
      if (tokens.length === 0) {
        for (const i of targets) {
          const prev = transcript.words[i]!;
          transcript.words[i] = parseWordPatch(
            { text: '', start: prev.start, end: prev.end },
            i,
            prev,
          );
        }
      } else if (tokens.length === targets.length) {
        for (let t = 0; t < targets.length; t++) {
          const i = targets[t]!;
          const prev = transcript.words[i]!;
          transcript.words[i] = parseWordPatch(
            { text: tokens[t], start: prev.start, end: prev.end },
            i,
            prev,
          );
        }
      } else if (tokens.length < targets.length) {
        for (let t = 0; t < targets.length; t++) {
          const i = targets[t]!;
          const prev = transcript.words[i]!;
          const assigned = t < tokens.length ? tokens[t]! : '';
          transcript.words[i] = parseWordPatch(
            { text: assigned, start: prev.start, end: prev.end },
            i,
            prev,
          );
        }
      } else {
        // More tokens than words: 1:1 for all but last, last gets the rest.
        for (let t = 0; t < targets.length; t++) {
          const i = targets[t]!;
          const prev = transcript.words[i]!;
          const text = t < targets.length - 1
            ? tokens[t]!
            : tokens.slice(t).join(' ');
          transcript.words[i] = parseWordPatch(
            { text, start: prev.start, end: prev.end },
            i,
            prev,
          );
        }
      }
    }

    // Cue boundary adjust — clamp first/last mapped word timings.
    if (typeof cue.start === 'number' || typeof cue.end === 'number') {
      const first = indices[0]!;
      const last = indices[indices.length - 1]!;
      const start = typeof cue.start === 'number' ? cue.start : transcript.words[first]!.start;
      const end = typeof cue.end === 'number' ? cue.end : transcript.words[last]!.end;
      assertValidTiming(start, end, `Cue ${ci}`);
      const prevFirst = transcript.words[first]!;
      const prevLast = transcript.words[last]!;
      if (last === first) {
        transcript.words[first] = parseWordPatch(
          { text: prevFirst.text, start, end },
          first,
          prevFirst,
        );
      } else {
        transcript.words[first] = parseWordPatch(
          {
            text: prevFirst.text,
            start,
            end: Math.max(start, Math.min(prevFirst.end, end)),
          },
          first,
          prevFirst,
        );
        transcript.words[last] = parseWordPatch(
          {
            text: prevLast.text,
            end,
            start: Math.min(end, Math.max(prevLast.start, start)),
          },
          last,
          prevLast,
        );
      }
    }
  }
}

/**
 * Apply in-editor transcript edits, persist atomically, and rebuild SRT/ASS.
 * Never calls ASR. MP4 is left untouched until the user re-renders.
 */
export function updateJobTranscript(
  jobId: string,
  body: UpdateTranscriptBody,
): { ok: true; wordCount: number } {
  const job = jobs.get(jobId);
  if (!job) throw new CaptionEngineError('Job not found.');
  if (job.status === 'running' || job.status === 'queued') {
    throw new CaptionEngineError(
      'Cannot edit the transcript while a render is in progress.',
      'Wait for the current job to finish, then try again.',
    );
  }

  const doc = loadTranscriptDoc(job);
  const stamp = doc._engine;
  const transcript: Transcript = {
    words: [...doc.words],
    language: doc.language,
    duration: doc.duration,
    provider: doc.provider,
    hasWordTimings: doc.hasWordTimings,
    ...(doc.model !== undefined ? { model: doc.model } : {}),
    ...(doc.detectedLanguageRaw !== undefined
      ? { detectedLanguageRaw: doc.detectedLanguageRaw }
      : {}),
    ...(doc.warnings !== undefined ? { warnings: doc.warnings } : {}),
  };

  if ('wordIndex' in body && typeof (body as { wordIndex?: unknown }).wordIndex === 'number') {
    const patch = body as { wordIndex: number; text: string; start?: number; end?: number };
    const idx = patch.wordIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= transcript.words.length) {
      throw new CaptionEngineError(
        `wordIndex ${idx} is out of range (0..${transcript.words.length - 1}).`,
      );
    }
    const prev = transcript.words[idx]!;
    transcript.words[idx] = parseWordPatch(
      {
        text: patch.text,
        start: patch.start ?? prev.start,
        end: patch.end ?? prev.end,
      },
      idx,
      prev,
    );
  } else if ('words' in body && Array.isArray((body as { words?: unknown }).words)) {
    const incoming = (body as { words: unknown[] }).words;
    if (incoming.length === 0) {
      throw new CaptionEngineError('words array must not be empty.');
    }
    // Full replace when lengths match prior schema, or accept as new list.
    if (incoming.length === transcript.words.length) {
      transcript.words = incoming.map((w, i) => parseWordPatch(w, i, transcript.words[i]));
    } else {
      transcript.words = incoming.map((w, i) => parseWordPatch(w, i));
    }
    const last = transcript.words[transcript.words.length - 1];
    if (last && last.end > transcript.duration) {
      transcript.duration = last.end;
    }
  } else if ('cues' in body && Array.isArray((body as { cues?: unknown }).cues)) {
    applyCuePatches(transcript, (body as { cues: unknown[] }).cues);
  } else {
    throw new CaptionEngineError(
      'Transcript patch must include words, cues, or wordIndex.',
      'Send { words: [...] }, { cues: [...] }, or { wordIndex, text, start?, end? }.',
    );
  }

  // Re-validate every word after mutation.
  for (let i = 0; i < transcript.words.length; i++) {
    const w = transcript.words[i]!;
    assertValidTiming(w.start, w.end, `Word ${i}`);
    sanitizeWordText(w.text);
  }

  const transcriptPath = job.outputs.transcript ?? join(job.outputDir, 'transcript.json');
  const payload = stamp ? { ...transcript, _engine: stamp } : transcript;
  atomicWriteText(transcriptPath, JSON.stringify(payload, null, 2));
  job.outputs.transcript = transcriptPath;

  rebuildSubtitleFiles(job, transcript);

  if (job.result) {
    job.result.transcript = {
      ...job.result.transcript,
      words: transcript.words.length,
      durationSec: transcript.duration,
    };
    job.result.formats = Object.keys(job.outputs);
  }
  job.updatedAt = Date.now();
  job.expiresAt = Date.now() + JOB_TTL_MS;

  return { ok: true, wordCount: transcript.words.length };
}

export interface CreateJobParams {
  stagedPath: string;
  originalName?: string;
  fields: Record<string, unknown>;
}

export function createJobFromStagedUpload(params: CreateJobParams): { jobId: string } {
  sweepExpiredJobs();

  if (!existsSync(params.stagedPath) || statSync(params.stagedPath).size === 0) {
    safeRm(params.stagedPath);
    throw new CaptionEngineError('Uploaded file is empty.');
  }

  const id = randomUUID();
  const jobDir = join(jobsRoot(), id);
  const workDir = join(jobDir, 'work');
  const outputDir = join(jobDir, 'output');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const ext = ensureExtension(params.originalName, params.stagedPath);
  const inputPath = join(jobDir, `input${ext}`);
  const outputPath = join(outputDir, 'captioned.mp4');

  try {
    renameSync(params.stagedPath, inputPath);
  } catch {
    safeRm(jobDir);
    safeRm(params.stagedPath);
    throw new CaptionEngineError('Failed to place uploaded file in the job directory.');
  }

  let opts: CliOptions;
  let requestedFormats: string[];
  try {
    const mapped = uiOptionsToCli(inputPath, outputPath, workDir, params.fields);
    opts = mapped.opts;
    requestedFormats = mapped.requestedFormats;
  } catch (err) {
    safeRm(jobDir);
    throw err;
  }

  const titleBase = (params.originalName || 'Untitled project').replace(/\.[^.]+$/, '');
  const now = Date.now();
  const job: JobRecord = {
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    jobDir,
    inputPath,
    outputDir,
    workDir,
    outputs: {},
    requestedFormats,
    events: [],
    listeners: new Set(),
    expiresAt: now + JOB_TTL_MS,
    cuts: [],
    clips: [],
    projectTitle: titleBase.slice(0, 80) || 'Untitled project',
    originalName: params.originalName,
    lastFields: { ...params.fields },
  };
  jobs.set(id, job);
  emit(job, { type: 'queued', message: 'Upload received. Starting caption pipeline…' });

  void runJob(job, opts);
  return { jobId: id };
}

/**
 * Re-render an existing job from its cached transcript — never calls ASR.
 *
 * Uses `runPipeline` with `transcriptIn` + `noAsr` + `allowStale`, and feeds
 * the current cut-restore state via `cutsIn` so editor restores survive.
 */
export function startReRender(
  jobId: string,
  body: ReRenderOptions = {},
): { jobId: string; outputs: Record<string, string> } {
  sweepExpiredJobs();

  const job = jobs.get(jobId);
  if (!job) {
    throw new CaptionEngineError('Job not found.');
  }
  if (job.status === 'running' || job.status === 'queued') {
    throw new CaptionEngineError(
      'Job is already rendering.',
      'Wait for the current render to finish, then try again.',
    );
  }
  if (!existsSync(job.inputPath) || statSync(job.inputPath).size === 0) {
    throw new CaptionEngineError(
      'Source video is no longer available for this job.',
      'Upload the media again to start a new project.',
    );
  }

  const transcriptPath = job.outputs.transcript ?? join(job.outputDir, 'transcript.json');
  if (!existsSync(transcriptPath)) {
    throw new CaptionEngineError(
      'Cached transcript not found — cannot re-render without ASR.',
      'Generate captions once first so a transcript is saved on the job.',
    );
  }

  // Persist the editor's current restore flags before handing cuts to the pipeline.
  const activeCuts = job.cuts.filter((c) => !c.restored);
  if (job.cuts.length > 0) {
    persistCuts(job);
  }

  mkdirSync(job.workDir, { recursive: true });
  mkdirSync(job.outputDir, { recursive: true });

  const outputPath = join(job.outputDir, 'captioned.mp4');
  const fields: Record<string, unknown> = {
    ...job.lastFields,
    ...(body.template ? { template: body.template } : {}),
    ...(body.style ? { style: body.style } : {}),
    ...(body.aspect ? { aspect: body.aspect } : {}),
    ...(body.animationTemplate ? { animationTemplate: body.animationTemplate } : {}),
    ...(body.toneStyle ? { toneStyle: body.toneStyle } : {}),
  };

  // Prefer gallery template when both template + style are set from overrides.
  if (body.template) {
    delete fields.style;
  } else if (body.style) {
    delete fields.template;
  }

  let opts: CliOptions;
  let requestedFormats: string[];
  try {
    const mapped = uiOptionsToCli(job.inputPath, outputPath, job.workDir, fields);
    opts = mapped.opts;
    requestedFormats = mapped.requestedFormats;
  } catch (err) {
    throw err;
  }

  // STRUCTURAL no-ASR path: load the cached transcript; never bill ASR credits.
  opts.transcriptIn = transcriptPath;
  opts.noAsr = true;
  opts.allowStale = true;
  opts.transcriptOut = transcriptPath;

  if (typeof body.animationTemplate === 'string' && body.animationTemplate.trim()) {
    const name = body.animationTemplate.trim();
    if (name !== 'auto') assertValidAnimationTemplateName(name);
    opts.animationTemplate = name;
  }

  if (typeof body.toneStyle === 'string') {
    const tone = body.toneStyle.trim().toLowerCase();
    if (tone === 'auto') opts.prosody = true;
    else if (tone === 'none') opts.prosody = false;
    else {
      throw new CaptionEngineError(
        `Unknown toneStyle "${body.toneStyle}".`,
        'Valid: auto, none',
      );
    }
  }

  const cutsPath = job.outputs.cuts ?? join(job.outputDir, 'cuts.json');
  if (job.cuts.length > 0 || existsSync(cutsPath)) {
    // Re-apply Auto Trim with the reviewed restore flags so restored segments
    // stay in the export without re-proposing from scratch alone.
    opts.autoTrim = true;
    opts.cutsIn = cutsPath;
    opts.cutsOut = cutsPath;
  }

  job.lastFields = fields;
  job.requestedFormats = requestedFormats;
  job.status = 'queued';
  job.error = undefined;
  job.expiresAt = Date.now() + JOB_TTL_MS;
  // Fresh SSE buffer so reconnecting clients see only this re-render.
  job.events = [];

  const activeCount = activeCuts.length;
  const restoredCount = job.cuts.length - activeCount;
  emit(job, {
    type: 'queued',
    message:
      `Re-rendering from cached transcript` +
      (job.cuts.length
        ? ` · ${activeCount} active cut(s), ${restoredCount} restored`
        : '') +
      '…',
  });

  void runJob(job, opts);

  return {
    jobId: job.id,
    outputs: Object.fromEntries(
      Object.keys(job.outputs).map((k) => [k, `/api/download/${job.id}/${k}`]),
    ),
  };
}

async function runJob(job: JobRecord, opts: CliOptions): Promise<void> {
  job.status = 'running';
  const log = makeReporter(job);

  try {
    const result = await runPipeline(opts, log);

    const filtered: Record<string, string> = {};
    for (const [key, path] of Object.entries(result.outputs)) {
      if (key === 'transcript' || key === 'clips' || key === 'cuts') {
        if (existsSync(path)) filtered[key] = path;
        continue;
      }
      if (job.requestedFormats.includes(key) && existsSync(path)) {
        filtered[key] = path;
      }
    }
    if (Object.keys(filtered).length === 0) {
      for (const [key, path] of Object.entries(result.outputs)) {
        if (existsSync(path)) filtered[key] = path;
      }
    }

    job.outputs = filtered;
    job.cuts = loadCutsFromDisk(filtered.cuts);
    job.clips = loadClipsFromDisk(filtered.clips);
    job.result = {
      transcript: result.transcript,
      trim: result.trim,
      transliteration: result.transliteration,
      tooling: result.tooling,
      formats: Object.keys(filtered),
      projectTitle: job.projectTitle,
    };
    job.status = 'done';
    job.expiresAt = Date.now() + JOB_TTL_MS;

    const message = `Finished — ${Object.keys(filtered).join(', ') || 'no files'}`;
    log.done(message);
    emit(job, {
      type: 'done',
      message,
      outputs: Object.fromEntries(
        Object.keys(filtered).map((k) => [k, `/api/download/${job.id}/${k}`]),
      ),
      result: job.result,
    });
  } catch (err) {
    job.status = 'error';
    job.expiresAt = Date.now() + 10 * 60 * 1000;
    const message = redactSecrets(
      err instanceof Error ? err.message : String(err),
    );
    const hint = err instanceof CaptionEngineError && err.hint
      ? redactSecrets(err.hint)
      : undefined;
    job.error = message;
    emit(job, { type: 'error', message, ...(hint ? { hint } : {}) });
  } finally {
    cleanupIntermediates(job);
  }
}

export function sweepExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= now && (job.status === 'done' || job.status === 'error')) {
      destroyJob(id);
    }
  }
}

export function uploadsStagingDir(): string {
  const dir = join(tmpdir(), 'caption-engine-uploads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

setInterval(() => {
  try {
    sweepExpiredJobs();
  } catch {
    /* ignore */
  }
}, 5 * 60 * 1000).unref();

/**
 * Test helper: install a finished job with a cached transcript (no ASR).
 * Not used by the production server.
 */
export function __testSeedDoneJob(params: {
  inputPath: string;
  transcript: unknown;
  cuts?: Cut[];
  fields?: Record<string, unknown>;
  formats?: Array<'mp4' | 'srt' | 'ass' | 'json'>;
}): string {
  const id = randomUUID();
  const jobDir = join(jobsRoot(), id);
  const workDir = join(jobDir, 'work');
  const outputDir = join(jobDir, 'output');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const ext = extname(params.inputPath) || '.mp4';
  const inputPath = join(jobDir, `input${ext}`);
  renameSync(params.inputPath, inputPath);

  const transcriptPath = join(outputDir, 'transcript.json');
  writeFileSync(transcriptPath, JSON.stringify(params.transcript, null, 2), 'utf8');

  const cuts = params.cuts ?? [];
  const outputs: Record<string, string> = { transcript: transcriptPath };
  if (cuts.length) {
    const cutsPath = join(outputDir, 'cuts.json');
    writeFileSync(cutsPath, JSON.stringify({ cuts }, null, 2), 'utf8');
    outputs.cuts = cutsPath;
  }

  const now = Date.now();
  const job: JobRecord = {
    id,
    status: 'done',
    createdAt: now,
    updatedAt: now,
    jobDir,
    inputPath,
    outputDir,
    workDir,
    outputs,
    requestedFormats: params.formats ?? ['mp4', 'srt'],
    events: [],
    listeners: new Set(),
    expiresAt: now + JOB_TTL_MS,
    cuts,
    clips: [],
    projectTitle: 'Test re-render',
    lastFields: {
      style: 'default',
      aspect: 'portrait',
      formats: params.formats ?? ['mp4', 'srt'],
      autoTrim: cuts.length > 0,
      ...(params.fields ?? {}),
    },
    result: {
      transcript: {
        words: Array.isArray((params.transcript as { words?: unknown }).words)
          ? (params.transcript as { words: unknown[] }).words.length
          : 0,
        language: String((params.transcript as { language?: string }).language ?? 'en'),
        provider: String((params.transcript as { provider?: string }).provider ?? 'fixture'),
        durationSec: Number((params.transcript as { duration?: number }).duration ?? 0),
      },
      tooling: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', rasteriser: 'none' },
      formats: Object.keys(outputs),
      projectTitle: 'Test re-render',
    },
  };
  jobs.set(id, job);
  return id;
}
