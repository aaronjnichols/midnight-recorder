# Acceptance evidence

Desktop acceptance is blocked in this agent session. This file records checks and open work.

| Requirement                    | Current evidence                                                                                                      | State                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Source-preserving edits        | Domain tests cover trim, cut, speed, mute, undo, redo, and time mapping                                               | Tested                   |
| Local storage                  | Library tests cover copy, restart, search, rename, delete failure, and special path characters                        | Tested                   |
| MP4 export                     | Real FFmpeg tests cover audio, cuts, speed, sparse frames, and existing output files                                  | Tested                   |
| CLI and MCP parity             | Integration test calls the local service from the CLI and an SDK MCP client                                           | Tested                   |
| Recording state and save       | Electron test uses a screen source and checks pause, resume, save, trim, and export                                   | Tested                   |
| Countdown and screen border    | Service tests cover cancellation and timing. Electron tests check countdown, border, pause, stop, and failure cleanup | Tested with test devices |
| Visible screen content         | This execution session records black screen video and reports Windows access errors                                   | Open                     |
| Camera and microphone pipeline | Chromium test devices produce visible frames and an audio track                                                       | Tested with test devices |
| Physical camera and microphone | No physical device test is complete                                                                                   | Open                     |
| Camera overlay                 | Saved camera overlay frames have visible content in the Chromium test-device check                                    | Tested                   |
| System audio                   | Acceptance test records a quiet tone through real Windows system audio capture                                        | Tested                   |
| Failed-save retry              | Service tests cover import failure and cleanup failure without duplicate import                                       | Tested                   |
| Disk write failure             | Electron test checks that Cancel releases the failed recorder                                                         | Tested                   |
| Input disconnect               | Electron test dispatches an ended input event and checks automatic save                                               | Tested                   |
| Preview controls               | Desktop test covers edited-time seek, volume, fullscreen, and agent commands                                          | Tested                   |
| Cursor Midnight palette        | Values came from the active Obsidian theme. An editor screenshot was inspected                                        | Checked                  |
| Independent review             | Three review agents checked the code. Fixes have regression tests                                                     | Tested                   |
| Git history                    | Requirements, domain, agent, and desktop stages have separate commits                                                 | Checked                  |

## Remaining checks

- Verify visible screen and window capture in a normal desktop session.
- Verify physical device selection and sound levels.
- Verify indicator exclusion from saved screen video in a normal Windows desktop session.

## Desktop capture limit

The current Electron 45.2.1 acceptance run records black screen and window video in this agent session. The system audio tone check passes. A separate FFmpeg GDI capture fails with Windows error 5, access denied. An earlier window check passed on Electron 40.9.3. This earlier result does not prove the current runtime works in this session.

The normal desktop check is pending. Use `npm run verify:desktop` from a normal Windows desktop session.

## Earlier frame-inspection regression result

`npm test` passes all 49 tests. The current run includes frame inspection and the three review fixes below. Library and editor screenshots were inspected at the minimum window width. There is no horizontal overflow.

The camera-only plus system-audio check passes. The app reports a clear error if the requested system audio track is missing.

The default app was launched with `npm start`. The live CLI returned an idle recorder and an empty library. A separate MCP client connected to that app, listed all 30 commands, and read the same idle state.

## Continuation checks

The current app still reports an idle recorder. Device enumeration returns Remote Audio input entries and no camera. A direct desktop capture still fails with Windows error 5, access denied. Desktop control found the Midnight Recorder window, but its app approval request timed out. No desktop UI action was performed.

The default data folder now stays in this project folder when a CLI or MCP client starts from another working folder. `MIDNIGHT_DATA` still selects another folder. The new default-path test failed before the fix and passes after it. A review agent found no code defect in this change. The README now explains the default path and how to retain a library created in another working folder.

A live CLI client and a live MCP client started from another folder both reached the open app without a data-path override. Both returned the same idle recording state.

## Blocked acceptance check

