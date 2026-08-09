import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitFontDirs, systemFontDirs, fontBasename, isInside } from '../src/text/fonts.js';

/**
 * Windows path handling.
 *
 * These run on every platform. The Windows separator is injected rather than
 * detected, because a bug that only reproduces on Windows is a bug that never
 * gets caught in CI.
 */

describe('FONT_DIR splitting', () => {
  test('Windows: splits on ";" and keeps drive letters intact', () => {
    const dirs = splitFontDirs('C:\\Users\\me\\fonts;D:\\shared\\fonts', ';');
    assert.deepEqual(dirs, ['C:\\Users\\me\\fonts', 'D:\\shared\\fonts']);
  });

  test('Windows: a colon inside a path is NOT a separator', () => {
    // The original bug: split(':') turned "C:\fonts" into ["C", "\fonts"],
    // so every Windows FONT_DIR resolved to nothing at all.
    const dirs = splitFontDirs('C:\\fonts', ';');
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0], 'C:\\fonts');
  });

  test('POSIX: splits on ":"', () => {
    assert.deepEqual(
      splitFontDirs('/usr/share/fonts:/home/me/.fonts', ':'),
      ['/usr/share/fonts', '/home/me/.fonts'],
    );
  });

  test('multiple directories, both platforms', () => {
    assert.equal(splitFontDirs('a;b;c', ';').length, 3);
    assert.equal(splitFontDirs('a:b:c', ':').length, 3);
  });

  test('empty, undefined and whitespace-only entries are dropped', () => {
    assert.deepEqual(splitFontDirs(undefined, ';'), []);
    assert.deepEqual(splitFontDirs('', ';'), []);
    assert.deepEqual(splitFontDirs(';;', ';'), []);
    assert.deepEqual(splitFontDirs(' C:\\a ; ; D:\\b ', ';'), ['C:\\a', 'D:\\b']);
  });

  test('a trailing separator does not produce an empty directory', () => {
    assert.deepEqual(splitFontDirs('C:\\a;', ';'), ['C:\\a']);
    assert.deepEqual(splitFontDirs('/a:', ':'), ['/a']);
  });
});

describe('font basename', () => {
  test('handles backslash paths', () => {
    assert.equal(fontBasename('C:\\Windows\\Fonts\\NotoSans.ttf'), 'NotoSans.ttf');
  });
  test('handles forward-slash paths', () => {
    assert.equal(fontBasename('/usr/share/fonts/NotoSans.ttf'), 'NotoSans.ttf');
  });
  test('handles mixed separators, as Node produces on Windows', () => {
    assert.equal(fontBasename('C:/Users/me\\fonts\\NotoSans.ttf'), 'NotoSans.ttf');
  });
  test('a bare filename is returned unchanged', () => {
    assert.equal(fontBasename('NotoSans.ttf'), 'NotoSans.ttf');
  });
});

describe('vendored-vs-system detection', () => {
  test('separator style does not change the verdict', () => {
    assert.ok(isInside('/repo/assets/fonts/NotoSans.ttf', '/repo/assets/fonts'));
    assert.ok(isInside('C:\\repo\\assets\\fonts\\NotoSans.ttf', 'C:\\repo\\assets\\fonts'));
    assert.ok(isInside('C:/repo/assets/fonts/NotoSans.ttf', 'C:\\repo\\assets\\fonts'));
  });

  test('a sibling directory with a shared prefix is not "inside"', () => {
    // Naive startsWith() would call this a match.
    assert.equal(isInside('/repo/assets/fonts-extra/X.ttf', '/repo/assets/fonts'), false);
  });

  test('a trailing separator on the parent is tolerated', () => {
    assert.ok(isInside('/repo/assets/fonts/X.ttf', '/repo/assets/fonts/'));
  });
});

describe('system font directories', () => {
  test('Windows: uses USERPROFILE, LOCALAPPDATA and SystemRoot', () => {
    const dirs = systemFontDirs({
      USERPROFILE: 'C:\\Users\\me',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      SystemRoot: 'C:\\Windows',
    } as NodeJS.ProcessEnv);
    const joined = dirs.join('|');
    assert.ok(joined.includes('Microsoft'), 'per-user font store missing');
    assert.ok(dirs.some((d) => /Windows[\\/]Fonts$/.test(d)), 'machine font store missing');
    assert.ok(dirs.some((d) => d.includes('Users')), 'user home not scanned');
  });

  test('POSIX: uses HOME and the usual share dirs', () => {
    const dirs = systemFontDirs({ HOME: '/home/me' } as NodeJS.ProcessEnv);
    assert.ok(dirs.some((d) => d.includes('/home/me')));
    assert.ok(dirs.includes('/usr/share/fonts'));
  });

  test('no home variable at all does not throw', () => {
    assert.doesNotThrow(() => systemFontDirs({} as NodeJS.ProcessEnv));
  });
});
