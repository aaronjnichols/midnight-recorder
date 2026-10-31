# Acceptance evidence

Desktop acceptance is blocked in this agent session. This file records checks and open work.

| Requirement                    | Current evidence                                                                               | State                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------ |
| Source-preserving edits        | Domain tests cover trim, cut, speed, mute, undo, redo, and time mapping                        | Tested                   |
| Local storage                  | Library tests cover copy, restart, search, rename, delete failure, and special path characters | Tested                   |
| MP4 export                     | Real FFmpeg tests cover audio, cuts, speed, sparse frames, and existing output files           | Tested                   |
| CLI and MCP parity             | Integration test calls the local service from the CLI and an SDK MCP client                    | Tested                   |
| Recording state and save       | Electron test uses a screen source and checks pause, resume, save, trim, and export            | Tested                   |
| Visible screen content         | This execution session records black screen video and reports Windows access errors            | Open                     |
| Camera and microphone pipeline | Chromium test devices produce visible frames and an audio track                                | Tested with test devices |
| Physical camera and microphone | No physical device test is complete                                                            | Open                     |
| Camera overlay                 | Saved camera overlay frames have visible content in the Chromium test-device check             | Tested                   |
| System audio                   | Acceptance test records a quiet tone through real Windows system audio capture                 | Tested                   |
| Failed-save retry              | Service tests cover import failure and cleanup failure without duplicate import                | Tested                   |
| Disk write failure             | Electron test checks that Cancel releases the failed recorder                                  | Tested                   |
| Input disconnect               | Electron test dispatches an ended input event and checks automatic save                        | Tested                   |
| Preview controls               | Desktop test covers edited-time seek, volume, fullscreen, and agent commands                   | Tested                   |
| Cursor Midnight palette        | Values came from the active Obsidian theme. An editor screenshot was inspected                 | Checked                  |
| Independent review             | Three review agents checked the code. Fixes have regression tests                              | Tested                   |
| Git history                    | Requirements, domain, agent, and desktop stages have separate commits                          | Checked                  |

## Remaining checks

- Verify visible screen and window capture in a normal desktop session.
- Verify physical device selection and sound levels.

## Desktop capture limit

The current Electron 45.2.1 acceptance run records black screen and window video in this agent session. The system audio tone check passes. A separate FFmpeg GDI capture fails with Windows error 5, access denied. An earlier window check passed on Electron 40.9.3. This earlier result does not prove the current runtime works in this session.

The normal desktop check is pending. Use `npm run verify:desktop` from a normal Windows desktop session.

## Latest regression result

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
