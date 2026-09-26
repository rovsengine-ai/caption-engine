# caption-engine — Hugging Face Spaces (Docker SDK)
# App listens on port 7860 as required by Spaces.

FROM node:20-bookworm

# System deps: ffmpeg package provides both ffmpeg and ffprobe binaries.
# Noto/FreeFont cover Indic + Latin fallback glyphs for system FONT_DIR.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-freefont-ttf \
    fonts-noto-core \
    fonts-noto-ui-core \
    ca-certificates \
    python3 \
    make \
    g++ \
  && ffmpeg -version \
  && ffprobe -version \
  && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces runs as uid 1000.
RUN useradd -m -u 1000 user \
  && mkdir -p /home/user/app /tmp \
  && chown -R user:user /home/user /tmp

WORKDIR /home/user/app

# Install dependencies first for better layer caching.
COPY --chown=user:user package.json package-lock.json ./
USER user
RUN npm ci

# Application source (including vendored assets/fonts when present).
COPY --chown=user:user . .

# Ensure Noto families used by HarfBuzz shaping are present.
RUN npm run fonts:install || true

# Compile TypeScript → dist/
RUN npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=7860
ENV HOST=0.0.0.0
# Sarvam first, ElevenLabs Scribe on failure / missing word timings.
ENV ASR_PROVIDER=sarvam_fallback_elevenlabs
# Extra font dirs on top of assets/fonts/ (system Noto as fallback).
ENV FONT_DIR=/usr/share/fonts
ENV MAX_UPLOAD_BYTES=524288000

EXPOSE 7860

# Ensure /tmp is writable for uploads and render scratch.
USER root
RUN chmod 1777 /tmp && chown -R user:user /home/user/app
USER user

CMD ["node", "dist/src/server.js"]
