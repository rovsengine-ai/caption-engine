/**
 * Visual verification: renders one caption frame per supported language and
 * tiles them into a single contact sheet for inspection.
 *
 *   npm run build && node dist/demo/visual-check.js
 *
 * Automated tests can prove glyphs are non-.notdef and that shaping reordered
 * clusters. They cannot prove the result is READABLE. Look at the sheet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCueSvg } from '../src/captions/svg.js';
import { renderPreviewFrame } from '../src/render/pipeline.js';
import { resolveStyle } from '../src/captions/style.js';
import { initShaper } from '../src/text/shaper.js';
import type { CaptionCue, Word } from '../src/types.js';

const OUT = join(process.cwd(), 'demo-out', 'visual');
mkdirSync(OUT, { recursive: true });

const SAMPLES: Array<{ lang: string; label: string; words: string[]; active: number }> = [
  { lang: 'hi', label: 'Hindi', words: ['आज', 'का', 'वीडियो', 'ख़ास'], active: 2 },
  { lang: 'hi', label: 'Hindi conjuncts', words: ['विद्या', 'क्षेत्र', 'त्रिशूल'], active: 0 },
  { lang: 'hi-Latn', label: 'Hinglish', words: ['ye', 'बहुत', 'important', 'है'], active: 2 },
  { lang: 'te', label: 'Telugu', words: ['నేను', 'ఈరోజు', 'చెప్తాను'], active: 2 },
  { lang: 'kn', label: 'Kannada', words: ['ನಾನು', 'ಇವತ್ತು', 'ಹೇಳ್ತೀನಿ'], active: 1 },
  { lang: 'ta', label: 'Tamil', words: ['நான்', 'இன்று', 'சொல்கிறேன்'], active: 2 },
  { lang: 'ml', label: 'Malayalam', words: ['ഞാൻ', 'ഇന്ന്', 'പറയാം'], active: 1 },
  { lang: 'bn', label: 'Bengali', words: ['আমি', 'আজ', 'বলছি'], active: 2 },
  { lang: 'gu', label: 'Gujarati', words: ['હું', 'આજે', 'કહીશ'], active: 1 },
  { lang: 'pa', label: 'Gurmukhi', words: ['ਮੈਂ', 'ਅੱਜ', 'ਦੱਸਾਂਗਾ'], active: 2 },
  { lang: 'mr', label: 'Marathi', words: ['मी', 'आज', 'सांगतो'], active: 2 },
  { lang: 'en', label: 'English', words: ['this', 'is', 'a', 'caption'], active: 3 },
];

function mkCue(words: string[]): CaptionCue {
  const ws: Word[] = words.map((text, i) => ({
    text, start: i * 0.4, end: i * 0.4 + 0.35,
    confidence: 1, type: 'word' as const, keep: true,
  }));
  return {
    index: 0,
    start: 0,
    end: words.length * 0.4,
    words: ws,
    text: words.join(' '),
  };
}

async function main() {
  await initShaper();
  const W = 1080, H = 520;
  const style = { ...resolveStyle('bold', 1920), positionY: 0.5, fontSizePx: 72 };

  const files: string[] = [];
  for (const s of SAMPLES) {
    const svg = await renderCueSvg(mkCue(s.words), {
      width: W, height: H, style, activeWordIndex: s.active, activeScale: 1.12,
    });
    const png = join(OUT, `${s.label.replace(/\s+/g, '_')}.png`);
    await renderPreviewFrame(svg, png, '#12161c', { width: W, height: H });
    files.push(png);
    writeFileSync(join(OUT, `${s.label.replace(/\s+/g, '_')}.svg`), svg, 'utf8');
    console.log(`  ${s.label.padEnd(18)} ${s.words.join(' ')}`);
  }

  console.log(`\n${files.length} frames written to ${OUT}`);
  console.log('\nInspect each for:');
  console.log('  [ ] no empty boxes (tofu)');
  console.log('  [ ] vowel marks on the correct consonant');
  console.log('  [ ] conjuncts joined, not split');
  console.log('  [ ] exactly one word highlighted');
  console.log('  [ ] nothing clipped at the frame edges');
}

main().catch((e) => {
  console.error('visual-check failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
