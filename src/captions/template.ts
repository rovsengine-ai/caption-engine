import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaptionEngineError } from '../errors.js';
import { vendoredFontFile } from '../text/fonts.js';
import type { ScriptName } from '../text/script.js';
import type {
  CaptionActiveWordStyle,
  CaptionBackgroundBox,
  CaptionSafeMargins,
  CaptionShadow,
  CaptionStyle,
} from '../types.js';
import { listAnimationTemplates } from './animation.js';
import type { AspectPreset } from './style.js';

/**
 * Data-driven caption templates.
 *
 * A template is JSON. `compileTemplateToStyle` turns it into the `CaptionStyle`
 * the SVG renderer already consumes. Legacy preset names (`default`, `bold`,
 * `minimal`, `neon`, `classic`) stay on the preset path in `resolveStyle`
 * unless the caller sets `preferTemplate`, so those renders stay identical.
 */

export type TextCase = 'uppercase' | 'none';
export type MotionLevelName = 'none' | 'subtle' | 'expressive' | 'auto';

export interface TemplateTypography {
  fontFamily: string;
  /** Size in px at a 1920px-tall frame. Scaled by targetHeight/1920. */
  fontSizePx?: number;
  /** Alternative to fontSizePx: fraction of the target frame height. */
  fontSizePxRatio?: number;
  fontWeight: number;
  /** Line box as a multiple of font size. 1.38 matches the renderer default. */
  lineSpacing: number;
  textCase: TextCase;
  maxWordsPerCue: number;
  maxCharsPerLine: number;
  maxLines: number;
}

export interface TemplateStroke {
  color: string;
  /** Outline thickness as a fraction of the compiled font size. 0 = no stroke. */
  widthRatio: number;
}

export interface TemplateShadow {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
}

export interface TemplateBackgroundBox {
  color: string;
  /** Padding in px at a 1920px-tall frame. */
  paddingPx: number;
  /** Corner radius in px at a 1920px-tall frame. */
  borderRadiusPx: number;
}

export interface TemplateActiveWord {
  color: string;
  scale: number;
  fontWeight: number;
  backgroundBox?: TemplateBackgroundBox;
}

export interface TemplateSafeMargins {
  portrait: CaptionSafeMargins;
  landscape: CaptionSafeMargins;
  square: CaptionSafeMargins;
}

export interface TemplateMotionDefault {
  /** A name from the animation template library. */
  animation: string;
  /** CLI motion level applied by the web gallery. */
  intensity: MotionLevelName;
}

export interface CaptionTemplate {
  id: string;
  name: string;
  description: string;
  aliases?: string[];
  typography: TemplateTypography;
  colors: {
    fill: string;
    stroke: TemplateStroke;
    shadow?: TemplateShadow;
  };
  backgroundBox?: TemplateBackgroundBox;
  activeWord: TemplateActiveWord;
  safeMargins: TemplateSafeMargins;
  motionDefault: TemplateMotionDefault;
  /** Filename (or absolute path) of a vendored face per script. */
  scriptFallbacks: Record<string, string>;
}

export const TEMPLATE_SCRIPTS: readonly ScriptName[] = [
  'Latin',
  'Devanagari',
  'Telugu',
  'Kannada',
  'Tamil',
  'Malayalam',
  'Bengali',
  'Gujarati',
  'Gurmukhi',
  'Oriya',
  'Arabic',
  'Common',
];

/** Sample strings shaped with fallback disabled. A `.notdef` here is a failure. */
export const SCRIPT_COVERAGE_SAMPLES: Record<ScriptName, string> = {
  Latin: 'Hello, world!',
  Devanagari: 'नमस्ते आज',
  Telugu: 'నేను ఈరోజు',
  Kannada: 'ನಾನು ಇವತ್ತು',
  Tamil: 'நான் இன்று',
  Malayalam: 'ഞാൻ ഇന്ന്',
  Bengali: 'আমি আজ',
  Gujarati: 'હું આજે',
  Gurmukhi: 'ਮੈਂ ਅੱਜ',
  Oriya: 'ମୁଁ ଆଜି',
  Arabic: 'سلام',
  Common: '2026',
};

