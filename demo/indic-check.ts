/**
 * Indic script rendering check — RUN THIS EARLY.
 *
 * This is the #1 place Indic captions break, and it fails SILENTLY: text renders
 * as empty boxes (tofu), or worse, renders as "readable" but with broken
 * conjuncts and misplaced matras that only a native speaker will catch.
 *
 * Two independent things must both be true:
 *   1. A font with the right glyphs is installed and findable by fontconfig.
 *   2. libass shapes complex scripts correctly — it needs HarfBuzz. Without it,
 *      Devanagari conjuncts (क्ष, त्र) and matras attach wrongly.
 *
 * Usage:
 *   node dist/demo/indic-check.js
 *   # then LOOK at demo-out/indic-check.png with a native speaker. Do not
 *   # skip that step — automated checks cannot catch bad shaping.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAss } from '../src/captions/ass.js';
import { groupIntoCues } from '../src/captions/group.js';
import { runFfmpeg } from '../src/render/ffmpeg.js';
import type { Transcript } from '../src/types.js';

const OUT = join(process.cwd(), 'demo-out');
mkdirSync(OUT, { recursive: true });

const SAMPLES: Array<{ lang: string; label: string; words: string[] }> = [
  { lang: 'hi', label: 'Hindi (Devanagari)', words: ['आज', 'का', 'वीडियो', 'बहुत', 'ख़ास', 'है'] },
  { lang: 'hi', label: 'Hindi conjuncts', words: ['क्षेत्र', 'त्रिशूल', 'विद्या', 'शुद्ध'] },
  { lang: 'te', label: 'Telugu', words: ['నేను', 'ఈరోజు', 'మీకు', 'చెప్తాను'] },
  { lang: 'kn', label: 'Kannada', words: ['ನಾನು', 'ಇವತ್ತು', 'ನಿಮಗೆ', 'ಹೇಳ್ತೀನಿ'] },
  { lang: 'ta', label: 'Tamil', words: ['நான்', 'இன்று', 'உங்களுக்கு', 'சொல்கிறேன்'] },
  { lang: 'hi', label: 'Code-switched', words: ['ye', 'बहुत', 'important', 'बात', 'है'] },
];

async function main() {
  const W = 1080;
  const H = 220 * SAMPLES.length + 80;

  const lines: string[] = [];
  SAMPLES.forEach((s, i) => {
    const t: Transcript = {
      provider: 'check',
      hasWordTimings: true,
      language: s.lang,
      duration: 3,
      words: s.words.map((text, k) => ({
        text,
        start: k * 0.3,
        end: k * 0.3 + 0.28,
        confidence: 1,
        type: 'word' as const,
        keep: true,
      })),
    };
    const cues = groupIntoCues(t, { maxWordsPerCue: 10, maxCharsPerLine: 60 });
    const ass = buildAss(cues, {
      video: { width: W, height: H },
      highlight: 'none',
      // Change this to whatever font you actually intend to ship with.
      style: { fontFamily: 'Noto Sans', fontSizePx: 54, positionY: 0 } as never,
    });
    const dialogue = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    // Re-position each sample onto its own row with \pos.
    const y = 120 + i * 200;
    for (const d of dialogue) {
      // Dialogue has 9 comma-separated fields before Text; Text itself may
      // contain commas, so split-and-rejoin rather than indexOf(',,').
      const text = d.split(',').slice(9).join(',');
      lines.push(
        `Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\pos(${W / 2},${y})}${text}`,
        `Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\pos(${W / 2},${y - 55})\\fs28\\c&H00888888&}${s.label}`,
      );
    }
  });

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Noto Sans,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,' +
      '-1,0,0,0,100,100,0,0,1,4,0,5,40,40,40,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...lines,
    '',
  ].join('\n');

  const assPath = join(OUT, 'indic-check.ass');
  writeFileSync(assPath, ass, 'utf8');

  const png = join(OUT, 'indic-check.png');
  const res = await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x14181d:s=${W}x${H}:d=1`,
    '-vf', `subtitles='${assPath}'`,
    '-frames:v', '1',
    png,
  ]);
  if (res.code !== 0) throw new Error(res.stderr.slice(-2000));

  console.log(`Wrote ${png}`);
  console.log(
    '\nNow LOOK at it. Checklist:\n' +
      '  [ ] No empty boxes (tofu) — means the font is missing that script\n' +
      '  [ ] Conjuncts joined: क्षेत्र त्रिशूल should be single ligatures, not split\n' +
      '  [ ] Matras (vowel marks) sit on the correct consonant\n' +
      '  [ ] Telugu/Kannada/Tamil glyphs are shaped, not a string of separate marks\n' +
      '  [ ] Code-switched line shows Latin and Devanagari at consistent size\n' +
      '\nIf anything is wrong: install Noto Sans Devanagari / Telugu / Kannada / Tamil,\n' +
      'and confirm your ffmpeg links libass built WITH HarfBuzz (ffmpeg -version | grep libass).',
  );
}

main().catch((e) => {
  console.error('indic-check failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
