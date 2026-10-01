#!/usr/bin/env bash
# Approach decision: local ASR is whisper.cpp (Approach B), not Shuka.
# Shuka does not return word timestamps, which this project rejects.
# Fine-tuning on Sarvam labels does not produce a transcriber today.
# Romanisation is a separate local LLM (Ollama, gemma3:4b) because Whisper's
# own spelling is not natural Hinglish. Cloud providers stay installed.

# One-time local AI setup for caption-engine.
# Safe to re-run. Prints what is ready and what is not. Does not remove
# cloud API keys and does not change the code default provider.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="${WHISPER_MODEL_DIR:-"$HOME/.cache/caption-engine/whisper"}"
MODEL_FILE="$MODEL_DIR/ggml-large-v3-turbo.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
LLM_MODEL="${LOCAL_LLM_MODEL:-gemma3:4b}"
ENV_FILE="$ROOT/.env.local"

ready=()
missing=()

note_ok() { ready+=("$1"); printf '  ok    %s\n' "$1"; }
note_miss() { missing+=("$1"); printf '  miss  %s\n' "$1"; }

echo "caption-engine local AI setup"
echo "project: $ROOT"
echo

arch="$(uname -m)"
os="$(uname -s)"
if [[ "$os" == "Darwin" && "$arch" == "arm64" ]]; then
  note_ok "Apple Silicon ($arch) — Metal builds of whisper.cpp are the fast path"
else
  note_miss "Not Apple Silicon ($os $arch). Setup will continue; speed will be lower."
fi

if command -v brew >/dev/null 2>&1; then
  note_ok "Homebrew $(brew --version | head -n 1)"
else
  note_miss "Homebrew is not installed. Install it from https://brew.sh and re-run."
fi

install_brew_formula() {
  local formula="$1"
  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi
  if brew list --formula "$formula" >/dev/null 2>&1; then
    note_ok "$formula already installed"
    return 0
  fi
  echo "  installing $formula ..."
  if brew install "$formula"; then
    note_ok "installed $formula"
    return 0
  fi
  note_miss "brew install $formula failed"
  return 1
}

install_brew_formula whisper-cpp || true
install_brew_formula ollama || true

whisper_bin=""
for candidate in whisper-server whisper-cli whisper-cpp; do
  if command -v "$candidate" >/dev/null 2>&1; then
    whisper_bin="$candidate"
    break
  fi
done
if [[ -n "$whisper_bin" ]]; then
  note_ok "whisper binary: $whisper_bin ($(command -v "$whisper_bin"))"
else
  note_miss "whisper.cpp binary not on PATH. Try: brew install whisper-cpp"
  echo "         Or build from source with Metal:"
  echo "           git clone https://github.com/ggml-org/whisper.cpp"
  echo "           cd whisper.cpp && make -j WHISPER_METAL=1"
fi

mkdir -p "$MODEL_DIR"
if [[ -f "$MODEL_FILE" && -s "$MODEL_FILE" ]]; then
  note_ok "Whisper model $MODEL_FILE"
else
  echo "  downloading ggml-large-v3-turbo (about 1.6 GB) ..."
  if command -v curl >/dev/null 2>&1 && curl -L --fail --retry 3 -o "$MODEL_FILE.partial" "$MODEL_URL"; then
    mv "$MODEL_FILE.partial" "$MODEL_FILE"
    note_ok "downloaded $MODEL_FILE"
  else
    rm -f "$MODEL_FILE.partial"
    note_miss "could not download $MODEL_URL"
  fi
fi

if command -v ollama >/dev/null 2>&1; then
  note_ok "ollama $(command -v ollama)"
  if ! curl -sf --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "  starting ollama serve so the model can be pulled ..."
    nohup ollama serve >"$HOME/.cache/caption-engine/ollama.log" 2>&1 &
    sleep 2
  fi
  if ollama pull "$LLM_MODEL"; then
    note_ok "pulled $LLM_MODEL"
  else
    note_miss "ollama pull $LLM_MODEL failed. Start Ollama and re-run."
  fi
else
  note_miss "ollama not on PATH"
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
upsert_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" k "=" { print k "=" v; found = 1; next }
    { print }
    END { if (!found) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

upsert_env LOCAL_WHISPER_ENDPOINT "http://127.0.0.1:8080"
upsert_env WHISPER_MODEL_PATH "$MODEL_FILE"
upsert_env LOCAL_LLM_ENDPOINT "http://127.0.0.1:11434/api/generate"
upsert_env LOCAL_LLM_MODEL "$LLM_MODEL"
upsert_env ASR_PROVIDER "local"
note_ok "wrote $ENV_FILE (ASR_PROVIDER=local). Shell exports still win. Delete that line to keep the cloud default."

echo
echo "Ready (${#ready[@]}):"
if [[ ${#ready[@]} -gt 0 ]]; then
  for line in "${ready[@]}"; do echo "  - $line"; done
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Not ready (${#missing[@]}):"
  for line in "${missing[@]}"; do echo "  - $line"; done
  echo
  echo "Fix the items above, then: npm run local:start"
  exit 1
fi
echo
echo "Next: npm run local:start"
exit 0