const SCRIPT_ALIASES: Record<string, ScriptName> = {
  latin: 'Latin',
  devanagari: 'Devanagari',
  telugu: 'Telugu',
  kannada: 'Kannada',
  tamil: 'Tamil',
  malayalam: 'Malayalam',
  bengali: 'Bengali',
  gujarati: 'Gujarati',
  gurmukhi: 'Gurmukhi',
  oriya: 'Oriya',
  odia: 'Oriya',
  arabic: 'Arabic',
  nastaliq: 'Arabic',
  urdu: 'Arabic',
  common: 'Common',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MOTION_LEVELS: readonly MotionLevelName[] = ['none', 'subtle', 'expressive', 'auto'];

const __dirname = dirname(fileURLToPath(import.meta.url));

function templatesDir(): string {
  const candidates = [
    join(__dirname, 'templates'),
    resolve(__dirname, '../../../src/captions/templates'),
    resolve(__dirname, '../../src/captions/templates'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new CaptionEngineError(
    'Caption templates directory was not found.',
    `Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function needString(obj: Record<string, unknown>, key: string, file: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new CaptionEngineError(
      `Template ${file} is missing a string "${key}".`,
      'Each template JSON needs id, name, and description.',
    );
  }
  return v.trim();
}

function needNumber(obj: Record<string, unknown>, key: string, file: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new CaptionEngineError(
      `Template ${file} field "${key}" must be a finite number.`,
      `Got ${JSON.stringify(v)}.`,
    );
  }
  return v;
}

function needHex(obj: Record<string, unknown>, key: string, file: string): string {
  const v = needString(obj, key, file);
  if (!HEX.test(v)) {
    throw new CaptionEngineError(
      `Template ${file} field "${key}" must be a hex colour.`,
      `Got "${v}". Use #RGB, #RRGGBB, or #RRGGBBAA.`,
    );
  }
  return v;
}

function parseMargins(raw: unknown, file: string, label: string): CaptionSafeMargins {
  if (!isObject(raw)) {
    throw new CaptionEngineError(`Template ${file} safeMargins.${label} must be an object.`);
  }
  const out = {
    top: needNumber(raw, 'top', file),
    bottom: needNumber(raw, 'bottom', file),
    left: needNumber(raw, 'left', file),
    right: needNumber(raw, 'right', file),
  };
  for (const [k, n] of Object.entries(out)) {
    if (n < 0 || n >= 0.5) {
      throw new CaptionEngineError(
        `Template ${file} safeMargins.${label}.${k} must be in 0..0.5, got ${n}.`,
      );
    }
  }
  if (out.top + out.bottom >= 1 || out.left + out.right >= 1) {
    throw new CaptionEngineError(
      `Template ${file} safeMargins.${label} leave no room for the caption.`,
    );
  }
  return out;
}

function parseBox(raw: unknown, file: string, label: string): TemplateBackgroundBox {
  if (!isObject(raw)) {
    throw new CaptionEngineError(`Template ${file} ${label} must be an object.`);
  }
  return {
    color: needHex(raw, 'color', file),
    paddingPx: needNumber(raw, 'paddingPx', file),
    borderRadiusPx: needNumber(raw, 'borderRadiusPx', file),
  };
}

function normaliseFallbacks(raw: unknown, file: string): Record<ScriptName, string> {
  if (!isObject(raw)) {
    throw new CaptionEngineError(
      `Template ${file} scriptFallbacks must map every supported script to a font file.`,
    );
  }
  const mapped: Partial<Record<ScriptName, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const script = SCRIPT_ALIASES[key.toLowerCase()];
    if (!script) {
      throw new CaptionEngineError(
        `Template ${file} has an unknown script "${key}" in scriptFallbacks.`,
        `Supported: ${TEMPLATE_SCRIPTS.join(', ')} (Odia is accepted as an alias of Oriya).`,
      );
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new CaptionEngineError(
        `Template ${file} scriptFallbacks.${key} must be a font filename.`,
      );
    }
    mapped[script] = value.trim();
  }
  const missing = TEMPLATE_SCRIPTS.filter((s) => !mapped[s]);
  if (missing.length > 0) {
    throw new CaptionEngineError(
      `Template ${file} does not map ${missing.join(', ')}.`,
      'Every template must name a vendored font for all 12 script buckets ' +
        '(Latin, Devanagari, Telugu, Kannada, Tamil, Malayalam, Bengali, Gujarati, ' +
        'Gurmukhi, Odia/Oriya, Arabic/Nastaliq, Common).',
    );
  }
  return mapped as Record<ScriptName, string>;
}

export function parseTemplate(raw: unknown, file = 'template'): CaptionTemplate {
  if (!isObject(raw)) {
    throw new CaptionEngineError(`Template ${file} must be a JSON object.`);
  }
  const id = needString(raw, 'id', file);
  const name = needString(raw, 'name', file);
  const description = needString(raw, 'description', file);
  const aliases = raw.aliases === undefined
    ? undefined
    : (Array.isArray(raw.aliases) && raw.aliases.every((a) => typeof a === 'string')
      ? raw.aliases.map((a) => a.trim()).filter(Boolean)
      : (() => {
          throw new CaptionEngineError(`Template ${file} aliases must be an array of strings.`);
        })());

  if (!isObject(raw.typography)) {
    throw new CaptionEngineError(`Template ${file} is missing typography.`);
  }
  const typo = raw.typography;
  const textCase = needString(typo, 'textCase', file);
  if (textCase !== 'uppercase' && textCase !== 'none') {
    throw new CaptionEngineError(
      `Template ${file} textCase must be "uppercase" or "none".`,
      `Got "${textCase}".`,
    );
  }
  const fontSizePx = typo.fontSizePx === undefined ? undefined : needNumber(typo, 'fontSizePx', file);
  const fontSizePxRatio = typo.fontSizePxRatio === undefined
    ? undefined
    : needNumber(typo, 'fontSizePxRatio', file);
  if (fontSizePx === undefined && fontSizePxRatio === undefined) {
    throw new CaptionEngineError(
      `Template ${file} typography needs fontSizePx or fontSizePxRatio.`,
    );
  }
  const typography: TemplateTypography = {
    fontFamily: needString(typo, 'fontFamily', file),
    ...(fontSizePx !== undefined ? { fontSizePx } : {}),
    ...(fontSizePxRatio !== undefined ? { fontSizePxRatio } : {}),
    fontWeight: needNumber(typo, 'fontWeight', file),
    lineSpacing: needNumber(typo, 'lineSpacing', file),
    textCase,
    maxWordsPerCue: needNumber(typo, 'maxWordsPerCue', file),
    maxCharsPerLine: needNumber(typo, 'maxCharsPerLine', file),
    maxLines: needNumber(typo, 'maxLines', file),
  };
  if (typography.maxWordsPerCue < 1 || typography.maxCharsPerLine < 1 || typography.maxLines < 1) {
    throw new CaptionEngineError(`Template ${file} typography limits must be at least 1.`);
  }
  if (typography.lineSpacing < 1 || typography.lineSpacing > 3) {
    throw new CaptionEngineError(`Template ${file} lineSpacing must be between 1 and 3.`);
  }

  if (!isObject(raw.colors)) {
    throw new CaptionEngineError(`Template ${file} is missing colors.`);
  }
  if (!isObject(raw.colors.stroke)) {
    throw new CaptionEngineError(`Template ${file} colors.stroke must be an object.`);
  }
  const colors: CaptionTemplate['colors'] = {
    fill: needHex(raw.colors, 'fill', file),
    stroke: {
      color: needHex(raw.colors.stroke, 'color', file),
      widthRatio: needNumber(raw.colors.stroke, 'widthRatio', file),
    },
  };
  if (colors.stroke.widthRatio < 0 || colors.stroke.widthRatio > 0.5) {
    throw new CaptionEngineError(`Template ${file} stroke widthRatio must be between 0 and 0.5.`);
  }
  if (raw.colors.shadow !== undefined) {
    if (!isObject(raw.colors.shadow)) {
      throw new CaptionEngineError(`Template ${file} colors.shadow must be an object.`);
    }
    colors.shadow = {
      color: needHex(raw.colors.shadow, 'color', file),
      blur: needNumber(raw.colors.shadow, 'blur', file),
      offsetX: needNumber(raw.colors.shadow, 'offsetX', file),
      offsetY: needNumber(raw.colors.shadow, 'offsetY', file),
    };
  }

  if (!isObject(raw.activeWord)) {
    throw new CaptionEngineError(`Template ${file} is missing activeWord.`);
  }
  const activeWord: TemplateActiveWord = {
    color: needHex(raw.activeWord, 'color', file),
    scale: needNumber(raw.activeWord, 'scale', file),
    fontWeight: needNumber(raw.activeWord, 'fontWeight', file),
  };
  if (activeWord.scale < 1 || activeWord.scale > 2) {
    throw new CaptionEngineError(`Template ${file} activeWord.scale must be between 1 and 2.`);
  }
  if (raw.activeWord.backgroundBox !== undefined) {
    activeWord.backgroundBox = parseBox(raw.activeWord.backgroundBox, file, 'activeWord.backgroundBox');
  }

  if (!isObject(raw.safeMargins)) {
    throw new CaptionEngineError(`Template ${file} is missing safeMargins.`);
  }
  const safeMargins: TemplateSafeMargins = {
    portrait: parseMargins(raw.safeMargins.portrait, file, 'portrait'),
    landscape: parseMargins(raw.safeMargins.landscape, file, 'landscape'),
    square: parseMargins(raw.safeMargins.square, file, 'square'),
  };

  if (!isObject(raw.motionDefault)) {
    throw new CaptionEngineError(`Template ${file} is missing motionDefault.`);
  }
  const animation = needString(raw.motionDefault, 'animation', file);
  const known = listAnimationTemplates();
  if (!known.includes(animation)) {
    throw new CaptionEngineError(
      `Template ${file} motionDefault.animation "${animation}" is not a real animation.`,
      `Available: ${known.join(', ')}`,
    );
  }
  const intensity = needString(raw.motionDefault, 'intensity', file);
  if (!(MOTION_LEVELS as readonly string[]).includes(intensity)) {
    throw new CaptionEngineError(
      `Template ${file} motionDefault.intensity must be ${MOTION_LEVELS.join(' | ')}.`,
    );
  }

  return {
    id,
    name,
    description,
    ...(aliases ? { aliases } : {}),
    typography,
    colors,
    ...(raw.backgroundBox !== undefined
      ? { backgroundBox: parseBox(raw.backgroundBox, file, 'backgroundBox') }
      : {}),
    activeWord,
    safeMargins,
    motionDefault: { animation, intensity: intensity as MotionLevelName },
    scriptFallbacks: normaliseFallbacks(raw.scriptFallbacks, file),
  };
}

let cache: CaptionTemplate[] | null = null;

export function clearTemplateCache(): void {
  cache = null;
}

export function loadTemplates(): CaptionTemplate[] {
  if (cache) return cache;
  const dir = templatesDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    throw new CaptionEngineError(
      `No caption templates in ${dir}.`,
      'Add one JSON file per template under src/captions/templates/.',
    );
  }
  const loaded: CaptionTemplate[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new CaptionEngineError(
        `Template ${file} is not valid JSON.`,
        e instanceof Error ? e.message : String(e),
      );
    }
    const template = parseTemplate(parsed, file);
    if (template.id !== file.replace(/\.json$/, '')) {
      throw new CaptionEngineError(
        `Template file ${file} declares id "${template.id}".`,
        'The filename and the id must match.',
      );
    }
    const keys = [template.id, ...(template.aliases ?? [])].map((k) => k.toLowerCase());
    for (const key of keys) {
      if (seen.has(key)) {
        throw new CaptionEngineError(
          `Template id or alias "${key}" is declared more than once.`,
        );
      }
      seen.add(key);
    }
    loaded.push(template);
  }
  const order = [
    'clean', 'bold-social', 'karaoke', 'minimal', 'neon', 'classic',
    'boxed', 'creator-highlight', 'subtitle-safe',
  ];
  loaded.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.id.localeCompare(b.id);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  cache = loaded;
  return loaded;
}

