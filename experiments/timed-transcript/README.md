# Timed transcript trial

This is a research trial. It does not add speech commands to the app, CLI, or MCP. Read [the report](report.md) before using the results to design those commands.

## Requirements

The measured run used Windows, Python 3.13.5, Node 22, FFmpeg, Microsoft Zira Desktop, and the local Whisper `small.en` model. Python package versions are in `requirements.txt`. The model snapshot was `d1d751a5f8271d482d14ca55d9e2deeebbae577f` from `Systran/faster-whisper-small.en`. Model files and audio are not in Git.

All commands below run from the project root. Use a complete local model folder with `config.json`, `model.bin`, `tokenizer.json`, and `vocabulary.txt`. Transcription uses `local_files_only=True` and `HF_HUB_OFFLINE=1`. It does not upload audio.

```powershell
uv venv .local/stt-venv --python 3.13
uv pip install --python .local/stt-venv/Scripts/python.exe --cache-dir .local/uv-cache -r experiments/timed-transcript/requirements.txt
$speechModel = 'C:/PATH/TO/LOCAL/MODEL/SNAPSHOT'

powershell.exe -NoProfile -File experiments/timed-transcript/make-speech.ps1 -OutputDirectory .local/transcript-practice
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav' -OutFile .local/transcript-practice/jfk.wav
.local/stt-venv/Scripts/python.exe experiments/timed-transcript/prepare_audio.py
node experiments/timed-transcript/prepare_video.mjs

.local/stt-venv/Scripts/python.exe experiments/timed-transcript/transcribe.py --model $speechModel
.local/stt-venv/Scripts/python.exe experiments/timed-transcript/transcribe.py --model $speechModel --regions-only
.local/stt-venv/Scripts/python.exe experiments/timed-transcript/glossary.py --model $speechModel
.local/stt-venv/Scripts/python.exe experiments/timed-transcript/measure.py
node experiments/timed-transcript/inspect-context.mjs
node experiments/timed-transcript/inspect-context.mjs --regional
node --test experiments/timed-transcript/context.test.mjs
```

The scripts write fixtures and results under `.local/transcript-practice`. A repeat run replaces fixture WAV files, reports, and the generated source MP4. It adds a new import to the test library. It does not change the normal app library. The video scripts use the shared service for library edits, export, and frame inspection.

`make-speech.ps1` needs access to the Windows speech service. A restricted process can fail even when synthesis writes only to a file. The measured run used a normal local process. The newest audio decoder, PyAV 19.0.2, rejected an argument from faster-whisper 1.2.1. This trial therefore pins PyAV 16.1.0.

`save_evidence.py` writes a small research record to `evidence.json`. Run it only after checking the new results and updating its review statement. The current record describes the reviewed run. The public human sample URL can change; the current audio hashes are in that record.

## Files

- `reference.json` in the result folder records the known script and SAPI word-start events.
- `clean-words.json` and `clean-segments.json` contain the standard engine results.
- `clean-regions.json` contains recognition of each detected speech interval separately.
- `measurements.json` compares exact matching words with the synthesis events.
- `context-regions-report.json` contains phrase matches, mapped times, and frame paths.
- `glossary.json` records the known-term vocabulary test.

`context.mjs` is a small experiment for word mapping, time queries, and phrase search. It is not a validated public input interface. A production tool still needs input validation, result limits, cache ownership, revision checks, cancellation, and clear status values.
