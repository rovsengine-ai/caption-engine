import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  startReRender,
  getJob,
  destroyJob,
  setCutRestored,
  subscribe,
  unsubscribe,
  __testSeedDoneJob,
  type ProgressEvent,
} from '../src/server/jobs.js';
import { CaptionEngineError } from '../src/errors.js';
import { initShaper } from '../src/text/shaper.js';
import {
  tempDir, makeTestVideo, hasFfmpeg, mkTranscript,
} from './helpers.js';
import type { Cut } from '../src/types.js';

const skip = hasFfmpeg() ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

before(async () => {
  await initShaper();
  tmp = tempDir('ce-rerender-');
});
after(() => {
  tmp?.cleanup();
});

function waitForTerminal(jobId: string, timeoutMs = 180_000): Promise<ProgressEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe(jobId, onEvent);
      reject(new Error(`re-render timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function onEvent(evt: ProgressEvent): void {
      if (evt.type === 'done' || evt.type === 'error') {
        clearTimeout(timer);
        unsubscribe(jobId, onEvent);
        resolve(evt);
      }
    }

    const buffered = subscribe(jobId, onEvent);
    if (!buffered) {
      clearTimeout(timer);
      reject(new Error('job disappeared while waiting'));
      return;
    }
    for (const evt of buffered) onEvent(evt);
  });
}

describe('startReRender validation', () => {
  test('rejects unknown job ids', () => {
    assert.throws(
      () => startReRender('does-not-exist'),
      (err: unknown) => err instanceof CaptionEngineError && /not found/i.test(err.message),
    );
  });

  test('rejects a job with no cached transcript', () => {
    const src = join(tmp.path, 'no-tx.mp4');
    writeFileSync(src, Buffer.alloc(64)); // placeholder — validation fails before probe
    // Seed requires renaming the input; use a tiny real-ish file via makeTestVideo when ffmpeg exists.
    // Without ffmpeg, write a fake and still exercise the transcript-missing path by deleting it.
    const input = hasFfmpeg()
      ? makeTestVideo(src, { durationSec: 1 })
      : (writeFileSync(src, Buffer.from('fake')), src);

    const transcript = mkTranscript([['hello', 0.1, 0.4]], 'en', 1);
    const jobId = __testSeedDoneJob({ inputPath: input, transcript });
    try {
      const job = getJob(jobId)!;
      unlinkSync(job.outputs.transcript!);
      delete job.outputs.transcript;
      assert.throws(
        () => startReRender(jobId),
        (err: unknown) =>
          err instanceof CaptionEngineError && /Cached transcript not found/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });

  test('rejects concurrent re-render while status is running', () => {
    const src = join(tmp.path, 'busy.mp4');
    const input = hasFfmpeg()
      ? makeTestVideo(src, { durationSec: 1 })
      : (writeFileSync(src, Buffer.from('fake')), src);
    const transcript = mkTranscript([['hi', 0.1, 0.3]], 'en', 1);
    const jobId = __testSeedDoneJob({ inputPath: input, transcript });
    try {
      const job = getJob(jobId)!;
      job.status = 'running';
      assert.throws(
        () => startReRender(jobId),
        (err: unknown) =>
          err instanceof CaptionEngineError && /already rendering/i.test(err.message),
      );
    } finally {
      destroyJob(jobId);
    }
  });
});

describe('re-render from cached transcript (no ASR)', () => {
  test('re-renders mp4+srt without ASR keys and honours restored cuts', { skip }, async () => {
    const saved = {
      e: process.env.ELEVENLABS_API_KEY,
      d: process.env.DEEPGRAM_API_KEY,
      s: process.env.SARVAM_API_KEY,
      p: process.env.ASR_PROVIDER,
    };
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    delete process.env.ASR_PROVIDER;

    let jobId = '';
    try {
      const src = makeTestVideo(join(tmp.path, 'rerender-src.mp4'), { durationSec: 3 });
      const transcript = mkTranscript(
        [['आज', 0.3, 0.8], ['मीटिंग', 0.9, 1.5], ['ठीक', 1.6, 2.1]],
        'hi',
        3,
      );
      const cuts: Cut[] = [
        {
          id: 'silence-0',
          start: 2.2,
          end: 2.8,
          reason: 'silence',
          category: 'silence',
          label: '0.6s silence',
          wordIndices: [],
          sourceWords: [],
          confidence: 0.9,
          restored: false,
        },
      ];
      jobId = __testSeedDoneJob({
        inputPath: src,
        transcript,
        cuts,
        fields: { style: 'default', aspect: 'portrait', autoTrim: true, formats: ['mp4', 'srt'] },
        formats: ['mp4', 'srt'],
      });

      // Restore the silence cut in the editor sense — must survive re-render.
      const restored = setCutRestored(jobId, 'silence-0', true);
      assert.ok(restored?.restored);

      const started = startReRender(jobId, { aspect: 'square', style: 'neon' });
      assert.equal(started.jobId, jobId);
      assert.ok(started.outputs);

      const terminal = await waitForTerminal(jobId);
      assert.equal(terminal.type, 'done', (terminal as { message?: string }).message);

      const job = getJob(jobId)!;
      assert.equal(job.status, 'done');
      assert.ok(job.outputs.mp4 && existsSync(job.outputs.mp4), 'mp4 output missing');
      assert.ok(job.outputs.srt && existsSync(job.outputs.srt), 'srt output missing');
      assert.ok(job.outputs.transcript && existsSync(job.outputs.transcript), 'transcript kept');

      const silence = job.cuts.find((c) => c.id === 'silence-0');
      // Cut ids are stable across identical autoTrim runs; restored flag must stick.
      if (silence) assert.equal(silence.restored, true);
    } finally {
      if (jobId) destroyJob(jobId);
      if (saved.e) process.env.ELEVENLABS_API_KEY = saved.e;
      if (saved.d) process.env.DEEPGRAM_API_KEY = saved.d;
      if (saved.s) process.env.SARVAM_API_KEY = saved.s;
      if (saved.p) process.env.ASR_PROVIDER = saved.p;
    }
  });
});
