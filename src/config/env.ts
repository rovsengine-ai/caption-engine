import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zero-dependency `.env` loading and *safe* environment reporting.
 *
 * Two rules govern this file:
 *
 *  1. **Real environment always wins.** A value already present in
 *     `process.env` is never overwritten by `.env`. Otherwise a stale file on
 *     disk silently beats the key you just exported, and you debug the wrong
 *     thing for an hour.
 *
 *  2. **A secret's value never leaves this module.** Everything exported
 *     reports *presence*, never content. There is deliberately no
 *     `getApiKey()` that logs, no `debug` mode that dumps the environment,
 *     and no error message that interpolates a value.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up from the compiled location to find the package root. */
function packageRoot(): string {
  for (const up of ['../../..', '../..', '..']) {
    const p = resolve(__dirname, up);
    if (existsSync(resolve(p, 'package.json'))) return p;
  }
  return process.cwd();
}

/**
 * Parse `.env` text into key/value pairs.
 *
 * Supports the subset that matters and nothing more: `KEY=value`, optional
 * `export ` prefix, `#` comments, blank lines, and single- or double-quoted
 * values. Escape sequences are expanded only inside double quotes, matching
 * every mainstream dotenv implementation.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: strip a trailing inline comment.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export interface LoadEnvResult {
  /** Absolute path of the file that was read, or null if none existed. */
  path: string | null;
  /** Names of variables this call set. Names only — never values. */
  applied: string[];
  /** Names present in the file but skipped because the real env already had them. */
  skipped: string[];
}

let loaded: LoadEnvResult | null = null;

/**
 * Load `.env`, then `.env.local` beside it, without clobbering existing values.
 *
 * `.env.local` may override keys that came from `.env`. A value already in
 * the real environment still wins over both files — that is how `npm run
 * local:setup` can opt a machine into local ASR without changing the code
 * default, and without beating a key you exported in the shell.
 *
 * Idempotent: repeated calls return the first result. Pass `force` in tests.
 */
export function loadEnv(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; force?: boolean } = {},
): LoadEnvResult {
  if (loaded && !opts.force) return loaded;

  const env = opts.env ?? process.env;
  const searchDirs = [opts.cwd ?? process.cwd(), packageRoot()];

  let path: string | null = null;
  for (const dir of searchDirs) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) { path = candidate; break; }
  }

  // Only the directory that supplied `.env`. Looking further would pull a
  // developer's project-root `.env.local` into a test that pointed `cwd` at
  // a temp folder with its own `.env`.
  let localPath: string | null = null;
  if (path) {
    const beside = resolve(dirname(path), '.env.local');
    if (existsSync(beside)) localPath = beside;
  } else {
    for (const dir of searchDirs) {
      const candidate = resolve(dir, '.env.local');
      if (existsSync(candidate)) { localPath = candidate; path = candidate; break; }
    }
  }

  const result: LoadEnvResult = { path, applied: [], skipped: [] };
  if (!path && !localPath) {
    if (!opts.force) loaded = result;
    return result;
  }

  const originallySet = new Set(
    Object.entries(env)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k]) => k),
  );

  const files = [path, localPath].filter((p): p is string => Boolean(p));
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(file, 'utf8'));
    } catch {
      // An unreadable env file is not fatal — real env vars may already be set.
      continue;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (originallySet.has(k)) {
        if (!result.skipped.includes(k)) result.skipped.push(k);
        continue;
      }
      env[k] = v;
      if (!result.applied.includes(k)) result.applied.push(k);
    }
  }

  if (!opts.force) loaded = result;
  return result;
}

/** Test seam. */
export function resetEnvLoader(): void {
  loaded = null;
}

// ---------------------------------------------------------------------------
// Safe reporting
// ---------------------------------------------------------------------------

/** Variables treated as secrets. Their values are never rendered anywhere. */
export const SECRET_ENV_VARS = [
  'ELEVENLABS_API_KEY',
  'DEEPGRAM_API_KEY',
  'SARVAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'KIMI_API_KEY',
] as const;

export type SecretEnvVar = (typeof SECRET_ENV_VARS)[number];

export interface EnvVarStatus {
  name: string;
  present: boolean;
  /** True for a variable that exists but is empty or whitespace — a common .env mistake. */
  blank: boolean;
}

/**
 * Report whether a variable is set. Returns presence only.
 *
 * There is no overload that returns the value: the point of this function is
 * that a caller which only needs "is it configured?" cannot accidentally log a
 * key by holding one.
 */
export function envStatus(name: string, env: NodeJS.ProcessEnv = process.env): EnvVarStatus {
  const raw = env[name];
  const present = raw !== undefined && raw.trim() !== '';
  return { name, present, blank: raw !== undefined && raw.trim() === '' };
}

/** Presence report for every known secret. Safe to print. */
export function secretsStatus(env: NodeJS.ProcessEnv = process.env): EnvVarStatus[] {
  return SECRET_ENV_VARS.map((n) => envStatus(n, env));
}

/**
 * Assert that the named variables are set, or throw listing the missing NAMES.
 *
 * The message names what is missing and never reveals what is present.
 */
export function requireEnv(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const missing = names.filter((n) => !envStatus(n, env).present);
  if (missing.length === 0) return;
  throw new Error(
    `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}\n` +
      `Set ${missing.length > 1 ? 'them' : 'it'} in your shell or in a .env file at the project root.\n` +
      `See .env.example for the expected names. Never commit .env.`,
  );
}

/**
 * Redact anything that looks like a configured secret out of a string.
 *
 * Defence in depth for log/error paths: the code should not put a key into a
 * message in the first place, but if one ever leaks through an upstream error
 * body this replaces it before it reaches a terminal or a file.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_VARS) {
    const v = env[name];
    // Short values are skipped: replacing a 3-character "value" would mangle prose.
    if (v && v.trim().length >= 8) {
      out = out.split(v).join(`[${name} redacted]`);
    }
  }
  return out;
}
