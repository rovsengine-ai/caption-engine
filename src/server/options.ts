import type { AspectPreset } from '../captions/style.js';
import { listStylePresets } from '../captions/style.js';
import type { CliOptions, OutputFormat } from '../cli/args.js';
import { listLanguages } from '../config/languages.js';
import { CaptionEngineError } from '../errors.js';

const ASPECTS: AspectPreset[] = ['portrait', 'landscape', 'square', 'original'];
const FORMATS: Array<'mp4' | 'srt' | 'ass' | 'json'> = ['mp4', 'srt', 'ass', 'json'];

export interface JobUiOptions {
  language?: string;
  script?: 'native' | 'roman';
  style?: string;
  aspect?: string;
  autoTrim?: boolean;
  formats?: string[];
  codeSwitching?: boolean;
}

/** Defaults shared with the CLI's `parseArgs` baseline. */
export function baseCliOptions(overrides: Partial<CliOptions> & Pick<CliOptions, 'input'>): CliOptions {
  return {
    format: 'mp4',
    style: 'default',
    aspect: 'portrait',
    highlight: 'active-word',
    activeScale: 1.08,
    activeBold: false,
    script: 'native',
    autoTrim: false,
    trimSilence: 0.7,
    keepFillers: false,
    analyzeFillerCandidates: false,
    noAudioAnalysis: false,
    clips: false,
    cropFocusX: 0.5,
    crf: 20,
    protectEnglish: true,
    codeSwitching: false,
    showDiagnostics: false,
    reviewCuts: false,
    analyzeVideo: false,
    romanFallback: 'error',
    prosody: false,
    toneScope: 'cue',
    motion: 'none',
    animationTemplate: 'auto',
    allowStale: false,
    dryRun: false,
    verbose: false,
    json: false,
    yes: true,
    ...overrides,
  };
}

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseFormats(raw: unknown): Array<'mp4' | 'srt' | 'ass' | 'json'> {
  let list: string[] = [];
  if (Array.isArray(raw)) {
    list = raw.map(String);
  } else if (typeof raw === 'string' && raw.trim()) {
    list = raw.split(/[,+\s]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    list = ['mp4'];
  }

  const selected = [...new Set(list.map((s) => s.toLowerCase()))].filter(
    (f): f is 'mp4' | 'srt' | 'ass' | 'json' => (FORMATS as string[]).includes(f),
  );

  if (selected.length === 0) {
    throw new CaptionEngineError(
      'No valid output formats selected.',
      `Choose one or more of: ${FORMATS.join(', ')}`,
    );
  }
  return selected;
}

function toPipelineFormat(formats: Array<'mp4' | 'srt' | 'ass' | 'json'>): OutputFormat {
  if (formats.length === 1) return formats[0]!;
  return 'all';
}

/**
 * Map multipart form fields (or a JSON body) into CliOptions.
 * Returns both the pipeline options and the exact formats the UI requested
 * (so downloads can hide formats the user did not ask for when `format=all`).
 */
export function uiOptionsToCli(
  inputPath: string,
  outputPath: string,
  workDir: string,
  body: Record<string, unknown>,
): { opts: CliOptions; requestedFormats: Array<'mp4' | 'srt' | 'ass' | 'json'> } {
  const language = typeof body.language === 'string' && body.language.trim()
    ? body.language.trim()
    : 'auto';

  const scriptRaw = typeof body.script === 'string' ? body.script.trim().toLowerCase() : 'native';
  if (scriptRaw !== 'native' && scriptRaw !== 'roman') {
    throw new CaptionEngineError(`Unknown script "${scriptRaw}".`, 'Valid: native, roman');
  }

  const style = typeof body.style === 'string' && body.style.trim()
    ? body.style.trim()
    : 'default';
  if (!listStylePresets().includes(style)) {
    throw new CaptionEngineError(
      `Unknown style "${style}".`,
      `Available: ${listStylePresets().join(', ')}`,
    );
  }

  const aspectRaw = typeof body.aspect === 'string' ? body.aspect.trim().toLowerCase() : 'portrait';
  if (!(ASPECTS as string[]).includes(aspectRaw)) {
    throw new CaptionEngineError(
      `Unknown aspect "${aspectRaw}".`,
      `Valid: ${ASPECTS.join(', ')}`,
    );
  }

  const requestedFormats = parseFormats(body.formats ?? body.format);
  const autoTrim = parseBool(body.autoTrim ?? body.auto_trim);
  const codeSwitching = parseBool(body.codeSwitching ?? body.code_switching);

  const opts = baseCliOptions({
    input: inputPath,
    output: outputPath,
    workDir,
    language,
    script: scriptRaw,
    style,
    aspect: aspectRaw as AspectPreset,
    format: toPipelineFormat(requestedFormats),
    autoTrim,
    codeSwitching,
    // Spaces jobs should not hang waiting for interactive confirmation.
    yes: true,
    verbose: true,
  });

  return { opts, requestedFormats };
}

export function publicMeta() {
  return {
    languages: [
      { code: 'auto', name: 'Auto-detect', nativeName: 'Auto' },
      ...listLanguages().map((l) => ({
        code: l.code,
        name: l.name,
        nativeName: l.nativeName,
        supportsRomanisation: l.supportsRomanisation,
      })),
    ],
    styles: listStylePresets(),
    aspects: ASPECTS,
    scripts: ['native', 'roman'] as const,
    formats: FORMATS,
  };
}
