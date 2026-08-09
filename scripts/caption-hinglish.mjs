#!/usr/bin/env node
/**
 * One-command Hinglish workflow.
 *
 *   npm run caption:hinglish -- ./my-video.mp4      (macOS / Linux)
 *   npm run caption:hinglish -- .\my-video.mp4      (Windows PowerShell)
 *
 * Produces  <OUTPUT_DIR>/<original-name>-hinglish.mp4  with ElevenLabs ASR,
 * code-switching, Sarvam transliteration, English protection, Auto Trim,
 * portrait framing and the bold caption style.
 *
 * Implementation notes:
 *
 *  - Everything is spawned with `process.execPath` and an argv **array**, never
 *    through a shell. That is what makes `My Video (final) #2.mp4` work
 *    identically in bash, zsh, cmd.exe and PowerShell — there is no shell to
 *    mis-quote it.
 *  - No `npm` binary is invoked either: `npm` is `npm.cmd` on Windows and
 *    spawning it without a shell fails. TypeScript is run directly instead.
 *  - Preflight checks run before the expensive work, and report the NAME of a
 *    missing variable, never its value.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RED = '\x1b[31m', YELLOW = '\x1b[33m', GREEN = '\x1b[32m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const colour = process.stderr.isTTY === true;
const paint = (c, s) => (colour ? `${c}${s}${OFF}` : s);

function fail(title, ...lines) {
  process.stderr.write(`\n${paint(RED, 'Error:')} ${title}\n`);
  for (const l of lines) process.stderr.write(`  ${l}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

function step(msg) {
  process.stderr.write(`${paint(GREEN, '▸')} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// 1. Input
// ---------------------------------------------------------------------------

// argv after `npm run caption:hinglish --`. Anything beyond the first
// non-flag argument is forwarded to the CLI so callers can still override.
const argv = process.argv.slice(2);
const passthrough = [];
let inputArg;
for (const a of argv) {
  if (!inputArg && !a.startsWith('-')) inputArg = a;
  else passthrough.push(a);
}

if (!inputArg) {
  fail(
    'No input file given.',
    'Usage:',
    '  npm run caption:hinglish -- ./my-video.mp4        (macOS / Linux)',
    '  npm run caption:hinglish -- .\\my-video.mp4        (Windows PowerShell)',
    '',
    'Quote the path if it contains spaces:',
    '  npm run caption:hinglish -- "./My Video (final).mp4"',
  );
}

const inputPath = resolve(inputArg);
if (!existsSync(inputPath)) {
  fail(
    `Input video not found: ${inputArg}`,
    `Looked for: ${inputPath}`,
    '',
    'Check the path and spelling. On Windows PowerShell a leading .\\ is fine;',
    'wrap the whole path in quotes if it contains spaces.',
  );
}
if (!statSync(inputPath).isFile()) {
  fail(`Not a file: ${inputPath}`, 'Pass a video or audio file, not a directory.');
}

// ---------------------------------------------------------------------------
// 2. FFmpeg
// ---------------------------------------------------------------------------

function probeBinary(name, envOverride) {
  const bin = process.env[envOverride] || name;
  const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return r.status === 0 && !r.error;
}

for (const [bin, env] of [['ffmpeg', 'FFMPEG_PATH'], ['ffprobe', 'FFPROBE_PATH']]) {
  if (!probeBinary(bin, env)) {
    fail(
      `${bin} not found on PATH.`,
      'Install it:',
      '  macOS          brew install ffmpeg',
      '  Windows        winget install Gyan.FFmpeg   (then reopen your terminal)',
      '  Ubuntu/Debian  sudo apt install ffmpeg',
      '',
      `Or set ${env} to the full path of the binary.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------

if (process.env.CAPTION_ENGINE_SKIP_BUILD === '1') {
  step('Skipping build (CAPTION_ENGINE_SKIP_BUILD=1)');
} else {
  step('Building');
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    fail(
      'TypeScript is not installed.',
      'Run:  npm install',
      `Looked for: ${tsc}`,
    );
  }
  const build = spawnSync(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    fail(
      'Build failed.',
      'Fix the TypeScript errors above and run the command again.',
      'Nothing was transcribed, so no API credit was used.',
    );
  }
}

const cliPath = join(ROOT, 'dist', 'src', 'cli.js');
if (!existsSync(cliPath)) {
  fail('Build produced no CLI.', `Expected: ${cliPath}`, 'Run:  npm install && npm run build');
}

// ---------------------------------------------------------------------------
// 4. Environment — load .env, then check key PRESENCE only
// ---------------------------------------------------------------------------

const { loadEnv, envStatus } = await import(
  pathToFileURL(join(ROOT, 'dist', 'src', 'config', 'env.js')).href
);

const loaded = loadEnv({ cwd: ROOT, force: true });
if (loaded.path) step(`Loaded ${loaded.path} (${loaded.applied.length} variable(s))`);
else process.stderr.write(paint(DIM, '  no .env file found — using the shell environment\n'));

const REQUIRED = [
  ['ELEVENLABS_API_KEY', 'ElevenLabs Scribe provides the word-level timestamps.'],
  ['SARVAM_API_KEY', 'Sarvam does the Hinglish transliteration in this workflow.'],
];

const missing = REQUIRED.filter(([name]) => !envStatus(name).present);
if (missing.length > 0) {
  fail(
    `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.map(([n]) => n).join(', ')}`,
    ...missing.map(([n, why]) => `  ${n} — ${why}`),
    '',
    'Add them to a .env file at the project root:',
    '',
    '  Copy-Item .env.example .env      # Windows PowerShell',
    '  cp .env.example .env             # macOS / Linux',
    '',
    'then fill in the values. .env is gitignored — never commit it.',
  );
}
// Blank-but-present is the classic .env mistake; name it explicitly.
for (const [name] of REQUIRED) {
  if (envStatus(name).blank) {
    fail(`${name} is set but empty.`, 'Fill in a value in .env, or unset the variable.');
  }
}

// ---------------------------------------------------------------------------
// 5. Output path
// ---------------------------------------------------------------------------

const outDir = resolve(ROOT, process.env.OUTPUT_DIR || 'outputs');
mkdirSync(outDir, { recursive: true });

const stem = basename(inputPath, extname(inputPath));
const outPath = join(outDir, `${stem}-hinglish.mp4`);

// ---------------------------------------------------------------------------
// 6. Run
// ---------------------------------------------------------------------------

const args = [
  cliPath,
  inputPath,
  '--provider', 'elevenlabs',
  '--code-switching',
  '--script', 'roman',
  '--transliterate', 'sarvam',
  '--protect-english',
  '--auto-trim',
  '--aspect', 'portrait',
  '--style', 'bold',
  '--format', 'mp4',
  '--output', outPath,
  ...passthrough,
];

step(`Captioning ${basename(inputPath)} → ${outPath}`);
process.stderr.write(paint(DIM, `  ${args.slice(1).join(' ')}\n`));

const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
if (run.status !== 0) {
  fail(
    `caption-engine exited with code ${run.status}.`,
    'See the error above. Nothing partial is left at the output path —',
    'the renderer writes to a temp file and only renames on success.',
  );
}

// ---------------------------------------------------------------------------
// 7. Validate the artifact independently of the engine
// ---------------------------------------------------------------------------

// Modes that deliberately stop before producing an MP4 have nothing to check.
const NO_ARTIFACT = ['--dry-run', '--review-cuts', '-h', '--help'];
if (passthrough.some((a) => NO_ARTIFACT.includes(a))) {
  process.stderr.write(paint(DIM, '\n  (stopped before rendering — no output file expected)\n\n'));
  process.exit(0);
}

if (!existsSync(outPath)) {
  fail('The render reported success but no output file exists.', `Expected: ${outPath}`);
}
const size = statSync(outPath).size;
if (size === 0) {
  fail('Output file is zero bytes.', `Path: ${outPath}`, 'This is a bug — please report it.');
}

const ffprobeBin = process.env.FFPROBE_PATH || 'ffprobe';
const probe = spawnSync(
  ffprobeBin,
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outPath],
  { encoding: 'utf8' },
);
const duration = Number((probe.stdout || '').trim());
if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
  fail(
    'Output could not be validated with ffprobe.',
    `Path: ${outPath}`,
    `ffprobe said: ${(probe.stderr || '').trim() || 'no output'}`,
  );
}

process.stderr.write(
  `\n${paint(GREEN, '✓')} ${outPath}\n` +
    paint(DIM, `  ${(size / 1_048_576).toFixed(1)} MB · ${duration.toFixed(1)}s\n\n`),
);
