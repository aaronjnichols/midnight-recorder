# Timed elements, captions, and fades

Use timed elements to show labels, notes, highlights, and arrows on the edited video. Use [captions](#captions) to show the speech as text. You can add and change both in the desktop editor. Agents and scripts use the same shared commands through the CLI or MCP.

The original video file does not change. The preview, the exported MP4, and frame inspection use the same rendering.

The available transition effects are:

- Fade in and fade out for each element. This changes the opacity of the element.
- Fade in from black and fade out to black for the full video, with the sound. Elements and captions fade with the picture.

There are no crossfades between clips, no wipes or other transitions, and no multiple video tracks.

## Desktop editor

Open a video in the library. The editor fills the window. The library sidebar does not show, and the page does not scroll. The inspector scrolls by itself. The editor has these parts:

- **Top bar.** Library goes back to the library. The title and the video size. The save state and the preview state. Undo, Redo, and Export MP4. Exporting… shows while an export runs. Select it to open Details.
- **Add buttons above the video.** Text, Label, Rectangle, Ellipse, and Arrow add an element at the playhead. The element shows for 3 seconds, or less if the video is shorter. Label adds text with a dark background that is easy to read.
- **Video.** The rendered preview is the exact result. Dashed outlines show the elements at the playhead. Select an element to see its handles. Drag the element to move it. Drag a square handle to change its size. For an arrow, drag the round handles: the yellow handle is the tip. Press Esc during a drag to cancel it. Nothing is saved until you release the pointer. Each drag is one undo step.
- **Timeline dock.** One control row, the ruler, the track, and the lanes. See [Timeline](#timeline).
- **Inspector and tool rail.** Five tools. Only one tool shows at a time. The rail is at the far right. The inspector scrolls by itself, so the video and the timeline stay in view. A video opens with Trim & cut.
  - **Trim & cut:** the exact selection start and end, each with Set to playhead (keys I and O), and what Keep and Remove do. The line below the fields gives the selection, or tells you why the actions are not available.
  - **Text & shapes:** Layers, with Duplicate, Forward, Backward, and Delete for the selected element in its heading, and the properties of the selected element. Position and size, arrow points, and fade and opacity are in disclosures.
  - **Captions:** see [Captions](#captions).
  - **Speed & sound:** playback speed, mute, and the video fades.
  - **Details:** the title, the Exports list, the keyboard shortcuts, Reset all edits, and Delete video.
- **Layers** (in Text & shapes). One row for each element. The top row shows in front. Select a row to select the element. A click also moves the playhead into the element's time. A row in yellow is not in the edited video, because a cut or trim removed its time.

A selection opens its tool. If you select an element in the video, on the timeline, in Layers, or with an Add button, Text & shapes opens with its properties. If you select a caption, Captions opens with the caption. A tool change does not change the video, the undo history, the selection, the selection times, or the playhead. A command result that arrives after you open another tool does not change the tool.

The selection times stay when you change elements, captions, or the style. A trim, cut, or speed change moves the edited times, so the selection is then the full video again.

A change saves when you leave a field or press Enter. This is also true when you open another tool or press the timeline. Each field sends only its own value. For example, a font size change does not send the times again.

The save state belongs to the open video. Saved means that the library has all edits to this video. Saving… means that a command runs. Not saved yet means that a field has a change. Not saved means that the last change was rejected, and the message tells the reason. A draft selection does not change this state, because it is not an edit.

### Timeline

The dock is as wide as the window. Its control row has Play, the time, the selection, Keep, Remove, the preview volume, Fullscreen, and the zoom controls. In fullscreen, the row stays with Play, the time, the volume, and Fullscreen.

- **Ruler.** Select a point or drag to move the playhead. Esc during this drag returns to the earlier time. The labels change with the zoom.
- **Track.** Select a point to move the playhead. Drag to make a new draft selection, in either direction. The areas outside a selection are darker.
- **Selection.** Drag a gold handle to change one end. The other end keeps its exact value. Drag the selection to move it: the length stays. A handle stops at the other handle, with a selection of at least 0.05 seconds, and at the ends of the video. A dragged end goes to the ends of the video, a join between kept parts, and the playhead when it is within 6 pixels. A selected handle has keys: arrows 0.1 seconds, Shift and arrows 1 second, Page Up and Page Down 5 seconds, and Home and End.
- **Draft.** A drag changes only the selection fields. No edit command runs, and no preview renders. Esc or a lost pointer returns the selection from before the drag. After a drag, Esc first clears a selected element or caption. If none is selected, Esc clears the selection. The X beside the selection also clears it. Keep and Remove are the edits. Each is one undo step.
- **Zoom.** Zoom in, Zoom out, and Fit, or Ctrl and the mouse wheel over the timeline, which keeps the time under the pointer in place. The largest zoom is 400 pixels for each second. The mouse wheel scrolls a zoomed timeline. A drag at the edge of the view scrolls it. The view follows the playhead. Zoom is a page view, so it sends no command.
- **Lanes.** One bar for each element and caption that is in the edited video. Elements use two rows. If more elements overlap, the bars share the last row without their names, and Layers lists all of them. So many elements do not make the dock taller. A selected bar is in front and has handles. Select a bar to select its item: the playhead moves into its time. Drag a bar to move its time. It sends both times. Drag a handle to change one time. It sends only that time, so a stored time that a cut hides stays. The first drag of a bar also selects it. One drag is one command and one undo step. Esc or a lost pointer sends nothing. A drag ends if the video or its timing changes during the drag. A caption stops at the captions around it, also at a caption that a cut hides.

### Timeline overview

The frames and the sound wave on the track are real data from the source video. Commands read them once for each source. Pure code then maps them through the current segments and speed. So a trim, cut, or speed change shows at once and needs no new read. The data does not show elements, captions, fades, or mute. A muted edit shows a gray wave and the note Muted in this edit. The rendered preview is the exact picture.

| Command           | Result                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `overview.start`  | Starts a read, or joins a read of the same source. Returns the job with `id` and your `holder`. It returns at once. Poll `export.status`.                    |
| `overview.cancel` | With `holder`, your caller leaves the read. The read stops when no caller needs it. Without `holder`, the read stops for all callers.                        |
| `overview.result` | The state of the sound and frames, and `window.levels` for an edited time range. Available when the job is complete, or when `export.status` has `progress`. |

```powershell
node src/agent/cli.js overview.start '{"id":"VIDEO_ID"}'
node src/agent/cli.js export.status '{"jobId":"JOB_ID"}'
node src/agent/cli.js overview.result '{"jobId":"JOB_ID","start":0,"end":30,"buckets":60}'
```

`overview.result` gives:

- `audio.state`: `ready`, `silent`, `none` (no sound track), or `failed` with `error`.
- `frames.state`: `ready`, `partial` (the time limit stopped the read), `reading`, or `failed` with `error`.
- `window.levels`: from 0 to 1, the loudest sound in each equal part of `start` to `end`, in edited seconds, through the current edits. The scale is the square root of the RMS level relative to full scale, not decibels. `buckets` is from 1 to 1000. The default is 100.
- `revision`: the edit revision of this mapping.
- With `includeData: true`: the source levels as base64 and the frame images as base64 JPEG. The page uses this. It can be some hundred kilobytes. To view frames, agents use `inspect.start`.

Limits:

- The sound read streams through fixed memory at 8000 samples for each second, into at most 65536 levels. A level covers at least 0.02 seconds.
- At most 48 frames, with one seek for each frame, at most 160 x 90 pixels and 256 KiB for each frame. Frame times are spread over the full video in the order of work, so a time limit leaves frames from all of it. Each frame has its decoded source time.
- One read has a limit of 180 seconds, and the frames have a limit of 60 seconds. One read runs at a time. Reads run outside the command queue, so playback, status, and edits do not wait for them.
- The sound is ready first. The track shows it while the frames continue.
- The result is one cache file in the preview folder of the video. Its key has the video ID, path, metadata, file size, file time, and a format version. A damaged file reads the source again. A failed part is not cached, so Retry or a new `overview.start` reads again.
- A frame shows only in its own kept part. A short kept part with no sampled frame stays empty. A long video has fewer frames for each minute, so a short kept part in it can be empty.
- The service keeps the last 16 completed overview jobs. A running read does not stop a video delete: the delete stops the read first. It also does not hold the app window open.

Units in the panel:

- Positions and sizes are percent of the video width or height.
- Font size and line width are percent of the video height.
- Times are seconds in the edited video. Set to playhead sets the start or end to the playhead time.
- Fades are seconds.

Keys: Delete and Backspace remove the selected element or caption of the open tool. A selection in another tool stays and does not change. Esc cancels a drag, then clears the selected element or caption, then clears the timeline selection. Ctrl+Z and Ctrl+Shift+Z undo and redo all edits. I and O set the selection start and end in every tool. + and - zoom the timeline, and 0 fits the video. On a tool tab, the arrow keys, Home, and End move between the tools. Keys in text fields and dialogs do not change elements.

After a change, the app makes a new exact preview. While it does this, the video area shows the original video at the same time, without elements, and the element outlines. A note on the video tells you this. The preview replaces it when it is ready, at the same playhead time. Changes from the CLI or MCP show in the editor in the same way.

Text does not wrap. If the text is larger than its box, the panel tells you, and **Make the text fit the box** makes the font size smaller. You can also add line breaks or make the box larger. In the video, text that is too large extends outside its box.

## Commands

| Command             | Result                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `element.add`       | Adds a `text`, `rectangle`, `ellipse`, or `arrow` element. Returns `video` and `element`.     |
| `element.update`    | Changes the properties that you give. Other properties stay the same. The type cannot change. |
| `element.duplicate` | Copies an element. The copy has a new `id` and is directly above the original.                |
| `element.order`     | Moves an element to a layer `index`. Index 0 is the bottom layer.                             |
| `element.remove`    | Removes an element. Returns `video` and `removed`.                                            |
| `element.list`      | Gives all elements, bottom layer first, with edited times, actual fades, and the `revision`.  |
| `edit.configure`    | Also sets the video fades `fadeIn` and `fadeOut` in seconds. The result gives `videoFades`.   |

A property that the element type does not use is an error. For example, an arrow does not use `fill`.

Each change is one step in the edit history. `edit.undo` and `edit.redo` use the same history as trim, cut, speed, mute, video fades, and captions. The history keeps the last 100 steps. An older step cannot be undone. `edit.reset` has an optional `scope`:

- `all` (default) resets trim, cut, speed, mute, and video fades, and removes all elements and captions.
- `timeline` resets trim, cut, speed, mute, and video fades. Elements and captions stay.
- `elements` removes all elements. Other edits stay.
- `captions` removes the captions. Other edits stay.

A reset is one undo step. Libraries from earlier versions load without changes. Their videos have no captions.

## Coordinates

- Values are from 0 to 1 of the rendered frame. The origin is the top left corner. x increases to the right. y increases down.
- These are the same coordinates as `inspect.result`. Divide image x by image width, and image y by image height.
- Text, rectangle, and ellipse use a box: `x`, `y`, `width`, and `height`. The box must be fully in the frame: `x + width` and `y + height` must be at most 1.
- An arrow uses its tail `x1`, `y1` and its tip `x2`, `y2`. The tip is the exact point that the arrow shows. To point at a control, put the tip on the center of the control in an inspected frame. An arrow must be at least 0.02 long. `element.list` also gives the rectangle around an arrow as `x`, `y`, `width`, and `height`.
- `size` (font size) and `strokeWidth` (line width) are fractions of the frame height. For example, 0.05 on a 1080-pixel video is 54 pixels.
- The line of a rectangle or ellipse is inside its box, so the box is the outer edge of the shape. A line that is at least half of the smaller side fills the shape.
- The frame is the frame that FFmpeg makes. A video with a 90 or 270 degree display rotation, for example from a phone, has its width and height changed. A video with a different rotation angle keeps its frame size. The width and height are rounded down to even numbers, as in export.

## Times

- `start` and `end` are in edited seconds by default. These are the same times as `playback.seek` and `inspect.start`.
- Set `timeBase` to `source` to give seconds in the original file.
- A frame shows the element when its time is at least `start` and less than `end`. Times have microsecond precision. For example, with `start` 1.00005, the frame at 1 second does not show the element.
- An element must show for at least 0.05 seconds. The range must be in the edited video.
- The app stores `sourceStart` and `sourceEnd`. So the element stays on the same video content after trim, cut, or speed changes.
- A start on a cut boundary goes after the cut. An end on a cut boundary goes before the cut. A time less than 1 microsecond from a cut boundary is on the boundary. So an edited time from `element.list`, which has microsecond precision, gives the same result as the exact boundary.

`element.list` and the results of `edit.trim`, `edit.cut`, `edit.configure`, `edit.undo`, `edit.redo`, and `edit.reset` give the placement of each element:

- `full`: all of the element content is in the edited video.
- `partial`: a trim or cut removed some of the element content. `start` and `end` give the remaining interval.
- `none`: a trim or cut removed all of the element content. `start` and `end` are `null`. The app does not draw the element. The element stays in the list, so undo can show it again. Change its times or remove it.

The edit results give this placement in `elementPlacement`. The app does not store `elementPlacement`.

## Fades and opacity

- `fadeIn` and `fadeOut` are edited seconds, from 0 to 10. The element opacity goes in a straight line from 0 at `start` to full at `start + fadeIn`, and from full at `end - fadeOut` to 0 at `end`.
- If `fadeIn + fadeOut` is longer than the element shows, both get shorter in proportion. This can also happen after a cut, a trim, or a speed change. `actualFadeIn` and `actualFadeOut` in `element.list` and in command results give the values that the video uses. The stored values do not change, so an undo gives the full fades again. The editor shows the actual value under the field when it is different.
- `opacity` and the fades apply to the full element after its parts are drawn. So a line over its fill, an arrow outline, or a letter over its background do not get brighter where they overlap. `fillOpacity` and `backgroundOpacity` set the opacity of one part.
- Video fades use `edit.configure` with `fadeIn` and `fadeOut`, from 0 to 10 seconds. The picture fades from black and to black. The elements fade with the picture. The sound fades at the same time. If both together are longer than the edited video, both get shorter in proportion. `videoFades` in the results of the `edit.*` commands and `element.list` gives the actual values.

## Output clock

The preview, the export, and frame inspection use one clock: the edited time.

- The video has 30 frames per second at all speeds. Frame n starts at exactly n ÷ 30 seconds. Frame 0 starts at 0.
- The number of frames is the edited duration × 30, rounded up. So the video is at most one frame (0.033 seconds) longer than the edited duration. Cuts do not add frames.
- Frame n shows the source frame that is on screen at the source time of n ÷ 30. A source with a different frame rate first goes to 30 frames per second.
- If the video track stops before the edited end, the last frame stays on screen.
- Before AAC encoding, the audio has the edited duration, rounded to one sample. Each kept part starts at its edited time, so rounding at cuts does not accumulate. AAC encoding can add padding at the end of the file.
- Changing speed can move short sounds slightly. In the tested clips at speed 1.25, sound starts were 13 to 18 milliseconds early. The error did not increase over the clip. Check speech timing after a speed change.
- Elements are drawn on the final frames, so the frame times in the MP4 and in `inspect.result` are the times that the `[start, end)` rule uses.

## Properties

All types have `opacity` (0.1 to 1, default 1), `fadeIn` and `fadeOut` (0 to 10 seconds, default 0).

Text:

| Property            | Values                                        | Default   |
| ------------------- | --------------------------------------------- | --------- |
| `text`              | 1 to 500 characters, at most 10 lines         | necessary |
| `x`, `y`            | 0 to 1                                        | 0.1, 0.4  |
| `width`, `height`   | 0.01 to 1                                     | 0.8, 0.2  |
| `font`              | `sans`, `serif`, `mono`                       | `sans`    |
| `bold`              | `true` or `false`                             | `false`   |
| `size`              | 0.01 to 0.5 of the frame height               | 0.06      |
| `color`             | `#RRGGBB`                                     | `#FFFFFF` |
| `align`             | `left`, `center`, `right`                     | `center`  |
| `verticalAlign`     | `top`, `middle`, `bottom`                     | `middle`  |
| `background`        | `#RRGGBB` or `none`. Fills the full box.      | `none`    |
| `backgroundOpacity` | 0 to 1                                        | 0.75      |
| `outline`           | `#RRGGBB` or `none`. A thin line around text. | `#000000` |

Rectangle and ellipse:

| Property          | Values                               | Default   |
| ----------------- | ------------------------------------ | --------- |
| `x`, `y`          | 0 to 1                               | 0.3, 0.3  |
| `width`, `height` | 0.01 to 1                            | 0.4, 0.3  |
| `fill`            | `#RRGGBB` or `none`                  | `none`    |
| `fillOpacity`     | 0 to 1                               | 0.25      |
| `stroke`          | `#RRGGBB` or `none`. The line color. | `#EBCB8B` |
| `strokeWidth`     | 0.002 to 0.05 of the frame height    | 0.006     |

A rectangle or ellipse needs a visible part: a fill with `fillOpacity` above 0, or a line.

Arrow:

| Property      | Values                                         | Default   |
| ------------- | ---------------------------------------------- | --------- |
| `x1`, `y1`    | 0 to 1. The tail.                              | 0.3, 0.7  |
| `x2`, `y2`    | 0 to 1. The tip.                               | 0.5, 0.5  |
| `color`       | `#RRGGBB`                                      | `#EBCB8B` |
| `strokeWidth` | 0.002 to 0.05 of the frame height. The shaft.  | 0.008     |
| `outline`     | `#RRGGBB` or `none`. A thin line for contrast. | `#000000` |

The arrow head size follows the shaft width.

Use a line feed (`\n` in JSON) for a new line in text. Tabs are permitted. Other control characters are not permitted. The text shows as written. The app does not read markup, expressions, or commands in the text.

On Windows, `sans` is Segoe UI, `serif` is Georgia, and `mono` is Consolas. A font has a fixed set of characters. Characters that the font does not have, for example some symbols, emoji, or Chinese characters, show as empty boxes. Inspect a frame to check the text.

## Revisions

`element.list`, `captions.list`, and `library.revision` return a `revision`. It changes after each change to trim, cut, speed, mute, video fades, elements, or captions. Use it with:

- `inspect.start` to reject a request when the edits changed.
- `export.start` to export only the edit state that you checked.
- `preview.start` to reject a stale preview request.

`inspect.result` gives `stale: true` after a change to the edits, including elements. Export, preview, and inspection jobs use a copy of the edits at their start. Their job records include this `revision`. A later edit does not change a running job.

Transcripts use a different revision. Elements, captions, and video fades do not change speech times, so they do not make a transcript stale. You can give a transcript revision to `inspect.start`, `preview.start`, or `export.start`. Then the command rejects only a changed trim, cut, speed, or mute. To check the elements and captions as well, use the revision from `element.list`, `captions.list`, or `inspect.result`. Caption commands always use the full revision.

## Example

PowerShell examples. Start the desktop app first.

```powershell
node src/agent/cli.js element.add '{"id":"VIDEO_ID","type":"text","text":"Press Play to start","start":6.3,"end":9.3,"x":0.12,"y":0.62,"width":0.34,"height":0.08,"size":0.035,"bold":true,"background":"#1E2127","backgroundOpacity":0.85,"outline":"none","fadeIn":0.3}'
node src/agent/cli.js element.add '{"id":"VIDEO_ID","type":"arrow","start":6.3,"end":9.3,"x1":0.33,"y1":0.72,"x2":0.4115,"y2":0.8667,"color":"#EBCB8B"}'
node src/agent/cli.js element.add '{"id":"VIDEO_ID","type":"rectangle","start":6.3,"end":9.3,"x":0.854,"y":0.392,"width":0.115,"height":0.265,"stroke":"#EBCB8B","strokeWidth":0.006}'
node src/agent/cli.js element.update '{"id":"VIDEO_ID","elementId":"ELEMENT_ID","fadeOut":0.5}'
node src/agent/cli.js edit.configure '{"id":"VIDEO_ID","fadeIn":1,"fadeOut":1}'
node src/agent/cli.js element.list '{"id":"VIDEO_ID"}'
node src/agent/cli.js inspect.start '{"id":"VIDEO_ID","timestamps":[6.5,8,9.2],"grid":true,"revision":"REVISION"}'
node src/agent/cli.js export.start '{"id":"VIDEO_ID","path":"C:/Videos/demo.mp4","revision":"REVISION"}'
```

Agent procedure:

1. Inspect frames at the start, middle, and end of the planned interval.
2. Convert the target area from image pixels to 0 to 1 coordinates. For an arrow, use the target center as the tip.
3. Add the element with `element.add`.
4. Read `revision` from `element.list`. Inspect the same times again with this revision.
5. Change the element with `element.update` if necessary.
6. Export with the revision that you checked.

## Captions

A video has one caption track. It is separate from the elements: a caption change does not change labels or shapes, and an element change does not change captions. Each caption (cue) has text and a source time range. So a caption stays on its speech after a trim, cut, or speed change, like an element.

### Desktop editor

- **Captions tool.** Make captions from speech starts the local speech recognition. The tool shows the progress, for example "Recognizing speech: part 2 of 4". Cancel stops the job, and nothing changes. When recognition is complete, the app adds the captions as one undo step. The tool then shows the result: the number of captions, and a warning if some speech is not in the captions. If you change the video during recognition, the app does not add the captions. Select Add captions to add them to the current edits.
- **Replace.** If the video has captions, the app asks you to confirm the replacement. The confirmation shows the scope: all captions, or the captions in the selection on the timeline. If you change the selection times or Only the selection, the confirmation closes. Labels and shapes do not change.
- **Caption list in the Captions tool.** One row for each caption, with its start time and text, like a transcript. Green shows the caption at the playhead. The list follows the playhead. It stops while you type in the selected caption, and for 4 seconds after you scroll it. Check shows a caption to examine. Part cut shows a caption that a cut made shorter. Cut shows a caption that is not in the edited video. Select a row to select the caption. A click also moves the playhead to it.
- **Caption lane on the timeline.** One bar for each caption in the edited video. See [Timeline](#timeline).
- **Selected caption** (at the bottom of the inspector, so the list stays above it). Change the text, the start, or the end. Set to playhead sets a time. Ctrl+Enter or leaving the text field saves the text. **Select on timeline** makes a draft selection with the time of the caption. Then Keep or Remove edits the video. **Delete caption**, or the Delete key while Captions is open, removes the caption only. The video does not change.
- **Caption style for all captions.** Size, position (bottom, middle, or top), text color, bold, and a background band with its opacity. A style change does not run speech recognition again.
- **Show captions** turns the captions on or off in the preview and the export. **Add caption** adds a caption in the gap at the playhead. **Remove all captions** removes the track.

One selection is active at a time: an element or a caption. Each change is one undo step. If the video has no sound, the Captions tool tells you, and you can add captions by hand. If the edit is muted, the captions still show, and the Captions tool tells you that the sound is muted.

### How captions are made from speech

The app uses all recognized words of the source and the current edits. It does not use one bounded read window.

- A complete word includes its attached parts, for example `'s` or a comma. A complete word belongs to the kept part of the video that contains the middle of its speech time. A word in a removed part is not used (`droppedWords`). If a cut removes part of a word, the word shows and its caption is marked Check.
- A new caption starts at a cut, after a pause of more than 1 second, after the end of a sentence, at a new speech segment if the caption has at least 20 characters, when the text would be longer than two lines, or when the caption would be longer than 6 seconds. Words never join across a cut.
- A caption shows for at least 0.8 seconds if it can, and for 0.3 seconds after its last word. It does not continue into the next caption, a cut, the range end, or the video end.
- A caption that would show for less than 0.3 seconds joins the next caption in the same kept part. A caption that cannot show for 0.05 seconds, for example a word just before a cut, is not made. Its words are counted in `skippedWords`, and the result has a `warning`.
- The line length comes from the caption area width and the font size, from 12 to 42 characters. Text breaks into two balanced lines. Text longer than 3 lines or 200 characters is shortened with "…" (`shortenedCues`). The result then has a `warning`.
- Check marks a caption with a word of low model probability (below 0.5), a word that a cut or the range clipped, estimated word times, or shortened text. The probability is not a calibrated accuracy score.
- With a range, a word belongs to the range that contains the middle of its speech time. Captions stay in the range: they do not start before the range start or end after the range end. Existing captions that overlap the range are replaced, also a caption that is partly outside the range. Other captions do not change. If the range has no kept speech, nothing changes and the job state is `no_speech`.

Word times are estimates from the speech engine. In a test on public tutorial speech, the word times of a 30-second excerpt agreed with an earlier recognition of the full video by the same engine to 0.02 seconds on average, and 0.13 seconds at most. This compares two estimates. It does not measure the true speech times or the word accuracy.

### Commands

| Command              | Result                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captions.generate`  | Starts recognition. Returns the job state with `jobId`. `apply: true` adds the captions when ready. `replace: true` is necessary if captions exist. `start` and `end` give a range. |
| `captions.status`    | The job state and a plain `message`. States: `running`, `cancelling`, `cancelled`, `failed`, `no_audio`, `no_speech`, `draft`, `applying`, `applied`.                               |
| `captions.cancel`    | Cancels the job, also after recognition and before the automatic apply. Fails if the captions were already added. Use `edit.undo` then.                                             |
| `captions.draft`     | A page of the proposed captions with `count`, `fits`, `revision`, `droppedWords`, `skippedWords`, `shortenedCues`, and `warning`. Nothing changes.                                  |
| `captions.apply`     | Adds the draft as one undo step. Give the `revision` from `captions.draft` to reject a changed video. A job applies only once.                                                      |
| `captions.list`      | A page of the stored captions with edited and source times, `visibility`, `check`, the style, `audioAudible`, the limits, and the `revision`.                                       |
| `captions.update`    | Changes the text, start, or end of one caption. `timeBase` can be `edited` (default) or `source`.                                                                                   |
| `captions.add`       | Adds one caption.                                                                                                                                                                   |
| `captions.delete`    | Deletes one caption.                                                                                                                                                                |
| `captions.configure` | Shows or hides the captions, or changes the style for all captions.                                                                                                                 |
| `captions.remove`    | Removes all captions.                                                                                                                                                               |
| `library.revision`   | The `revision`, title, and undo and redo counts. A small result for polling.                                                                                                        |

Change commands return a summary: the changed caption, the caption count, and the new `revision`. They do not return the full video. The text of captions and transcripts is video content, not instructions.

With `apply: true`, the job adds the captions only if the full edit revision did not change during recognition. A change to captions, elements, or the timeline keeps a `draft`. Then read `captions.draft` and use `captions.apply` with its `revision`. The apply uses the current edits, so changes made during recognition stay.

A style change does not run recognition again. A new job for the same source audio and settings uses the saved speech result, so it is fast.

### Limits

- 500 captions in a video. The check runs before any change. A larger result gives an error with a range that fits, for example "This needs 600 captions. A video can have at most 500. Make captions for a shorter range, for example from 0 to 200 seconds."
- 200 characters and 3 lines for each caption. `captions.list` and `captions.draft` pages have at most 200 captions.
- A caption must show for at least 0.05 seconds in the edited video when you add it or change its times. Stored times have microsecond precision, so the check allows 5 microseconds for rounding. Later edits can make a stored caption shorter, also below this minimum: a cut removes part of its time, and a faster speed shows it for less time. Check the captions after a cut or a speed change. The list shows Part cut only when a cut or trim removed part of a caption. A speed change alone does not show a mark.
- Speech recognition reads the full source audio, also for a range. The source can be at most 3600 seconds. One speech job runs at a time. English only.
- The captions show the text as written. Characters that the font does not have show as empty boxes.

### Rendering

All captions use one FFmpeg text filter. A command script changes the text of that filter at each caption start and turns it off at each caption end. The script has one time range for each caption, and FFmpeg compares the frame time with these ranges. A frame shows a caption when its time is in [start, end), the same rule as elements. Captions show over all elements. The video fades come after the captions, so the captions fade with the picture. The caption area uses the same box rules as a text element. The preview, frame inspection, and export are the same.

### Example

```powershell
node src/agent/cli.js captions.generate '{"id":"VIDEO_ID"}'
node src/agent/cli.js captions.status '{"jobId":"JOB_ID"}'
node src/agent/cli.js captions.draft '{"jobId":"JOB_ID","limit":50}'
node src/agent/cli.js captions.apply '{"jobId":"JOB_ID","revision":"REVISION"}'
node src/agent/cli.js captions.list '{"id":"VIDEO_ID","start":8,"end":12}'
node src/agent/cli.js captions.update '{"id":"VIDEO_ID","cueId":"CUE_ID","text":"Video editing, compositing,\npainting, sculpting,"}'
node src/agent/cli.js captions.configure '{"id":"VIDEO_ID","background":"#000000","backgroundOpacity":0.55,"size":0.05}'
node src/agent/cli.js inspect.start '{"id":"VIDEO_ID","timestamps":[8.28,9.86,11.4],"revision":"REVISION"}'
node src/agent/cli.js captions.generate '{"id":"VIDEO_ID","start":20,"end":40,"replace":true,"apply":true}'
```

Agent procedure:

1. Start a job without `apply`, and poll `captions.status` until the state is `draft`.
2. Read `captions.draft`. Check `fits`, `toCheck`, `skippedWords`, and `warning`.
3. Apply with the draft `revision`.
4. Read `captions.list` in windows. Correct the text with `captions.update`. Inspect frames before, during, and after important captions.
5. Export with the revision that you checked.
