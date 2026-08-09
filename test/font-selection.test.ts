import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverFontFamilies, listFontFamilies, resolveFont, clearFontCache,
} from '../src/text/fonts.js';
import { MissingFontError } from '../src/errors.js';

/**
 * Font discovery and `--font` selection.
 *
 * Feature-1 edge cases. The discovery machinery already existed; what was thin
 * was proof that the FAILURE paths behave — a font selector that silently
 * substitutes is how a Kannada caption ends up as a row of empty boxes with no
 * error anywhere in the log.
 *
 * Offline: reads the vendored files in assets/fonts, nothing else.
 */

describe('discovery is data-driven', () => {
  test('the vendored Noto set is discovered without being hard-coded', () => {
    const families = discoverFontFamilies();
    assert.ok(families.length > 0, 'assets/fonts should yield families');
    const names = families.map((f) => f.name.toLocaleLowerCase());
    for (const expected of ['noto sans', 'noto sans devanagari', 'noto sans kannada']) {
      assert.ok(names.includes(expected), `expected to discover "${expected}"`);
    }
  });

  test('regular and bold faces group into ONE family', () => {
    // Two files, one family. Treating them as separate families would make
    // --font "Noto Sans 700Bold" a thing users could type, and would break the
    // real-bold path that --active-bold depends on.
    const f = discoverFontFamilies().find((x) => x.name.toLocaleLowerCase() === 'noto sans');
    assert.ok(f, 'Noto Sans should be discovered');
    assert.ok(f!.regular, 'family needs a regular face');
    assert.ok(f!.bold, 'family needs a real bold face');
    assert.notEqual(f!.regular, f!.bold, 'regular and bold must be different files');
  });

  test('script coverage is inferred per family', () => {
    const kannada = discoverFontFamilies().find((x) => /kannada/i.test(x.name));
    assert.ok(kannada);
    assert.ok(kannada!.scripts.includes('Kannada'));
  });

  test('vendored fonts are labelled as such', () => {
    const f = discoverFontFamilies().find((x) => x.name.toLocaleLowerCase() === 'noto sans');
    assert.equal(f!.source, 'vendored', 'reproducible renders depend on the vendored copy winning');
  });

  test('listFontFamilies is sorted and non-empty', () => {
    const list = listFontFamilies();
    assert.ok(list.length > 0);
    assert.deepEqual(list, [...list].sort((a, b) => a.localeCompare(b)));
  });
});

describe('an unknown --font fails loudly and helpfully', () => {
  test('it throws rather than silently substituting', () => {
    assert.throws(
      () => resolveFont('Latin', { family: 'Definitely Not Installed' }),
      (e: unknown) => {
        assert.ok(e instanceof MissingFontError, 'must be the typed font error');
        return true;
      },
    );
  });

  test('the message names the font that was asked for', () => {
    assert.throws(
      () => resolveFont('Latin', { family: 'Definitely Not Installed' }),
      /Definitely Not Installed/,
    );
  });

  test('the message LISTS the fonts that are available', () => {
    // Without this the user has to go read the source to find out what to type.
    try {
      resolveFont('Latin', { family: 'Definitely Not Installed' });
      assert.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      const available = listFontFamilies();
      assert.ok(available.length > 0);
      for (const name of available.slice(0, 3)) {
        assert.ok(msg.includes(name), `available font "${name}" should be listed`);
      }
    }
  });

  test('an explicit font FILE that does not exist is also an error', () => {
    assert.throws(
      () => resolveFont('Latin', { override: '/nope/missing.ttf' }),
      /Font file not found/,
    );
  });
});

describe('selection never renders tofu', () => {
  test('a named family that covers the script is used', () => {
    const r = resolveFont('Kannada', { family: 'Noto Sans Kannada' });
    assert.match(r.path, /Kannada/i);
    assert.equal(r.script, 'Kannada');
  });

  test('bold resolves to the real bold file, not a synthesised weight', () => {
    const regular = resolveFont('Latin', { family: 'Noto Sans', bold: false });
    const bold = resolveFont('Latin', { family: 'Noto Sans', bold: true });
    assert.notEqual(regular.path, bold.path, 'a real bold face must exist and be chosen');
    assert.match(bold.path, /bold/i);
  });

  test('a named family that does NOT cover the script falls through to one that does', () => {
    // A Latin-only choice must not be honoured for Kannada text: the selection
    // is a preference, not permission to emit .notdef boxes.
    const r = resolveFont('Kannada', { family: 'Noto Sans' });
    assert.match(r.path, /Kannada/i, 'must fall through to a font with Kannada coverage');
  });

  test('every supported script resolves to some font', () => {
    for (const script of [
      'Latin', 'Devanagari', 'Kannada', 'Telugu', 'Tamil', 'Malayalam',
      'Bengali', 'Gujarati', 'Gurmukhi', 'Oriya',
    ] as const) {
      assert.doesNotThrow(() => resolveFont(script), `no font resolved for ${script}`);
    }
  });

  test('resolution is cached but the cache is clearable', () => {
    const a = resolveFont('Latin');
    clearFontCache();
    const b = resolveFont('Latin');
    assert.equal(a.path, b.path, 'clearing the cache must not change the answer');
  });
});
