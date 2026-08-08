import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoCues, DEFAULT_STYLE } from '../src/captions/group.js';
import { buildAss, buildSrt, assTime, srtTime, toAssColour } from '../src/captions/ass.js';
import { hinglishTranscript, teluguTranscript } from './fixtures.js';

/** Parse "H:MM:SS.cc" back to seconds, for assertions. */
function parseAssTime(s: string): number {
  const [h, m, rest] = s.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}

describe('cue grouping', () => {
  const cues = groupIntoCues(hinglishTranscript);

  test('produces cues', () => {
    assert.ok(cues.length > 0);
  });

  test('respects max words per cue', () => {
    for (const c of cues) {
      assert.ok(c.words.length <= 4, `cue has ${c.words.length} words: "${c.text}"`);
    }
  });

  test('cues are chronological and non-overlapping', () => {
    for (let i = 1; i < cues.length; i++) {
      assert.ok(
        cues[i]!.start >= cues[i - 1]!.start,
        'cues out of order',
      );
      assert.ok(
        cues[i - 1]!.end <= cues[i]!.start + 0.001,
        `cue ${i - 1} overlaps ${i}: ${cues[i - 1]!.end} > ${cues[i]!.start}`,
      );
    }
  });

  test('no word is lost during grouping', () => {
    const spoken = hinglishTranscript.words.filter((w) => w.type === 'word' && w.keep !== false);
    const inCues = cues.flatMap((c) => c.words);
    assert.equal(inCues.length, spoken.length, 'every spoken word must appear in exactly one cue');
  });

  test('breaks at the long silence', () => {
    // The 3s gap at 7.3-10.3 must not be swallowed inside one cue.
    const spanning = cues.find((c) => c.start < 7.3 && c.end > 10.3);
    assert.equal(spanning, undefined, 'a cue must not span the 3s silence');
  });

  test('excludes words marked keep:false', () => {
    const t = {
      ...hinglishTranscript,
      words: hinglishTranscript.words.map((w) =>
        w.text === 'um' ? { ...w, keep: false } : w,
      ),
    };
    const out = groupIntoCues(t);
    assert.equal(
      out.some((c) => c.words.some((w) => w.text === 'um')),
      false,
      'trimmed words must not appear in captions',
    );
  });

  test('handles an empty transcript', () => {
    assert.deepEqual(groupIntoCues({ ...hinglishTranscript, words: [] }), []);
  });

  test('breaks on Devanagari danda, not just ASCII punctuation', () => {
    const t = {
      ...hinglishTranscript,
      language: 'hi',
      duration: 4,
      words: [
        { text: 'यह', start: 0.0, end: 0.4, confidence: 1, type: 'word' as const, keep: true },
        { text: 'सच', start: 0.4, end: 0.8, confidence: 1, type: 'word' as const, keep: true },
        { text: 'है।', start: 0.8, end: 1.2, confidence: 1, type: 'word' as const, keep: true },
        { text: 'अगला', start: 1.25, end: 1.6, confidence: 1, type: 'word' as const, keep: true },
      ],
    };
    const out = groupIntoCues(t, { maxWordsPerCue: 10, maxCharsPerLine: 100 });
    assert.ok(out.length >= 2, 'danda । should end a cue');
  });
});

describe('time formatting', () => {
  test('ASS format', () => {
    assert.equal(assTime(0), '0:00:00.00');
    assert.equal(assTime(1.5), '0:00:01.50');
    assert.equal(assTime(61.23), '0:01:01.23');
    assert.equal(assTime(3661.5), '1:01:01.50');
  });

  test('ASS rounding does not emit .100', () => {
    const s = assTime(1.999);
    assert.match(s, /^\d:\d\d:\d\d\.\d\d$/);
    assert.equal(s, '0:00:02.00');
  });

  test('SRT format', () => {
    assert.equal(srtTime(0), '00:00:00,000');
    assert.equal(srtTime(61.234), '00:01:01,234');
  });

  test('SRT rounding does not emit ,1000', () => {
    assert.equal(srtTime(1.9999), '00:00:02,000');
  });

  test('negative times clamp to zero', () => {
    assert.equal(assTime(-5), '0:00:00.00');
  });
});

