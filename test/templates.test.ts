import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Resvg } from '@resvg/resvg-js';

import {
  loadTemplates, getTemplate, compileTemplateToStyle, parseTemplate,
  validateTemplateFonts, listTemplateIds, TEMPLATE_SCRIPTS, clearTemplateCache,
  runTemplatesCommand, formatTemplateList, SCRIPT_COVERAGE_SAMPLES,
} from '../src/captions/template.js';
import {
  resolveStyle, DEFAULT_STYLE, STYLE_PRESETS, listStylePresets,
} from '../src/captions/style.js';
import { renderCueSvg } from '../src/captions/svg.js';
import { initShaper } from '../src/text/shaper.js';
import { parseArgs } from '../src/cli/args.js';
import { uiOptionsToCli, publicMeta, TEMPLATE_GALLERY } from '../src/server/options.js';
import { CaptionEngineError } from '../src/errors.js';
import { mkCue } from './helpers.js';

const LEGACY = ['default', 'bold', 'minimal', 'neon', 'classic'] as const;
const CORE = [
  'clean', 'bold-social', 'karaoke', 'minimal', 'neon', 'classic',
  'boxed', 'creator-highlight', 'subtitle-safe',
] as const;

before(async () => {
  clearTemplateCache();
  await initShaper();
});

function expectedLegacy(name: typeof LEGACY[number], height: number) {
  const preset = STYLE_PRESETS[name] ?? {};
  const base = { ...DEFAULT_STYLE, ...preset };
  const scale = height / 1920;
  return {
    ...base,
    fontSizePx: Math.round(base.fontSizePx * scale),
    outlineWidthPx: Math.max(1, Math.round(base.outlineWidthPx * scale)),
  };
}

describe('caption template schema', () => {
  test('loads the nine core templates', () => {
    const ids = listTemplateIds();
    for (const id of CORE) assert.ok(ids.includes(id), id);
    assert.equal(ids.length, CORE.length);
  });

  test('every JSON template validates and compiles for every aspect', () => {
    for (const template of loadTemplates()) {
      assert.equal(template.id.length > 0, true);
      assert.equal(template.description.length > 0, true);
      for (const aspect of ['portrait', 'landscape', 'square'] as const) {
        const style = compileTemplateToStyle(template, aspect, 1920);
        assert.equal(style.fontFamily.length > 0, true);
        assert.ok(style.fontSizePx >= 8 && style.fontSizePx <= 400);
        assert.ok(style.positionY > 0 && style.positionY < 1);
        assert.equal(style.positionY, 1 - template.safeMargins[aspect].bottom);
        assert.ok(style.safeMargins);
        assert.equal(style.animationTemplate, template.motionDefault.animation);
        assert.ok(style.fontFallbacks);
        for (const script of TEMPLATE_SCRIPTS) {
          assert.ok(style.fontFallbacks[script], `${template.id} missing ${script}`);
        }
      }
    }
  });

  test('aliases resolve and Odia is accepted as Oriya', () => {
    assert.equal(getTemplate('boldsocial')?.id, 'bold-social');
    assert.equal(getTemplate('SAFE')?.id, 'subtitle-safe');
    const raw = structuredClone(loadTemplates().find((t) => t.id === 'clean'));
    assert.ok(raw);
    const again = parseTemplate(JSON.parse(JSON.stringify({
      ...raw,
      id: 'clean',
      scriptFallbacks: raw.scriptFallbacks,
    })), 'clean.json');
    assert.ok((again.scriptFallbacks.Oriya ?? '').length > 0);
  });

  test('a template that omits a script fails loudly', () => {
    const raw = JSON.parse(JSON.stringify(loadTemplates()[0]));
    delete raw.scriptFallbacks.Devanagari;
    delete raw.scriptFallbacks.Odia;
    assert.throws(() => parseTemplate(raw, 'broken.json'), /Devanagari/);
  });

  test('creator-highlight compiles to a 1.15 active-word scale', () => {
    const style = compileTemplateToStyle(getTemplate('creator-highlight')!, 'portrait', 1920);
    assert.equal(style.activeWord?.scale, 1.15);
    assert.equal(style.activeColor, '#7C4DFF');
  });

  test('karaoke compiles with an active-word pill and boxed compiles with a band', () => {
    const karaoke = compileTemplateToStyle(getTemplate('karaoke')!, 'portrait', 1920);
    assert.ok(karaoke.activeWord?.backgroundBox);
    assert.equal(karaoke.backgroundBox, undefined);
    const boxed = compileTemplateToStyle(getTemplate('boxed')!, 'portrait', 1920);
    assert.ok(boxed.backgroundBox);
    assert.equal(boxed.outlineWidthPx, 0);
  });

  test('subtitle-safe sits higher on portrait than on landscape', () => {
    const portrait = compileTemplateToStyle(getTemplate('subtitle-safe')!, 'portrait', 1920);
    const landscape = compileTemplateToStyle(getTemplate('subtitle-safe')!, 'landscape', 1080);
    assert.ok(portrait.positionY < landscape.positionY);
    assert.ok((portrait.safeMargins?.left ?? 0) >= 0.08);
    assert.ok((landscape.safeMargins?.bottom ?? 1) <= 0.16);
  });
});

