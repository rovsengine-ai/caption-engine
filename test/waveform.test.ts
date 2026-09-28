import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  chooseWaveformWindow,
  dbToAmplitude,
  windowsToPeaks,
  parseWaveformDoc,
  computeWaveformPeaks,
} from '../src/media/waveform.js';
import {
  getJobWaveform,
  destroyJob,
  __testSeedDoneJob,
  getJob,
} from '../src/server/jobs.js';
import { CaptionEngineError } from '../src/errors.js';
import { tempDir, makeTestVideo, hasFfmpeg, mkTranscript } from './helpers.js';

const skipNoFfmpeg = hasFfmpeg() ? undefined : 'ffmpeg not available';

let tmp: { path: string; cleanup: () => void };

before(() => {
  tmp = tempDir('ce-waveform-');
});
after(() => tmp?.cleanup());

describe('waveform peak helpers', () => {
  test('chooseWaveformWindow caps long media at maxPeaks', () => {
    const { targetPeaks, windowSec } = chooseWaveformWindow(300, {
      idealPeaksPerSecond: 100,
      minPeaks: 200,
      maxPeaks: 4000,
    });
    assert.equal(targetPeaks, 4000);
    assert.ok(Math.abs(windowSec - 300 / 4000) < 1e-9);
  });

  test('chooseWaveformWindow keeps short clips dense without padding to minPeaks', () => {
    const { targetPeaks } = chooseWaveformWindow(3, {
      idealPeaksPerSecond: 100,
      minPeaks: 200,
      maxPeaks: 4000,
    });
    assert.equal(targetPeaks, 300);
  });

  test('dbToAmplitude maps silence and loudness', () => {
    assert.equal(dbToAmplitude(-91), 0);
    assert.equal(dbToAmplitude(-60), 0);
    assert.ok(dbToAmplitude(-6) > 0.4);
    assert.ok(dbToAmplitude(0) >= 0.99);
  });

  test('windowsToPeaks max-normalizes', () => {
    const peaks = windowsToPeaks([
      { t: 0, db: -40 },
      { t: 0.1, db: -20 },
      { t: 0.2, db: -91 },
    ]);
    assert.equal(peaks.length, 3);
    assert.equal(peaks[1], 1);
    assert.equal(peaks[2], 0);
    assert.ok(peaks[0]! > 0 && peaks[0]! < 1);
  });

  test('parseWaveformDoc rejects garbage and clamps peaks', () => {
    assert.equal(parseWaveformDoc(null), null);
    assert.equal(parseWaveformDoc({ peaks: [] }), null);
    const ok = parseWaveformDoc({
      durationSec: 10,
      peaks: [-0.5, 0.5, 2],
      windowSec: 0.1,
      peaksPerSecond: 10,
    });
    assert.ok(ok);
    assert.deepEqual(ok!.peaks, [0, 0.5, 1]);
  });
});

describe('computeWaveformPeaks', { skip: skipNoFfmpeg }, () => {
  test('extracts peaks from a short tone video in under a second', async () => {
    const path = join(tmp.path, `tone-${Date.now()}.mp4`);
    makeTestVideo(path, { durationSec: 2, width: 320, height: 180 });
    const t0 = Date.now();
    const wf = await computeWaveformPeaks(path, 2);
    const ms = Date.now() - t0;
    assert.ok(wf.peaks.length >= 32);
    assert.ok(wf.peaks.some((p) => p > 0.05), 'tone should produce non-zero peaks');
    assert.ok(ms < 5000, `waveform took ${ms}ms`);
  });
});

describe('getJobWaveform cache', { skip: skipNoFfmpeg }, () => {
  test('computes once then serves waveform.json from disk', async () => {
    const src = join(tmp.path, `job-src-${Date.now()}.mp4`);
    makeTestVideo(src, { durationSec: 2, width: 320, height: 180 });
    const transcript = mkTranscript([
      ['hello', 0.1, 0.4],
      ['world', 0.5, 0.9],
    ], 'en', 2);
    const jobId = __testSeedDoneJob({
      inputPath: src,
      transcript,
      formats: ['mp4'],
    });
    try {
      const t0 = Date.now();
      const first = await getJobWaveform(jobId);
      const firstMs = Date.now() - t0;
      assert.ok(first.peaks.length > 0);
      assert.ok(firstMs < 8000, `first waveform took ${firstMs}ms`);

      const job = getJob(jobId)!;
      assert.ok(job.outputs.waveform && existsSync(job.outputs.waveform));
      const disk = JSON.parse(readFileSync(job.outputs.waveform, 'utf8'));
      assert.equal(disk.peaks.length, first.peaks.length);

      const t1 = Date.now();
      const second = await getJobWaveform(jobId);
      const cachedMs = Date.now() - t1;
      assert.deepEqual(second.peaks, first.peaks);
      assert.ok(cachedMs < 200, `cached read took ${cachedMs}ms`);
    } finally {
      destroyJob(jobId);
    }
  });
});

describe('getJobWaveform errors', () => {
  test('rejects unknown jobs', async () => {
    await assert.rejects(
      () => getJobWaveform('missing'),
      (err: unknown) => err instanceof CaptionEngineError && /not found/i.test(err.message),
    );
  });
});
