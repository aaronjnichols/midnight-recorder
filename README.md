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

Select a screen or window. Select a microphone or camera if needed. Select Start recording. The app shows 3, 2, 1 before capture starts. Use Cancel countdown if you are not ready. A red screen border and a Recording label show when capture is active. The border turns amber when paused. It closes when capture stops. Use Pause, Resume, and Stop and save to control the recording. For a camera recording without a screen, select Camera only.

The top bar of the app shows the recording state and the recorded time in the library and the editor. Select it to show the recording controls. Settings are locked during a recording.

For screen capture, the border marks the selected display. For window or camera capture, it appears on all connected displays as a recording indicator. It also appears on all displays if Windows does not supply the screen's display ID. The border lets mouse clicks pass through and does not take keyboard focus. Windows capture protection is enabled for the indicator. Verify that it stays out of the saved video on your Windows capture system.

Use Import video to add an existing MP4, WebM, MOV, or MKV file. The app copies the source into its library.

Type in Search by title to find a video. The library count always shows all videos. If no title matches, select Clear search. An Edited label shows on a video that has edits.

Open a video to edit it. Keep range trims the video to the specified range. Remove range cuts out that range. All times refer to the current edited video. Select Use playhead to set the start or end to the current preview time. The range fields show two decimals. At some speeds, the edited end has more decimals. For example, a 10 second video at 1.5x speed ends at 6.666... seconds. A playhead at the end, or an end value up to 0.005 seconds after the end, selects the exact end. The timeline shows the kept parts of the source video, the playhead, and the selected range. Select a point on the timeline to move the playhead. Speed and mute settings also apply to export. Undo, Redo, and Reset all edits keep the source file unchanged.

The app prepares edited previews in the background. The preview and export use the same FFmpeg renderer. The app also prepares a compatible preview if it cannot play an imported source codec. Preview controls become available when the preview is ready.

Export MP4 writes a new H.264 MP4 file at 30 frames per second. It does not replace an existing file. The Exports list below the editor shows the file name, folder, and state of each export of the open video. A message shows when an export is complete or fails.

### Keyboard shortcuts

Editor keys do not operate when a text field or a list has focus. A key that you press during an operation applies after the operation is complete.

| Key                                       | Action                                     | Shared command                    |
| ----------------------------------------- | ------------------------------------------ | --------------------------------- |
| Space or K                                | Play or pause the preview                  | `playback.play`, `playback.pause` |
| Left arrow or Right arrow                 | Move the playhead 5 seconds                | `playback.seek`                   |
| Shift + Left arrow or Shift + Right arrow | Move the playhead 1 second                 | `playback.seek`                   |
| I or O                                    | Set the range start or end to the playhead | None. This changes a form value.  |
| Ctrl + Z                                  | Undo an edit                               | `edit.undo`                       |
| Ctrl + Shift + Z or Ctrl + Y              | Redo an edit                               | `edit.redo`                       |
| F                                         | Enter or leave fullscreen preview          | `playback.fullscreen`             |
| / or Ctrl + F                             | Go to the library search                   | None                              |
| Esc                                       | Clear the search, or leave fullscreen      | `playback.fullscreen`             |

## Storage

The default data folder is `.local/data` in this project folder. The app, CLI, and MCP use this same folder even when they start from another working folder. It contains:

- `library.json`, the video records and edit history.
- `media`, the source video copies.
- `pending`, recording files that the app has not yet imported.
- `previews`, cached copies of edited videos. Deleting a library video also removes its previews.
- `connection.json`, the local agent connection and token.
- `electron`, the desktop session data.

Set `MIDNIGHT_DATA` to use another folder. Use the same value for the desktop app, CLI, and MCP server. Use an absolute path when you start these programs from different folders.

If an earlier version created a library in another working folder, set `MIDNIGHT_DATA` to that library's `.local/data` path. The app does not move existing video files.

```powershell
$env:MIDNIGHT_DATA = 'C:\Videos\Midnight'
npm start
```

Set `FFMPEG_PATH` and `FFPROBE_PATH` if the programs are not on `PATH`.

If a save fails, leave the app open. Select Stop and save to retry. Cancel recording removes the pending recording. If the app stops unexpectedly, keep files in `pending`. You can import a readable pending file through `library.import`. Automatic recovery after an app crash is not yet available. Cached previews use extra disk space.

