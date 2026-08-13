import { CaptionEngineError } from '../errors.js';
import { listStylePresets, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX } from '../captions/style.js';
import type { AspectPreset } from '../captions/style.js';
import {
  MOTION_LEVELS, listAnimationTemplates, assertValidMotionLevel,
  assertValidAnimationTemplateName,
  type MotionLevel,
} from '../captions/animation.js';

export type OutputFormat = 'mp4' | 'srt' | 'ass' | 'json' | 'all';

export interface CliOptions {
  input: string;
  output?: string;
  language?: string;
  provider?: string;
  format: OutputFormat;
  style: string;
  aspect: AspectPreset;
  highlight: 'active-word' | 'none';
  activeScale: number;
  activeColor?: string;
  activeBold: boolean;
  /** A discovered font family name from assets/fonts or FONT_DIR. */
  font?: string;
  script: 'native' | 'roman';
  autoTrim: boolean;
  trimSilence: number;
  keepFillers: boolean;
  /** error | native | http — what to do when Roman output is unavailable. */
  romanFallback: 'error' | 'native' | 'http';
  /** Suppress Auto Trim proposals below this confidence, 0..1. */
  minCutConfidence?: number;
  /** Print the Pass 1 filler evidence table and stop before rendering. */
  analyzeFillerCandidates: boolean;
  /** Skip the FFmpeg audio-measurement pass. Faster; weaker evidence. */
  noAudioAnalysis: boolean;
  /** Below this, a token is too brief to judge as a held hesitation. */
  minFillerDuration?: number;
  /** Above this, a token is a word spoken slowly, not a hesitation. */
  maxFillerDuration?: number;
  /** Pass 2 verdicts below this become review-required instead of propose-cut. */
  fillerConfidence?: number;
  /** Seconds of audio kept on each side of a speech cut. */
  cutHandles?: number;
  /** Seconds of fade at each cut join. 0 disables. */
  cutFade?: number;
  clips: boolean;
  maxWordsPerCue?: number;
  fontSize?: number;
  positionY?: number;
  cropFocusX: number;
  fps?: number;
  crf: number;
  /** x264 speed/quality preset. */
  preset?: string;
  transcriptIn?: string;
  /** Set by the `render` subcommand: hard guarantee that no ASR call happens. */
  noAsr?: boolean;
  /** Force a rasteriser: resvg | ffmpeg. */
  rasteriser?: string;
  /** Transliteration backend for --script roman: local | sarvam | http. */
  transliterate?: string;
  /** Extra Hinglish glossary file, merged over the built-in one. */
  glossary?: string;
  /** Protect Latin/English tokens from any transliteration backend. Default true. */
  protectEnglish: boolean;
  /** Domain vocabulary passed to the ASR as keyterms. */
  keyterms?: string[];
  /** File of keyterms, one per line. */
  keytermsFile?: string;
  /** Tell the ASR to expect Hindi-English code-switching. */
  codeSwitching: boolean;
  /** Print the per-token original → final table. */
  showDiagnostics: boolean;
  /**
   * Analyse local audio prosody (loudness + F0 pitch) and style words by tone.
   * OFF by default: with this absent the render is byte-identical to before.
   */
  prosody: boolean;
  /** Override config/caption-theme.json. */
  captionTheme?: string;
  /**
   * Kinetic captions. 'none' (the default) is a hard guarantee: with it,
   * frame planning and rendering take the exact same code path they did
   * before this feature existed — not just a visually similar one.
   */
  motion: MotionLevel;
  /** Overrides the level's own baseline strength. 0..1. */
  motionIntensity?: number;
  /** A name from listAnimationTemplates(), or 'auto' to resolve from tone/style. */
  animationTemplate: string;
  /**
   * Whether a tone styles a whole caption line or each word individually.
   * 'cue' by default: per-word tone changes roughly every 200 ms on real
   * speech, which reads as flicker rather than expression.
   */
  toneScope: 'cue' | 'word';
  /** Propose Auto Trim cuts and stop before rendering. */
  reviewCuts: boolean;
  /**
   * Sample video frames and use a Vision AI model to flag odd/unusable
   * footage (speaker looking away, blurry, wild camera movement) as
   * visual_reject cuts. Implies --auto-trim. Needs ANTHROPIC_API_KEY or
   * GEMINI_API_KEY, depending on --vision-provider.
   */
  analyzeVideo: boolean;
  /**
   * Which Vision AI backend --analyze-video calls. Explicit flag always
   * wins; otherwise picked from whichever API key is set (Anthropic
   * preferred when both are present, for backward compatibility).
   */
  visionProvider?: 'anthropic' | 'gemini';
  transcriptOut?: string;
  cutsIn?: string;
  cutsOut?: string;
  workDir?: string;
  /** Reuse a transcript/cut file even when its input fingerprint does not match. */
  allowStale: boolean;
  dryRun: boolean;
  verbose: boolean;
  json: boolean;
  yes: boolean;
}