describe('legacy preset compatibility', () => {
  for (const name of LEGACY) {
    test(`${name} resolveStyle matches the historical preset object`, () => {
      assert.deepEqual(resolveStyle(name, 1920), expectedLegacy(name, 1920));
      assert.deepEqual(resolveStyle(name, 1080), expectedLegacy(name, 1080));
    });

    test(`${name} rendered SVG and PNG match a hand-built preset style`, async () => {
      const viaApi = resolveStyle(name, 960);
      const manual = expectedLegacy(name, 960);
      const cue = mkCue(['आज', 'meeting']);
      const opts = { width: 540, height: 960, activeWordIndex: 1, activeScale: 1.08 };
      const svgA = await renderCueSvg(cue, { ...opts, style: viaApi });
      const svgB = await renderCueSvg(cue, { ...opts, style: manual });
      assert.equal(svgA, svgB);
      const pngA = new Resvg(svgA).render().asPng();
      const pngB = new Resvg(svgB).render().asPng();
      assert.ok(pngA.equals(pngB));
      assert.ok(pngA.length > 500);
    });
  }

  test('preferTemplate uses the data template when the name collides with a preset', () => {
    const preset = resolveStyle('neon', 1920);
    const templated = resolveStyle('neon', 1920, {}, { preferTemplate: true, aspect: 'portrait' });
    assert.equal(preset.shadow, undefined);
    assert.ok(templated.shadow);
    assert.notEqual(preset.outlineColor, templated.outlineColor);
  });

  test('an unknown name still lists every legacy preset', () => {
    assert.throws(() => resolveStyle('not-a-real-preset', 1920), (e: unknown) => {
      assert.ok(e instanceof CaptionEngineError);
      const msg = (e as Error).message + (e as CaptionEngineError).hint;
      for (const name of listStylePresets()) assert.ok(msg.includes(name), name);
      assert.match(msg, /bold-social/);
      return true;
    });
  });
});

describe('font coverage', () => {
  test('every template covers every script sample with no .notdef', async () => {
    const report = await validateTemplateFonts();
    assert.deepEqual(report.failures, []);
    assert.equal(report.ok, true);
    assert.ok(report.checked >= CORE.length * TEMPLATE_SCRIPTS.length);
  });

  test('a template that names a font without the script fails loudly', async () => {
    const good = getTemplate('clean')!;
    const bad = {
      ...good,
      id: 'bad-font',
      scriptFallbacks: {
        ...good.scriptFallbacks,
        Telugu: good.scriptFallbacks.Latin!,
      },
    };
    const report = await validateTemplateFonts([bad]);
    assert.equal(report.ok, false);
    assert.ok(report.failures.some((f) => f.script === 'Telugu' && /\.notdef|glyph/i.test(f.detail)));
  });

  test('coverage samples include the Indic scripts and Latin punctuation', () => {
    for (const script of ['Devanagari', 'Telugu', 'Kannada', 'Tamil', 'Malayalam', 'Bengali', 'Gujarati', 'Gurmukhi', 'Oriya', 'Arabic', 'Latin'] as const) {
      assert.ok(SCRIPT_COVERAGE_SAMPLES[script].length > 0);
    }
    assert.match(SCRIPT_COVERAGE_SAMPLES.Latin, /Hello, world!/);
  });
});

