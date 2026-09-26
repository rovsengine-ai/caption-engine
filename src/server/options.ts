import type { AspectPreset } from '../captions/style.js';
import { listStylePresets } from '../captions/style.js';
import type { CliOptions, OutputFormat } from '../cli/args.js';
import { listLanguages } from '../config/languages.js';
import { CaptionEngineError } from '../errors.js';
import {
  DEFAULT_PROVIDER_MODE,
  isProviderMode,
  PROVIDER_MODES,
  type ProviderMode,
} from '../asr/index.js';
import {
  autoTrimToCliFragment,
  parseAutoTrimControls,
  publicAutoTrimMeta,
} from './autotrim-presets.js';
import { join } from 'node:path';

const ASPECTS: AspectPreset[] = ['portrait', 'landscape', 'square', 'original'];
const FORMATS: Array<'mp4' | 'srt' | 'ass' | 'json'> = ['mp4', 'srt', 'ass', 'json'];

/** FluxoCut-style template gallery → engine style preset (+ motion hint). */
export const TEMPLATE_GALLERY = [
  { id: 'ink-flow', name: 'Ink Flow', style: 'lyric', motion: 'subtle', blurb: 'Cursive energy, soft glow' },
  { id: 'script-duo', name: 'Script Duo', style: 'elegant', motion: 'subtle', blurb: 'Bold sans + script accent' },
  { id: 'type-stairs', name: 'Type Stairs', style: 'editorial', motion: 'expressive', blurb: 'Stepped typographic stack' },
  { id: 'word-stairs', name: 'Word Stairs', style: 'kinetic', motion: 'expressive', blurb: 'Word-by-word climb' },
  { id: 'slice-glow', name: 'Slice Glow', style: 'neon', motion: 'expressive', blurb: 'Neon sliced glow' },
  { id: 'zyada', name: 'Zyada', style: 'minimal', motion: 'subtle', blurb: 'Hyper clean green outline' },
  { id: 'hyper-clean', name: 'Hyper Clean', style: 'minimal', motion: 'none', blurb: 'Minimal outline glow' },
  { id: 'editorial', name: 'Editorial', style: 'editorial', motion: 'none', blurb: 'Magazine-clean serif/sans' },
  { id: 'pop-viral', name: 'Pop Viral', style: 'pop', motion: 'expressive', blurb: 'High-impact active word pop' },
  { id: 'viral-minimal', name: 'Viral Minimalist', style: 'creator', motion: 'subtle', blurb: 'Quiet flex, loud word' },
  { id: 'active-box', name: 'Active Box', style: 'karaoke', motion: 'subtle', blurb: 'Pill behind spoken word' },
  { id: 'ekdam', name: 'Ekdam', style: 'bold', motion: 'expressive', blurb: 'Punchy uppercase kinetic' },
  { id: 'kinetic-stack', name: 'Kinetic Stack', style: 'kinetic', motion: 'expressive', blurb: 'Stacked word hits' },
  { id: 'neon-script', name: 'Neon Script', style: 'neon', motion: 'subtle', blurb: 'Cyan neon script vibe' },
  { id: 'felt', name: 'Felt', style: 'soft', motion: 'subtle', blurb: 'Warm soft caption feel' },
  { id: 'trio-lockup', name: 'Trio Lockup', style: 'classic', motion: 'none', blurb: 'Three-word lockup' },
] as const;

