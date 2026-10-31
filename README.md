# Midnight Recorder

A local Windows video recorder and editor. The desktop app, CLI, and MCP server use the same command service.

The app uses the colors from the active Cursor Midnight theme in the Second Brain Obsidian vault.

## Start

Requirements: Windows 10 or 11, Node.js 22 or later, and FFmpeg with FFprobe on `PATH`.

```powershell
npm ci
npm start
```

You can also run `Start Midnight Recorder.cmd` from this folder.

Select a screen or window. Select a microphone or camera if needed. Select Start recording. Use Pause, Resume, and Stop and save to control the recording. For a camera recording without a screen, select Camera only.

Use Import video to add an existing MP4, WebM, MOV, or MKV file. The app copies the source into its library.

Open a video to edit it. Keep range trims the video to the specified range. Remove range cuts out that range. All times refer to the current edited video. Speed and mute settings also apply to export. Undo, Redo, and Reset all edits keep the source file unchanged.

Export MP4 writes a new H.264 MP4 file. It does not replace an existing file. The app shows the export result below the editor.

## Storage

The default data folder is `.local/data` in the working folder. It contains:

- `library.json`, the video records and edit history.
- `media`, the source video copies.
- `pending`, recording files that the app has not yet imported.
- `connection.json`, the local agent connection and token.
- `electron`, the desktop session data.

Set `MIDNIGHT_DATA` to use another folder. Use the same value for the desktop app, CLI, and MCP server. Use an absolute path when you start these programs from different folders.

```powershell
$env:MIDNIGHT_DATA = 'C:\Videos\Midnight'
npm start
```

Set `FFMPEG_PATH` and `FFPROBE_PATH` if the programs are not on `PATH`.

If a save fails, leave the app open. Select Stop and save to retry. Cancel recording removes the pending recording. If the app stops unexpectedly, keep files in `pending`. You can import a readable pending file through `library.import`. Automatic recovery after an app crash is not yet available.

## CLI

Start the desktop app first. Run commands from this project folder. Commands return JSON. Errors use standard error and a nonzero exit code.

```powershell
node src/agent/cli.js help
node src/agent/cli.js capture.sources
node src/agent/cli.js capture.devices
node src/agent/cli.js app.status
```

Pass arguments as one JSON value. PowerShell examples:

```powershell
node src/agent/cli.js recording.start '{"sourceId":"screen:0:0","title":"Demo"}'
node src/agent/cli.js recording.pause
node src/agent/cli.js recording.resume
node src/agent/cli.js recording.stop
node src/agent/cli.js library.list
node src/agent/cli.js edit.trim '{"id":"VIDEO_ID","start":1,"end":8}'
node src/agent/cli.js edit.cut '{"id":"VIDEO_ID","start":2,"end":3}'
node src/agent/cli.js export.start '{"id":"VIDEO_ID","path":"C:/Videos/demo.mp4"}'
node src/agent/cli.js export.status '{"jobId":"JOB_ID"}'
```

Use IDs from command results. Source IDs can change when a window closes. Export commands return a job ID. Poll `export.status` until its state is `complete` or `failed`.

`help` returns the complete command catalog and argument schemas. It works when the desktop app is closed.

## MCP

Configure your MCP client to start Node with `src/agent/mcp.js`. Example server entry:

```json
{
  "mcpServers": {
    "midnight-recorder": {
      "command": "node",
      "args": ["C:/PATH/TO/PROJECT/src/agent/mcp.js"],
      "env": {
        "MIDNIGHT_DATA": "C:/PATH/TO/PROJECT/.local/data"
      }
    }
  }
}
```

The MCP server uses standard input and output. It exposes the same names and schemas as the CLI. The desktop app must be open to run commands.

The agent connection binds to `127.0.0.1` on a random port. It requires a random token. It rejects browser origins. Do not share `connection.json`. The agent has the same file and recording controls as the desktop app.

## Commands

| Task               | Commands                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| App state and view | `app.status`, `app.view`                                                                                                            |
| Capture selection  | `capture.sources`, `capture.devices`                                                                                                |
| Recording          | `recording.start`, `recording.pause`, `recording.resume`, `recording.stop`, `recording.cancel`                                      |
| Library            | `library.list`, `library.get`, `library.import`, `library.rename`, `library.delete`                                                 |
| Editing            | `edit.trim`, `edit.cut`, `edit.configure`, `edit.undo`, `edit.redo`, `edit.reset`                                                   |
| Export             | `export.start`, `export.status`                                                                                                     |
| Preview            | `playback.open`, `playback.play`, `playback.pause`, `playback.seek`, `playback.status`, `playback.configure`, `playback.fullscreen` |

## Code structure

- `src/domain` has time-range edits and time conversion. It has no Electron or file-system dependencies.
- `src/application` has command schemas, validation, and workflow state. It uses injected adapters.
- `src/adapters` has file storage and FFmpeg operations.
- `src/desktop` has Electron setup, capture, permissions, and IPC.
- `src/ui` has the desktop page and styles.
- `src/agent` has the local server, CLI, and MCP adapters.

The command service serializes changes. Exports run as background jobs. Each export uses the edit state from the time the job starts.

## Tests and verification limits

```powershell
npm test
```

The suite includes real FFmpeg operations, authenticated CLI and MCP calls, and Electron desktop tests. It needs a Windows desktop session and local loopback access. Tests use separate folders under `.local`.

Camera and microphone tests use Chromium test devices. They check visible video frames and an audio track. They do not verify physical devices.

The current execution session reports Windows capture access errors and produces black screen video. The lifecycle test checks start, pause, resume, save, edit, and export. Visible screen content, physical devices, and system audio still require verification in a normal desktop session. Do not treat the lifecycle test as proof of visible screen capture.

There is no cloud upload, hosted share link, transcript, or account system. Share an exported MP4 through a file-sharing method of your choice.