describe('templates CLI', () => {
  test('parseArgs accepts templates and --template as a style replacement', () => {
    const listed = parseArgs(['templates']);
    assert.equal(listed.command, 'templates');
    const validate = parseArgs(['templates', '--validate-fonts']);
    assert.equal(validate.command, 'templates');
    if (validate.command === 'templates') assert.deepEqual(validate.args, ['--validate-fonts']);

    const run = parseArgs(['in.mp4', '--transcript-in', 't.json', '--template', 'boldsocial']);
    assert.equal(run.command, 'run');
    if (run.command === 'run') {
      assert.equal(run.options.style, 'bold-social');
      assert.equal(run.options.preferTemplate, true);
      assert.equal(run.options.template, 'bold-social');
    }
  });

  test('--style bold stays the legacy preset', () => {
    const run = parseArgs(['in.mp4', '--transcript-in', 't.json', '--style', 'bold']);
    assert.equal(run.command, 'run');
    if (run.command === 'run') assert.equal(run.options.preferTemplate, undefined);
    assert.deepEqual(resolveStyle('bold', 1920), expectedLegacy('bold', 1920));
  });

  test('--validate-fonts exits 0 for the shipped set', async () => {
    const code = await runTemplatesCommand(['--validate-fonts']);
    assert.equal(code, 0);
  });

  test('the list names every template and its default motion', () => {
    const text = formatTemplateList();
    assert.match(text, /bold-social/);
    assert.match(text, /punch/);
    assert.match(text, /subtitle-safe/);
    assert.match(text, /safe title areas/i);
  });
});

describe('web studio template gallery', () => {
  test('publicMeta templates are the data-driven ids', () => {
    const meta = publicMeta();
    const ids = meta.templates.map((t) => t.id);
    assert.deepEqual(ids, [...CORE]);
    for (const t of TEMPLATE_GALLERY) {
      assert.equal(t.style, t.id);
      assert.ok(t.blurb.length > 0);
    }
  });

  test('a gallery id drives a re-render style the compiler accepts', () => {
    const { opts } = uiOptionsToCli('/tmp/in.mp4', '/tmp/out/captioned.mp4', '/tmp/work', {
      template: 'creator-highlight',
      aspect: 'portrait',
    });
    assert.equal(opts.style, 'creator-highlight');
    assert.equal(opts.preferTemplate, true);
    assert.equal(opts.motion, 'expressive');
    const style = resolveStyle(opts.style, 1920, {}, { preferTemplate: true, aspect: 'portrait' });
    assert.equal(style.activeWord?.scale, 1.15);
  });

  test('an unknown gallery id is rejected', () => {
    assert.throws(
      () => uiOptionsToCli('/tmp/in.mp4', '/tmp/out/captioned.mp4', '/tmp/work', { template: 'ink-flow' }),
      /Unknown template/,
    );
  });
});

describe('template frames render', () => {
  test('each template produces a path-only SVG', async () => {
    for (const id of CORE) {
      const template = getTemplate(id)!;
      const style = compileTemplateToStyle(template, 'portrait', 640);
      const svg = await renderCueSvg(mkCue(['नमस्ते', 'reel']), {
        width: 360,
        height: 640,
        style,
        activeWordIndex: 0,
        activeScale: style.activeWord?.scale ?? 1,
      });
      assert.match(svg, /<path/, id);
      assert.doesNotMatch(svg, /<text/i);
      const png = new Resvg(svg).render().asPng();
      assert.ok(png.length > 200, id);
    }
  });
});
