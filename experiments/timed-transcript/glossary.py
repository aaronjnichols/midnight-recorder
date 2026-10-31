"""Test a vocabulary hint on the technical phrase. Keep the baseline results."""
import argparse
import json
import os
import time
from dataclasses import asdict
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

parser=argparse.ArgumentParser()
parser.add_argument('--model', required=True)
args=parser.parse_args()
root=Path('.local/transcript-practice')
region=json.loads((root/'clean-regions.json').read_text())['speechRegions'][-1]
audio=decode_audio(str(root/'clean.wav'))
model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=4,local_files_only=True)
start=time.perf_counter()
segments,_=model.transcribe(audio[round(region['start']*16000):round(region['end']*16000)],language='en',beam_size=5,
    vad_filter=False,word_timestamps=True,condition_on_previous_text=False,hotwords="Manning's n")
segments=[asdict(s) for s in segments]
result={'hotwords':"Manning's n",'sourceOffset':region['start'],'elapsedSeconds':time.perf_counter()-start,
    'text':' '.join(s['text'].strip() for s in segments),'segments':segments,
    'limit':'The vocabulary hint uses the known test term. This is not an independent accuracy test. Segment and word times are relative to sourceOffset.'}
(root/'glossary.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='segments'}))
