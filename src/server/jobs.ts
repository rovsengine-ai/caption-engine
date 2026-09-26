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
import type { Cut } from '../types.js';
import { CaptionEngineError } from '../errors.js';
import { loadEnv, redactSecrets } from '../config/env.js';
import { uiOptionsToCli } from './options.js';

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
  projectTitle: string;
  originalName?: string;
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

export function setProjectTitle(jobId: string, title: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.projectTitle = title.trim().slice(0, 120) || job.projectTitle;
  if (job.result) job.result.projectTitle = job.projectTitle;
  return true;
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
    projectTitle: titleBase.slice(0, 80) || 'Untitled project',
    originalName: params.originalName,
  };
  jobs.set(id, job);
  emit(job, { type: 'queued', message: 'Upload received. Starting caption pipeline…' });

  void runJob(job, opts);
  return { jobId: id };
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
