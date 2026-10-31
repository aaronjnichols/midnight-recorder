"""Make controlled audio fixtures. This does not change the app."""
import json
import wave
from pathlib import Path
import numpy as np

root = Path('.local/transcript-practice')
reference = json.loads((root / 'reference.json').read_text(encoding='utf-8-sig'))
rate = 16000
clean = np.zeros(int(reference['duration'] * rate), dtype=np.float64)
for cue in reference['cues']:
    with wave.open(cue['file'], 'rb') as wav:
        assert wav.getframerate() == rate and wav.getnchannels() == 1 and wav.getsampwidth() == 2
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float64) / 32768
    start = round(cue['start'] * rate)
    assert start + len(data) <= len(clean)
    clean[start:start + len(data)] += data
    cue['audioEnd'] = cue['start'] + len(data) / rate

def write(name, data):
    with wave.open(str(root / name), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes((np.clip(data, -1, 1) * 32767).astype('<i2').tobytes())

write('clean.wav', clean)
write('silence.wav', np.zeros(rate * 12))
rng = np.random.default_rng(42)
noise = rng.standard_normal(len(clean))
noise *= np.sqrt(np.mean(clean ** 2)) / (10 ** (6 / 20))
mixed = clean + noise
mixed /= max(1, np.max(np.abs(mixed)))
write('noise-6db.wav', mixed)
reference['noiseDefinition'] = 'White noise, seed 42, global signal-to-noise power ratio 6 dB before peak normalization. Silence is included in the signal RMS.'
(root / 'reference.json').write_text(json.dumps(reference, indent=2), encoding='utf-8')
print(json.dumps({'duration':len(clean)/rate,'cues':len(reference['cues']),'peak':float(np.max(np.abs(clean)))}))
