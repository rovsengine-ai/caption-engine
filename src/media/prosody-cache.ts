import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProsodyAnalysis } from './prosody.js';

const CACHE_VERSION = 1;

/** Local-only cache. It stores numeric measurements, never audio or credentials. */
export function prosodyCachePath(inputHash: string, root = join(tmpdir(), 'caption-engine-prosody-cache')): string {
  return join(root, `${inputHash.slice(0, 32)}.json`);
}

export function loadProsodyCache(inputHash: string, root?: string): ProsodyAnalysis | null {
  const path = prosodyCachePath(inputHash, root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: number; analysis?: ProsodyAnalysis };
    return parsed.version === CACHE_VERSION && parsed.analysis?.version === 1 ? parsed.analysis : null;
  } catch {
    return null;
  }
}

export function saveProsodyCache(inputHash: string, analysis: ProsodyAnalysis, root?: string): string {
  const path = prosodyCachePath(inputHash, root);
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: CACHE_VERSION, analysis }), 'utf8');
  renameSync(temp, path);
  return path;
}