describe('ASS colour conversion', () => {
  test('converts RGB hex to ASS BGR order', () => {
    // Red #FF0000 must become &H000000FF — blue-green-red, not red-green-blue.
    assert.equal(toAssColour('#FF0000'), '&H000000FF');
    assert.equal(toAssColour('#00FF00'), '&H0000FF00');
    assert.equal(toAssColour('#0000FF'), '&H00FF0000');
    assert.equal(toAssColour('#FFFFFF'), '&H00FFFFFF');
  });

  test('expands 3-digit hex', () => {
    assert.equal(toAssColour('#F00'), '&H000000FF');
  });

  test('tolerates a missing #', () => {
    assert.equal(toAssColour('FFD400'), toAssColour('#FFD400'));
  });
});

describe('ASS document', () => {
  const cues = groupIntoCues(hinglishTranscript);
  const ass = buildAss(cues, { video: { width: 1080, height: 1920 } });

  test('has the required sections', () => {
    assert.match(ass, /\[Script Info\]/);
    assert.match(ass, /\[V4\+ Styles\]/);
    assert.match(ass, /\[Events\]/);
    assert.match(ass, /^Style: Default,/m);
  });

  test('declares the real frame size', () => {
    assert.match(ass, /PlayResX: 1080/);
    assert.match(ass, /PlayResY: 1920/);
  });

  test('active-word mode emits one Dialogue line per word', () => {
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const wordCount = cues.reduce((n, c) => n + c.words.length, 0);
    assert.ok(
      lines.length >= wordCount,
      `expected >= ${wordCount} dialogue lines, got ${lines.length}`,
    );
  });

  test('active-word: exactly ONE word is highlighted per line', () => {
    // The bug this guards: highlighting the whole line at once, which happens if
    // the colour is never reset after the active word.
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const active = toAssColour(DEFAULT_STYLE.activeColor);
    for (const l of lines) {
      const hits = [...l.matchAll(new RegExp(`\\\\c${active.replace(/[&\\]/g, '\\$&')}`, 'g'))];
      assert.ok(hits.length <= 1, `line highlights ${hits.length} words: ${l.slice(0, 120)}`);
    }
  });

  test('active-word: colour is reset after the highlighted word', () => {
    const line = ass
      .split('\n')
      .find((l) => l.startsWith('Dialogue:') && l.includes(toAssColour(DEFAULT_STYLE.activeColor)));
    assert.ok(line, 'expected at least one highlighted line');
    assert.match(
      line!,
      new RegExp(`${toAssColour(DEFAULT_STYLE.primaryColor).replace(/[&\\]/g, '\\$&')}`),
      'must return to the primary colour or the highlight bleeds across the cue',
    );
  });

  test('active-word: highlight windows stay inside their cue', () => {
    const cue = cues[0]!;
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const first = lines[0]!;
    const m = first.match(/Dialogue: 0,([\d:.]+),([\d:.]+),/);
    assert.ok(m);
    assert.ok(parseAssTime(m![1]!) >= cue.start - 0.001);
  });

  test('karaoke mode uses native \\kf without inline colour overrides', () => {
    // Inline \c tags override the Secondary→Primary karaoke transition and
    // flatten every word to one colour — the bug caught by rendering a frame.
    const k = buildAss(cues, { highlight: 'karaoke' });
    assert.match(k, /\\kf\d+/, 'expected \\kf tags');
    assert.doesNotMatch(k, /\\kf\d+\\c/, 'inline \\c after \\kf defeats the karaoke fill');
  });

  test('karaoke style puts the active colour in PrimaryColour', () => {
    // ASS \k transitions Secondary → Primary. Reversed, text starts highlighted
    // and fades to normal.
    const k = buildAss(cues, { highlight: 'karaoke' });
    const styleRow = k.split('\n').find((l) => l.startsWith('Style: Default'))!;
    const cols = styleRow.split(',');
    assert.equal(cols[3], toAssColour(DEFAULT_STYLE.activeColor), 'PrimaryColour = sung colour');
    assert.equal(cols[4], toAssColour(DEFAULT_STYLE.primaryColor), 'SecondaryColour = unsung');
  });

  test('karaoke durations are positive integers', () => {
    const k = buildAss(cues, { highlight: 'karaoke' });
    for (const m of k.matchAll(/\\kf(\d+)/g)) {
      assert.ok(Number(m[1]) >= 1, `bad karaoke duration: ${m[0]}`);
    }
  });

  test('karaoke timings sum to roughly the cue duration', () => {
    // \k values are relative and cumulative, so an error compounds across the
    // line and desyncs the highlight by the end of the cue.
    const k = buildAss(cues, { highlight: 'karaoke' });
    const line = k.split('\n').filter((l) => l.startsWith('Dialogue:'))[0]!;
    const totalCs = [...line.matchAll(/\\k[f]?(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    const expectedCs = (cues[0]!.end - cues[0]!.start) * 100;
    assert.ok(
      Math.abs(totalCs - expectedCs) < expectedCs * 0.5 + 30,
      `karaoke total ${totalCs}cs vs cue ${expectedCs.toFixed(0)}cs`,
    );
  });

  test('none mode is plain text', () => {
    const plain = buildAss(cues, { highlight: 'none' });
    assert.doesNotMatch(plain, /\\kf/);
    assert.doesNotMatch(plain, /\\c&H/, 'no inline colour tags in plain mode');
    assert.match(plain, /^Dialogue:/m);
    assert.equal(
      plain.split('\n').filter((l) => l.startsWith('Dialogue:')).length,
      cues.length,
      'one line per cue',
    );
  });

  test('legacy activeWordHighlight:false still maps to plain text', () => {
    const plain = buildAss(cues, { activeWordHighlight: false });
    assert.doesNotMatch(plain, /\\kf/);
  });

  test('activeScale emits font-scale tags and resets them', () => {
    const scaled = buildAss(cues, { highlight: 'active-word', activeScale: 1.2 });
    assert.match(scaled, /\\fscx120\\fscy120/);
    assert.match(scaled, /\\fscx100\\fscy100/, 'scale must be reset after the word');
  });

  test('preserves English words inside Hindi audio', () => {
    assert.match(ass, /important/, 'code-switched English must survive to the caption');
  });

  test('preserves Telugu script', () => {
    const te = buildAss(groupIntoCues(teluguTranscript));
    assert.match(te, /చెప్తాను/, 'Telugu glyphs must pass through unmangled');
  });

  test('escapes ASS-significant braces so they cannot break the parser', () => {
    const t = {
      ...hinglishTranscript,
      words: [{ text: '{hack}', start: 0, end: 1, confidence: 1, type: 'word' as const, keep: true }],
      duration: 1,
    };
    const out = buildAss(groupIntoCues(t));
    assert.match(out, /\\\{hack\\\}/, 'literal braces must be escaped');
  });

  test('respects the reels-safe vertical position', () => {
    const marginV = Math.round(1920 * (1 - DEFAULT_STYLE.positionY));
    assert.ok(ass.includes(`,${marginV},1`), `expected MarginV ${marginV} in the style line`);
  });
});

describe('SRT export', () => {
  const srt = buildSrt(groupIntoCues(hinglishTranscript));

  test('is correctly numbered from 1', () => {
    assert.match(srt, /^1\n/);
  });

  test('uses the arrow separator', () => {
    assert.match(srt, /\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d/);
  });

  test('contains the transcript text', () => {
    assert.match(srt, /important/);
  });
});
