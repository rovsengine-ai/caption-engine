#!/usr/bin/env node
/**
 * Install the Noto fonts caption-engine needs into assets/fonts/.
 *
 * Fonts are VENDORED into the repo rather than resolved from the system,
 * because caption output must be byte-reproducible: a machine with a different
 * "Noto Sans Devanagari" installed would otherwise render different glyph
 * widths and different line breaks.
 *
 * Source: the @expo-google-fonts/* npm packages, which ship static .ttf files
 * (Google Fonts' own CDN serves woff2, which FreeType/opentype.js cannot read).
 *
 *   npm run fonts:install
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'assets', 'fonts');

const PACKAGES = [
  'noto-sans',
  'noto-sans-devanagari',
  'noto-sans-telugu',
  'noto-sans-kannada',
  'noto-sans-tamil',
  'noto-sans-malayalam',
  'noto-sans-bengali',
  'noto-sans-gujarati',
  'noto-sans-gurmukhi',
  'noto-sans-oriya',
  'noto-nastaliq-urdu',
];

const WEIGHTS = ['400Regular', '700Bold'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ttf')) out.push(p);
  }
  return out;
}

function main() {
  mkdirSync(DEST, { recursive: true });

  const existing = existsSync(DEST) ? readdirSync(DEST).filter((f) => f.endsWith('.ttf')) : [];
  if (existing.length >= PACKAGES.length * WEIGHTS.length && !process.argv.includes('--force')) {
    console.log(`${existing.length} fonts already present in assets/fonts/`);
    console.log('Use --force to reinstall.');
    return;
  }

  const work = join(tmpdir(), `caption-engine-fonts-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  console.log(`Downloading ${PACKAGES.length} font packages...`);

  try {
    execFileSync('npm', ['init', '-y'], { cwd: work, stdio: 'ignore' });
    const specs = PACKAGES.map((p) => `@expo-google-fonts/${p}`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', ...specs], {
      cwd: work,
      stdio: 'inherit',
      timeout: 15 * 60_000,
    });

    const src = join(work, 'node_modules', '@expo-google-fonts');
    if (!existsSync(src)) throw new Error('font packages did not install');

    let n = 0;
    for (const f of walk(src)) {
      if (!WEIGHTS.some((w) => f.includes(w))) continue;
      copyFileSync(f, join(DEST, f.split('/').pop()));
      n++;
    }
    console.log(`\nInstalled ${n} font files into assets/fonts/`);
    console.log('Verify with:  npm run doctor');
  } catch (e) {
    console.error(`\nFont install failed: ${e.message}`);
    console.error(
      '\nManual alternative — download Noto fonts and point FONT_DIR at them:\n' +
        '  https://fonts.google.com/noto\n' +
        '  export FONT_DIR=/path/to/fonts\n' +
        '\nmacOS via Homebrew:\n' +
        '  brew install --cask font-noto-sans font-noto-sans-devanagari \\\n' +
        '    font-noto-sans-telugu font-noto-sans-kannada font-noto-sans-tamil',
    );
    process.exitCode = 1;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main();