export interface JobUiOptions {
  language?: string;
  script?: 'native' | 'roman';
  style?: string;
  aspect?: string;
  autoTrim?: boolean;
  formats?: string[];
  codeSwitching?: boolean;
  provider?: ProviderMode;
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

function parseProvider(raw: unknown): ProviderMode {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_PROVIDER_MODE;
  const v = raw.trim().toLowerCase();
  if (!isProviderMode(v)) {
    throw new CaptionEngineError(
      `Unknown provider "${v}".`,
      `Valid: ${PROVIDER_MODES.join(', ')}`,
    );
  }
  return v;
}

function resolveTemplateStyle(body: Record<string, unknown>): {
  style: string;
  motion: CliOptions['motion'];
} {
  const templateId = typeof body.template === 'string' ? body.template.trim().toLowerCase() : '';
  if (templateId) {
    const t = TEMPLATE_GALLERY.find((x) => x.id === templateId);
    if (t) {
      return {
        style: t.style,
        motion: (t.motion as CliOptions['motion']) || 'none',
      };
    }
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
  const motionRaw = typeof body.motion === 'string' ? body.motion.trim().toLowerCase() : 'none';
  const motion = (['none', 'subtle', 'expressive', 'auto'].includes(motionRaw)
    ? motionRaw
    : 'none') as CliOptions['motion'];
  return { style, motion };
}

/**
 * Map multipart form fields (or a JSON body) into CliOptions.
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

  const { style, motion } = resolveTemplateStyle(body);

  const aspectRaw = typeof body.aspect === 'string' ? body.aspect.trim().toLowerCase() : 'portrait';
  if (!(ASPECTS as string[]).includes(aspectRaw)) {
    throw new CaptionEngineError(
      `Unknown aspect "${aspectRaw}".`,
      `Valid: ${ASPECTS.join(', ')}`,
    );
  }

  const requestedFormats = parseFormats(body.formats ?? body.format);
  const codeSwitching = parseBool(body.codeSwitching ?? body.code_switching);
  const provider = parseProvider(body.provider);
  const trimControls = parseAutoTrimControls(body);
  const trimCli = autoTrimToCliFragment(trimControls);

  const outputDir = join(outputPath, '..');
  const cutsOut = join(outputDir, 'cuts.json');
  const transcriptOut = join(outputDir, 'transcript.json');

  const maxWordsRaw = body.maxWordsPerCue ?? body.max_words;
  const maxWordsPerCue = maxWordsRaw !== undefined && maxWordsRaw !== ''
    ? Number(maxWordsRaw)
    : undefined;

  const opts = baseCliOptions({
    input: inputPath,
    output: outputPath,
    workDir,
    language,
    script: scriptRaw,
    style,
    motion,
    aspect: aspectRaw as AspectPreset,
    format: toPipelineFormat(requestedFormats),
    codeSwitching,
    provider,
    autoTrim: trimCli.autoTrim,
    trimSilence: trimCli.trimSilence,
    keepFillers: trimCli.keepFillers,
    removeFalseStarts: trimCli.removeFalseStarts,
    fillerConfidence: trimCli.fillerConfidence,
    minCutConfidence: trimCli.minCutConfidence,
    analyzeVideo: trimCli.analyzeVideo,
    // Always persist cuts + transcript for the editor restore / cue list APIs.
    cutsOut: trimCli.autoTrim ? cutsOut : undefined,
    transcriptOut,
    ...(maxWordsPerCue !== undefined && Number.isFinite(maxWordsPerCue)
      ? { maxWordsPerCue: Math.max(1, Math.min(20, maxWordsPerCue)) }
      : {}),
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
    templates: TEMPLATE_GALLERY,
    aspects: ASPECTS,
    scripts: [
      { value: 'native', label: 'Native script' },
      { value: 'roman', label: 'Hinglish / Roman' },
    ],
    formats: FORMATS,
    autoTrim: publicAutoTrimMeta(),
    providers: [
      {
        value: 'sarvam_fallback_elevenlabs',
        label: 'Sarvam AI + ElevenLabs Fallback',
        badge: 'Recommended',
        description: 'Sarvam first for Indic/Hinglish; ElevenLabs Scribe if Sarvam fails or lacks word timings.',
      },
      {
        value: 'sarvam',
        label: 'Sarvam AI only',
        description: 'India-hosted. Chunk-level timings — not enough for word-timed karaoke alone.',
      },
      {
        value: 'elevenlabs',
        label: 'ElevenLabs Scribe',
        description: 'Word-level timestamps + strong code-switch handling.',
      },
      {
        value: 'deepgram',
        label: 'Deepgram Nova',
        description: 'Word timings; good Telugu/Kannada coverage.',
      },
    ],
    defaultProvider: DEFAULT_PROVIDER_MODE,
  };
}
