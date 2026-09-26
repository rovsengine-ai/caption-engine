/**
 * Hugging Face Spaces web server for caption-engine.
 *
 * Listens on port 7860, streams uploads to os.tmpdir() via multer disk storage,
 * bridges runPipeline() progress to SSE, and cleans intermediates in try/finally.
 */
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

import { CaptionEngineError } from './errors.js';
import { loadEnv, redactSecrets } from './config/env.js';
import {
  createJobFromStagedUpload,
  destroyJob,
  getJob,
  listJobCuts,
  readJobTranscript,
  setCutRestored,
  setProjectTitle,
  subscribe,
  unsubscribe,
  uploadsStagingDir,
  type ProgressEvent,
} from './server/jobs.js';
import { publicMeta } from './server/options.js';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve package root whether we run from `src/` (tsx) or `dist/src/` (compiled). */
function packageRoot(): string {
  for (const up of ['../..', '..', '.'] as const) {
    const candidate = resolve(__dirname, up);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return process.cwd();
}

const ROOT = packageRoot();
const PUBLIC_DIR = join(ROOT, 'public');

const PORT = Number(process.env.PORT || process.env.CAPTION_ENGINE_PORT || 7860);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 500 * 1024 * 1024);

function param(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, uploadsStagingDir());
      } catch (err) {
        cb(err as Error, '');
      }
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || '.mp4';
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okMime =
      file.mimetype.startsWith('video/') ||
      file.mimetype.startsWith('audio/') ||
      file.mimetype === 'application/octet-stream';
    const okExt = /\.(mp4|mov|mkv|webm|avi|m4v|mpg|wmv|flv|ts|wav|mp3|m4a|aac|flac|ogg|opus|aiff|caf)$/i
      .test(file.originalname);
    if (okMime || okExt) {
      cb(null, true);
      return;
    }
    cb(new CaptionEngineError(
      `Unsupported file type: ${file.originalname || file.mimetype}`,
      'Upload a video or audio file (mp4, mov, webm, wav, mp3, …).',
    ));
  },
});

const app = express();
app.disable('x-powered-by');

// CORS: allow Spaces iframe/preview and local dev. Uploads are same-origin in
// the shipped UI; this keeps the API usable from a separate frontend origin.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With',
  );
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'caption-engine', port: PORT });
});

app.get('/api/meta', (_req, res) => {
  res.json(publicMeta());
});

app.post('/api/jobs', (req: Request, res: Response, next: NextFunction) => {
  upload.single('video')(req, res, (err: unknown) => {
    if (err) {
      next(err);
      return;
    }

    try {
      const file = req.file;
      if (!file) {
        throw new CaptionEngineError(
          'Missing video file.',
          'Send multipart field "video" with your media file.',
        );
      }

      const fields: Record<string, unknown> = { ...req.body };
      if (typeof fields.formats === 'undefined' && typeof fields.format === 'string') {
        fields.formats = fields.format;
      }

      const { jobId } = createJobFromStagedUpload({
        stagedPath: file.path,
        originalName: file.originalname,
        fields,
      });

      res.status(202).json({ jobId, progressUrl: `/api/progress/${jobId}` });
    } catch (e) {
      if (req.file?.path) {
        try { unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      next(e);
    }
  });
});

app.get('/api/progress/:jobId', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const write = (event: ProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const buffered = subscribe(jobId, write);
  if (!buffered) {
    res.status(404).end();
    return;
  }
  for (const event of buffered) write(event);

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe(jobId, write);
  };
  req.on('close', close);
  req.on('error', close);
});

app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
  const job = getJob(param(req.params.jobId));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    projectTitle: job.projectTitle,
    originalName: job.originalName,
    formats: job.requestedFormats,
    outputs: Object.fromEntries(
      Object.keys(job.outputs).map((k) => [k, `/api/download/${job.id}/${k}`]),
    ),
    result: job.result,
    error: job.error,
    cutsCount: job.cuts.length,
    cutsActive: job.cuts.filter((c) => !c.restored).length,
    cutsRestored: job.cuts.filter((c) => c.restored).length,
  });
});

app.patch('/api/jobs/:jobId', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (typeof req.body?.projectTitle === 'string') {
    setProjectTitle(jobId, req.body.projectTitle);
  }
  res.json({ id: job.id, projectTitle: job.projectTitle });
});

app.get('/api/jobs/:jobId/cuts', (req: Request, res: Response) => {
  const cuts = listJobCuts(param(req.params.jobId));
  if (!cuts) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({
    cuts,
    summary: {
      total: cuts.length,
      active: cuts.filter((c) => !c.restored).length,
      restored: cuts.filter((c) => c.restored).length,
      secondsRemoved: cuts
        .filter((c) => !c.restored)
        .reduce((n, c) => n + (c.end - c.start), 0),
    },
  });
});

