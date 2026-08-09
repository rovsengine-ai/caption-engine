import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashFile,
  fingerprintInput,
  stableStringify,
  configHash,
  transcriptConfigHash,
  cutsConfigHash,
  makeStamp,
  verifyStamp,
  explainVerdict,
  FINGERPRINT_VERSION,
  type InputFingerprint,
} from '../src/config/fingerprint.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ce-fp-'));
}

describe('file hashing', () => {
  test('identical bytes hash identically', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a'), 'same content');
      writeFileSync(join(dir, 'b'), 'same content');
      const a = await hashFile(join(dir, 'a'));
      const b = await hashFile(join(dir, 'b'));
      assert.equal(a.sha256, b.sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a one-byte change changes the hash', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a'), 'take one');
      const before = await hashFile(join(dir, 'a'));
      writeFileSync(join(dir, 'a'), 'take two');
      const after = await hashFile(join(dir, 'a'));
      assert.notEqual(before.sha256, after.sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('sampled mode is deterministic and labelled', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a'), 'x'.repeat(4096));
      const a = await hashFile(join(dir, 'a'), { mode: 'sampled' });
      const b = await hashFile(join(dir, 'a'), { mode: 'sampled' });
      assert.equal(a.sha256, b.sha256);
      assert.equal(a.mode, 'sampled');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('sampled and full hashes differ, so modes are never compared', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'a'), 'content');
      const full = await hashFile(join(dir, 'a'), { mode: 'full' });
      const sampled = await hashFile(join(dir, 'a'), { mode: 'sampled' });
      assert.notEqual(full.sha256, sampled.sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('stable stringify', () => {
  test('key order does not affect the result', () => {
    assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  });
  test('nested key order does not affect the result', () => {
    assert.equal(
      stableStringify({ x: { a: 1, b: 2 } }),
      stableStringify({ x: { b: 2, a: 1 } }),
    );
  });
  test('array order DOES matter', () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });
  test('undefined members are dropped', () => {
    assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
  });
  test('null survives', () => {
    assert.equal(stableStringify({ a: null }), '{"a":null}');
  });
});

describe('config hashing', () => {
  test('same options → same hash', () => {
    assert.equal(configHash({ a: 1, b: 'x' }), configHash({ b: 'x', a: 1 }));
  });

  test('changing the ASR language changes the transcript hash', () => {
    assert.notEqual(
      transcriptConfigHash({ language: 'hi' }),
      transcriptConfigHash({ language: 'en' }),
    );
  });

  test('keyterm ORDER does not change the transcript hash', () => {
    assert.equal(
      transcriptConfigHash({ keyterms: ['a', 'b'] }),
      transcriptConfigHash({ keyterms: ['b', 'a'] }),
    );
  });

  test('adding a keyterm DOES change the transcript hash', () => {
    assert.notEqual(
      transcriptConfigHash({ keyterms: ['a'] }),
      transcriptConfigHash({ keyterms: ['a', 'b'] }),
    );
  });

  test('code-switching is part of the transcript identity', () => {
    assert.notEqual(
      transcriptConfigHash({ codeSwitching: true }),
      transcriptConfigHash({ codeSwitching: false }),
    );
  });

  test('trim threshold is part of the cuts identity', () => {
    assert.notEqual(cutsConfigHash({ trimSilence: 0.7 }), cutsConfigHash({ trimSilence: 1.2 }));
  });
});

describe('stamp verification', () => {
  const base: InputFingerprint = {
    v: FINGERPRINT_VERSION,
    sha256: 'a'.repeat(64),
    mode: 'full',
    sizeBytes: 1000,
    durationSec: 12.5,
    name: 'my-video.mp4',
  };
  const cfg = 'cfg0123456789ab';

  test('an unchanged input and config verifies', () => {
    const s = makeStamp('transcript', base, cfg);
    assert.deepEqual(verifyStamp(s, base, cfg), { ok: true });
  });

  test('THE case this exists for: same filename, new content', () => {
    const s = makeStamp('transcript', base, cfg);
    const replaced: InputFingerprint = { ...base, sha256: 'b'.repeat(64) };
    const v = verifyStamp(s, replaced, cfg);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'input-changed');
  });

  test('a different file size is rejected even if hashes were sampled', () => {
    const s = makeStamp('transcript', { ...base, mode: 'sampled' }, cfg);
    const v = verifyStamp(s, { ...base, mode: 'sampled', sizeBytes: 2000 }, cfg);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'input-changed');
  });

  test('a different duration is rejected', () => {
    const s = makeStamp('transcript', base, cfg);
    const v = verifyStamp(s, { ...base, durationSec: 40 }, cfg);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'input-changed');
  });

  test('sub-frame duration jitter is tolerated', () => {
    const s = makeStamp('transcript', base, cfg);
    assert.equal(verifyStamp(s, { ...base, durationSec: 12.52 }, cfg).ok, true);
  });

  test('changed options are rejected separately from changed input', () => {
    const s = makeStamp('transcript', base, cfg);
    const v = verifyStamp(s, base, 'different0000000');
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'config-changed');
  });

  test('a file with no stamp is reported as unstamped, not rejected outright', () => {
    // Files written by earlier versions must keep working.
    const v = verifyStamp(undefined, base, cfg);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'unstamped');
  });

  test('an older stamp version is reported distinctly', () => {
    const s = { ...makeStamp('transcript', base, cfg), v: 0 };
    const v = verifyStamp(s, base, cfg);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.code, 'version');
  });

  test('the file NAME is never used for matching', () => {
    const s = makeStamp('transcript', base, cfg);
    assert.equal(verifyStamp(s, { ...base, name: 'renamed.mp4' }, cfg).ok, true);
  });

  test('the explanation names the override flag', () => {
    const v = verifyStamp(makeStamp('cuts', base, cfg), { ...base, sha256: 'c'.repeat(64) }, cfg);
    assert.equal(v.ok, false);
    if (v.ok === false) {
      const msg = explainVerdict(v, 'cuts.json');
      assert.match(msg, /--allow-stale/);
      assert.match(msg, /cuts\.json/);
    }
  });
});

describe('fingerprinting a real file', () => {
  test('captures size, name and duration', async () => {
    const dir = tmp();
    try {
      const p = join(dir, 'clip.mp4');
      writeFileSync(p, 'not really a video');
      const fp = await fingerprintInput(p, { durationSec: 3.14159 });
      assert.equal(fp.name, 'clip.mp4');
      assert.equal(fp.sizeBytes, 18);
      assert.equal(fp.durationSec, 3.142); // rounded to ms
      assert.equal(fp.sha256.length, 64);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