After capture stops, the recording state is `stopped` while the app adds the video to the library. The app shows Saving. The state has no `error` value during this step. If the import fails, the state stays `stopped`, `error` has the message, and the app shows Not saved. If the import is complete but the recorder cleanup fails, `saved` has the library video, `error` has the cleanup message, and the app shows Saved. Cleanup failed. Stop and save then tries the cleanup again and does not import a second copy. Cancel recording keeps the saved video. A retry removes the old `error` value before it starts.

If a recording write fails, capture pauses and `app.status` reports a recording state of `failed` with an `error` message. The desktop app shows the same error. Stop and save and Cancel remain available. The app keeps the pending file after a failed Stop. It does not repeat a failed write because the file can contain part of that write. The pending file can be incomplete or unreadable. Copy it before you select Cancel if you want to attempt manual recovery.

## CLI

Start the desktop app first. The examples use this project folder. From another folder, use the full path to `src/agent/cli.js`. Commands return JSON. Errors use standard error and a nonzero exit code.

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

Use `recording.countdown` with the same arguments as `recording.start` to get the same 3, 2, 1 countdown as the desktop button. It returns an `id`, `state: "countdown"`, and `remaining: 3`. Poll `app.status` until recording starts. Use `recording.cancel` to cancel the countdown. A startup failure returns the recorder to `idle` with an `error` message. `recording.start` starts capture immediately. Both commands use the native recording border. These commands are also available through MCP.

The service keeps the recording time in the shared state. A reloaded app page and CLI or MCP clients read the same values from `app.status`:

- `startedAt` is the time when capture started.
- `pausedSeconds` is the total time of completed pauses, in seconds.
- `pausedAt` is the start time of the current pause or capture failure. It is not present while capture is active.
- `stoppedAt` is the time when capture stopped.
- `recordedSeconds` is the recorded time without pauses at the time of the request. Only `app.status` adds this value.

The recorded time is the time from `startedAt` to `pausedAt`, `stoppedAt`, or now, less `pausedSeconds`. The times are ISO 8601 strings from the computer clock.

`recording.start` returns a recording `id`. Capture adapters use `recording.fail` with this `recordingId` and an `error` message to report a failure through the shared service. This command pauses capture and retains the pending data. The service ignores duplicate failure reports and reports for an old recording ID.

`help` returns the complete command catalog and argument schemas. It works when the desktop app is closed.

After `playback.open`, poll `playback.status` until `ready` is `true`. If `error` has a value, preview preparation failed. `preview.start` prepares a cached preview without opening the editor. Use `export.status` to read its job state.

## Inspect video frames

Agents can read images from the edited video without moving the player. Use one timestamp for one frame, or up to 12 timestamps to check a sequence. These times include cuts and speed changes.

```powershell
node src/agent/cli.js inspect.start '{"id":"VIDEO_ID","timestamps":[1,2.9,3,4.5],"width":960,"grid":true}'
node src/agent/cli.js export.status '{"jobId":"JOB_ID"}'
node src/agent/cli.js inspect.result '{"jobId":"JOB_ID","includeImages":false}'
```

Wait until the job state is `complete` before calling `inspect.result`. A failed job has an `error` value. `export.status` returns paths and metadata. It does not load image data. Inspection jobs run in the background. Recording controls remain available. The first request can require a full edited preview render. Each inspection scans the preview's frame times, so long videos take more time.

`inspect.result` includes image data by default. MCP returns native PNG image blocks that an image-capable agent can see. The CLI returns the same images as base64 in JSON. Set `includeImages` to `false` to get paths only. Inline image data has an 8 MiB total limit. If this limit is exceeded, use fewer timestamps, a smaller width, or paths only.

Each frame has these fields:

- `requestedSeconds` is the time you requested in the edited video.
- `seconds` is the selected frame's actual presentation time. The tool selects the frame at or before the requested time.
- `sourceSeconds` maps that edited time back to the source timeline. This is a timeline position, not a source frame number.
- `width` and `height` are the image dimensions. `videoSize` gives the edited video's full dimensions.
- `path` is the local PNG file. `data` contains base64 PNG data when requested through the CLI.

The origin is the top left corner. The x coordinate increases to the right. The y coordinate increases down. Divide image x by image width, and image y by image height, to get coordinates from 0 to 1. Multiply those values by `videoSize.width` and `videoSize.height` to get full-size video coordinates. The optional grid has 10 rows and 10 columns. It appears only on inspection images.

