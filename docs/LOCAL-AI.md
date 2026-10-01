<!--
Approach decision.

ASR is Approach B: whisper.cpp with Metal, not Sarvam's open-source Shuka
(Approach A) and not a fine-tune (Approach C).

Shuka is an audio language model. It does not return per-word start and end
times. caption-engine rejects that output in assertWordTimings() — the same
reason the Sarvam cloud adapter cannot drive karaoke captions on its own.

Fine-tuning a local model on Sarvam labels needs a cloud data pipeline and
does not transcribe anything today.

Whisper Large-v3-Turbo does return cross-attention word times, runs on Apple
Silicon through whisper.cpp, and covers the Indic languages this project
renders. Its romanisation is not natural Hinglish, so transliteration is a
separate local step: Ollama (gemma3:4b by default) with the built-in
Devanagari and Kannada rule engines as fallback. Cloud providers are unchanged.
The code default remains sarvam_fallback_elevenlabs.
-->

# Local AI (zero cloud)

Run speech-to-text and Indic romanisation on this machine. No Sarvam, ElevenLabs, or Deepgram call is made when you pass `--provider local` and `--transliterate local-llm`.

Cloud providers keep working. Local mode is opt-in.

## Hardware

| | |
|---|---|
| Recommended | Apple Silicon. An M3 Ultra with 96 GB unified memory is comfortable for Whisper Large-v3-Turbo and a 4B LLM at the same time. |
| Minimum | Apple Silicon with 16 GB. Prefer a smaller Whisper model if memory pressure shows up. |
| Other machines | The same HTTP adapters work against a whisper.cpp server and Ollama on Linux, without Metal. |

FFmpeg must already be installed. Caption rendering, Auto Trim, and prosody already run locally and are not replaced by this stack.

## Why these models

**Whisper Large-v3-Turbo** (`ggml-large-v3-turbo.bin`) is the speed/quality balance for word-timed captions. whisper.cpp runs it with Metal on Apple Silicon. Word times come from the model alignment, so `hasWordTimings` is true and karaoke captions can use them.

**gemma3:4b** through Ollama is only the romaniser. It is small, it needs no API key, and the prompt asks for typed Hinglish (`बहुत` → `bahut`, `आज` → `aaj`) rather than scholarly transliteration. If Ollama is down, Hindi, Marathi, Nepali, and Kannada fall back to the built-in rule engines. Tamil, Telugu, and the other scripts that have no rule engine fail with an error instead of returning a different number of words.

Shuka v1 was not used. It does not produce the word timestamps this pipeline requires.

## Setup

```bash
npm run local:setup
```

That script:

1. Checks for Apple Silicon.
2. Installs `whisper-cpp` and `ollama` with Homebrew when they are missing.
3. Downloads `ggml-large-v3-turbo.bin` to `~/.cache/caption-engine/whisper/`.
4. Pulls `gemma3:4b`.
5. Writes `.env.local` (gitignored):

```
LOCAL_WHISPER_ENDPOINT=http://127.0.0.1:8080
WHISPER_MODEL_PATH=~/.cache/caption-engine/whisper/ggml-large-v3-turbo.bin
LOCAL_LLM_ENDPOINT=http://127.0.0.1:11434/api/generate
LOCAL_LLM_MODEL=gemma3:4b
ASR_PROVIDER=local
```

`ASR_PROVIDER=local` in `.env.local` opts this checkout into local ASR after setup. The code default is still `sarvam_fallback_elevenlabs`. A variable you export in the shell wins over the file. Delete the `ASR_PROVIDER` line to keep using the cloud chain by default.

If Homebrew is not how you install whisper.cpp, build it with Metal and leave `whisper-server` on `PATH`:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp && make -j WHISPER_METAL=1
```

## Start

```bash
npm run local:start
npm run local:status
npm run doctor
```

`local:start` runs `whisper-server` on port 8080 and `ollama serve` if they are not already up. Logs go to `~/.cache/caption-engine/run/`.

`doctor` reports local Whisper and local LLM as optional. Reachable is ok. Missing is a warning, not a blocking failure, so a machine that only has cloud keys still passes.

## Use

```bash
node dist/src/cli.js my-video.mp4 \
  --provider local \
  --script roman \
  --transliterate local-llm \
  --auto-trim \
  --output outputs/my-video-local.mp4
