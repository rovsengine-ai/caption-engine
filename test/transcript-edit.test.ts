import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  updateJobTranscript,
  destroyJob,
  __testSeedDoneJob,
  getJob,
  readJobTranscript,
} from '../src/server/jobs.js';
import { CaptionEngineError } from '../src/errors.js';
import { initShaper } from '../src/text/shaper.js';
import { tempDir, makeTestVideo, hasFfmpeg, mkTranscript } from './helpers.js';

const skip = hasFfmpeg() ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-tx-edit-');
});
after(() => tmp?.cleanup());

function seedJob(overrides: {
  words?: Array<[string, number, number]>;
  withCuts?: boolean;
} = {}): string {
  const srcPath = join(tmp.path, `src-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  const input = hasFfmpeg()
    ? makeTestVideo(srcPath, { durationSec: 3 })
    : (writeFileSync(srcPath, Buffer.from('fake')), srcPath);

  const words = overrides.words ?? [
    ['hello', 0.2, 0.5],
    ['Vaibhav', 0.55, 1.0],
    ['here', 1.1, 1.4],
  ];
  const transcript = mkTranscript(words, 'en', 3);
  // Simulate a prior romanisation pass on the proper noun.
  transcript.words[1]!.roman = 'Vaibhav';

  return __testSeedDoneJob({
    inputPath: input,
    transcript,
    formats: ['mp4', 'srt', 'ass'],
    fields: { style: 'default', aspect: 'portrait', script: 'native', formats: ['mp4', 'srt', 'ass'] },
  });
}

describe('updateJobTranscript validation', () => {
  test('rejects unknown jobs', () => {
    assert.throws(
      () => updateJobTranscript('missing', { wordIndex: 0, text: 'x' }),
      (err: unknown) => err instanceof CaptionEngineError && /not found/i.test(err.message),
    );
  });

  test('rejects empty patch body', () => {
    const jobId = seedJob();
    try {
      assert.throws(
        () => updateJobTranscript(jobId, {} as never),
        (err: unknown) => err instanceof CaptionEngineError && /words, cues, or wordIndex/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });

  test('rejects start > end on a single-word patch', () => {
    const jobId = seedJob();
    try {
      assert.throws(
        () => updateJobTranscript(jobId, { wordIndex: 0, text: 'hi', start: 2, end: 1 }),
        (err: unknown) => err instanceof CaptionEngineError && /start .* must be <= end/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });

  test('rejects negative timestamps', () => {
    const jobId = seedJob();
    try {
      assert.throws(
        () => updateJobTranscript(jobId, { wordIndex: 0, text: 'hi', start: -0.1, end: 0.2 }),
        (err: unknown) => err instanceof CaptionEngineError && /timestamps must be >= 0/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });

  test('rejects out-of-range wordIndex', () => {
    const jobId = seedJob();
    try {
      assert.throws(
        () => updateJobTranscript(jobId, { wordIndex: 99, text: 'nope' }),
        (err: unknown) => err instanceof CaptionEngineError && /out of range/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });
});

describe('updateJobTranscript persistence', () => {
  test('patches a single word, preserves roman sync, rebuilds srt/ass', () => {
    const jobId = seedJob();
    try {
      const result = updateJobTranscript(jobId, {
        wordIndex: 1,
        text: 'ROVS',
      });
      assert.deepEqual(result, { ok: true, wordCount: 3 });

      const doc = readJobTranscript(jobId) as {
        words: Array<{ text: string; roman?: string }>;
      };
      assert.equal(doc.words[1]!.text, 'ROVS');
      assert.equal(doc.words[1]!.roman, 'ROVS', 'romanisation should track the spelling fix');

      const job = getJob(jobId)!;
      assert.ok(job.outputs.srt && existsSync(job.outputs.srt));
      assert.ok(job.outputs.ass && existsSync(job.outputs.ass));
      const srt = readFileSync(job.outputs.srt, 'utf8');
      assert.match(srt, /ROVS/);
      assert.doesNotMatch(srt, /Vaibhav/);
    } finally {
      destroyJob(jobId);
    }
  });

  test('applies a cue-level text rewrite via wordIndices', () => {
    const jobId = seedJob();
    try {
      const result = updateJobTranscript(jobId, {
        cues: [{
          wordIndices: [0, 1, 2],
          text: 'hey ROVS folks',
          start: 0.15,
          end: 1.5,
        }],
      });
      assert.equal(result.ok, true);

      const doc = readJobTranscript(jobId) as {
        words: Array<{ text: string; start: number; end: number }>;
      };
      assert.equal(doc.words[0]!.text, 'hey');
      assert.equal(doc.words[1]!.text, 'ROVS');
      assert.equal(doc.words[2]!.text, 'folks');
      assert.equal(doc.words[0]!.start, 0.15);
      assert.equal(doc.words[2]!.end, 1.5);
    } finally {
      destroyJob(jobId);
    }
  });

  test('full words array replace keeps metadata and duration', () => {
    const jobId = seedJob();
    try {
      updateJobTranscript(jobId, {
        words: [
          { text: 'Namaste', start: 0.1, end: 0.6, type: 'word', confidence: 0.99 },
          { text: 'doston', start: 0.7, end: 1.2, type: 'word', confidence: 0.98, roman: 'doston' },
        ],
      });
      const doc = readJobTranscript(jobId) as {
        words: Array<{ text: string; roman?: string }>;
        duration: number;
      };
      assert.equal(doc.words.length, 2);
      assert.equal(doc.words[1]!.roman, 'doston');
      assert.ok(doc.duration >= 1.2);
    } finally {
      destroyJob(jobId);
    }
  });

  test('atomic write leaves a readable transcript.json', { skip }, () => {
    const jobId = seedJob();
    try {
      updateJobTranscript(jobId, { wordIndex: 0, text: 'hola' });
      const job = getJob(jobId)!;
      const path = job.outputs.transcript!;
      assert.ok(existsSync(path));
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(parsed.words[0].text, 'hola');
    } finally {
      destroyJob(jobId);
    }
  });
});