export function listTemplateIds(): string[] {
  return loadTemplates().map((t) => t.id);
}

export function getTemplate(id: string): CaptionTemplate | undefined {
  const key = id.trim().toLowerCase();
  return loadTemplates().find(
    (t) => t.id.toLowerCase() === key || (t.aliases ?? []).some((a) => a.toLowerCase() === key),
  );
}

export function requireTemplate(id: string): CaptionTemplate {
  const found = getTemplate(id);
  if (found) return found;
  throw new CaptionEngineError(
    `Unknown caption template "${id}".`,
    `Available templates: ${listTemplateIds().join(', ')}\n` +
      `Example:  caption-engine templates\n` +
      `          --template bold-social`,
  );
}

function scalePx(px: number, targetHeight: number): number {
  return Math.round(px * (targetHeight / 1920));
}

function marginsFor(template: CaptionTemplate, aspect: AspectPreset): CaptionSafeMargins {
  switch (aspect) {
    case 'portrait':
    case 'original':
      return template.safeMargins.portrait;
    case 'landscape':
      return template.safeMargins.landscape;
    case 'square':
      return template.safeMargins.square;
    default: {
      const neverAspect: never = aspect;
      return neverAspect;
    }
  }
}

function compileBox(box: TemplateBackgroundBox, targetHeight: number): CaptionBackgroundBox {
  return {
    color: box.color,
    paddingPx: Math.max(0, scalePx(box.paddingPx, targetHeight)),
    borderRadiusPx: Math.max(0, scalePx(box.borderRadiusPx, targetHeight)),
  };
}

