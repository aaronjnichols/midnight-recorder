"""Measure the trial against its known script and synthesis event times."""
import difflib
import json
import re
import statistics
from pathlib import Path

root = Path('.local/transcript-practice')
reference = json.loads((root/'reference.json').read_text(encoding='utf-8'))
ref = [w for cue in reference['cues'] for w in cue['words']]
normalize = lambda s: re.sub(r"[^a-z0-9']", '', s.lower())
reports = {}
for name in ['clean-words', 'noisy-words', 'clean-regions', 'noisy-regions']:
    if not (root/f'{name}.json').exists():
        continue
    result = json.loads((root/f'{name}.json').read_text())
    words = [w for segment in result['segments'] for w in segment['words']]
    matcher = difflib.SequenceMatcher(None,[normalize(w['text']) for w in ref],[normalize(w['word']) for w in words],autojunk=False)
    deltas = []
    outliers = []
    mismatches = []
    for tag, a, b, c, d in matcher.get_opcodes():
        if tag == 'equal':
            deltas.extend(abs(ref[a+i]['start']-words[c+i]['start']) for i in range(b-a))
            for i in range(b-a):
                error=abs(ref[a+i]['start']-words[c+i]['start'])
                if error > .25:
                    outliers.append({'reference':ref[a+i], 'recognized':words[c+i], 'errorSeconds':error})
        else:
            mismatches.append({'reference':[w['text'] for w in ref[a:b]],'recognized':words[c:d]})
    ordered=sorted(deltas)
    reports[name] = {
        'matchedWords':len(deltas),'referenceWords':len(ref),'recognizedWords':len(words),
        'medianStartErrorAgainstSapiSeconds':statistics.median(deltas),
        'maxStartErrorAgainstSapiSeconds':max(deltas),
        'p95StartErrorAgainstSapiSeconds':ordered[min(len(ordered)-1,round(.95*(len(ordered)-1)))],
        'mismatches':mismatches,
        'outliers':outliers,
    }
segment_result=json.loads((root/'clean-segments.json').read_text())
word_result=json.loads((root/'clean-words.json').read_text())
compact_segments=[{key:s[key] for key in ['start','end','text']} for s in segment_result['segments']]
compact_words=[{key:s[key] for key in ['start','end','text','words']} for s in word_result['segments']]
reports['payloadBytes']={'segments':len(json.dumps(compact_segments).encode()),'withWords':len(json.dumps(compact_words).encode())}
reports['timingLimit']=reference['timingReference']+' Timing metrics include exact matched tokens only, not all words.'
(root/'measurements.json').write_text(json.dumps(reports,indent=2))
print(json.dumps(reports,indent=2))
