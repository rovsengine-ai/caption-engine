import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  listJobClips,
  generateJobClips,
  exportJobClip,
  destroyJob,
  __testSeedDoneJob,
  getJob,
  toPublicClip,
} from '../src/server/jobs.js';
import { scoreTranscriptSegments } from '../src/clips/score.js';
import { CaptionEngineError } from '../src/errors.js';
import { initShaper } from '../src/text/shaper.js';
import { tempDir, makeTestVideo, hasFfmpeg, mkTranscript } from './helpers.js';

const skipNoFfmpeg = hasFfmpeg() ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-clips-');
});
after(() => tmp?.cleanup());

/** Build a ~40s transcript dense enough for rule-based scoring. */
function longWords(): Array<[string, number, number]> {
  const tokens = [
    'How', 'do', 'you', 'actually', '10x', 'your', 'productivity?',
    'The', 'secret', 'is', 'simple.', 'Stop', 'multitasking', 'and',
    'start', 'one', 'thing', 'at', 'a', 'time.', 'Most', 'people',
    'never', 'learn', 'this', 'hack.', 'Why', 'does', 'it', 'work?',
    'Because', 'focus', 'compounds.', 'Always', 'protect', 'your',
    'deep', 'work', 'blocks.', 'That', 'is', 'the', 'best', 'tip.',
  ];
  const out: Array<[string, number, number]> = [];
  let t = 0.2;
  for (const text of tokens) {
    const dur = 0.55 + (text.length % 3) * 0.12;
    out.push([text, t, t + dur]);
    t += dur + 0.08;
  }
  // Push past 15s min duration with a second beat after a pause.
  t += 0.8;
  const more = [
    'Mistake', 'number', 'one', 'is', 'checking', 'email', 'first.',
    'Must', 'block', 'distractions.', "Don't", 'open', 'Slack', 'until',
    'noon.', 'This', 'truth', 'changed', 'everything', 'for', 'me.',
  ];
  for (const text of more) {
    const dur = 0.5 + (text.length % 4) * 0.1;
    out.push([text, t, t + dur]);
    t += dur + 0.06;
  }
  return out;
}