The width defaults to 960 pixels. The allowed width is 160 to 1920 pixels. The height is at most 1080 pixels. Small images do not enlarge. Timestamps must be at least zero and strictly before the edited duration. Results keep the request order, including duplicate timestamps.

Check `stale` before using a result to place elements. It becomes `true` if the current edits differ from the inspected edits. Pass the returned `revision` to `inspect.start` to reject a request based on changed edits. Jobs last until the app closes. Deleting a library video also deletes its inspection images.

For label placement, inspect the start, middle, and end of the proposed interval. Inspect more frames near a visible change. Sampling can miss motion between frames. These commands provide visual input and coordinates. Text, shape, and transition editing are not yet app commands.

Run `npm run practice:inspection` to test the workflow. It opens a separate app with a test library, makes a sample video, calls the CLI and MCP, and saves images and a JSON report under `.local`. The sample Save button changes position at source time 3. The practice then cuts source time 1 to 2 and sets speed to 0.5. The button changes position at edited time 4. The normal library stays unchanged.

## Timed speech

Run `npm run setup:transcription` once to install local English speech recognition. Start the app, then use `transcript.start`, `transcript.status`, `transcript.read`, and `transcript.search`. Search results include edited timestamps for frame inspection. Speech jobs support cancellation, bounded reads, cached results, and cut-word warnings.

See [setup and agent instructions](docs/transcription.md) and [tests on downloaded public videos](docs/transcription-validation.md). Audio stays on this computer. Word times and text are estimates. Text, shape, and transition editing remain separate work.

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

| Task               | Commands                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| App state and view | `app.status`, `app.view`                                                                                                                |
| Capture selection  | `capture.sources`, `capture.devices`                                                                                                    |
| Recording          | `recording.countdown`, `recording.start`, `recording.pause`, `recording.resume`, `recording.stop`, `recording.cancel`, `recording.fail` |
| Library            | `library.list`, `library.get`, `library.import`, `library.rename`, `library.delete`                                                     |
| Editing            | `edit.trim`, `edit.cut`, `edit.configure`, `edit.undo`, `edit.redo`, `edit.reset`                                                       |
| Export             | `export.start`, `export.status`                                                                                                         |
| Preview rendering  | `preview.start`, with job state from `export.status`                                                                                    |
| Frame inspection   | `inspect.start`, `inspect.result`, with job state from `export.status`                                                                  |
| Timed speech       | `transcript.capabilities`, `transcript.start`, `transcript.status`, `transcript.read`, `transcript.search`, `transcript.cancel`         |
| Preview            | `playback.open`, `playback.play`, `playback.pause`, `playback.seek`, `playback.status`, `playback.configure`, `playback.fullscreen`     |

## Code structure

- `src/domain` has time-range edits and time conversion. It has no Electron or file-system dependencies.
- `src/application` has command schemas, validation, and workflow state. It uses injected adapters.
- `src/adapters` has file storage and FFmpeg operations.
- `src/desktop` has Electron setup, capture, permissions, and IPC.
- `src/ui` has the desktop page and styles. `src/ui/view-model.js` has the page state rules and keyboard map. It has no DOM or Electron dependencies, so `node:test` checks it directly.
- `src/agent` has the local server, CLI, and MCP adapters.

The command service serializes changes. Exports run as background jobs. Each export uses the edit state from the time the job starts.

## Tests and verification limits

```powershell
npm test
```

The suite includes real FFmpeg operations, authenticated CLI and MCP calls, and Electron desktop tests. It needs a Windows desktop session and local loopback access. Tests use separate folders under `.local`.

Camera and microphone tests use Chromium test devices. They check visible video frames and an audio track. They do not verify physical devices.

Run `npm run verify:desktop` in a normal Windows desktop session to check real screen video, window video, and system audio. This check plays a short, quiet test tone.

The current agent execution session reports Windows capture access errors and produces black screen and window video. A direct FFmpeg GDI capture also fails with Windows error 5, access denied. System audio passes the tone check. Camera, microphone, and overlay tests use Chromium test devices. Visible desktop content and physical devices still require verification in a normal desktop session. Do not treat the lifecycle test as proof of visible screen capture.

The app uses Electron 45.2.1. It disables the Windows D3D11 camera capture path because that path caused the video capture service to stop during the combined camera and screen test. GPU rendering remains enabled.

There is no cloud upload, hosted share link, or account system. Share an exported MP4 through a file-sharing method of your choice. Timed English transcripts are local.
