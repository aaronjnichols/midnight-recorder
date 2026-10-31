"""Copy small, non-media results into the research record."""
import json
from pathlib import Path

root=Path('.local/transcript-practice')
read=lambda name:json.loads((root/name).read_text(encoding='utf-8'))
baseline=read('run-summary.json')
regional=read('region-summary.json')
measurements=read('measurements.json')
context=read('context-regions-report.json')
glossary=read('glossary.json')
evidence={
    'scope':'Research only. No speech commands were added to the app, CLI, or MCP.',
    'baseline':baseline,'regional':regional,'measurements':measurements,
    'context':{
        'method':context['transcriptVariant'],
        'sourceDuration':context['sourceDuration'],'editedDuration':context['editedDuration'],
        'sourceSegments':json.loads(context['revision'])['segments'],
        'speed':json.loads(context['revision'])['speed'],
        'hits':context['hits'],'directEditedHits':context['directHits'],
        'frameTimes':[{key:f[key] for key in ['requestedSeconds','seconds','sourceSeconds','width','height']} for f in context['frames']['frames']],
        'partialWords':context['partialWords'],'noAudioStatus':context['noAudioStatus'],
        'payloadBytes':context['payloadBytes'],
    },
    'glossary':glossary,
    'inputHashes':{name:read(f'{name}.json')['inputSha256'] for name in ['clean-words','noisy-words','silence-vad','human-words','edited-words']},
    'humanSampleSource':'https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav',
    'review':'Independent GPT-6.1-SOL high review: no findings. Four deterministic context checks passed. The reviewer inspected both pairs of frame images.',
}
# The human clip was an execution check, not a scored recognition test.
for case in evidence['baseline']['cases']:
    if case['case']=='human-words':
        case.pop('text')
        case['limit']='No independent transcript or timing score was measured.'
Path('experiments/timed-transcript/evidence.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
