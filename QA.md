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
| Camera overlay                 | Code is present. Content test is pending                                                       | Open                     |
| System audio                   | Acceptance test records a quiet tone through real Windows system audio capture                 | Open                     |
| Failed-save retry              | Service tests cover import failure and cleanup failure without duplicate import                | Tested                   |
| Disk write failure             | Electron test checks that Cancel releases the failed recorder                                  | Tested                   |
| Input disconnect               | Electron test dispatches an ended input event and checks automatic save                        | Tested                   |
| Preview controls               | Desktop test covers edited-time seek, volume, fullscreen, and agent commands                   | In progress              |
| Cursor Midnight palette        | Values came from the active Obsidian theme. An editor screenshot was inspected                 | Checked                  |
| Independent review             | Three review agents found defects. Fixes and regression tests are in progress                  | In progress              |
| Git history                    | Requirements, domain, agent, and desktop stages have separate commits                          | Checked                  |

## Remaining checks

- Check the final library and editor layouts at the minimum window size.
- Complete the overlay test. The system audio tone test passes.
- Verify visible screen and window capture in a normal desktop session.
- Verify physical device selection and sound levels.
- The failed export test confirms that the selected output path remains available.
- Review the final changes and run the complete suite.