The third goal turn rechecked the live app, capture devices, and direct FFmpeg GDI capture. The app remains idle. The device list still contains Remote Audio inputs and no camera. Desktop capture still fails with Windows error 5, access denied. The same desktop acceptance limit has persisted across three goal turns.

Run `npm run verify:desktop` from this project folder in a normal Windows desktop session. Report the screen, window, and system-audio results. If physical camera or microphone inputs are available, check them in the app as well. This session cannot complete those remaining checks.

## Requested desktop recheck

The agent ran `npm run verify:desktop` after the user requested the check. Two checks passed and two failed:

- Camera-only recording with a test camera and a real system-audio track passed. This check does not measure the track's sound level.
- Real system audio with a test tone passed.
- Screen recording failed because the saved video was black.
- Window recording failed because the saved video was black.

Computer Use selected the open Midnight Recorder window. Its screenshot was black, and its accessibility state was unavailable. A separate FFmpeg GDI capture failed with Windows error 5, access denied. Windows reported an active Remote Desktop session. These results do not establish the cause of the capture failure.

The app remains open and idle. The device list contains Remote Audio inputs and no camera. No Windows security or privacy settings were changed. Visible desktop capture and physical device checks remain open.

## Review fixes

Three GPT-6.1-SOL agents at high reasoning effort made these fixes in sequence:

- `45b4ecc`: The first recording write error pauses capture. The shared service reports `failed` and the error text to the app, CLI, and MCP. Pending data remains after a failed Stop. Tests cover duplicate reports, old recording IDs, and reports during Stop or Cancel. The disk test injects a rejected write. It does not exhaust a real disk.
- `881958f`: Export and edited preview keep delayed audio through cuts and speed changes. Selections before the first audio frame remain silent. A new preview cache version prevents reuse of old renders. Real FFmpeg tests measure the decoded sound timing and check that source bytes stay unchanged.
- `590e403`: The default trim end keeps the exact timeline duration. UI tests use Keep range at 1.5x and 0.75x speed and check that the full source endpoint remains. The domain still rejects times past the real end.

Each regression failed before its production fix and passed after it. Independent reviews of the stages and the combined change found no defects. The final `npm test` run passed 40 tests with no failures or skipped tests. Its log is `.local/review-fixes-regression.log`.

These fixes do not close the visible desktop capture or physical device checks. Those acceptance limits remain as described above.

## Frame inspection

The shared service now has `inspect.start` and `inspect.result`. The CLI can start a job and read its PNG paths. MCP returns native image content. The full regression run passed 49 tests with no failures or skipped tests. The log is `.local/frame-inspection-regression.log`.

New checks cover edited-time sampling after cuts and speed changes, exact frame boundaries, request order, duplicate timestamps, a coordinate grid, stale edit detection, image-size limits, portrait dimensions, failed-job cleanup, and library deletion. The CLI/MCP test checks the returned image bytes against the saved PNG file. Background job checks confirm that state commands remain available during inspection.

The first inspection test failed because the command was absent. The MCP test then failed because the response contained no image blocks. Each test passed after its implementation. An independent core review found that a fixed 30 fps assumption selected the wrong frame at 0.5x speed. A second review found a decimal timestamp rounding error. Both defects have regressions that failed before their fixes. The final implementation reads integer frame presentation timestamps and the stream time base. The core re-review returned no findings. A separate review of the MCP response, CLI test, and desktop practice also returned no findings.

`npm run practice:inspection` passed through the real Electron app with a separate library. It used the CLI to import and edit a generated sample, then an SDK MCP client to retrieve 11 PNG images. The agent inspected the images. The Save button is on the left before source time 3 and on the right from source time 3. After removing source time 1 to 2 and setting speed to 0.5, this change occurs at edited time 4. The final report is `.local/inspection-practice-aU7yzK/report.json`.

This practice checks imported video inspection. It does not close the real desktop capture or physical device checks. It does not add text, shape, or transition editing commands. See `docs/inspection-practice.md` for the placement plan derived from the images.