function compileShadow(shadow: TemplateShadow, targetHeight: number): CaptionShadow {
  return {
    color: shadow.color,
    blur: Math.max(0, scalePx(shadow.blur, targetHeight)),
    offsetX: scalePx(shadow.offsetX, targetHeight),
    offsetY: scalePx(shadow.offsetY, targetHeight),
  };
}

/**
 * Turn a template into the runtime style the SVG renderer draws.
 * Sizes follow the same 1920px reference as `resolveStyle`.
 */
export function compileTemplateToStyle(
  template: CaptionTemplate,
  aspect: AspectPreset,
  targetHeight: number,
): CaptionStyle {
  if (!Number.isFinite(targetHeight) || targetHeight <= 0) {
    throw new CaptionEngineError(
      `Cannot compile template "${template.id}" for frame height ${targetHeight}.`,
      'Pass a positive frame height in pixels.',
    );
  }
  const typo = template.typography;
  const fontSizePx = typo.fontSizePxRatio !== undefined
    ? Math.round(typo.fontSizePxRatio * targetHeight)
    : scalePx(typo.fontSizePx ?? 72, targetHeight);
  if (fontSizePx < 8 || fontSizePx > 400) {
    throw new CaptionEngineError(
      `Template "${template.id}" compiles to a ${fontSizePx}px font at height ${targetHeight}.`,
      'Pick fontSizePx or fontSizePxRatio so the result stays between 8 and 400.',
    );
  }
  const margins = marginsFor(template, aspect);
  const outlineWidthPx = Math.max(0, Math.round(fontSizePx * template.colors.stroke.widthRatio));
  const fallbacks: Record<string, string> = {};
  for (const script of TEMPLATE_SCRIPTS) {
    const named = template.scriptFallbacks[script];
    if (!named) {
      throw new CaptionEngineError(
        `Template "${template.id}" has no font for ${script}.`,
      );
    }
    const resolved = named.startsWith('/') || /^[A-Za-z]:[\\/]/.test(named)
      ? (existsSync(named) ? named : null)
      : vendoredFontFile(named);
    if (!resolved) {
      throw new CaptionEngineError(
        `Template "${template.id}" names "${named}" for ${script}, but that file is not in assets/fonts.`,
        'Run "npm run fonts:install" or fix scriptFallbacks. A missing face is a hard error, not a silent fallback.',
      );
    }
    fallbacks[script] = resolved;
  }
  const active: CaptionActiveWordStyle = {
    color: template.activeWord.color,
    scale: template.activeWord.scale,
    fontWeight: template.activeWord.fontWeight,
    ...(template.activeWord.backgroundBox
      ? { backgroundBox: compileBox(template.activeWord.backgroundBox, targetHeight) }
      : {}),
  };
  return {
    fontFamily: typo.fontFamily,
    fontSizePx,
    fontWeight: typo.fontWeight,
    primaryColor: template.colors.fill,
    activeColor: template.activeWord.color,
    outlineColor: template.colors.stroke.color,
    outlineWidthPx,
    positionY: Math.min(1, Math.max(0, 1 - margins.bottom)),
    uppercase: typo.textCase === 'uppercase',
    maxWordsPerCue: typo.maxWordsPerCue,
    maxCharsPerLine: typo.maxCharsPerLine,
    maxLines: typo.maxLines,
    lineSpacing: typo.lineSpacing,
    ...(template.colors.shadow ? { shadow: compileShadow(template.colors.shadow, targetHeight) } : {}),
    ...(template.backgroundBox ? { backgroundBox: compileBox(template.backgroundBox, targetHeight) } : {}),
    activeWord: active,
    safeMargins: margins,
    fontFallbacks: fallbacks,
    animationTemplate: template.motionDefault.animation,
    motionIntensity: motionStrength(template.motionDefault.intensity),
  };
}

