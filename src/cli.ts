#!/usr/bin/env node
import { rmSync, existsSync } from 'node:fs';
import { parseArgs, printHelp } from './cli/args.js';
import { runTemplatesCommand } from './captions/template.js';
import { runDoctor, formatDoctor, isBlocking } from './cli/doctor.js';
import { fontTable } from './text/fonts.js';
import { runPipeline, type Reporter } from './cli/run.js';
import { languageTable } from './config/languages.js';
import { loadEnv, redactSecrets } from './config/env.js';
import { CaptionEngineError } from './errors.js';

// Load .env before anything reads process.env. Real environment variables
// always win — a stale file on disk must never beat the key you just exported.
loadEnv();

const isTty = process.stdout.isTTY === true;
const c = {
  dim: (s: string) => (isTty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTty ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (isTty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTty ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s: string) => (isTty ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTty ? `\x1b[36m${s}\x1b[0m` : s),
};

function makeReporter(opts: { json: boolean; verbose: boolean }): Reporter {
  if (opts.json) {
    // Diagnostics go to stderr so stdout stays a clean JSON document.
    return {
      step: (m) => process.stderr.write(`[step] ${m}\n`),
      info: (m) => opts.verbose && process.stderr.write(`[info] ${m}\n`),
      warn: (m) => process.stderr.write(`[warn] ${m}\n`),
      progress: () => {},
      done: (m) => process.stderr.write(`[done] ${m}\n`),
    };
  }
  let lastProgress = -1;
  return {
    step: (m) => process.stderr.write(`\n${c.bold(c.cyan('▸ ' + m))}\n`),
    info: (m) => process.stderr.write(`  ${c.dim(m)}\n`),
    warn: (m) => process.stderr.write(`  ${c.yellow('! ' + m)}\n`),
    progress: (pct, m) => {
      if (!isTty) {
        if (pct >= lastProgress + 25) {
          lastProgress = pct;
          process.stderr.write(`  ${m} ${pct}%\n`);
        }
        return;
      }
      const w = 28;
      const filled = Math.round((pct / 100) * w);
      process.stderr.write(
        `\r  [${'█'.repeat(filled)}${'░'.repeat(w - filled)}] ${String(pct).padStart(3)}% ${m}   `,
      );
      if (pct >= 100) process.stderr.write('\n');
    },
    done: (m) => process.stderr.write(`\n${c.green('✓ ' + m)}\n`),
  };
}

/**
 * Clean cancellation.
 *
 * Ctrl-C during a long render would otherwise leave a temp directory full of
 * caption PNGs (hundreds of MB on a long video) and a half-written MP4 that
 * looks like a real output but will not play. Track both and clean up.
 */
const partialOutputs = new Set<string>();
const tempDirs = new Set<string>();

function cleanupPartials(): void {
  for (const f of partialOutputs) {
    try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* best effort */ }
  }
  for (const d of tempDirs) {
    try { if (existsSync(d)) rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (interrupted) process.exit(130); // second Ctrl-C: leave immediately
    interrupted = true;
    process.stderr.write(
      `\n\n${c.yellow('Interrupted.')} Removing partial output...\n` +
        `${c.dim('(press Ctrl-C again to exit without cleaning up)')}\n`,
    );
    cleanupPartials();
    process.exit(130);
  });
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === 'help') {
    printHelp();
    return 0;
  }
  if (parsed.command === 'languages') {
    process.stdout.write(languageTable() + '\n');
    return 0;
  }
  if (parsed.command === 'fonts') {
    process.stdout.write(fontTable() + '\n');
    return 0;
  }
  if (parsed.command === 'templates') {
    return runTemplatesCommand(parsed.args);
  }
  if (parsed.command === 'doctor') {
    const results = await runDoctor();
    process.stdout.write(formatDoctor(results));
    // Font and API-key gaps limit features but do not make the tool unusable.
    return results.some(isBlocking) ? 1 : 0;
  }

  const opts = parsed.options;
  const log = makeReporter(opts);
  const started = Date.now();
  // Register before the work starts so an interrupt mid-render cleans up.
  if (opts.output) partialOutputs.add(opts.output);
  const result = await runPipeline(opts, log);
  // Completed successfully — no longer "partial".
  partialOutputs.clear();
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, elapsedSec: Number(secs), ...result }, null, 2) + '\n');
    return 0;
  }

  log.done(`Finished in ${secs}s`);
  const entries = Object.entries(result.outputs);
  if (entries.length > 0) {
    process.stderr.write('\n  Output files:\n');
    for (const [k, v] of entries) {
      process.stderr.write(`    ${c.bold(k.padEnd(10))} ${v}\n`);
    }
  }
  process.stderr.write(`\n  ${c.dim('Intermediate files: ' + result.workDir)}\n\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Defence in depth: an upstream provider can echo a rejected key back in an
    // error body. Scrub anything matching a configured secret before printing.
    if (err instanceof CaptionEngineError) {
      process.stderr.write(`\n${c.red('Error:')} ${redactSecrets(err.message)}\n`);
      if (err.hint) {
        process.stderr.write(`\n${c.yellow('How to fix:')}\n`);
        for (const line of redactSecrets(err.hint).split('\n')) process.stderr.write(`  ${line}\n`);
      }
      process.stderr.write('\n');
      process.exit(1);
    }
    const e = err as Error;
    process.stderr.write(`\n${c.red('Unexpected error:')} ${redactSecrets(e?.message ?? String(err))}\n`);
    if (process.env.CAPTION_ENGINE_DEBUG && e?.stack) {
      process.stderr.write(`\n${redactSecrets(e.stack)}\n`);
    } else {
      process.stderr.write(
        `\n${c.dim('Set CAPTION_ENGINE_DEBUG=1 for a stack trace.')}\n`,
      );
    }
    process.stderr.write('\n');
    process.exit(1);
  });