const HELP = `
caption-engine — word-timed captions, Auto Trim and clip finding

USAGE
  caption-engine <input> [options]
  caption-engine render <input> --transcript <file> [options]
                                   render from a saved transcript — NEVER calls an ASR API
  caption-engine doctor            check every rendering dependency (functional probes)
  caption-engine languages         list supported languages
  caption-engine fonts             list discovered font families for --font

INPUT
  Video: .mp4 .mov .mkv .webm .avi .m4v .mpg .wmv .flv .ts
  Audio: .wav .mp3 .m4a .aac .flac .ogg .opus .aiff .caf
  Audio is extracted automatically from video before transcription.

CORE OPTIONS
  -o, --output <path>       Output file. Extension picks the format if --format is absent.
  -l, --language <code>     auto | hi | te | kn | ta | ml | bn | gu | pa | mr | en | ...
                            "auto" (or omitting this) detects from the ASR result:
                            the provider's own language tag first, corroborated by
                            the dominant script. An explicit code ALWAYS wins over
                            detection. Provider codes are normalised (hin→hi,
                            kan→kn, tam→ta, tel→te, mal→ml, ben→bn, guj→gu,
                            pan→pa, ori→or, asm→as, nep→ne, mar→mr, eng→en).
  -f, --format <fmt>        mp4 | srt | ass | json | all          (default: from -o, else mp4)
  -p, --provider <name>     elevenlabs | deepgram | sarvam        (default: $ASR_PROVIDER or elevenlabs)

APPEARANCE
      --style <name>        ${listStylePresets().join(' | ')}   (default: default)
      --aspect <name>       portrait | landscape | square | original  (default: portrait)
      --highlight <mode>    active-word | none                   (default: active-word)
      --active-scale <n>    Scale of the highlighted word        (default: 1.08)
      --active-color <hex>  Active-word colour, e.g. #FFD400
      --active-bold         Use the real bold face for the active word
      --font <name>         Font family from assets/fonts or FONT_DIR
      --font-size <px>      Override caption size (${MIN_FONT_SIZE_PX}-${MAX_FONT_SIZE_PX}, default: preset's own size)
      --position-y <0..1>   Vertical anchor, 0 = top, 1 = bottom (default: 0.72)
      --max-words <n>       Max words shown at once
      --crop-focus <0..1>   Horizontal focus when reframing      (default: 0.5)
      --script <mode>       native | roman   (default: native)
                            roman = the DETECTED language written in Roman
                            letters. Not translation, and not always Hinglish —
                            Hinglish is only what this is called for Hindi.
                              hi  आज meeting बहुत important है
                                  → Aaj meeting bahut important hai   (Hinglish)
                              kn  ಇದು ಒಂದು important meeting
                                  → Idu ondu important meeting        (Kannglish)
                            English words stay as they are in every language.
      --transliterate <b>   auto | local | sarvam | http   (default: auto —
                            sarvam/http if configured, else local)
                            local  offline rules. LOWER QUALITY on English written
                                   in Devanagari; leans on the glossary.
                            sarvam model-based, needs SARVAM_API_KEY
                            http   your own endpoint via TRANSLITERATE_URL
      --prosody             Measure local audio prosody (loudness + F0 pitch,
                            all offline) and style each word by its tone.
                            Off by default; without it output is unchanged.
      --tone-style <mode>   auto | none   (default: none) — alias for --prosody
      --tone-scope <mode>   cue | word    (default: cue)
                            cue  one tone per caption line. Steadier: per-word
                                 tone changes ~5x/second on real speech.
                            word a tone per word. More responsive, twitchier.
      --caption-theme <f>   Tone→style map. Default: config/caption-theme.json
      --motion <level>      ${MOTION_LEVELS.join(' | ')}   (default: none)
                            none        static rendering — IDENTICAL to no
                                        animation at all, the safe default
                            subtle      restrained motion, safe to leave on
                            expressive  full template strength
                            auto        level AND template chosen from tone/
                                        style — needs --prosody to react to
                                        anything; otherwise behaves like subtle
      --motion-intensity <0..1>
                            Overrides the level's own baseline strength
      --animation-template <name>
                            auto | ${listAnimationTemplates().join(' | ')}
                            "auto" picks a restrained template from the
                            selected --style and, with --prosody on, the
                            detected tone. Ignored while --motion is none.
                            Run with --diagnostics to see which template and
                            intensity actually rendered.
      --hinglish-glossary <f>
                            Extra glossary merged over the built-in one. Maps
                            Devanagari-written English back to real spelling
                            (चीट डे => cheat day) and protects Latin phrases.
      --roman-fallback <p>  What to do when Roman output is unavailable for the
                            detected language                    (default: error)
                              error   stop, with instructions
                              native  keep the ORIGINAL script and carry on. Always
                                      reported, never silent, and only used when
                                      romanisation is genuinely unavailable.
                              http    use TRANSLITERATE_URL instead
                            Kannada, Telugu, Tamil, Malayalam, Bengali, Gujarati,
                            Punjabi, Odia and Assamese have no offline engine, so a
                            failed Sarvam batch has nothing to fall back to. With
                            "native" that batch keeps its script and is named in
                            the report; with "error" the run stops.
      --protect-english     Never let a backend alter Latin/English tokens (default on)
      --no-protect-english  Disable that protection
      --diagnostics         Print the per-token table: original → final → stage

AUTO TRIM
      --auto-trim           Remove silences, fillers and false starts
      --trim-silence <sec>  Gap length treated as silence        (default: 0.7)
      --keep-fillers        Trim silence only, leave filler words in
      --analyze-filler-candidates
                            Print the evidence behind every filler candidate —
                            duration, ASR confidence, ASR gaps, MEASURED silence,
                            elongation, repetition, position — then stop. Nothing
                            is cut. Use this when a cut looks wrong: the table
                            shows which signal was responsible.
      --no-audio-analysis   Skip the FFmpeg measurement pass (3 extra passes over
                            the audio; real time on a long file). Auto Trim falls
                            back to ASR-gap arithmetic, which cannot tell silence
                            from a word the recogniser failed on. Ambiguous
                            fillers are then offered for review rather than cut.
      --min-filler-duration <sec>
                            Shorter than this is too brief to judge     (default: 0.06)
      --max-filler-duration <sec>
                            Longer than this is a word, not a hesitation (default: 2.0)
      --filler-confidence <0..1>
                            Below this a filler is marked review-required instead
                            of proposed for cutting                     (default: 0.6)
                            Review cuts appear in --cuts-out with "restored": true
                            and are NOT applied. Set it to false to accept one.
      --min-cut-confidence <0..1>
                            Only propose cuts this confident              (default: 0)
                            Every cut carries a deterministic confidence: silence
                            scales with gap length, an unambiguous filler scores
                            0.95, a real word cut on pause evidence caps at 0.85,
                            a repeated take at 0.9. 0 proposes everything and lets
                            the review step decide — raise it for an unattended run.
      --cut-handles <sec>   Audio kept on each side of a speech cut  (default: 0.04)
                            ASR word boundaries are estimates; cutting exactly on
                            them clips the final consonant. Applied to the cut list
                            before captions are timed, so audio and captions stay
                            in step. 0 cuts exactly on the ASR boundary.
      --cut-fade <sec>      Fade at each cut join                    (default: 0.012)
                            Removes the click where two segments meet. A level
                            shape only — it never changes a duration. 0 disables.
      --cuts-out <file>     Write the proposed cut list as JSON for review
      --cuts-in <file>      Apply a reviewed cut list (set "restored": true to keep a cut)
      --review-cuts         Propose cuts, write --cuts-out, then STOP before rendering
      --analyze-video       Sample video frames (1/sec) and use a Vision AI model
                            to flag odd/unusable footage — speaker looking away,
                            blurry, covered, wild camera movement — as
                            visual_reject cuts. Implies --auto-trim. Needs
                            ANTHROPIC_API_KEY or GEMINI_API_KEY (see
                            --vision-provider). Always review-required: these
                            cuts are written to --cuts-out with "restored": true
                            and are NOT applied until you flip that to false —
                            unlike other cut types, a single Vision AI call has
                            no second signal to corroborate it.
      --vision-provider <p> anthropic | gemini   (default: whichever API key is
                            set; anthropic wins if both are)
                            gemini uses Google AI Studio's free tier —
                            GEMINI_API_KEY, no charge for light use.

ASR QUALITY (mixed Hindi-English)
      --code-switching      Tell the ASR to expect Hinglish and keep English in Latin.
                            Fixes "cheat day" → "चीट डे" at the source, which is far
                            better than repairing it afterwards.
      --keyterms <a,b,c>    Domain vocabulary: names, brands, product terms
      --keyterms-file <f>   Same, one term per line

CLIPS
      --clips               Find clip-worthy moments in long-form input (needs an LLM key)

TRANSCRIPT REUSE (avoid paying for ASR twice)
      --transcript-out <f>  Save the transcript JSON after transcribing
      --transcript-in <f>   Use a saved transcript and skip ASR entirely
      --transcript <f>      Alias of --transcript-in (reads naturally with 'render')

RENDERING
      --rasteriser <name>   resvg | ffmpeg   (default: resvg, auto-detected)
                            resvg is a native library with no system dependencies.
                            ffmpeg only works if built with librsvg — Homebrew's
                            core ffmpeg is NOT.

ENCODING
      --fps <n>             Output frame rate
      --crf <n>             x264 quality, lower is better         (default: 20)
      --preset <name>       x264 speed: ultrafast … veryslow        (default: medium)
                            ultrafast/veryfast dramatically cut render time on
                            long videos, at some file-size cost.

OTHER
      --work-dir <dir>      Where intermediate files go (default: a temp dir)
      --allow-stale         Reuse a --transcript-in / --cuts-in file even when its
                            recorded input fingerprint does not match this media.
                            Off by default: replacing a video while keeping the
                            same filename otherwise silently reuses the old take's
                            transcript, and every caption lands at the wrong time.
      --dry-run             Show the plan without transcribing or rendering
      --json                Machine-readable output
  -v, --verbose             Verbose logging
  -y, --yes                 Do not prompt
  -h, --help                This message

EXAMPLES
  # Video → captioned vertical MP4
  caption-engine input.mp4 --language hi --output out.mp4

  # Audio → subtitle file only (no rendering, no API cost for video)
  caption-engine podcast.wav --language en --format srt --output captions.srt

  # Auto Trim with a review step
  caption-engine talk.mp4 --auto-trim --cuts-out cuts.json --format json
  #   ...edit cuts.json, set "restored": true on anything to keep...
  caption-engine talk.mp4 --auto-trim --cuts-in cuts.json --output trimmed.mp4

  # Auto Trim plus visual analysis (flags odd/unusable footage for review)
  caption-engine talk.mp4 --auto-trim --analyze-video --cuts-out cuts.json --format json
  #   ...edit cuts.json, set "restored": false on any visual_reject to cut it...
  caption-engine talk.mp4 --auto-trim --cuts-in cuts.json --output trimmed.mp4

  # Reuse a transcript across several renders
  caption-engine v.mp4 --transcript-out t.json --format json
  caption-engine v.mp4 --transcript-in t.json --style neon --aspect square -o square.mp4

  # Kinetic captions: a named template
  caption-engine v.mp4 --style kinetic --motion expressive --animation-template pop -o out.mp4

  # Kinetic captions that react to how the line was actually spoken
  caption-engine v.mp4 --motion auto --prosody --animation-template auto -o out.mp4

ENVIRONMENT
  ELEVENLABS_API_KEY / DEEPGRAM_API_KEY / SARVAM_API_KEY
  ANTHROPIC_API_KEY      for --clips and --analyze-video (Anthropic provider)
  GEMINI_API_KEY         for --analyze-video (Gemini provider — free tier)
  TRANSLITERATE_PROVIDER default backend for --script roman
  TRANSLITERATE_URL      endpoint for --transliterate http
  HINGLISH_GLOSSARY      default extra glossary file
  ASR_PROVIDER           default provider
  FFMPEG_PATH / FFPROBE_PATH   custom binary locations
  FONT_DIR               extra font directories (colon-separated)
`;