```

| Flag | Meaning |
|---|---|
| `--provider local` | whisper.cpp only. No API key. |
| `--provider local_fallback_elevenlabs` | Local Whisper first, ElevenLabs Scribe if the local server fails. Needs `ELEVENLABS_API_KEY` for the second step. |
| `--transliterate local-llm` | Ollama romanisation. |
| `--language` | Passed to Whisper unless `--code-switching` is also set. Forcing a language on mixed speech makes Whisper write English in the Indic script. |
| `--code-switching` | Leaves language detection on and prompts Whisper to keep English words in Latin script. |
| `--keyterms` | Added to that prompt. Whisper has no separate keyterm API. |

The web UI lists the same two provider values. The recommended default in the dropdown stays Sarvam + ElevenLabs.

## Environment

| Variable | Default | Role |
|---|---|---|
| `LOCAL_WHISPER_ENDPOINT` | `http://127.0.0.1:8080` | whisper.cpp server. The adapter posts to `/inference`, then `/v1/audio/transcriptions`. |
| `WHISPER_MODEL_PATH` | unset | ggml file. Used when the server is down: the adapter spawns `whisper-cli`. |
| `WHISPER_BIN` | `whisper-cli` | Binary name for that fallback. |
| `WHISPER_MODEL` | `large-v3-turbo` | Label stored on the transcript. |
| `LOCAL_LLM_ENDPOINT` | `http://127.0.0.1:11434/api/generate` | Ollama generate URL, or any OpenAI-compatible chat URL (`/v1/chat/completions`). A bare origin is treated as Ollama. |
| `LOCAL_LLM_MODEL` | `gemma3:4b` | Model name sent with the prompt. |

## Performance

Large-v3-Turbo on whisper.cpp is faster than realtime on Apple Silicon. On an M3 Ultra, a one-minute clip often finishes in a few seconds. That depends on the model, whether Metal is actually in the binary, and the audio. Measure a real file with `npm run local:status` and a short transcribe before planning a batch.

Romanisation is a short text prompt per dozen words. It is not the slow part.

Audio hour cost for the local provider is $0. You still pay electricity and disk for the model files (the turbo ggml file is about 1.6 GB; gemma3:4b is a few GB more).

## Cloud vs local

| | Cloud (Sarvam → ElevenLabs) | Local (Whisper + Ollama) |
|---|---|---|
| Word timestamps | ElevenLabs yes. Sarvam's REST API no, so the chain falls forward. | Yes, from Whisper alignment. |
| Indic / Hinglish quality | Sarvam is built for this. Scribe keeps a lot of English in Latin script. | Whisper is strong and general. Roman Hinglish depends on the LLM prompt plus the rule fallback, and it will miss more loanword spellings than Sarvam. |
| Speed | Network round trip plus vendor queue. | On an M3 Ultra, often a few seconds per minute of audio once the models are loaded. |
| Cost | Sarvam and ElevenLabs per audio hour. | $0 of API spend. |
| Privacy | Audio leaves the machine. | Audio and text stay on the machine while these two flags are set. |
| Offline | No. | Yes, after the models are downloaded. |

## Troubleshooting

**`Local Whisper failed` / connection refused.** `npm run local:start`, then `npm run local:status`. If the server log says the model is missing, re-run `npm run local:setup`.

**Server is up but captions have no word times.** The adapter asks for `verbose_json` and `word_timestamps=true`. An old `whisper-server` that only returns a sentence is rejected on purpose. Update whisper.cpp, or set `WHISPER_MODEL_PATH` so the CLI fallback can write JSON with token offsets.

**`ollama pull` failed.** Start the Ollama app or `ollama serve`, then `ollama pull gemma3:4b`.

**Roman output is still in Devanagari or Tamil.** For Hindi and Kannada the rule engine should have caught a dead LLM. For Tamil, Telugu, Malayalam, Bengali, Gujarati, Punjabi, Odia, and Assamese there is no rule engine — the LLM has to be up. `npm run doctor` shows whether the model is pulled.

**English words were transliterated.** Pass `--code-switching` at transcribe time, and keep `--protect-english` on (it is the default) at romanise time. Latin tokens are not sent to the LLM.

**Setup changed my default provider.** `.env.local` sets `ASR_PROVIDER=local`. Remove that line, or export `ASR_PROVIDER=sarvam_fallback_elevenlabs` in the shell.

**Port 8080 is taken.** Edit `LOCAL_WHISPER_ENDPOINT` and start `whisper-server` with the same `--port`.
