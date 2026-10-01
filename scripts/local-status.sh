#!/usr/bin/env bash
# Report whether the local Whisper server and Ollama are reachable.
# Exit 0 when both answer, 1 otherwise. Never changes configuration.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

ENDPOINT="${LOCAL_WHISPER_ENDPOINT:-http://127.0.0.1:8080}"
ENDPOINT="${ENDPOINT%/}"
LLM_ORIGIN="${LOCAL_LLM_ENDPOINT:-http://127.0.0.1:11434/api/generate}"
MODEL="${LOCAL_LLM_MODEL:-gemma3:4b}"
llm_origin="http://127.0.0.1:11434"
if [[ "$LLM_ORIGIN" =~ ^(https?://[^/]+) ]]; then
  llm_origin="${BASH_REMATCH[1]}"
fi

fail=0

if curl -sf --max-time 2 "${ENDPOINT}/" >/dev/null 2>&1; then
  echo "ok    whisper  $ENDPOINT"
else
  echo "miss  whisper  $ENDPOINT"
  fail=1
fi

if tags="$(curl -sf --max-time 2 "${llm_origin}/api/tags" 2>/dev/null)"; then
  if printf '%s' "$tags" | grep -q "$MODEL"; then
    echo "ok    ollama   $llm_origin  model $MODEL"
  else
    echo "miss  ollama   $llm_origin is up but $MODEL is not in the model list"
    fail=1
  fi
else
  echo "miss  ollama   $llm_origin"
  fail=1
fi

if [[ -n "${WHISPER_MODEL_PATH:-}" ]]; then
  if [[ -f "$WHISPER_MODEL_PATH" ]]; then
    echo "ok    model    $WHISPER_MODEL_PATH"
  else
    echo "miss  model    $WHISPER_MODEL_PATH"
    fail=1
  fi
fi

exit "$fail"