function seedJob(opts: {
  words?: Array<[string, number, number]>;
  durationSec?: number;
} = {}): string {
  const durationSec = opts.durationSec ?? 45;
  const srcPath = join(tmp.path, `src-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  const input = hasFfmpeg()
    ? makeTestVideo(srcPath, { durationSec, width: 1280, height: 720 })
    : (writeFileSync(srcPath, Buffer.from('fake')), srcPath);

  const words = opts.words ?? longWords();
  const transcript = mkTranscript(words, 'en', durationSec);

  return __testSeedDoneJob({
    inputPath: input,
    transcript,
    formats: ['mp4', 'srt', 'ass'],
    fields: { style: 'default', aspect: 'portrait', formats: ['mp4', 'srt', 'ass'] },
  });
}

describe('scoreTranscriptSegments (rule-based fallback)', () => {
  test('returns empty for tiny transcripts', () => {
    const tx = mkTranscript([
      ['hi', 0, 0.3],
      ['there', 0.4, 0.7],
    ], 'en', 1);
    assert.deepEqual(scoreTranscriptSegments(tx), []);
  });

  test('finds scored candidates with hooks and questions', () => {
    const tx = mkTranscript(longWords(), 'en', 45);
    const clips = scoreTranscriptSegments(tx, { minDurationSec: 8, maxDurationSec: 60, maxCandidates: 5 });
    assert.ok(clips.length >= 1, 'expected at least one rule-based candidate');
    for (const c of clips) {
      assert.ok(c.end > c.start);
      assert.ok(c.score >= 0 && c.score <= 100);
      assert.ok(c.title.length > 0);
      assert.match(c.reason, /rule-based/i);
    }
    // Highest score first.
    for (let i = 1; i < clips.length; i++) {
      assert.ok(clips[i - 1]!.score >= clips[i]!.score);
    }
  });
});

describe('listJobClips / generateJobClips', () => {
  test('list returns empty array before generate', () => {
    const jobId = seedJob({ durationSec: 4, words: [
      ['hello', 0.2, 0.5],
      ['world', 0.6, 1.0],
    ] });
    try {
      const clips = listJobClips(jobId);
      assert.ok(clips);
      assert.equal(clips!.length, 0);
    } finally {
      destroyJob(jobId);
    }
  });

  test('list returns null for unknown job', () => {
    assert.equal(listJobClips('missing-job'), null);
  });

  test('generate uses rule-based scoring when no Anthropic key', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const jobId = seedJob({ durationSec: 50 });
    try {
      const result = await generateJobClips(jobId);
      assert.equal(result.source, 'rules');
      assert.ok(result.count >= 1, `expected clips, got ${result.count}`);
      assert.equal(result.clips.length, result.count);

      const first = result.clips[0]!;
      assert.match(first.id, /^clip-\d+$/);
      assert.ok(typeof first.hook === 'string' && first.hook.length > 0);
      assert.ok(first.viralityScore >= 0 && first.viralityScore <= 100);
      assert.ok(first.end > first.start);
      assert.ok(typeof first.reasoning === 'string');

      const listed = listJobClips(jobId)!;
      assert.equal(listed.length, result.count);

      const job = getJob(jobId)!;
      assert.ok(job.outputs.clips && existsSync(job.outputs.clips));
      const disk = JSON.parse(readFileSync(job.outputs.clips, 'utf8')) as { clips: unknown[] };
      assert.ok(Array.isArray(disk.clips) && disk.clips.length === result.count);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
      destroyJob(jobId);
    }
  });

  test('generate rejects unknown jobs', async () => {
    await assert.rejects(
      () => generateJobClips('nope'),
      (err: unknown) => err instanceof CaptionEngineError && /not found/i.test(err.message),
    );
  });

  test('toPublicClip maps score→viralityScore and title→hook', () => {
    const pub = toPublicClip('jid', {
      id: 'clip-3',
      start: 10,
      end: 42,
      score: 94,
      title: 'The Secret to 10x Productivity',
      reason: 'Strong hook',
      transcriptExcerpt: '…',
    }, {});
    assert.equal(pub.id, 'clip-3');
    assert.equal(pub.hook, 'The Secret to 10x Productivity');
    assert.equal(pub.viralityScore, 94);
    assert.equal(pub.reasoning, 'Strong hook');
    assert.equal(pub.durationSec, 32);
    assert.equal(pub.exported, false);
  });
});

describe('exportJobClip', { skip: skipNoFfmpeg }, () => {
  test('exports a short 9:16 reel and returns downloadUrl', async () => {
    const jobId = seedJob({
      durationSec: 6,
      words: [
        ['How', 0.2, 0.5],
        ['to', 0.55, 0.7],
        ['focus', 0.75, 1.2],
        ['deeply', 1.3, 1.8],
        ['every', 1.9, 2.2],
        ['morning', 2.3, 2.9],
        ['without', 3.0, 3.4],
        ['failing', 3.5, 4.2],
      ],
    });
    try {
      const job = getJob(jobId)!;
      job.clips = [{
        id: 'clip-0',
        start: 0.5,
        end: 3.5,
        score: 88,
        title: 'Focus every morning',
        reason: 'fixture',
        transcriptExcerpt: 'How to focus deeply',
      }];

      const result = await exportJobClip(jobId, 'clip-0');
      assert.equal(result.ok, true);
      assert.equal(result.outputKey, 'clip-0');
      assert.equal(result.downloadUrl, `/api/download/${jobId}/clip-0`);

      const outPath = job.outputs['clip-0'];
      assert.ok(outPath && existsSync(outPath));
      assert.ok(statSync(outPath).size > 1000);

      const listed = listJobClips(jobId)!;
      assert.equal(listed[0]!.exported, true);
      assert.equal(listed[0]!.downloadUrl, result.downloadUrl);
    } finally {
      destroyJob(jobId);
    }
  });

  test('rejects missing clip id', async () => {
    const jobId = seedJob({ durationSec: 4, words: [['hi', 0.1, 0.4], ['there', 0.5, 0.9]] });
    try {
      await assert.rejects(
        () => exportJobClip(jobId, 'clip-99'),
        (err: unknown) => err instanceof CaptionEngineError && /not found/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });
});