const FORMATS: OutputFormat[] = ['mp4', 'srt', 'ass', 'json', 'all'];
const ASPECTS: AspectPreset[] = ['portrait', 'landscape', 'square', 'original'];

function needValue(flag: string, v: string | undefined): string {
  if (v === undefined || v.startsWith('--')) {
    throw new CaptionEngineError(`Option ${flag} requires a value.`, `Example: ${flag} <value>`);
  }
  return v;
}

function num(flag: string, v: string | undefined, min?: number, max?: number): number {
  const n = Number(needValue(flag, v));
  if (!Number.isFinite(n)) {
    throw new CaptionEngineError(`${flag} must be a number, got "${v}".`);
  }
  if (min !== undefined && n < min) throw new CaptionEngineError(`${flag} must be >= ${min}.`);
  if (max !== undefined && n > max) throw new CaptionEngineError(`${flag} must be <= ${max}.`);
  return n;
}

export function printHelp(): void {
  process.stdout.write(HELP);
}

export type ParsedCommand =
  | { command: 'help' }
  | { command: 'doctor' }
  | { command: 'languages' }
  | { command: 'fonts' }
  | { command: 'run'; options: CliOptions };

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) return { command: 'help' };
  if (argv[0] === 'doctor') return { command: 'doctor' };
  if (argv[0] === 'languages' || argv[0] === '--list-languages') return { command: 'languages' };
  if (argv[0] === 'fonts' || argv[0] === '--list-fonts') return { command: 'fonts' };
  if (argv.includes('-h') || argv.includes('--help')) return { command: 'help' };

  // `render` is a thin alias that GUARANTEES no ASR call: it requires a
  // transcript and rejects any provider flag, so there is no code path from it
  // to a paid API. Making that a separate verb (rather than a flag you might
  // forget) is the point.
  let renderMode = false;
  if (argv[0] === 'render') {
    renderMode = true;
    argv = argv.slice(1);
    if (argv.length === 0) {
      throw new CaptionEngineError(
        'render requires an input file.',
        'Usage: caption-engine render <input> --transcript <file> [options]',
      );
    }
  }

  let input: string | undefined;
  const o: Partial<CliOptions> = {
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
    // Measured audio is on whenever Auto Trim runs. It is the difference
    // between "the ASR emitted no word here" and "the speaker was silent here",
    // and every filler verdict is weaker without it.
    noAudioAnalysis: false,
    clips: false,
    cropFocusX: 0.5,
    crf: 20,
    protectEnglish: true,
    codeSwitching: false,
    showDiagnostics: false,
    reviewCuts: false,
    analyzeVideo: false,
    // 'error' preserves the pre-existing strict behaviour: asking for Roman and
    // getting native back must be something you opted into.
    romanFallback: 'error',
    prosody: false,
    toneScope: 'cue',
    motion: 'none',
    animationTemplate: 'auto',
    allowStale: false,
    dryRun: false,
    verbose: false,
    json: false,
    yes: false,
  };
  let formatExplicit = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case '-o': case '--output': o.output = needValue(a, next); i++; break;
      case '-l': case '--language': o.language = needValue(a, next); i++; break;
      case '-p': case '--provider': o.provider = needValue(a, next); i++; break;
      case '-f': case '--format': {
        const v = needValue(a, next) as OutputFormat;
        if (!FORMATS.includes(v)) {
          throw new CaptionEngineError(
            `Unknown --format "${v}".`, `Valid: ${FORMATS.join(', ')}`,
          );
        }
        o.format = v; formatExplicit = true; i++; break;
      }
      case '--style': o.style = needValue(a, next); i++; break;
      case '--aspect': {
        const v = needValue(a, next) as AspectPreset;
        if (!ASPECTS.includes(v)) {
          throw new CaptionEngineError(`Unknown --aspect "${v}".`, `Valid: ${ASPECTS.join(', ')}`);
        }
        o.aspect = v; i++; break;
      }
      case '--highlight': {
        const v = needValue(a, next);
        if (v !== 'active-word' && v !== 'none') {
          throw new CaptionEngineError(
            `Unknown --highlight "${v}".`, 'Valid: active-word, none',
          );
        }
        o.highlight = v; i++; break;
      }
      case '--script': {
        const v = needValue(a, next);
        if (v !== 'native' && v !== 'roman') {
          throw new CaptionEngineError(`Unknown --script "${v}".`, 'Valid: native, roman');
        }
        o.script = v; i++; break;
      }
      case '--active-scale': o.activeScale = num(a, next, 1, 2); i++; break;
      case '--active-color': {
        const value = needValue(a, next);
        if (!/^#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) {
          throw new CaptionEngineError('--active-color must be a 3- or 6-digit hex colour.');
        }
        o.activeColor = value.startsWith('#') ? value : `#${value}`; i++; break;
      }
      case '--active-bold': o.activeBold = true; break;
      case '--font': o.font = needValue(a, next); i++; break;
      case '--font-size': o.fontSize = num(a, next, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX); i++; break;
      case '--position-y': o.positionY = num(a, next, 0, 1); i++; break;
      case '--max-words': o.maxWordsPerCue = num(a, next, 1, 20); i++; break;
      case '--crop-focus': o.cropFocusX = num(a, next, 0, 1); i++; break;
      case '--fps': o.fps = num(a, next, 1, 240); i++; break;
      case '--crf': o.crf = num(a, next, 0, 51); i++; break;
      case '--preset': o.preset = needValue(a, next); i++; break;
      case '--auto-trim': o.autoTrim = true; break;
      case '--trim-silence': o.trimSilence = num(a, next, 0.05, 30); i++; break;
      case '--keep-fillers': o.keepFillers = true; break;
      case '--min-cut-confidence': o.minCutConfidence = num(a, next, 0, 1); i++; break;
      case '--analyze-filler-candidates':
      case '--analyse-filler-candidates': o.analyzeFillerCandidates = true; break;
      case '--no-audio-analysis': o.noAudioAnalysis = true; break;
      case '--min-filler-duration': o.minFillerDuration = num(a, next, 0, 5); i++; break;
      case '--max-filler-duration': o.maxFillerDuration = num(a, next, 0.05, 30); i++; break;
      case '--filler-confidence': o.fillerConfidence = num(a, next, 0, 1); i++; break;
      case '--cut-handles': o.cutHandles = num(a, next, 0, 1); i++; break;
      case '--cut-fade': o.cutFade = num(a, next, 0, 0.5); i++; break;
      case '--clips': o.clips = true; break;
      case '--transcript': // alias, natural with the `render` verb
      case '--transcript-in': o.transcriptIn = needValue(a, next); i++; break;
      case '--rasteriser': case '--rasterizer': o.rasteriser = needValue(a, next); i++; break;
      case '--transliterate': case '--transliterator':
        o.transliterate = needValue(a, next); i++; break;
      case '--hinglish-glossary': case '--glossary':
        o.glossary = needValue(a, next); i++; break;
      case '--protect-english': o.protectEnglish = true; break;
      case '--no-protect-english': o.protectEnglish = false; break;
      case '--diagnostics': o.showDiagnostics = true; break;
      case '--prosody': o.prosody = true; break;
      case '--tone-style': {
        // Alias for --prosody, phrased in terms of what it DOES rather than
        // what it measures. 'none' is the explicit off switch.
        const v = (next ?? '').toLowerCase();
        if (v !== 'auto' && v !== 'none') {
          throw new CaptionEngineError(
            `--tone-style must be auto or none (got "${next ?? ''}").`,
            'auto  analyse local audio prosody and style words by tone\n' +
              'none  disable tone styling (the default)',
          );
        }
        o.prosody = v === 'auto';
        i++;
        break;
      }
      case '--tone-scope': {
        const v = (next ?? '').toLowerCase();
        if (v !== 'cue' && v !== 'word') {
          throw new CaptionEngineError(
            `--tone-scope must be cue or word (got "${next ?? ''}").`,
            'cue   one tone per caption line (default, steadier on screen)\n' +
              'word  a tone per word (more responsive, visibly twitchier)',
          );
        }
        o.toneScope = v;
        i++;
        break;
      }
      case '--caption-theme': o.captionTheme = needValue(a, next); i++; break;
      case '--motion': {
        const v = needValue(a, next).toLowerCase();
        assertValidMotionLevel(v);
        o.motion = v; i++; break;
      }
      case '--motion-intensity': o.motionIntensity = num(a, next, 0, 1); i++; break;
      case '--animation-template': case '--animation-preset': {
        const v = needValue(a, next);
        assertValidAnimationTemplateName(v);
        o.animationTemplate = v; i++; break;
      }
      case '--code-switching': case '--code-switch': o.codeSwitching = true; break;
      case '--keyterms':
        o.keyterms = needValue(a, next).split(',').map((x) => x.trim()).filter(Boolean);
        i++; break;
      case '--keyterms-file': o.keytermsFile = needValue(a, next); i++; break;
      case '--review-cuts': o.reviewCuts = true; o.autoTrim = true; break;
      case '--analyze-video':
      case '--analyse-video': o.analyzeVideo = true; o.autoTrim = true; break;
      case '--vision-provider': {
        const v = (next ?? '').toLowerCase();
        if (v !== 'anthropic' && v !== 'gemini') {
          throw new CaptionEngineError(
            `--vision-provider must be anthropic or gemini (got "${next ?? ''}").`,
            'anthropic  needs ANTHROPIC_API_KEY\n' +
              'gemini     needs GEMINI_API_KEY (free tier via Google AI Studio)',
          );
        }
        o.visionProvider = v;
        i++;
        break;
      }
      case '--transcript-out': o.transcriptOut = needValue(a, next); i++; break;
      case '--cuts-in': o.cutsIn = needValue(a, next); i++; break;
      case '--cuts-out': o.cutsOut = needValue(a, next); i++; break;
      case '--work-dir': o.workDir = needValue(a, next); i++; break;
      case '--roman-fallback': {
        const v = (next ?? '').toLowerCase();
        if (!['error', 'native', 'http'].includes(v)) {
          throw new CaptionEngineError(
            `--roman-fallback must be error, native or http (got "${next ?? ''}").`,
            'error   refuse if Roman output is unavailable (default)\n' +
              'native  keep the original script and continue, reported not silent\n' +
              'http    use TRANSLITERATE_URL instead',
          );
        }
        o.romanFallback = v as 'error' | 'native' | 'http';
        i++;
        break;
      }
      case '--allow-stale': o.allowStale = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--json': o.json = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '-y': case '--yes': o.yes = true; break;
      default:
        if (a.startsWith('-')) {
          throw new CaptionEngineError(
            `Unknown option "${a}".`, 'Run with --help to see available options.',
          );
        }
        if (input) {
          throw new CaptionEngineError(
            `Multiple inputs given ("${input}" and "${a}").`,
            'Provide one input file. Quote paths containing spaces.',
          );
        }
        input = a;
    }
  }

  if (!input) {
    throw new CaptionEngineError('No input file given.', 'Usage: caption-engine <input> [options]');
  }

  if (renderMode) {
    if (!o.transcriptIn) {
      throw new CaptionEngineError(
        '`render` requires --transcript <file>.',
        'This subcommand exists to render WITHOUT calling (and paying for) an ASR API.\n' +
          'Produce a transcript once:\n' +
          '  caption-engine input.mp4 --transcript-out transcript.json --format json -o t.json\n' +
          'Then render as often as you like:\n' +
          '  caption-engine render input.mp4 --transcript transcript.json -o out.mp4',
      );
    }
    if (o.provider) {
      throw new CaptionEngineError(
        '`render` does not accept --provider: it never contacts an ASR provider.',
        'Drop --provider, or use the normal form if you want to transcribe.',
      );
    }
    o.noAsr = true;
  }

  // Infer format from the output extension unless it was set explicitly, so
  // `-o captions.srt` does the obvious thing.
  if (!formatExplicit && o.output) {
    const ext = o.output.slice(o.output.lastIndexOf('.') + 1).toLowerCase();
    if (ext === 'srt' || ext === 'ass' || ext === 'json' || ext === 'mp4') {
      o.format = ext as OutputFormat;
    }
  }

  return { command: 'run', options: { ...(o as CliOptions), input } };
}
