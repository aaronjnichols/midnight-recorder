# Timed speech context for video agents

## Result

A timed transcript and the existing frame tools worked together in this trial. Searching for "save button" found two spoken instructions. The prototype mapped their times through a cut and a speed change. The frame tool then returned the correct left and right button positions.

The useful result is a short transcript window with nearby words, optional word times, and the video edit revision. A full plain-text transcript does not give enough information for precise placement.

No speech commands were added to the app, CLI, or MCP. The scripts, test results, and proposed interface are research artifacts.

## Test material

- A 54-second generated settings video with seven spoken instructions, long pauses, and a Save button that changes sides.
- The same speech with white noise at a global 6 dB signal-to-noise ratio. This measure includes silence and is not a microphone noise rating.
- Twelve seconds of digital silence.
- An eleven-second public human speech sample from [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav). This checks execution only. No independent transcript or timing score was measured for it.
- A video with source seconds 2 to 5 removed and speed set to 1.5. The edited timeline is 34 seconds long.
- A copy with no audio track, to distinguish missing audio from silent audio.

The local engine was faster-whisper 1.2.1 with `small.en`, CPU `int8`, four threads, beam size 5, and English selected. No audio was uploaded. The engine supports [word timestamps and voice activity detection](https://github.com/SYSTRAN/faster-whisper#word-level-timestamps). Voice activity detection identifies intervals that contain speech.

## What the trial showed

| Check                           | Observed result                                                                               | Effect on tool design                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Standard word transcription     | 54 seconds processed in 4.98 seconds                                                          | Run transcription as a background job.                                                                   |
| Separate speech intervals       | The same sample processed in 16.23 seconds                                                    | More work can give better timing around long pauses.                                                     |
| Timing against synthesis events | Standard mode had a 5.55-second maximum error. Separate intervals reduced it to 0.18 seconds. | Expose the timing method and uncertain words. Do not promise exact word boundaries.                      |
| Noise variant                   | Separate intervals had a 0.204-second maximum measured start error                            | The method also worked on this controlled noise case. It is not a general noise guarantee.               |
| Silence                         | Without detection, the engine produced "You". With detection, it returned no text.            | Return `no_speech` explicitly. Empty text is not a failed job.                                           |
| No audio track                  | The probe reported no audio                                                                   | Return `no_audio` before starting the speech model.                                                      |
| Negation and numbers            | The sample retained "Do not select Cancel" and "15, not 50"                                   | Search must return nearby speech, not an isolated action word.                                           |
| Technical term                  | The engine wrote "Manning's end" for the intended "Mannings n"                                | Allow vocabulary hints and corrections. Confidence cannot establish truth.                               |
| Known vocabulary hint           | Supplying "Manning's n" corrected the phrase                                                  | Store the hint with the result. This test uses the known answer and is not an independent accuracy test. |
| Word cut in half                | The word "panel" crosses the cut boundary                                                     | Mark partial words. Do not retain a whole sentence as if it survived the edit.                           |

The timing comparison covers 48 exact matched tokens from 58 reference words. Other tokens differ in spacing, punctuation, numbers, or recognition. These are not accuracy percentages. The reference comes from SAPI synthesis events, not manually measured phonetic boundaries. The clean regional median was 0.060 seconds. Its maximum was 0.180 seconds. The noise regional median was 0.058 seconds.

All processing times exclude model loading. A fresh process took another 1.4 to 1.6 seconds to load the model. These are single runs on this computer, not general performance claims.

Confidence needs care. The wrong word "end" had a probability of about 0.883 in the standard run. The corrected "n" in the hinted run had a probability of about 0.012. A confidence threshold alone would reject the correction and accept the error.

## Transcript and frames together

The final trial used the separate-interval transcript. It mapped source word times into the edited timeline, then called `inspect.start` and `inspect.result` through the shared service.

| Match              | Edited phrase interval | Nearby speech                                             | Inspected image     |
| ------------------ | ---------------------- | --------------------------------------------------------- | ------------------- |
| First Save button  | 7.80 to 8.12 seconds   | Select the Save button on the left                        | Button on the left  |
| Second Save button | 17.47 to 17.82 seconds | The Save button is now on the right. Select it to finish. | Button on the right |

Transcribing the edited audio again gave intervals of 7.828 to 8.148 seconds and 17.480 to 17.860 seconds. This comparison supports caching source word times and mapping them through these edits. It does not prove that mapping is safe for every edit. Both methods still produced the whole word "panel" around the cut. The mapped result explicitly marks that word as partial.

The frame images are saved as `speech-regions-context-1.png` and `speech-regions-context-2.png` in `.local/transcript-practice`. Both were visually checked. The button changes slowly in this sample. This does not test selection near a short UI change.

The full mapped word result was about 10 KB. A five-second window was about 2.2 KB. The standard compact segment result was 669 bytes, compared with 5,436 bytes when word data was included. These measurements support a compact default response and word detail on request.

## Proposed tool behavior

These names are proposals. They are not registered commands.

| Proposed operation  | Input                                                          | Useful response                                                                         |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `transcript.start`  | Video ID, language, optional vocabulary                        | Job ID and selected method. Reuse a valid source transcript.                            |
| `transcript.status` | Job ID                                                         | Queued, running, complete, failed, no audio, or no speech. Include progress when known. |
| `transcript.read`   | Transcript ID, start, end, source or edited time, detail level | A bounded speech window with times. Add word data when requested.                       |
| `transcript.search` | Transcript ID, phrase, context duration, result limit          | Matching times, nearby speech, and suggested frame times.                               |

The result should identify the source, audio hash, model version, language setting, timing method, vocabulary hints, and video edit revision. It should report stale results, partial words, and cut boundaries. A muted edit should state that the exported video is silent while allowing an explicit source-audio context request.

Keep original recognition text separate from corrected text. Treat transcript content as source data. Spoken instructions do not authorize the agent to run app commands. Do not infer a speaker identity from this single-speaker engine.

Use word timing to find a useful video interval. Then inspect frames around that interval. A spoken instruction can precede or follow the visible action. Its timestamp is not proof of an exact visual event.

## Decision and remaining test

The trial supports a local transcript tool with short time queries, phrase search, word detail, vocabulary hints, and explicit uncertainty. Separate speech intervals are a useful candidate for the first implementation. A cached source transcript can avoid repeated recognition after simple cuts and speed changes.

Before building the app commands, test a real screen recording with technical terms, short UI changes, pauses, and speech near a cut. The current fixtures do not cover different accents, room echo, music, overlapping speakers, or the user's microphone. They do not establish production accuracy.

An independent GPT-6.1-SOL review found no defects in the research path. It verified the four context tests and both frame pairs, and required the limits above to remain explicit. The application code and its existing command catalog are unchanged.