## Timed speech

The speech-stage `npm test` run passed 67 tests with no failures or skipped tests. The log is `.local/transcription-verified-tests.log`. Three Python scoring tests also passed. That stage had 39 shared commands, including six transcript commands.

Three downloaded public videos passed the production engine check. A NASA caption comparison measured 13 word edits in 970 reference words, or 1.34%. This is one English file, not a general accuracy score. Two Blender videos supplied actual screen controls and spoken instructions. See [sources, measurements, and limits](docs/transcription-validation.md).

A fresh `npm run setup:transcription` passed. The actual desktop, CLI, and MCP workflow passed with word pages, phrase search, native PNG images, cuts, speed changes, stale flags, mute state, cache reuse after restart, silence, no audio, and validation errors. A cancellation check observed one completed speech region before it cancelled the Python process. The report is `.local/transcript-agent-practice/report.json`.

An independent agent found the requested Blender control through CLI and MCP and viewed its before, during, and after frames. Review fixes cover cancellation during startup, package changes in cache identity, cache deletion order, the no-audio flag, scoring with no matched words, and proof of speech progress before cancellation. The final reviews returned no findings.

An existing test-camera check was intermittent because it used a fixed sleep before ending the input. It now waits for recorded bytes with a ten-second limit. The full suite passed after this test change. Production capture code did not change. The real desktop and physical-device limits above remain open.

## Countdown and recording border

The final `npm test` run passed all 73 tests with no failures or skipped tests. The run took 122 seconds. The log is `.local/countdown-verified-tests.log`.

The Record button uses `recording.countdown`. CLI and MCP can use the same command. The app has 40 shared commands. Immediate `recording.start` remains available.

Service tests check 3, 2, 1, no capture during the countdown, cancellation, stale timers, duplicate starts, and startup errors. The transport test calls the new command through CLI and MCP. The Electron test uses a test camera as its screen input. It checks the native countdown, protected and non-focusable indicator, display bounds, pause, resume, save, and failure cleanup. The missing-system-audio test now selects a real source ID before it supplies its test stream.

Display tests cover a second monitor, negative display coordinates, display size changes, connection during preparation or capture, removal, and cancellation while an indicator loads. These use display test objects. Physical monitor connection checks remain open.

The countdown and red and amber border screenshots were inspected in `output/playwright/04-countdown.png`, `05-recording-border.png`, and `06-paused-border.png`. The border image has a transparent center. The indicator uses Windows capture protection. This remote session cannot confirm indicator exclusion from saved screen video because the real screen capture remains black.

Two review agents checked the service and desktop stages. Fixes cover a timer race in the transport test and monitors connected while indicator windows load. The final review returned no findings.

## Desktop UI pass

The desktop page has a new layout. It keeps the Cursor Midnight colors. The muted text color is slightly lighter to increase contrast on panels. The command catalog did not change. New keys and controls use existing shared commands.

Changes:

- The top bar shows the recording state and the recorded time in the library and the editor. Select it to show the recording controls.
- During a countdown or a recording, the recorder shows the state, the time, and the controls at the top of the panel. At the minimum window size, 1000 × 720, Start recording, Pause, and Stop and save are visible without scrolling. Settings are locked during a recording.
- A search with no result shows the search text and Clear search. Before this change, it showed "Your video library is empty." and set the library count to 0. Spaces alone caused a `query must not be empty` error. Press / to go to the search field. Press Esc to clear it.
- Video cards show the length, the date, the size, and an Edited label. Two cards fit in each row at 1000 × 720.
- The editor timeline shows the playhead and the selected range. Select a point on it to move the playhead. Use playhead sets the range start or end. Keep range and Remove range are not available for a full or invalid range. A message tells the reason.
- The Exports list shows the exports of the open video. Before this change, frame inspection jobs showed as "Export complete: undefined". A message shows when an export is complete or fails.
- Keyboard shortcuts use `playback.play`, `playback.pause`, `playback.seek`, `playback.fullscreen`, `edit.undo`, and `edit.redo`. A key pressed during an operation applies after the operation. Before the fix, the app ignored it.
- Enter saves a changed title. Focus moves to the editor title when you open a video, and back to its card when you go back. The delete dialog names the video and starts on Keep video.

