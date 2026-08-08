/**
 * Typed errors with actionable messages.
 *
 * Every error here should tell the user what to DO, not just what went wrong.
 * `hint` is printed by the CLI as a "try this" line.
 */

export class CaptionEngineError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingApiKeyError extends CaptionEngineError {
  constructor(readonly provider: string, envVar: string) {
    super(
      `No API key for ASR provider "${provider}".`,
      `Set ${envVar} in your environment or .env file:\n` +
        `  export ${envVar}="your-key-here"\n` +
        `Or choose a different provider with --provider <name>.`,
    );
  }
}

export class UnsupportedFormatError extends CaptionEngineError {
  constructor(readonly path: string, readonly detected: string, supported: string[]) {
    super(
      `Unsupported input format for "${path}" (detected: ${detected}).`,
      `Supported: ${supported.join(', ')}.\n` +
        `Convert first, e.g.:  ffmpeg -i "${path}" output.mp4`,
    );
  }
}

export class MissingFontError extends CaptionEngineError {
  constructor(message: string, readonly script: string, readonly tried: string[]) {
    super(
      message,
      `Install the bundled Noto fonts:\n` +
        `  npm run fonts:install\n` +
        `On macOS you can also:  brew install --cask font-noto-sans font-noto-sans-devanagari`,
    );
  }
}

export class FfmpegError extends CaptionEngineError {
  constructor(message: string, readonly args: string[], readonly stderr: string) {
    super(message, `Full command:\n  ffmpeg ${args.map(quote).join(' ')}`);
  }
}

export class FfmpegMissingError extends CaptionEngineError {
  constructor(bin: string) {
    super(
      `"${bin}" not found on PATH.`,
      `Install FFmpeg:\n` +
        `  macOS:  brew install ffmpeg\n` +
        `  Ubuntu: sudo apt install ffmpeg\n` +
        `Then verify:  ffmpeg -version`,
    );
  }
}

export class FfmpegFeatureError extends CaptionEngineError {
  constructor(feature: string, why: string) {
    super(
      `FFmpeg is missing a required feature: ${feature}.`,
      `${why}\n` +
        `Check your build:  ffmpeg -version | tr ' ' '\\n' | grep enable-\n` +
        `macOS:  brew reinstall ffmpeg`,
    );
  }
}

export class InvalidTranscriptError extends CaptionEngineError {
  constructor(message: string, hint?: string) {
    super(message, hint);
  }
}

export class NoWordTimingsError extends CaptionEngineError {
  constructor(provider: string, extra = '') {
    super(
      `Provider "${provider}" did not return real per-word timestamps. ` +
        `Word-timed captions and Auto Trim require them. ${extra}`.trim(),
      `Use a provider that supports word timings:\n` +
        `  --provider elevenlabs   (Scribe v2, word + character timestamps)\n` +
        `  --provider deepgram     (Nova-3)\n` +
        `Sarvam's REST API returns sentence-level timestamps only and cannot back word-timed captions.`,
    );
  }
}

export class ShapingError extends CaptionEngineError {}

function quote(s: string): string {
  return /[\s'"$`\\|&;<>()*?[\]{}]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
