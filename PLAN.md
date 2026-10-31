# Midnight Recorder

Build a local Windows desktop recorder and editor. Use the active Cursor Midnight palette from the Second Brain Obsidian vault.

## Required behavior

- Record a screen or window. Support a microphone, system audio, and a camera overlay. Support camera-only recording.
- List capture sources and media devices. Start, pause, resume, stop, and cancel a recording.
- Store recordings locally. Import, list, search, rename, preview, and delete videos.
- Keep source videos unchanged. Trim a video, remove sections, change speed, mute audio, and undo or redo edits.
- Export an edited MP4 file. Report errors and export state.
- Give CLI and MCP clients the same operations as the desktop app, including playback controls.
- Use one command catalog, a domain layer, file and media adapters, and thin desktop and agent adapters.
- Use tests before code. Include real FFmpeg tests, agent transport tests, and desktop tests.
- Review changes with independent agents and make frequent Git commits.

## Delivery checks

1. Domain and storage tests pass.
2. A real media import, edit, and export test passes.
3. CLI and MCP use the running desktop service.
4. A real desktop screen recording can pause, resume, stop, and export.
5. The UI works with the Cursor Midnight colors. Check the rendered app.
6. Document install, start, storage, agent setup, and known limits.

## Current state

The workspace started empty. Node 22, Git, and FFmpeg 8.1.1 are installed.
The active Obsidian theme is Cursor Midnight. Its palette source is
`C:\_Obsidian\Second Brain\.obsidian\themes\Cursor Midnight\theme.css`.
The app will use Electron 40.9.3, which has a cached Windows runtime on this computer.