`src/ui/view-model.js` has the state rules and the keyboard map without DOM or Electron dependencies. `test/ui-view-model.test.js` checks it with `node:test`. `test/ui.test.js` checks the search states, the editor keys, the timeline, the title, the delete dialog, the export list, and the recording state at 1000 × 720. Each test failed before its production change. The logs are `.local/claude-ui/red-pure.log`, `.local/claude-ui/red-ui.log`, and `.local/claude-ui/red-ui-queue.log`.

Before and after screenshots are in `output/playwright/claude-ui`. They show 1440 × 940 and 1000 × 720 windows. The screenshots use generated videos, Chromium test devices, and camera-only capture. They do not record the desktop or a microphone. The real screen capture limit in this session did not change.

### Review corrections

An independent review found three defects. Each correction has a regression test that failed before the fix.

1. Recorded time after a page reload. The page counted time locally. After a reload, a paused recording showed 0:00, and a resumed recording counted the earlier pause. The service now keeps `startedAt`, `pausedSeconds`, `pausedAt`, and `stoppedAt`. `app.status` adds `recordedSeconds`. The page and agents use the same values. `test/recording-time.test.js` uses a test clock and checks pauses, resumes, failures, stops, countdown, cancel, and immediate start. An Electron test reloads the page while paused and after a resume. It compares the page, `app.status`, the CLI, and the saved video duration. Red logs: `.local/claude-ui/fix1-red-reload.log` and `.local/claude-ui/fix1-red-service.log`. The native border and the command guards did not change.
2. Save wording. The page showed "The app did not save the recording" during a normal save. It showed "Not saved" when the import was complete and only the cleanup failed. The service now keeps the import or cleanup error in the `stopped` state and removes it when a retry starts. A capture error from the `failed` state does not show during the save. The page shows Saving, Not saved, or Saved. Cleanup failed. Red log: `.local/claude-ui/fix2-red.log`.
3. Range end at fractional speeds. At 1.5x speed, Use playhead and the O key at the end wrote 6.67. The edited end is 6.666... seconds, so the app disabled Keep range. The message also showed 6.67 as the maximum. A playhead value within 0.005 seconds of the end now gives the exact end. A typed end up to 0.005 seconds after the end gives the exact end. The Electron test uses the arrow keys, the O key, Use playhead, the displayed maximum, and Keep range. The trim keeps source time 1.5 to 10. Red logs: `.local/claude-ui/fix3-red.log` and `.local/claude-ui/fix3-red-unit.log`.
4. Range maximum at a rounding boundary. A second review found that a 5.35 second video at 2x speed showed the maximum 2.68, but the app did not accept 2.68. In floating point, 2.675 + 0.005 is 2.6799999999999997. The range check now adds a tolerance of 1e-9 seconds to the half-step limit. The shown maximum gives the exact end. Values after the half step, such as 2.681 and 2.69, stay outside the accepted range. A unit test checks this case and 42 combinations of 7 durations and 6 speeds. Red log: `.local/claude-ui/fix4-red-range.log`. Green logs: `.local/claude-ui/fix4-green-unit.log` and `.local/claude-ui/fix4-green-electron.log`.

The combined `npm test` run had 91 tests. 90 passed and 1 failed. No test was skipped. The log is `.local/claude-ui/review-fixes-full-test.log`. The failed test is "cancel releases the recorder after a disk write fails". This existing test waits a fixed 1.4 seconds for the first recorder data, then expects the `failed` state. The state was still `recording`. When this test ran alone, it passed one time and failed two times.

