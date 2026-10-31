"""Offline speech-to-text trial. No app, CLI, or MCP commands are added."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import time
from dataclasses import asdict
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps

parser = argparse.ArgumentParser()
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--root', type=Path, default=Path('.local/transcript-practice'))
parser.add_argument('--regions-only', action='store_true')
args = parser.parse_args()
started = time.perf_counter()
model = WhisperModel(str(args.model.resolve()), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
load_seconds = time.perf_counter() - started
metadata = {
    'model': 'faster-whisper-small.en', 'modelRevision': args.model.name,
    'modelConfigSha256': hashlib.sha256((args.model / 'config.json').read_bytes()).hexdigest(),
    'packages': {name:importlib.metadata.version(name) for name in ['faster-whisper','ctranslate2','av']},
    'device':'cpu', 'computeType':'int8', 'threads':4, 'platform':platform.platform(),
    'loadSeconds':round(load_seconds,3),
    'language':'en', 'languageIsForced':True, 'beamSize':5, 'conditionOnPreviousText':False,
}
cases = [] if args.regions_only else [
    ('clean-segments','clean.wav',False,True),
    ('clean-words','clean.wav',True,True),
    ('noisy-words','noise-6db.wav',True,True),
    ('silence-vad','silence.wav',True,True),
    ('silence-no-vad','silence.wav',True,False),
    ('human-words','jfk.wav',True,True),
    ('edited-words','edited.wav',True,True),
]
summary = []
for name, file, words, vad in cases:
    print(f'Start {name}', flush=True)
    start = time.perf_counter()
    segments, info = model.transcribe(str(args.root / file), language='en', beam_size=5,
        word_timestamps=words, vad_filter=vad, condition_on_previous_text=False,
        vad_parameters={'min_silence_duration_ms':500} if vad else None)
    segments = [asdict(segment) for segment in segments]
    elapsed = time.perf_counter() - start
    result = {
        **metadata, 'case':name, 'input':file,
        'inputSha256':hashlib.sha256((args.root/file).read_bytes()).hexdigest(),
        'duration':info.duration,'speechDurationAfterVad':info.duration_after_vad,
        'wordTimestamps':words,'vad':vad,'elapsedSeconds':round(elapsed,3),
        'realTimeFactor':round(elapsed/info.duration,3),
        'text':' '.join(s['text'].strip() for s in segments),'segments':segments,
    }
    (args.root/f'{name}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    brief = {key:result[key] for key in ['case','duration','elapsedSeconds','realTimeFactor','text']}
    summary.append(brief)
    print(json.dumps(brief), flush=True)
if args.regions_only:
    for name, file in [('clean-regions','clean.wav'),('noisy-regions','noise-6db.wav'),('edited-regions','edited.wav'),('silence-regions','silence.wav')]:
        print(f'Start {name}', flush=True)
        start = time.perf_counter()
        audio = decode_audio(str(args.root/file), sampling_rate=16000)
        options = VadOptions(min_silence_duration_ms=500, speech_pad_ms=200, max_speech_duration_s=20)
        regions = get_speech_timestamps(audio, options)
        all_segments = []
        for region in regions:
            offset = region['start']/16000
            segments, _ = model.transcribe(audio[region['start']:region['end']], language='en', beam_size=5, word_timestamps=True, vad_filter=False, condition_on_previous_text=False)
            for segment in segments:
                value = asdict(segment)
                value['start'] += offset
                value['end'] += offset
                for word in value['words']:
                    word['start'] += offset
                    word['end'] += offset
                all_segments.append(value)
        elapsed = time.perf_counter()-start
        result = {**metadata, 'case':name, 'input':file, 'inputSha256':hashlib.sha256((args.root/file).read_bytes()).hexdigest(),
            'duration':len(audio)/16000,'vad':True,'wordTimestamps':True,
            'speechRegions':[{'start':r['start']/16000,'end':r['end']/16000} for r in regions],
            'vadOptions':asdict(options),'elapsedSeconds':round(elapsed,3),'realTimeFactor':round(elapsed/(len(audio)/16000),3),
            'text':' '.join(s['text'].strip() for s in all_segments),'segments':all_segments}
        (args.root/f'{name}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        brief={key:result[key] for key in ['case','duration','elapsedSeconds','realTimeFactor','text']}
        summary.append(brief)
        print(json.dumps(brief),flush=True)
summary_file = 'region-summary.json' if args.regions_only else 'run-summary.json'
(args.root/summary_file).write_text(json.dumps({'settings':metadata,'cases':summary},indent=2),encoding='utf-8')
