"""One offline job per process. JSON lines on stdout; diagnostics on stderr."""
import json
import os
import sys
import time
import importlib.metadata

os.environ['HF_HUB_OFFLINE'] = '1'


def emit(kind, data):
    print(json.dumps({'type': kind, 'data': data}, ensure_ascii=True), flush=True)


def main():
    request = json.load(sys.stdin)
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    if request.get('check'):
        emit('result', {name: importlib.metadata.version(name) for name in
                       ['faster-whisper', 'ctranslate2', 'av', 'onnxruntime']})
        return
    started = time.perf_counter()
    audio = decode_audio(request['audio'], sampling_rate=16000)
    duration = len(audio) / 16000
    regions = get_speech_timestamps(audio, VadOptions(
        min_silence_duration_ms=500, speech_pad_ms=200, max_speech_duration_s=20))
    words = []
    if regions:
        model = WhisperModel(request['model'], device='cpu', compute_type='int8',
                             cpu_threads=4, local_files_only=True)
        for index, region in enumerate(regions):
            offset = region['start'] / 16000
            segments, _ = model.transcribe(audio[region['start']:region['end']],
                language='en', beam_size=5, word_timestamps=True,
                vad_filter=False, condition_on_previous_text=False,
                initial_prompt=', '.join(request.get('vocabulary', [])) or None)
            for segment in segments:
                segment_id = len(words)
                for word in segment.words or []:
                    start = max(0, word.start + offset)
                    end = min(duration, region['end']/16000, word.end + offset)
                    if end > start and word.word.strip():
                        words.append({'word': word.word, 'start': start, 'end': end,
                                      'probability': word.probability, 'segmentId': segment_id})
            emit('progress', {'phase': 'speech', 'completedRegions': index + 1,
                              'totalRegions': len(regions), 'processedSeconds': region['end']/16000})
    emit('result', {'words': words, 'speechRegions': len(regions),
                    'elapsedSeconds': time.perf_counter()-started})


if __name__ == '__main__':
    main()