A timing script measured this path four times in each mode. The first data reached the main process 1.21 to 1.50 seconds after `recording.start` returned. The service set `failed` 17 to 88 ms after that data. With an idle page, the first data arrived after 1.15 to 1.31 seconds. With an active page after startup, it arrived after 1.25 to 1.35 seconds. The capture window and the capture code did not change. These results show that the 1.4 second wait has a small margin on this computer. A comparison with the baseline commit was not done. The logs are `.local/claude-ui/disk-timing-current.log`, `.local/claude-ui/disk-timing-idle.log`, and `.local/claude-ui/disk-timing-settled.log`.

The disk-error test now polls `app.status` until the state is `failed`, with a limit of ten seconds. It does not use a fixed 1.4 second wait. All other checks did not change: the error message, the paused recorder, one failed write, the page status, the disabled Pause button, the pending file, the failed Stop, and the Cancel cleanup. Production capture code did not change. The test passed three of three times alone. The logs are `.local/claude-ui/disk-wait-1.log`, `.local/claude-ui/disk-wait-2.log`, and `.local/claude-ui/disk-wait-3.log`.

The final `npm test` run for this stage had 92 tests. All 92 passed. No test failed or was skipped. The run took 211 seconds. The complete log is `.local/claude-ui/final-full-test.log`.

Three independent review agents checked the layout, page behavior, and state rules. Follow-up reviews checked the timing, save states, keyboard queue, range limits, and disk-error test. The final reviews found no remaining defects.

## Captions and final editing integration

Captions come from the local English speech engine. They have a separate track, one undo step for each change, and the same shared commands in the app, CLI, and MCP. The preview, frame inspection, and export use the same renderer and the same [start, end) frame rule as elements. See [captions](docs/editing.md#captions).

Tests and verification (the regression fixes have recorded failing runs; logs and the red/green index are in `.local/claude-editing/logs.md`):

- Domain: `test/captions.test.js`, `test/caption-review.test.js`. Word grouping, cuts, partial and attached words, speed, ranges, capacity, validation, unique IDs, minimum display time, history limit 100, old libraries.
- Service: `test/caption-service.test.js`. Atomic apply and replace, full-revision guards, edits during recognition, cancel before and after a queued apply, no audio, no speech, an empty range, failure, summaries, and omission warnings.
- CLI and MCP: `test/caption-agent.test.js`. Real commands, inspection, and export.
- Renderer: `test/caption-render.test.js`. Text with filter and command characters renders pixel-equal to a text element. Exact frame edges and gaps, cuts, speed, shapes, fades, hidden captions, and 500 captions with cuts.
- Desktop: `test/late-result-ui.test.js` and `test/caption-ui-review.test.js` hold real command replies to check late results after a video, layer, or caption change. A mutation run with each guard removed failed. `test/caption-ui.test.js` uses the real speech engine to generate, select, seek, correct, style, undo, redo, delete, hide, reload, and export.

The full `npm test` run had 206 tests. All passed, none were skipped, in 384 seconds: `.local/claude-editing/stage3-full.log`. After one more review correction, the 43 affected tests passed: `.local/claude-editing/stage3-affected-after-full.log`.

Real speech trial: a 30-second excerpt of "First Steps" (Mike Newbon, Blender Studio, CC-BY), with all steps through the CLI. Recognition took 14.5 seconds. It gave 74 words and 8 captions. A second job used the cache and took 1.3 seconds. The before, during, and after frames from inspection and from the exported MP4 show the caption only during its time. No word correction was made. This trial did not measure word accuracy. Report: `.local/claude-editing/stage3-trial.md`. Images: `output/playwright/claude-editing/stage3-trial-*`.

Screenshots at 1440 × 940 and 1000 × 720: `output/playwright/claude-editing/stage3-captions-*`.

Limits: English only. One speech job at a time, on a source of at most one hour. 500 captions, 200 characters, and 3 lines for each caption. Word times are estimates. The app does not write SRT or VTT files. Characters that the font does not have show as boxes. The real speech desktop test skips if the engine or the excerpt source is not on the computer.
