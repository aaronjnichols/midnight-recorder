# Timed text elements

Use timed text elements to show labels and notes on the edited video. Agents and scripts use the shared commands through the CLI or MCP. The desktop editor shows the elements in its preview. The desktop editor does not have controls to add or change elements yet.

The original video file does not change. The preview, the exported MP4, and frame inspection use the same rendering.

## Commands

| Command             | Result                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `element.add`       | Adds a text element. Returns `video` and `element`. The element has a new `id`.              |
| `element.update`    | Changes the properties that you give. Other properties stay the same.                        |
| `element.duplicate` | Copies an element. The copy has a new `id` and is directly above the original.               |
| `element.order`     | Moves an element to a layer `index`. Index 0 is the bottom layer.                            |
| `element.remove`    | Removes an element. Returns `video` and `removed`.                                           |
| `element.list`      | Gives all elements, bottom layer first, with edited times, `visibility`, and the `revision`. |

Each change is one step in the edit history. `edit.undo` and `edit.redo` use the same history as trim, cut, speed, and mute. `edit.reset` has an optional `scope`:

- `all` (default) resets trim, cut, speed, and mute, and removes all elements.
- `timeline` resets trim, cut, speed, and mute. Elements stay.
- `elements` removes all elements. Other edits stay.

## Coordinates

- `x`, `y`, `width`, and `height` give the element box. The values are from 0 to 1 of the rendered frame.
- The origin is the top left corner. x increases to the right. y increases down.
- These are the same coordinates as `inspect.result`. Divide image x by image width, and image y by image height.
- The box must be fully in the frame: `x + width` and `y + height` must be at most 1.
- `size` is the font size as a fraction of the frame height. For example, 0.05 on a 1080-pixel video is 54 pixels.
- The frame is the frame that FFmpeg makes. A video with a 90 or 270 degree display rotation, for example from a phone, has its width and height changed. A video with a different rotation angle keeps its frame size. The width and height are rounded down to even numbers, as in export.

## Times

- `start` and `end` are in edited seconds by default. These are the same times as `playback.seek` and `inspect.start`.
- Set `timeBase` to `source` to give seconds in the original file.
- A frame shows the element when its time is at least `start` and less than `end`. Times have microsecond precision. For example, with `start` 1.00005, the frame at 1 second does not show the element.
- An element must show for at least 0.05 seconds. The range must be in the edited video.
- The app stores `sourceStart` and `sourceEnd`. So the element stays on the same video content after trim, cut, or speed changes.
- A start on a cut boundary goes after the cut. An end on a cut boundary goes before the cut. A time less than 1 microsecond from a cut boundary is on the boundary. So an edited time from `element.list`, which has microsecond precision, gives the same result as the exact boundary.

## Output clock

The preview, the export, and frame inspection use one clock: the edited time.

- The video has 30 frames per second at all speeds. Frame n starts at exactly n ÷ 30 seconds. Frame 0 starts at 0.
- The number of frames is the edited duration × 30, rounded up. So the video is at most one frame (0.033 seconds) longer than the edited duration. Cuts do not add frames.
- Frame n shows the source frame that is on screen at the source time of n ÷ 30. A source with a different frame rate first goes to 30 frames per second.
- If the video track stops before the edited end, the last frame stays on screen.
- Before AAC encoding, the audio has the edited duration, rounded to one sample. Each kept part starts at its edited time, so rounding at cuts does not accumulate. AAC encoding can add padding at the end of the file.
- Changing speed can move short sounds slightly. In the tested clips at speed 1.25, sound starts were 13 to 18 milliseconds early. The error did not increase over the clip. Check speech timing after a speed change.
- Elements are drawn on the final frames, so the frame times in the MP4 and in `inspect.result` are the times that the `[start, end)` rule uses.

`element.list` and the results of `edit.trim`, `edit.cut`, `edit.configure`, `edit.undo`, `edit.redo`, and `edit.reset` give the placement of each element:

- `full`: all of the element content is in the edited video.
- `partial`: a trim or cut removed some of the element content. `start` and `end` give the remaining interval.
- `none`: a trim or cut removed all of the element content. `start` and `end` are `null`. The app does not draw the element. The element stays in the list, so undo can show it again. Change its times or remove it.

The edit results give this placement in `elementPlacement`. The app does not store `elementPlacement`.

## Text properties

| Property            | Values                                        | Default   |
| ------------------- | --------------------------------------------- | --------- |
| `text`              | 1 to 500 characters, at most 10 lines         | necessary |
| `x`, `y`            | 0 to 1                                        | 0.1, 0.4  |
| `width`, `height`   | 0.01 to 1                                     | 0.8, 0.2  |
| `font`              | `sans`, `serif`, `mono`                       | `sans`    |
| `bold`              | `true` or `false`                             | `false`   |
| `size`              | 0.01 to 0.5 of the frame height               | 0.06      |
| `color`             | `#RRGGBB`                                     | `#FFFFFF` |
| `opacity`           | 0.1 to 1                                      | 1         |
| `align`             | `left`, `center`, `right`                     | `center`  |
| `verticalAlign`     | `top`, `middle`, `bottom`                     | `middle`  |
| `background`        | `#RRGGBB` or `none`. Fills the full box.      | `none`    |
| `backgroundOpacity` | 0 to 1                                        | 0.75      |
| `outline`           | `#RRGGBB` or `none`. A thin line around text. | `#000000` |

Use a line feed (`\n` in JSON) for a new line. Tabs are permitted. Other control characters are not permitted. The text shows as written. The app does not read markup, expressions, or commands in the text.

On Windows, `sans` is Segoe UI, `serif` is Georgia, and `mono` is Consolas. A font has a fixed set of characters. Characters that the font does not have, for example some symbols, emoji, or Chinese characters, show as empty boxes. Inspect a frame to check the text.

The text does not wrap. Text that is too large can extend outside its box. The box does not cut the text. Use line feeds, a smaller `size`, or a larger box.

## Revisions

`element.list` returns a `revision`. It changes after each change to trim, cut, speed, mute, or elements. Use it with:

- `inspect.start` to reject a request when the edits changed.
- `export.start` to export only the edit state that you checked.
- `preview.start` to reject a stale preview request.

`inspect.result` gives `stale: true` after a change to the edits, including elements. Export, preview, and inspection jobs use a copy of the edits at their start. Their job records include this `revision`. A later edit does not change a running job.

Transcripts use a different revision. Text elements do not change speech times, so they do not make a transcript stale. You can give a transcript revision to `inspect.start`, `preview.start`, or `export.start`. Then the command rejects only a changed trim, cut, speed, or mute. To check the elements as well, use the revision from `element.list` or `inspect.result`.

## Example

PowerShell examples. Start the desktop app first.

```powershell
node src/agent/cli.js element.add '{"id":"VIDEO_ID","type":"text","text":"Click Save","start":1.5,"end":4,"x":0.1,"y":0.45,"width":0.2,"height":0.12,"bold":true,"size":0.05,"background":"#5E81AC","backgroundOpacity":0.95}'
node src/agent/cli.js element.update '{"id":"VIDEO_ID","elementId":"ELEMENT_ID","text":"Click Save\nThen close","height":0.18}'
node src/agent/cli.js element.list '{"id":"VIDEO_ID"}'
node src/agent/cli.js inspect.start '{"id":"VIDEO_ID","timestamps":[1.5,2.75,3.9],"grid":true,"revision":"REVISION"}'
node src/agent/cli.js export.start '{"id":"VIDEO_ID","path":"C:/Videos/demo.mp4","revision":"REVISION"}'
```

Agent procedure:

1. Inspect frames at the start, middle, and end of the planned interval.
2. Convert the target area from image pixels to 0 to 1 coordinates.
3. Add the element with `element.add`.
4. Read `revision` from `element.list`. Inspect the same times again with this revision.
5. Change the element with `element.update` if necessary.
6. Export with the revision that you checked.
