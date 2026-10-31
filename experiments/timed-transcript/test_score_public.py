import unittest
from score_public import align, parse_captions, tokens, score
import tempfile
import json
from pathlib import Path

class ScoreTests(unittest.TestCase):
    def test_missing_matches_keep_word_error_score(self):
        Path('.local').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir='.local') as folder:
            captions=Path(folder)/'ref.srt';result=Path(folder)/'result.json'
            captions.write_text('1\n00:00:01,000 --> 00:00:03,000\nhello world')
            for words in [[],[{'word':'wrong','start':1,'end':2}],[{'word':'goodbye','start':1,'end':2},{'word':'world','start':2,'end':3}]]:
                result.write_text(json.dumps({'words':words}))
                scored=score(captions,result)
                self.assertGreater(scored['wordErrorRate'],0)
                self.assertEqual(scored['firstWordVsCaptionStartSeconds'],{'count':0,'median':None,'p95':None,'max':None})
    def test_edit_distance_and_matches(self):
        self.assertEqual(align(['one','two','three'],['one','four','three','five'])[0],2)
        self.assertEqual(align(['one','two'],['one'])[0],1)
        self.assertEqual(align(['one'],['one'])[1],[(0,0)])
    def test_non_speech_labels_are_removed(self):
        cues=parse_captions('1\n00:00:01,000 --> 00:00:03,000\n[ECHO] Hello (WHISPERING) there.\n\n2\n00:00:03,000 --> 00:00:04,000\n[MUSIC]')
        self.assertEqual(cues,[{'start':1.0,'end':3.0,'words':['hello','there']}])
        self.assertEqual(tokens("Don't left-click!"),['dont','left','click'])

if __name__=='__main__': unittest.main()