function motionStrength(level: MotionLevelName): number {
  switch (level) {
    case 'none': return 0;
    case 'subtle': return 0.45;
    case 'expressive': return 0.85;
    case 'auto': return 0.45;
    default: {
      const neverLevel: never = level;
      return neverLevel;
    }
  }
}

export function templateMotionDefault(styleOrId: string): string | undefined {
  return getTemplate(styleOrId)?.motionDefault.animation;
}

export interface FontCoverageFailure {
  templateId: string;
  script: string;
  font: string;
  detail: string;
}

export interface FontCoverageReport {
  ok: boolean;
  checked: number;
  failures: FontCoverageFailure[];
}

/**
 * Shape every template's sample for every script with the named face only.
 * A missing file or a `.notdef` glyph fails the report. Nothing is substituted.
 */
export async function validateTemplateFonts(
  templates: CaptionTemplate[] = loadTemplates(),
): Promise<FontCoverageReport> {
  const { initShaper, shapeText } = await import('../text/shaper.js');
  await initShaper();
  const failures: FontCoverageFailure[] = [];
  let checked = 0;
  for (const template of templates) {
    let style: CaptionStyle;
    try {
      style = compileTemplateToStyle(template, 'portrait', 1920);
    } catch (e) {
      failures.push({
        templateId: template.id,
        script: '*',
        font: '',
        detail: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    const fonts = style.fontFallbacks ?? {};
    for (const script of TEMPLATE_SCRIPTS) {
      const sample = SCRIPT_COVERAGE_SAMPLES[script];
      const font = fonts[script] ?? '';
      checked++;
      if (!font) {
        failures.push({
          templateId: template.id,
          script,
          font: '',
          detail: 'script is not mapped to a font',
        });
        continue;
      }
      try {
        await shapeText(sample, 48, { fontPath: font, allowFallback: false });
      } catch (e) {
        failures.push({
          templateId: template.id,
          script,
          font,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    checked++;
    try {
      await shapeText('meeting आज', 48, {
        fontsByScript: fonts as Partial<Record<ScriptName, string>>,
        allowFallback: false,
      });
    } catch (e) {
      failures.push({
        templateId: template.id,
        script: 'Latin+Devanagari',
        font: fonts.Latin ?? '',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { ok: failures.length === 0, checked, failures };
}

export function formatTemplateList(templates: CaptionTemplate[] = loadTemplates()): string {
  const width = Math.max(8, ...templates.map((t) => t.id.length));
  const lines = [
    `${templates.length} caption template${templates.length === 1 ? '' : 's'}`,
    '',
    `  ${'id'.padEnd(width)}  motion`,
  ];
  for (const t of templates) {
    lines.push(
      `  ${t.id.padEnd(width)}  ${t.motionDefault.animation} (${t.motionDefault.intensity})`,
    );
    lines.push(`  ${''.padEnd(width)}  ${t.description}`);
  }
  lines.push('', 'Use --template <id> in place of --style, or run with --validate-fonts.');
  return lines.join('\n');
}

export function formatTemplateShow(template: CaptionTemplate): string {
  return [
    `${template.name}  (${template.id})`,
    template.description,
    `motion: ${template.motionDefault.animation} / ${template.motionDefault.intensity}`,
    `type:   ${template.typography.fontFamily} ${template.typography.fontSizePx ?? template.typography.fontSizePxRatio} ${template.typography.textCase}`,
    `fill:   ${template.colors.fill}   active: ${template.activeWord.color} ×${template.activeWord.scale}`,
  ].join('\n');
}

export async function runTemplatesCommand(argv: string[]): Promise<number> {
  const validateFonts = argv.includes('--validate-fonts');
  const asJson = argv.includes('--json');
  const show = argv.find((a) => !a.startsWith('--'));
  const templates = loadTemplates();
  if (validateFonts) {
    const report = await validateTemplateFonts(templates);
    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (report.ok) {
      process.stdout.write(
        `Font coverage ok — ${templates.length} templates × ${TEMPLATE_SCRIPTS.length} scripts, no .notdef.\n`,
      );
    } else {
      process.stderr.write(`Font coverage failed (${report.failures.length}):\n`);
      for (const f of report.failures) {
        process.stderr.write(`  ${f.templateId}  ${f.script}  ${f.detail}\n`);
      }
    }
    return report.ok ? 0 : 1;
  }
  if (show) {
    const template = requireTemplate(show);
    if (asJson) process.stdout.write(JSON.stringify(template, null, 2) + '\n');
    else process.stdout.write(formatTemplateShow(template) + '\n');
    return 0;
  }
  if (asJson) process.stdout.write(JSON.stringify(templates, null, 2) + '\n');
  else process.stdout.write(formatTemplateList(templates) + '\n');
  return 0;
}
