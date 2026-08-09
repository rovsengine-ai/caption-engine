import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseEnvFile,
  loadEnv,
  envStatus,
  secretsStatus,
  requireEnv,
  redactSecrets,
  SECRET_ENV_VARS,
} from '../src/config/env.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ce-env-'));
}

describe('.env parsing', () => {
  test('plain KEY=value', () => {
    assert.deepEqual(parseEnvFile('A=1\nB=two'), { A: '1', B: 'two' });
  });

  test('comments and blank lines are ignored', () => {
    assert.deepEqual(parseEnvFile('# note\n\nA=1\n   # indented\n'), { A: '1' });
  });

  test('export prefix is accepted', () => {
    assert.deepEqual(parseEnvFile('export A=1'), { A: '1' });
  });

  test('double quotes are stripped and escapes expanded', () => {
    assert.deepEqual(parseEnvFile('A="line1\\nline2"'), { A: 'line1\nline2' });
  });

  test('single quotes are literal', () => {
    assert.deepEqual(parseEnvFile("A='no\\nescape'"), { A: 'no\\nescape' });
  });

  test('an inline comment is stripped from an unquoted value', () => {
    assert.deepEqual(parseEnvFile('A=value # trailing'), { A: 'value' });
  });

  test('a "#" inside a quoted value survives — keys often contain one', () => {
    assert.deepEqual(parseEnvFile('A="v#alue"'), { A: 'v#alue' });
  });

  test('CRLF line endings (Windows editors) parse correctly', () => {
    assert.deepEqual(parseEnvFile('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  test('empty value is preserved, not dropped', () => {
    assert.deepEqual(parseEnvFile('A='), { A: '' });
  });

  test('malformed lines are skipped rather than throwing', () => {
    assert.deepEqual(parseEnvFile('nonsense\n=novalue\n1BAD=x\nA=1'), { A: '1' });
  });
});

describe('.env loading', () => {
  test('sets variables that are not already present', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'CE_TEST_NEW=fromfile\n');
      const env = {} as NodeJS.ProcessEnv;
      const r = loadEnv({ cwd: dir, env, force: true });
      assert.equal(env.CE_TEST_NEW, 'fromfile');
      assert.deepEqual(r.applied, ['CE_TEST_NEW']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the real environment always wins over the file', () => {
    // Otherwise a stale .env silently beats the key you just exported, and you
    // spend an hour debugging the wrong credential.
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'CE_TEST_WIN=fromfile\n');
      const env = { CE_TEST_WIN: 'fromshell' } as NodeJS.ProcessEnv;
      const r = loadEnv({ cwd: dir, env, force: true });
      assert.equal(env.CE_TEST_WIN, 'fromshell');
      assert.deepEqual(r.skipped, ['CE_TEST_WIN']);
      assert.deepEqual(r.applied, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an empty existing value is treated as unset and gets filled', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'CE_TEST_BLANK=real\n');
      const env = { CE_TEST_BLANK: '' } as NodeJS.ProcessEnv;
      loadEnv({ cwd: dir, env, force: true });
      assert.equal(env.CE_TEST_BLANK, 'real');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing .env is not an error', () => {
    const dir = tmp();
    try {
      const r = loadEnv({ cwd: dir, env: {} as NodeJS.ProcessEnv, force: true });
      // May resolve the package root .env when one exists locally; the contract
      // is only that it does not throw and reports what it did.
      assert.ok(Array.isArray(r.applied));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the result reports NAMES only, never values', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, '.env'), 'CE_TEST_SECRET=sk-super-secret-value\n');
      const r = loadEnv({ cwd: dir, env: {} as NodeJS.ProcessEnv, force: true });
      assert.ok(!JSON.stringify(r).includes('sk-super-secret-value'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('safe environment reporting', () => {
  test('envStatus reports presence, not content', () => {
    const s = envStatus('X', { X: 'sk-secret' } as NodeJS.ProcessEnv);
    assert.equal(s.present, true);
    assert.ok(!JSON.stringify(s).includes('sk-secret'));
  });

  test('a whitespace-only value counts as absent and is flagged blank', () => {
    const s = envStatus('X', { X: '   ' } as NodeJS.ProcessEnv);
    assert.equal(s.present, false);
    assert.equal(s.blank, true);
  });

  test('an unset variable is absent but not blank', () => {
    const s = envStatus('X', {} as NodeJS.ProcessEnv);
    assert.deepEqual(s, { name: 'X', present: false, blank: false });
  });

  test('secretsStatus covers every known key and leaks none', () => {
    const env = Object.fromEntries(
      SECRET_ENV_VARS.map((n) => [n, `value-of-${n}`]),
    ) as NodeJS.ProcessEnv;
    const rows = secretsStatus(env);
    assert.equal(rows.length, SECRET_ENV_VARS.length);
    assert.ok(rows.every((r) => r.present));
    assert.ok(!JSON.stringify(rows).includes('value-of-'));
  });
});

describe('requireEnv', () => {
  test('passes when everything is set', () => {
    assert.doesNotThrow(() => requireEnv(['A'], { A: '1' } as NodeJS.ProcessEnv));
  });

  test('names what is missing', () => {
    assert.throws(
      () => requireEnv(['A', 'B'], { A: '1' } as NodeJS.ProcessEnv),
      /Missing required environment variable: B/,
    );
  });

  test('the message never contains the value of a variable that IS set', () => {
    try {
      requireEnv(['MISSING_ONE'], { PRESENT_ONE: 'sk-do-not-print' } as NodeJS.ProcessEnv);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(!(e as Error).message.includes('sk-do-not-print'));
    }
  });
});

describe('provider error bodies never carry a credential', () => {
  test('a token-shaped string in the provider message is redacted', async () => {
    const { safeErrorDetail } = await import('../src/clips/llm.js');
    const body = JSON.stringify({
      error: { message: 'invalid x-api-key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    const out = await safeErrorDetail({ text: async () => body });
    assert.ok(!out.includes('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA'));
    assert.match(out, /invalid x-api-key/);
  });

  test('a non-JSON body reports nothing at all', async () => {
    const { safeErrorDetail } = await import('../src/clips/llm.js');
    assert.equal(await safeErrorDetail({ text: async () => '<html>sk-ant-secret</html>' }), '');
  });

  test('an empty body reports nothing', async () => {
    const { safeErrorDetail } = await import('../src/clips/llm.js');
    assert.equal(await safeErrorDetail({ text: async () => '' }), '');
  });

  test('a normal message survives intact', async () => {
    const { safeErrorDetail } = await import('../src/clips/llm.js');
    const body = JSON.stringify({ error: { message: 'rate limit exceeded' } });
    assert.equal(await safeErrorDetail({ text: async () => body }), 'rate limit exceeded');
  });
});

describe('redaction', () => {
  test('a configured key is replaced by its name', () => {
    const env = { ELEVENLABS_API_KEY: 'sk_live_abcdef123456' } as NodeJS.ProcessEnv;
    const out = redactSecrets('request failed: key sk_live_abcdef123456 rejected', env);
    assert.ok(!out.includes('sk_live_abcdef123456'));
    assert.ok(out.includes('[ELEVENLABS_API_KEY redacted]'));
  });

  test('every occurrence is replaced, not just the first', () => {
    const env = { SARVAM_API_KEY: 'abcdefghijkl' } as NodeJS.ProcessEnv;
    const out = redactSecrets('abcdefghijkl and abcdefghijkl', env);
    assert.equal(out.includes('abcdefghijkl'), false);
  });

  test('short values are left alone so ordinary prose is not mangled', () => {
    const env = { SARVAM_API_KEY: 'abc' } as NodeJS.ProcessEnv;
    assert.equal(redactSecrets('abc is a common substring', env), 'abc is a common substring');
  });

  test('text with no secret in it is unchanged', () => {
    const env = { ELEVENLABS_API_KEY: 'sk_live_abcdef123456' } as NodeJS.ProcessEnv;
    assert.equal(redactSecrets('nothing to see here', env), 'nothing to see here');
  });
});
