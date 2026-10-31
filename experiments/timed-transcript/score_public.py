"""Compare local ASR output with the publisher's caption file."""
import argparse
import hashlib
import json
import re
import statistics
from pathlib import Path


def tokens(text):
    return re.findall(r'[a-z0-9]+', text.lower().replace("'", '').replace('’', ''))


def parse_captions(text):
    def seconds(value):
        h,m,s=value.strip().replace(',','.').split(':')
        return int(h)*3600+int(m)*60+float(s)
    cues=[]
    for block in re.split(r'\n\s*\n', text):
        lines=block.strip().splitlines()
        index=next((i for i,line in enumerate(lines) if '-->' in line),None)
        if index is None: continue
        start,end=lines[index].split(' --> ')
        words=tokens(re.sub(r'\[[^\]]*\]|\([^)]*\)|<[^>]*>', '', ' '.join(lines[index+1:])))
        if words: cues.append({'start':seconds(start),'end':seconds(end),'words':words})
    return cues


def align(reference, hypothesis):
    # Unit-cost word Levenshtein distance with exact-token alignment.
    matrix=[list(range(len(hypothesis)+1))]
    for i,left in enumerate(reference,1):
        row=[i]
        for j,right in enumerate(hypothesis,1):
            row.append(min(row[-1]+1,matrix[-1][j]+1,matrix[-1][j-1]+(left!=right)))
        matrix.append(row)
    i,j=len(reference),len(hypothesis); matched=[]
    while i or j:
        if i and j and matrix[i][j]==matrix[i-1][j-1]+(reference[i-1]!=hypothesis[j-1]):
            if reference[i-1]==hypothesis[j-1]: matched.append((i-1,j-1))
            i-=1;j-=1
        elif i and matrix[i][j]==matrix[i-1][j]+1: i-=1
        else: j-=1
    return matrix[-1][-1], list(reversed(matched))


def score(caption_file, result_file):
    cues=parse_captions(caption_file.read_text(encoding='utf-8-sig'))
    reference=[(word,cue) for cue in cues for word in cue['words']]
    result=json.loads(result_file.read_text(encoding='utf-8'))
    hypothesis=[(token,word) for word in result['words'] for token in tokens(word['word'])]
    errors,matched=align([w for w,c in reference],[w for w,c in hypothesis])
    distances=[];cue_starts={}
    for ri,hi in matched:
        cue,word=reference[ri][1],hypothesis[hi][1]
        # Captions give broad intervals, not exact word boundaries.
        distances.append(max(0,cue['start']-word['start'],word['end']-cue['end']))
        if ri==0 or reference[ri-1][1] is not cue:
            cue_starts[cue['start']]=abs(word['start']-cue['start'])
    def summary(values):
        if not values: return {'count':0,'median':None,'p95':None,'max':None}
        ordered=sorted(values)
        return {'count':len(values),'median':statistics.median(values),'p95':ordered[int(.95*(len(ordered)-1))],'max':max(values)}
    return {'referenceWords':len(reference),'recognizedWords':len(hypothesis),'wordEdits':errors,
      'wordErrorRate':errors/len(reference),'matchedWords':len(matched),
      'wordOutsideCaptionSeconds':summary(distances),'firstWordVsCaptionStartSeconds':summary(list(cue_starts.values())),
      'captionSha256':hashlib.sha256(caption_file.read_bytes()).hexdigest(),
      'resultSha256':hashlib.sha256(result_file.read_bytes()).hexdigest(),
      'timingLimit':'Publisher captions are approximate intervals, not measured word boundaries.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('captions',type=Path);parser.add_argument('result',type=Path);parser.add_argument('--output',type=Path)
    args=parser.parse_args();text=json.dumps(score(args.captions,args.result),indent=2)
    if args.output: args.output.write_text(text,encoding='utf-8')
    print(text)