app.patch('/api/jobs/:jobId/cuts/:cutId', (req: Request, res: Response) => {
  const jobId = param(req.params.jobId);
  const cutId = param(req.params.cutId);
  const restored = Boolean(req.body?.restored);
  const cut = setCutRestored(jobId, cutId, restored);
  if (!cut) {
    res.status(404).json({ error: 'Job or cut not found' });
    return;
  }
  res.json({ cut, message: restored ? 'Cut restored (will be kept in export)' : 'Cut re-applied' });
});

app.get('/api/jobs/:jobId/transcript', (req: Request, res: Response) => {
  const doc = readJobTranscript(param(req.params.jobId));
  if (!doc) {
    res.status(404).json({ error: 'Transcript not available' });
    return;
  }
  res.json(doc);
});

/** Stream the original upload for the editor canvas (ephemeral server tmp). */
app.get('/api/jobs/:jobId/source', (req: Request, res: Response) => {
  const job = getJob(param(req.params.jobId));
  if (!job || !existsSync(job.inputPath)) {
    res.status(404).json({ error: 'Source media not available' });
    return;
  }
  const size = statSync(job.inputPath).size;
  const ext = extname(job.inputPath).toLowerCase();
  const type =
    ext === '.webm' ? 'video/webm'
      : ext === '.mov' ? 'video/quicktime'
        : ext === '.mp3' ? 'audio/mpeg'
          : ext === '.wav' ? 'audio/wav'
            : 'video/mp4';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Accept-Ranges', 'bytes');
  createReadStream(job.inputPath).pipe(res);
});

const DOWNLOAD_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  srt: 'application/x-subrip; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  transcript: 'application/json; charset=utf-8',
  clips: 'application/json; charset=utf-8',
  cuts: 'application/json; charset=utf-8',
};

function sendDownload(req: Request, res: Response, headOnly: boolean): void {
  const job = getJob(param(req.params.jobId));
  const format = param(req.params.format).toLowerCase();
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status !== 'done') {
    res.status(409).json({ error: 'Job is not finished yet', status: job.status });
    return;
  }
  const filePath = job.outputs[format];
  if (!filePath || !existsSync(filePath)) {
    res.status(404).json({
      error: `Output "${format}" not available`,
      available: Object.keys(job.outputs),
    });
    return;
  }

  const size = statSync(filePath).size;
  const type = DOWNLOAD_TYPES[format] ?? 'application/octet-stream';
  let downloadName = `captioned.${format}`;
  if (format === 'transcript') downloadName = 'transcript.json';
  if (format === 'clips') downloadName = 'clips.json';
  if (format === 'cuts') downloadName = 'cuts.json';

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  if (headOnly) {
    res.status(200).end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

app.head('/api/download/:jobId/:format', (req, res) => sendDownload(req, res, true));
app.get('/api/download/:jobId/:format', (req, res) => sendDownload(req, res, false));

app.delete('/api/jobs/:jobId', (req: Request, res: Response) => {
  const ok = destroyJob(param(req.params.jobId));
  if (!ok) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json({ ok: true });
});

mkdirSync(PUBLIC_DIR, { recursive: true });

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

/** App SPA shell — dashboard (/app), new draft (/app/new), project (/app/p/:id) */
app.get(['/app', '/app/', '/app/new', '/app/new/', '/app/p/:id'], (req: Request, res: Response) => {
  const appPage = join(PUBLIC_DIR, 'app.html');
  if (existsSync(appPage)) {
    res.sendFile(appPage);
    return;
  }
  res.status(404).send('Editor UI missing — public/app.html');
});

app.get(/^(?!\/api\/).*/, (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  // Deep-link editor paths that static missed
  if (req.path.startsWith('/app')) {
    const appPage = join(PUBLIC_DIR, 'app.html');
    if (existsSync(appPage)) {
      res.sendFile(appPage);
      return;
    }
  }
  const index = join(PUBLIC_DIR, 'index.html');
  if (existsSync(index)) {
    res.sendFile(index);
    return;
  }
  res.status(404).send('UI not found — public/index.html missing');
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`
      : err.message;
    res.status(400).json({ error: msg });
    return;
  }
  if (err instanceof CaptionEngineError) {
    res.status(400).json({
      error: redactSecrets(err.message),
      ...(err.hint ? { hint: redactSecrets(err.hint) } : {}),
    });
    return;
  }
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  console.error('[server]', message);
  res.status(500).json({ error: message });
});

export function startServer(port = PORT, host = HOST): void {
  app.listen(port, host, () => {
    console.log(`caption-engine web UI listening on http://${host}:${port}`);
  });
}

const isDirect = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  startServer();
}

export { app };
