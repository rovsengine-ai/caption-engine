#!/usr/bin/env bash
# Start the local ASR and transliteration servers in the background.
# whisper.cpp serves word-timed transcription. Ollama serves romanisation.
# Cloud providers are not stopped and not required.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${HOME}/.cache/caption-engine/run"
mkdir -p "$RUN_DIR" "${HOME}/.cache/caption-engine"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

ENDPOINT="${LOCAL_WHISPER_ENDPOINT:-http://127.0.0.1:8080}"
ENDPOINT="${ENDPOINT%/}"
PORT="${ENDPOINT##*:}"
PORT="${PORT%%/*}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  PORT=8080
fi
MODEL="${WHISPER_MODEL_PATH:-$HOME/.cache/caption-engine/whisper/ggml-large-v3-turbo.bin}"
LLM_ORIGIN="${LOCAL_LLM_ENDPOINT:-http://127.0.0.1:11434/api/generate}"

whisper_server_bin() {
  if [[ -n "${WHISPER_SERVER_BIN:-}" && -x "${WHISPER_SERVER_BIN}" ]]; then
    printf '%s\n' "$WHISPER_SERVER_BIN"
    return
  fi
  local candidate
  for candidate in whisper-server whisper-cpp; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
}

if curl -sf --max-time 2 "${ENDPOINT}/" >/dev/null 2>&1; then
  echo "ok    whisper server already reachable at $ENDPOINT"
else
  bin="$(whisper_server_bin || true)"
  if [[ -z "${bin:-}" ]]; then
    echo "miss  whisper-server not on PATH. Run: npm run local:setup"
  elif [[ ! -f "$MODEL" ]]; then
    echo "miss  Whisper model not found at $MODEL"
  else
    echo "      starting $bin on port $PORT"
    nohup "$bin" -m "$MODEL" --host 127.0.0.1 --port "$PORT" \
      >"$RUN_DIR/whisper-server.log" 2>&1 &
    echo $! > "$RUN_DIR/whisper-server.pid"
    up=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sf --max-time 2 "${ENDPOINT}/" >/dev/null 2>&1; then
        up=1
        break
      fi
      sleep 0.5
    done
    if [[ "$up" == 1 ]]; then
      echo "ok    whisper server at $ENDPOINT (log: $RUN_DIR/whisper-server.log)"
    else
      echo "miss  whisper server did not answer. See $RUN_DIR/whisper-server.log"
    fi
  fi
fi

llm_origin="http://127.0.0.1:11434"
if [[ "$LLM_ORIGIN" =~ ^(https?://[^/]+) ]]; then
  llm_origin="${BASH_REMATCH[1]}"
fi

if curl -sf --max-time 2 "${llm_origin}/api/tags" >/dev/null 2>&1; then
  echo "ok    Ollama already reachable at $llm_origin"
else
  if ! command -v ollama >/dev/null 2>&1; then
    echo "miss  ollama not on PATH. Run: npm run local:setup"
  else
    echo "      starting ollama serve"
    nohup ollama serve >"$RUN_DIR/ollama.log" 2>&1 &
    echo $! > "$RUN_DIR/ollama.pid"
    up=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sf --max-time 2 "${llm_origin}/api/tags" >/dev/null 2>&1; then
        up=1
        break
      fi
      sleep 0.5
    done
    if [[ "$up" == 1 ]]; then
      echo "ok    Ollama at $llm_origin (log: $RUN_DIR/ollama.log)"
    else
      echo "miss  Ollama did not answer. See $RUN_DIR/ollama.log"
    fi
  fi
fi

echo
echo "Transcribe with:"
echo "  node dist/src/cli.js video.mp4 --provider local --script roman --transliterate local-llm --auto-trim -o outputs/out.mp4"
