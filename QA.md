# Acceptance evidence

The goal is still active. This file records checks and open work.

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

`npm test` passes all 29 tests. The current run includes the audio option and layout changes. Library and editor screenshots were inspected at the minimum window width. There is no horizontal overflow.

The camera-only plus system-audio check passes. The app reports a clear error if the requested system audio track is missing.

The default app was launched with `npm start`. The live CLI returned an idle recorder and an empty library. A separate MCP client connected to that app, listed all 30 commands, and read the same idle state.
