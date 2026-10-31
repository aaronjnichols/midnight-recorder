# Speech validation on public videos

Checked on 31 October 2026. Source files, full transcripts, and images stay in `.local`. [The saved measurements](transcription-validation.json) include source hashes and engine settings.

## Downloaded sources

| Video                        | Credit and source                                                                                                | Reuse terms                                                                           | Duration | Words | Processing time |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------: | ----: | --------------: |
| First Steps                  | [Mike Newbon, Blender Studio](https://studio.blender.org/training/blender-2-8-fundamentals/first-steps/)         | CC-BY on the publisher page                                                           |   58.5 s |   160 |          13.8 s |
| Viewport Navigation          | [Mike Newbon, Blender Studio](https://studio.blender.org/training/blender-2-8-fundamentals/viewport-navigation/) | CC-BY on the publisher page                                                           |  221.8 s |   728 |          59.3 s |
| Infrared: Beyond the Visible | [NASA / STScI, narration by Joshua Moore](https://science.nasa.gov/asset/webb/infrared-beyond-the-visible/)      | [NASA media use guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) |  450.4 s |   968 |         129.4 s |

Times include the first engine check, audio conversion, and recognition for each call as measured by the acceptance script. The engine used CPU `int8`, four threads, and the pinned English `small.en` model. These are measurements on this computer. They are not speed guarantees. The NASA video includes music and sound effects. The Blender screen tutorial shows real controls and view changes.

## Text and timing score

The NASA publisher provides an SRT caption file. The score removes bracketed sound labels and parenthesized directions. It removes case and punctuation. It does not rewrite number words or correct recognized text. A tested Levenshtein comparison found **13 word edits in 970 reference words**, a **1.34% word error rate**. This includes substitutions, insertions, and deletions.

Of 960 exact matched words, the median time outside the corresponding caption interval was zero. The 95th percentile was 0.158 seconds. The maximum was 0.617 seconds. For 130 matched caption first words, the median absolute difference from caption start was 0.135 seconds. The 95th percentile was 0.334 seconds.

Caption intervals are approximate. These results do not prove exact word boundaries or exact subtitle timing. Only the NASA file has an independent text score. The Blender caption download was unavailable. The Blender trial checks transcript context against visible actions, not a complete word error rate. The earlier raw trial also inserted an extra short phrase in the Blender transcript. Small text errors remain possible.

## CLI, MCP, and desktop checks

The real desktop app used a separate test library. The test imported the Blender tutorial, kept its first 95 seconds, and searched for the blue Z axis. MCP returned three PNG images. The images showed the Z-axis control and its tooltip. A later frame showed Top Orthographic view.

The test then removed the first 20 seconds and set speed to 1.5. The old transcript reported `stale: true`. A new job reused the audio cache. The search time changed to 22.552–23.032 seconds. This maps to source time 53.828–54.548 seconds. The before and after images showed the same control.

The workflow also checked paged reads, mute state, cache reuse after app restart, MCP validation errors, CLI error exit, an eight-second silent video, and a video without an audio track. Silent audio returned `no_speech`. The video without audio returned `no_audio` and `audioAudible: false`. A real Python speech job was cancelled after it reported speech progress. Its source video stayed available.

An independent GPT-6.1-SOL agent at high effort used CLI help and the real MCP SDK without the main test script. It found the phrase, read nearby speech, and viewed all three frame images. It found the no-audio flag error. A regression test failed before the fix and passed after it. Other stage reviews found startup cancellation, package cache identity, and cache deletion order defects. Those defects also have tests and fixes.

An existing capture test sometimes stopped the test camera before its first data chunk arrived. The unchanged Git version and the current version both passed focused runs. One full run passed, and another failed this test. The test now waits up to ten seconds for recorded data before it sends the input-ended event. Capture production code did not change. These speech changes do not resolve the earlier real desktop capture limits in [QA.md](../QA.md).

## Repeat the checks

Download the two Blender MP4 files from their free publisher pages. Save them as `.local/transcript-validation/blender.mp4` and `viewport.mp4`. Download the NASA 640 by 360 MP4 and its SRT captions from the NASA page. Save them as `nasa.mp4` and `nasa.srt` in the same folder. The Blender page required a browser download in this session.

```powershell
npm run setup:transcription
npm run verify:transcription
python experiments/timed-transcript/score_public.py .local/transcript-validation/nasa.srt .local/transcript-validation/nasa-production.json
npm run practice:transcription
npm test
python -m unittest discover -s experiments/timed-transcript -p test_score_public.py
```

Run these commands in sequence. The practice uses `.local/transcript-agent-practice`, preserves the normal library, and saves `report.json` plus frame images there. The source videos are not part of Git. Compare their hashes with the measurement file before comparing a new score.

This set has three files and two English narrators. It does not qualify all accents, echo, overlapping voices, or technical terms. Use the word times to find useful video intervals. Check the images before placing an element.
