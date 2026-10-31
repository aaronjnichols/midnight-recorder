# Frame inspection practice

## Task

Inspect a sample settings video. Find the Save button. Choose space for a label without covering the button. Check when the position changes.

Run `npm run practice:inspection` to reproduce the command path. The script creates a six-second sample and starts a separate Electron app with a test library. It imports the sample through the CLI. It then requests images through MCP. Images and a JSON report remain in the printed `.local` folder.

## What the images showed

The video is 960 by 540 pixels. A frame at time 2 shows the Save button on the left. The sequence includes times 2.9, 3, 4.5, and 5.9. At time 3, the button changes to the right side. The later samples show the same right-side position.

| Time in source video  | Button rectangle in pixels         | Planned label rectangle in pixels  |
| --------------------- | ---------------------------------- | ---------------------------------- |
| 0 to before 3 seconds | x=120, y=330, width=160, height=70 | x=100, y=235, width=240, height=55 |
| 3 to 6 seconds        | x=680, y=330, width=160, height=70 | x=640, y=235, width=240, height=55 |

The label text would be "Select Save". Both positions leave a gap above the button and stay below the title. A pointer could end at the top center of the button. These coordinates are a plan from the inspected images. The practice does not save annotation edits.

The first label position is x=0.1042, y=0.4352 on a 0-to-1 coordinate scale. The second position is x=0.6667, y=0.4352. The label width is 0.25 and its height is 0.1019. This scale lets the agent use smaller inspection images without losing the video position.

## Check after editing

The practice removes source time 1 to 2 and sets speed to 0.5. The edited duration is 10 seconds. The button changes position at edited time 4.

The agent inspected a frame just before time 4, a frame at time 4, and a frame near the end. The first image shows the left button. The other two show the right button. A label tied to the button must change position at this boundary. A label that used the old three-second boundary would move too soon.

## Tools needed for this workflow

- One frame at a chosen edited time to read text and choose a position.
- Several frames per request to inspect motion and interval boundaries.
- Image size and an optional grid to estimate coordinates.
- Actual frame times and source timeline positions to relate the image to edits.
- An edit revision and a stale-result flag to avoid using old positions after edits.
- Native MCP image content so the agent can see the result.

The app now supplies these through `inspect.start` and `inspect.result`. Samples can miss a change between requested times. The agent must request more frames near a change and check the rendered result after future annotation edits.
