/**
 * A stand-in for api.sarvam.ai that enforces the rule which caused the bug.
 *
 * This exists so the batching fix can be exercised over REAL HTTP — real
 * sockets, real JSON, real status codes — without a paid key. It reproduces the
 * server-side validation exactly:
 *
 *     body.input: String should have at most 1000 characters
 *
 * measured the way pydantic measures it, in Unicode code points.
 *
 * What it does NOT reproduce is Sarvam's model quality. It romanises with the
 * project's own offline engine, so a green run here proves transport, batching
 * and index alignment are correct — not that the model's output is good.
 *
 * Usage:
 *   node tools/fake-sarvam-server.mjs [port]
 *   SARVAM_API_KEY=test SARVAM_BASE_URL=http://127.0.0.1:8899 caption-engine ...
 */
import { createServer } from 'node:http';
import { transliterateToken } from '../dist/src/transliterate/devanagari.js';

const PORT = Number(process.argv[2] ?? 8899);
const LIMIT = 1000;
const ALLOWED = new Set([
  'input', 'source_language_code', 'target_language_code',
  'numerals_format', 'spoken_form', 'spoken_form_numerals_language',
]);

const log = { requests: 0, rejected: 0, maxChars: 0, sizes: [] };

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/transliterate')) {
    return send(res, 404, { error: 'not found' });
  }
  if (!req.headers['api-subscription-key']) {
    return send(res, 401, { error: { message: 'missing api-subscription-key' } });
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch {
      return send(res, 400, { error: { message: 'invalid JSON' } });
    }

    for (const k of Object.keys(body)) {
      if (!ALLOWED.has(k)) {
        return send(res, 422, { error: { message: `body.${k}: Extra inputs are not permitted` } });
      }
    }
    if (typeof body.input !== 'string') {
      return send(res, 422, { error: { message: 'body.input: Input should be a valid string' } });
    }

    // The exact rule that broke the original implementation.
    const chars = [...body.input].length;
    log.requests++;
    log.sizes.push(chars);
    log.maxChars = Math.max(log.maxChars, chars);

    if (chars > LIMIT) {
      log.rejected++;
      process.stderr.write(`[fake-sarvam] REJECT ${chars} chars\n`);
      return send(res, 422, {
        error: { message: `body.input: String should have at most ${LIMIT} characters` },
      });
    }

    // Romanise piecewise so the separator structure survives, which is what the
    // client relies on to map answers back to word positions.
    const out = body.input
      .split('|')
      .map((piece) => piece.trim().split(/\s+/).map(transliterateToken).join(' '))
      .join(' | ');

    send(res, 200, { transliterated_text: out, source_language_code: body.source_language_code });
  });
});

function send(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

process.on('SIGTERM', () => {
  process.stderr.write(`[fake-sarvam] ${JSON.stringify(log)}\n`);
  server.close(() => process.exit(0));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[fake-sarvam] listening on ${PORT}, limit ${LIMIT} chars\n`);
});
