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
    formats: job.requestedFormats,
    outputs: Object.fromEntries(
      Object.keys(job.outputs).map((k) => [k, `/api/download/${job.id}/${k}`]),
    ),
    result: job.result,
    error: job.error,
  });
});

const DOWNLOAD_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  srt: 'application/x-subrip; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  transcript: 'application/json; charset=utf-8',
  clips: 'application/json; charset=utf-8',
};

app.get('/api/download/:jobId/:format', (req: Request, res: Response) => {
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

  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  createReadStream(filePath).pipe(res);
});

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

app.get(/^(?!\/api\/).*/, (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
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
