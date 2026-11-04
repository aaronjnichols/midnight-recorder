import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  access,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media, run } from "../src/adapters/media.js";
import { PreviewCache } from "../src/adapters/preview.js";
import {
  createTimeline,
  cut,
  configure,
  duration,
  trim,
} from "../src/domain/timeline.js";
import { addElement, updateElement } from "../src/domain/elements.js";
import { applyCaptions, configureCaptions } from "../src/domain/captions.js";
import { frameAt, region, isRed, frameTimes } from "../test-support/frames.js";

async function workspace(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  return mkdtemp(path.resolve(".local/claude-editing", prefix));
}

const W = 320,
  H = 180;

// A white bar that moves 2 pixels on each source frame. The bar position
// gives the frame that a picture shows, so a wrong frame cannot pass.
async function barSource(root, rate = 30, seconds = 4) {
  const file = path.join(root, `bar-${rate}.mp4`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=${rate}:d=${seconds}`,
    "-vf",
    "format=yuv444p,geq=lum='if(between(X,N*2,N*2+5),255,16)':cb=128:cr=128,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    "-g",
    "250",
    "-bf",
    "0",
    file,
  ]);
  return file;
}

// Frames with gaps of 1/30 s, then 0.25 s, then 0.4 s, with one long GOP.
async function unevenSource(root) {
  const file = path.join(root, "uneven.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=30:d=3`,
    "-vf",
    "format=yuv444p,geq=lum='if(between(X,N*2,N*2+5),255,16)':cb=128:cr=128,format=yuv420p,setpts='(N/30+if(gte(N,30),0.25,0)+if(gte(N,60),0.4,0))/TB'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    "-g",
    "250",
    "-bf",
    "0",
    file,
  ]);
  return file;
}

// A source that starts 1.5 s after the zero of its clock.
async function offsetSource(root) {
  const file = path.join(root, "offset.mkv");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=30:d=3`,
    "-vf",
    "format=yuv444p,geq=lum='if(between(X,N*2,N*2+5),255,16)':cb=128:cr=128,format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    "-g",
    "250",
    "-bf",
    "0",
    "-output_ts_offset",
    "1.5",
    file,
  ]);
  return file;
}

// The same layout as a MediaRecorder file: live WebM, no cues, no duration.
async function recordingSource(root) {
  const file = path.join(root, "recording.webm");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${W}x${H}:r=30:d=4`,
    "-vf",
    "format=yuv444p,geq=lum='if(between(X,N*2,N*2+5),255,16)':cb=128:cr=128,format=yuv420p",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "2M",
    "-g",
    "90",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-f",
    "webm",
    "-live",
    "1",
    file,
  ]);
  return file;
}

async function colorSource(root, seconds = 3) {
  const file = path.join(root, "color.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x6090C0:s=640x360:r=30:d=${seconds}`,
    "-vf",
    "setparams=colorspace=bt709",
    "-colorspace",
    "bt709",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "12",
    file,
  ]);
  return file;
}

async function darkSource(root, seconds = 3) {
  const file = path.join(root, "dark.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x1e2127:s=640x360:r=30:d=${seconds}`,
    "-vf",
    "setparams=colorspace=bt709",
    "-colorspace",
    "bt709",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

const barAt = (file, seconds = 0) => {
  const frame = frameAt(file, seconds, W, H);
  const found = region(frame, ([r]) => r > 150);
  assert.ok(found.count > 0, `No bar in ${file} at ${seconds}.`);
  return Math.round(found.centerX);
};

// RGBA bytes of an image.
function rgba(file, width, height) {
  const data = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "format=rgba",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(data.length, width * height * 4);
  return {
    at(x, y) {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

const near = (actual, expected, limit, name) =>
  actual.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) <= limit,
      `${name}: ${actual} is not near ${expected}`,
    ),
  );

async function setup(root, source, change) {
  const media = new Media();
  const metadata = await media.probe(source);
  const video = {
    id: "draft",
    path: source,
    metadata,
    timeline: change(createTimeline(metadata.duration), metadata.duration),
  };
  return { media, cache: new PreviewCache(root, media), video };
}

const edited = {
  type: "text",
  text: "Edited",
  start: 0,
  end: 4,
  x: 0.5,
  y: 0.7,
  width: 0.2,
  height: 0.2,
  background: "#00FF00",
  backgroundOpacity: 1,
};

// Compare the base picture with an export that does not have the element.
async function compareClock(t, name, source, change, times) {
  await t.test(name, async () => {
    const root = await workspace("draft-clock-");
    const { media, cache, video } = await setup(
      root,
      source,
      (value, length) => {
        const changed = change(value, length);
        return addElement(changed, length, "e", {
          ...edited,
          end: duration(changed),
        });
      },
    );
    const control = path.join(root, "control.mp4");
    const { elements, ...plain } = video.timeline;
    await media.export({ ...video, timeline: plain }, control);
    for (const seconds of times) {
      const result = await cache.frame(video, { elementId: "e", seconds });
      const exact = barAt(control, result.seconds);
      assert.equal(
        barAt(result.under.path),
        exact,
        `Edited time ${seconds}: frame ${result.frameIndex}.`,
      );
    }
  });
}

test("the base picture shows the same source frame as the export", async (t) => {
  const root = await workspace("draft-sources-");
  const thirty = await barSource(root);
  await compareClock(t, "plain", thirty, (v) => v, [0, 0.5, 1.5, 2.03, 3.9]);
  await compareClock(
    t,
    "after a cut on frames",
    thirty,
    (v) => cut(v, 0.5, 1),
    [0.4, 0.5, 0.52, 2.9],
  );
  await compareClock(
    t,
    "after cuts between frames",
    thirty,
    (v) => cut(cut(v, 0.517, 1.013), 1.5007, 1.911),
    [0.48, 0.5, 0.52, 0.55, 1, 1.49, 1.52, 2.5],
  );
  await compareClock(
    t,
    "after a trim at a higher speed",
    thirty,
    (v) => configure(trim(v, 0.4, 3.6), { speed: 1.5 }),
    [0, 0.7, 1.33, 2],
  );
  await compareClock(
    t,
    "after a cut at a lower speed",
    thirty,
    (v) => configure(cut(v, 1.2071, 2.113), { speed: 0.75 }),
    [0.3, 1.5, 1.6, 1.62, 3.9],
  );
  const low = await barSource(root, 24);
  await compareClock(t, "a 24 fps source", low, (v) => v, [0.5, 1.25, 3.5]);
  // At 60 fps, each second frame is exactly half way between two output
  // frames, so rounding must be the same as in the export.
  const high = await barSource(root, 60, 2);
  await compareClock(
    t,
    "a 60 fps source",
    high,
    (v) => v,
    [0.5, 0.517, 1.25, 1.9],
  );
  await compareClock(
    t,
    "a 60 fps source after a cut",
    high,
    (v) => cut(v, 0.508, 0.909),
    [0.49, 0.51, 1.2],
  );
  const uneven = await unevenSource(root);
  await compareClock(
    t,
    "a variable frame rate source",
    uneven,
    (v) => v,
    [0.5, 1.1, 1.2, 1.3, 2.2, 2.4, 2.6],
  );
  const offset = await offsetSource(root);
  await compareClock(
    t,
    "a source with a nonzero start time",
    offset,
    (v) => v,
    [0, 0.5, 1.5, 2.9],
  );
  await compareClock(
    t,
    "a nonzero start time after a cut",
    offset,
    (v) => cut(v, 0.7, 1.1),
    [0.69, 0.71, 2],
  );
});

test("the base picture shows the same frame in a recording without an index", async (t) => {
  // The app records WebM with MediaRecorder: no cues and few keyframes.
  const root = await workspace("draft-webm-");
  const recording = await recordingSource(root);
  await compareClock(
    t,
    "a WebM recording",
    recording,
    (v) => v,
    [0, 0.5, 1.5, 2.03, 3.9],
  );
  await compareClock(
    t,
    "a WebM recording after a cut",
    recording,
    (v) => cut(v, 1.017, 1.513),
    [1, 1.02, 3.4],
  );
});

test("the test sources are what their names tell", async () => {
  const root = await workspace("draft-source-check-");
  const media = new Media();
  assert.ok((await media.renderInfo(await offsetSource(root))).start > 1);
  const cues = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    await recordingSource(root),
  ]).toString();
  assert.match(cues, /N\/A/, "A live WebM has no duration, as MediaRecorder.");
  const times = frameTimes(await unevenSource(root));
  const gaps = times.slice(1).map((time, i) => time - times[i]);
  assert.ok(Math.max(...gaps) > 0.2, "The source has long gaps.");
  assert.ok(Math.min(...gaps) < 0.04, "The source has short gaps.");
});

test("the base picture holds the last frame when the video track ends first", async () => {
  const root = await workspace("draft-short-");
  const file = path.join(root, "short.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=f=330:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  const { cache, video } = await setup(root, file, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  assert.ok(video.metadata.duration > 1.5);
  const result = await cache.frame(video, { elementId: "e", seconds: 1.5 });
  const count = region(frameAt(result.under.path, 0, W, H), isRed).count;
  assert.ok(count > W * H * 0.9, `Red pixels: ${count}`);
});

test("the pair is the picture around the element, in layer order", async () => {
  const root = await workspace("draft-layers-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) => {
    let next = addElement(value, length, "below", {
      type: "rectangle",
      start: 0,
      end: 3,
      x: 0,
      y: 0,
      width: 0.25,
      height: 0.25,
      fill: "#FF0000",
      fillOpacity: 1,
      stroke: "none",
    });
    next = addElement(next, length, "edited", {
      type: "text",
      text: "OLD WORDS",
      start: 0,
      end: 3,
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      size: 0.1,
      background: "#00FF00",
      backgroundOpacity: 1,
    });
    next = addElement(next, length, "above", {
      type: "rectangle",
      start: 0,
      end: 3,
      x: 0.6,
      y: 0.6,
      width: 0.3,
      height: 0.3,
      fill: "#0000FF",
      fillOpacity: 1,
      stroke: "none",
    });
    return addElement(next, length, "glass", {
      type: "rectangle",
      start: 0,
      end: 3,
      x: 0,
      y: 0.6,
      width: 0.3,
      height: 0.3,
      fill: "#FFFFFF",
      fillOpacity: 1,
      stroke: "none",
      opacity: 0.5,
    });
  });
  const result = await cache.frame(video, {
    elementId: "edited",
    seconds: 1,
  });
  assert.deepEqual(result.frame, { width: 640, height: 360 });
  const under = rgba(result.under.path, 640, 360);
  const over = rgba(result.over.path, 640, 360);
  // Below: the shape is in the base, and the edited box is not.
  near(under.at(40, 40), [255, 0, 0, 255], 12, "shape below");
  near(under.at(320, 180), [30, 33, 39, 255], 12, "no edited element");
  // Above: the shape is in the top image, and the top image is clear elsewhere.
  near(over.at(500, 280), [0, 0, 255, 255], 12, "shape above");
  assert.equal(over.at(320, 180)[3], 0, "Clear over the edited element.");
  assert.equal(over.at(40, 40)[3], 0, "Clear over the shape below.");
  assert.equal(under.at(500, 280)[2] < 80, true, "Above is not in the base.");
  // The opacity of an upper element stays in the top image.
  const glass = over.at(100, 280);
  assert.ok(Math.abs(glass[3] - 128) <= 3, `Alpha: ${glass}`);
  near(glass.slice(0, 3), [255, 255, 255], 6, "glass color");

  // The two images together equal an export without the edited element.
  const control = path.join(root, "control.mp4");
  const others = video.timeline.elements.filter((e) => e.id !== "edited");
  await media.export(
    { ...video, timeline: { ...video.timeline, elements: others } },
    control,
  );
  const exact = frameAt(control, 1, 640, 360);
  for (const [x, y] of [
    [40, 40],
    [320, 180],
    [500, 280],
    [100, 280],
    [620, 20],
  ]) {
    const [r, g, b] = under.at(x, y);
    const [or, og, ob, oa] = over.at(x, y);
    const mix = (low, high) => low + ((high - low) * oa) / 255;
    near(
      [mix(r, or), mix(g, og), mix(b, ob)],
      exact.at(x, y),
      14,
      `Composite at ${x}, ${y}`,
    );
  }
});

test("the pair has straight alpha: translucent layers match the export on color footage", async () => {
  const root = await workspace("draft-alpha-");
  const source = await colorSource(root);
  const shape = {
    type: "rectangle",
    start: 0,
    end: 3,
    stroke: "none",
  };
  const { media, cache, video } = await setup(root, source, (value, length) => {
    let next = addElement(value, length, "edited", {
      ...edited,
      x: 0.02,
      y: 0.02,
      width: 0.1,
      height: 0.1,
      end: length,
    });
    // A partly transparent fill at full element opacity.
    next = addElement(next, length, "tint", {
      ...shape,
      x: 0.1,
      y: 0.1,
      width: 0.35,
      height: 0.35,
      fill: "#E02020",
      fillOpacity: 0.4,
    });
    // A partly transparent fill with element opacity, over the first.
    next = addElement(next, length, "both", {
      ...shape,
      x: 0.3,
      y: 0.3,
      width: 0.3,
      height: 0.3,
      fill: "#20E020",
      fillOpacity: 0.5,
      opacity: 0.6,
    });
    next = addElement(next, length, "arrow", {
      type: "arrow",
      start: 0,
      end: 3,
      x1: 0.65,
      y1: 0.15,
      x2: 0.95,
      y2: 0.55,
      color: "#FFFF00",
      strokeWidth: 0.02,
    });
    next = addElement(next, length, "ring", {
      type: "ellipse",
      start: 0,
      end: 3,
      x: 0.65,
      y: 0.55,
      width: 0.25,
      height: 0.3,
      stroke: "#FFFFFF",
      strokeWidth: 0.012,
    });
    // A text background that the caption box covers in part.
    next = addElement(next, length, "plate", {
      type: "text",
      text: "Plate text",
      start: 0,
      end: 3,
      x: 0.1,
      y: 0.8,
      width: 0.8,
      height: 0.15,
      size: 0.05,
      background: "#202080",
      backgroundOpacity: 0.7,
    });
    const captioned = applyCaptions(
      next,
      [{ sourceStart: 0, sourceEnd: 3, text: "Caption over plate" }],
      { ids: () => "c1" },
    ).timeline;
    return configureCaptions(captioned, {
      background: "#101010",
      backgroundOpacity: 0.6,
    });
  });
  const result = await cache.frame(video, {
    elementId: "edited",
    seconds: 1,
  });
  const under = rgba(result.under.path, 640, 360);
  const over = rgba(result.over.path, 640, 360);
  const control = path.join(root, "control.mp4");
  const others = video.timeline.elements.filter((e) => e.id !== "edited");
  await media.export(
    { ...video, timeline: { ...video.timeline, elements: others } },
    control,
  );
  const exact = frameAt(control, 1, 640, 360);
  const composite = (x, y) => {
    const low = under.at(x, y),
      high = over.at(x, y);
    return low
      .slice(0, 3)
      .map((value, i) => value + ((high[i] - value) * high[3]) / 255);
  };
  // Flat areas: one layer, two layers, and caption over text background.
  for (const [name, x, y] of [
    ["tint", 110, 70],
    ["tint and both", 240, 140],
    ["both", 300, 180],
    ["plate", 90, 310],
    ["clear", 620, 340],
  ])
    near(composite(x, y), exact.at(x, y), 12, name);
  // Edges: antialiasing on a transparent canvas must not darken the mix.
  let total = 0,
    count = 0,
    worst = 0;
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++) {
      const value = composite(x, y);
      const expected = exact.at(x, y);
      const difference =
        (Math.abs(value[0] - expected[0]) +
          Math.abs(value[1] - expected[1]) +
          Math.abs(value[2] - expected[2])) /
        3;
      total += difference;
      count++;
      worst = Math.max(worst, difference);
    }
  assert.ok(total / count < 4, `Mean difference: ${total / count}`);
});

// The pair has the colors that the player shows, so the picture does not jump
// when the exact preview replaces it. These player colors of #E02020 are
// measured on screen, and the visual tests compare with the real player.
test("a frame has the colors of the player", async (t) => {
  const check = (name, size, tag, displayColor, shown) =>
    t.test(name, async () => {
      const root = await workspace("draft-color-");
      const file = path.join(root, "color.mp4");
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=0x3B5B7A:s=${size}:r=30:d=1`,
        ...tag,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "ultrafast",
        file,
      ]);
      const [width, height] = size.split("x").map(Number);
      const shape = {
        type: "rectangle",
        start: 0,
        width: 0.25,
        height: 0.25,
        y: 0,
        fillOpacity: 1,
        stroke: "none",
        fill: "#E02020",
      };
      const { cache, video } = await setup(root, file, (value, length) => {
        const end = length;
        let next = addElement(value, length, "low", { ...shape, end, x: 0 });
        next = addElement(next, length, "e", { ...edited, end });
        return addElement(next, length, "high", { ...shape, end, x: 0.5 });
      });
      const result = await cache.frame(video, { elementId: "e", seconds: 0.5 });
      assert.equal(result.displayColor, displayColor);
      const point = [width * 0.1, height * 0.1].map(Math.round);
      const under = rgba(result.under.path, width, height);
      near(under.at(...point).slice(0, 3), shown, 6, "under");
      const over = rgba(result.over.path, width, height);
      const top = over.at(Math.round(width * 0.6), point[1]);
      near(top.slice(0, 3), shown, 6, "over");
      assert.equal(top[3], 255);
      assert.equal(
        over.at(width >> 2, height - 10)[3],
        0,
        "The clear part stays clear.",
      );
    });
  await check("untagged HD", "1280x720", [], "bt709", [240, 51, 28]);
  await check("untagged SD", "640x360", [], "smpte170m", [218, 47, 30]);
  await check(
    "tagged HD",
    "1280x720",
    ["-vf", "setparams=colorspace=bt709", "-colorspace", "bt709"],
    null,
    [224, 32, 32],
  );
});

test("there is no top image when nothing is above the element", async () => {
  const root = await workspace("draft-no-top-");
  const source = await darkSource(root);
  const { cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const result = await cache.frame(video, { elementId: "e", seconds: 1 });
  assert.equal(result.over, null);
});

test("the top image has text, the caption, and fades at their frame", async () => {
  const root = await workspace("draft-top-");
  const source = await darkSource(root);
  const { cache, video } = await setup(root, source, (value, length) => {
    let next = addElement(value, length, "e", { ...edited, end: length });
    next = addElement(next, length, "top", {
      type: "text",
      text: `Top 'x' [y]; %{pts} : \\ é`,
      start: 0,
      end: 3,
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.2,
      size: 0.08,
      background: "#FF0000",
      backgroundOpacity: 1,
      fadeIn: 2,
    });
    return applyCaptions(
      next,
      [{ sourceStart: 0, sourceEnd: 2, text: "Caption words" }],
      { ids: () => "c1" },
    ).timeline;
  });
  const result = await cache.frame(video, { elementId: "e", seconds: 1 });
  const over = rgba(result.over.path, 640, 360);
  // Text on a box, at half of its fade.
  const box = over.at(4, 4);
  assert.ok(Math.abs(box[3] - 128) <= 6, `Alpha: ${box}`);
  near(box.slice(0, 3), [255, 0, 0], 12, "faded box");
  // The caption box is low in the frame and opaque in its letters.
  let opaque = 0;
  for (let y = 240; y < 360; y++)
    for (let x = 0; x < 640; x += 2) if (over.at(x, y)[3] > 200) opaque++;
  assert.ok(opaque > 100, `Caption pixels: ${opaque}`);
});

test("the pair does not bake the video fade, and reports its black level", async () => {
  const root = await workspace("draft-fade-");
  const source = await darkSource(root);
  const { cache, video } = await setup(root, source, (value, length) =>
    configure(addElement(value, length, "e", { ...edited, end: length }), {
      fadeIn: 2,
    }),
  );
  const result = await cache.frame(video, { elementId: "e", seconds: 1 });
  assert.equal(result.fadeOpacity, 0.5);
  const under = rgba(result.under.path, 640, 360);
  near(under.at(320, 40), [30, 33, 39, 255], 12, "no fade in the base");
});

test("a frame deep in a long element costs one frame, not the element", async () => {
  const root = await workspace("draft-long-");
  const source = await darkSource(root, 60);
  const { cache, video } = await setup(root, source, (value, length) => {
    let next = addElement(value, length, "e", { ...edited, end: length });
    return addElement(next, length, "layer", {
      type: "text",
      text: "A long layer",
      start: 0,
      end: length,
      opacity: 0.5,
    });
  });
  const started = performance.now();
  await cache.frame(video, { elementId: "e", seconds: 55 });
  const elapsed = performance.now() - started;
  // A full render of this element takes many seconds on any device here.
  assert.ok(elapsed < 5000, `Frame took ${Math.round(elapsed)} ms.`);
});

test("a turned video gives the turned frame size", async () => {
  const root = await workspace("draft-turn-");
  const plain = await darkSource(root);
  const file = path.join(root, "turned.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-display_rotation",
    "90",
    "-i",
    plain,
    "-c",
    "copy",
    file,
  ]);
  const { cache, video } = await setup(root, file, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const result = await cache.frame(video, { elementId: "e", seconds: 1 });
  assert.deepEqual(result.frame, { width: 360, height: 640 });
  frameAt(result.under.path, 0, 360, 640);
});

test("text changes of the element use the same pair, and other changes make a new one", async () => {
  const root = await workspace("draft-cache-");
  const source = await darkSource(root);
  const { cache, video } = await setup(root, source, (value, length) => {
    const next = addElement(value, length, "e", { ...edited, end: length });
    return addElement(next, length, "b", { ...edited, x: 0, end: length });
  });
  const request = { elementId: "e", seconds: 1 };
  const first = await cache.frame(video, request);
  const changed = {
    ...video,
    timeline: updateElement(video.timeline, 3, "e", { text: "New words" }),
  };
  const second = await cache.frame(changed, request);
  assert.equal(second.under.url, first.under.url);
  assert.equal(second.baseRevision, first.baseRevision);
  const other = {
    ...video,
    timeline: updateElement(video.timeline, 3, "b", { text: "Other" }),
  };
  const third = await cache.frame(other, request);
  assert.notEqual(third.under.url, first.under.url);
  assert.notEqual(third.baseRevision, first.baseRevision);
  // Each frame of the output clock is one entry.
  const near1 = await cache.frame(video, { ...request, seconds: 1.01 });
  assert.equal(near1.under.url, first.under.url);
  const next = await cache.frame(video, { ...request, seconds: 1.04 });
  assert.notEqual(next.under.url, first.under.url);
});

test("two requests for one frame share one render", async () => {
  const root = await workspace("draft-share-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  let renders = 0;
  const render = media.draftFrame.bind(media);
  media.draftFrame = (...args) => {
    renders++;
    return render(...args);
  };
  const request = { elementId: "e", seconds: 1 };
  const [one, two] = await Promise.all([
    cache.frame(video, request),
    cache.frame(video, request),
  ]);
  assert.equal(one.under.url, two.under.url);
  assert.equal(renders, 1);
  await cache.frame(video, request);
  assert.equal(renders, 1, "A finished frame comes from the cache.");
});

test("the frame cache is bounded, and the video delete removes it", async () => {
  const root = await workspace("draft-bound-");
  const source = await darkSource(root);
  const { cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const files = async () =>
    (await readdir(path.join(cache.directory(video.id), "frames"))).length;
  let first;
  for (let i = 0; i < 20; i++) {
    const result = await cache.frame(video, {
      elementId: "e",
      seconds: i * 0.1,
    });
    first ??= result;
  }
  assert.ok((await files()) <= 12, `Files: ${await files()}`);
  await assert.rejects(() => access(first.under.path), /ENOENT/);
  await cache.remove(video.id);
  await assert.rejects(() => access(cache.directory(video.id)), /ENOENT/);
});

test("a large frame is scaled after composition, and reports both sizes", async () => {
  const root = await workspace("draft-large-");
  const file = path.join(root, "large.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1e2127:s=2560x1440:r=30:d=1",
    "-vf",
    "setparams=colorspace=bt709",
    "-colorspace",
    "bt709",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    file,
  ]);
  const { cache, video } = await setup(root, file, (value, length) => {
    const next = addElement(value, length, "e", { ...edited, end: length });
    return addElement(next, length, "top", {
      ...edited,
      x: 0,
      y: 0,
      end: length,
      background: "#FF0000",
    });
  });
  const result = await cache.frame(video, { elementId: "e", seconds: 0.5 });
  assert.deepEqual(result.frame, { width: 2560, height: 1440 });
  assert.deepEqual(result.image, { width: 1920, height: 1080 });
  frameAt(result.under.path, 0, 1920, 1080);
  near(
    rgba(result.over.path, 1920, 1080).at(100, 100).slice(0, 3),
    [255, 0, 0],
    12,
    "scaled top image",
  );
});

// A render that waits until the test releases it, or until its signal ends.
function gatedMedia(media) {
  const gates = [];
  const render = media.draftFrame.bind(media);
  media.draftFrame = (video, request, files, options) =>
    new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () =>
        reject(options.signal.reason),
      );
      gates.push(() => render(video, request, files).then(resolve, reject));
    });
  return gates;
}

test("the number of pending renders is limited, and a shared frame does not count twice", async () => {
  const root = await workspace("draft-pending-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const gates = gatedMedia(media);
  const at = (seconds) => cache.frame(video, { elementId: "e", seconds });
  const pending = [at(0.5), at(0.5), at(1), at(1.5), at(2)];
  while (gates.length < 4) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(() => at(2.5), /Too many frame requests/);
  for (const release of gates) release();
  const results = await Promise.all(pending);
  assert.equal(results[0].under.url, results[1].under.url);
  // The limit counts pending work only.
  const next = at(2.5);
  while (gates.length < 5) await new Promise((r) => setTimeout(r, 5));
  gates[4]();
  assert.ok((await next).under.url);
});

test("a frame render has a deadline", async () => {
  const root = await workspace("draft-deadline-");
  const source = await darkSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const cache = new PreviewCache(root, media, { frameDeadlineMs: 50 });
  const video = {
    id: "draft",
    path: source,
    metadata,
    timeline: addElement(
      createTimeline(metadata.duration),
      metadata.duration,
      "e",
      {
        ...edited,
        end: metadata.duration,
      },
    ),
  };
  gatedMedia(media);
  await assert.rejects(
    () => cache.frame(video, { elementId: "e", seconds: 1 }),
    /took too long/,
  );
});

test("a frame is published whole or not at all", async () => {
  const root = await workspace("draft-atomic-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(
      addElement(value, length, "e", { ...edited, end: length }),
      length,
      "top",
      {
        ...edited,
        x: 0,
        end: length,
      },
    ),
  );
  const render = media.draftFrame.bind(media);
  media.draftFrame = async (input, request, files, options) => {
    await render(input, request, files, options);
    await rm(files.over);
    throw new Error("Stopped between the two images.");
  };
  await assert.rejects(
    () => cache.frame(video, { elementId: "e", seconds: 1 }),
    /Stopped/,
  );
  const folder = path.join(cache.directory(video.id), "frames");
  assert.deepEqual(await readdir(folder), [], "No file stays.");
});

test("a delete during a render does not bring the folder back", async () => {
  const root = await workspace("draft-delete-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const gates = gatedMedia(media);
  const late = cache.frame(video, { elementId: "e", seconds: 1 });
  while (!gates.length) await new Promise((r) => setTimeout(r, 5));
  await cache.remove(video.id);
  gates[0]();
  await assert.rejects(() => late, /deleted/);
  await assert.rejects(() => access(cache.directory(video.id)), /ENOENT/);
});

// Review B1: the delete check starts at the first line of a request.
test("a delete during the metadata read does not bring the folder back", async () => {
  const root = await workspace("draft-delete-early-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  let release;
  const read = media.renderInfo.bind(media);
  media.renderInfo = async (...args) => {
    await new Promise((resolve) => (release = resolve));
    return read(...args);
  };
  const late = cache.frame(video, { elementId: "e", seconds: 1 });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  await cache.remove(video.id);
  release();
  await assert.rejects(() => late, /deleted/);
  await assert.rejects(() => access(cache.directory(video.id)), /ENOENT/);
});

// Review B3: a real export is the control for each frame of a short fade.
test("the black level of a video fade follows the frames of the export", async (t) => {
  const root = await workspace("draft-fade-frames-");
  const file = path.join(root, "white.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=white:s=160x90:r=30:d=2",
    "-c:v",
    "libx264",
    "-crf",
    "1",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  const media = new Media();
  const metadata = await media.probe(file);
  const levels = (output) => {
    const data = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        output,
        "-vf",
        "crop=2:2:80:45,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { maxBuffer: 1 << 26 },
    );
    const list = [];
    for (let i = 0; i < data.length; i += 12) list.push(data[i] / 255);
    return list;
  };
  for (const [name, fades, frames] of [
    ["fractional fade in", { fadeIn: 0.05 }, [0, 1, 2]],
    ["longer fractional fade in", { fadeIn: 0.517 }, [1, 7, 15, 16, 17]],
    ["fade in under half a frame", { fadeIn: 0.01 }, [0, 1]],
    ["fractional fade out", { fadeOut: 0.05 }, [57, 58, 59]],
    ["longer fractional fade out", { fadeOut: 0.517 }, [43, 44, 50, 59]],
    ["both fades", { fadeIn: 0.1, fadeOut: 0.31 }, [1, 2, 3, 51, 59]],
  ])
    await t.test(name, async () => {
      const value = addElement(
        configure(createTimeline(metadata.duration), fades),
        metadata.duration,
        "e",
        {
          type: "text",
          text: "x",
          start: 0.9,
          end: 1,
          x: 0,
          y: 0,
          width: 0.1,
          height: 0.1,
        },
      );
      const video = { id: name, path: file, metadata, timeline: value };
      const output = path.join(root, `${name}.mp4`);
      await media.export(video, output);
      const exact = levels(output);
      const cache = new PreviewCache(root, media);
      for (const frame of frames) {
        const result = await cache.frame(video, {
          elementId: "e",
          seconds: (frame + 0.5) / 30,
        });
        assert.equal(result.frameIndex, frame);
        assert.ok(
          Math.abs(1 - result.fadeOpacity - exact[frame]) < 0.02,
          `Frame ${frame}: level ${1 - result.fadeOpacity}, export ${exact[frame]}.`,
        );
      }
    });
});

// Review B4: the limit and the deadline cover the whole request.
test("metadata reads count as pending work, with their own deadline and signal", async () => {
  const root = await workspace("draft-preflight-");
  const source = await darkSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const signals = [];
  media.renderInfo = (file, { signal } = {}) => {
    signals.push(signal);
    return new Promise(() => {});
  };
  const cache = new PreviewCache(root, media, { frameDeadlineMs: 60 });
  const request = (id) => {
    const timeline = addElement(
      createTimeline(metadata.duration),
      metadata.duration,
      "e",
      { ...edited, end: metadata.duration },
    );
    return cache.frame(
      { id, path: path.join(root, `${id}.mp4`), metadata, timeline },
      { elementId: "e", seconds: 1 },
    );
  };
  const results = [1, 2, 3, 4].map((n) => request(`video-${n}`));
  // The fifth distinct request is refused before any metadata read.
  await assert.rejects(() => request("video-5"), /Too many frame requests/);
  assert.equal(signals.length, 4, "Only admitted work reads metadata.");
  assert.ok(signals.every(Boolean), "Each read has a signal.");
  for (const result of results)
    await assert.rejects(() => result, /took too long/);
  assert.ok(signals.every((signal) => signal.aborted));
  // A hung read does not hold the limit after its deadline.
  await assert.rejects(() => request("video-6"), /took too long/);
});

test("one failed metadata read does not block the next request", async () => {
  const root = await workspace("draft-preflight-retry-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const read = media.renderInfo.bind(media);
  media.renderInfo = async () => {
    throw new Error("ffprobe failed.");
  };
  const request = { elementId: "e", seconds: 1 };
  await assert.rejects(() => cache.frame(video, request), /ffprobe failed/);
  media.renderInfo = read;
  assert.ok((await cache.frame(video, request)).under.url);
});

// Review B5: the cleanup of an earlier run ends before any new work starts.
test("the first requests after a restart wait for the old frames to go", async () => {
  const root = await workspace("draft-cold-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const first = await cache.frame(video, { elementId: "e", seconds: 0.5 });
  const folder = path.join(cache.directory(video.id), "frames");
  // Many old files make the recursive delete slow enough to overlap.
  for (let i = 0; i < 40; i++)
    await writeFile(path.join(folder, `old-${i}.png`), "old");
  const restarted = new PreviewCache(root, media);
  const results = await Promise.all(
    [0.5, 1, 1.5, 2].map((seconds) =>
      restarted.frame(video, { elementId: "e", seconds }),
    ),
  );
  for (const result of results) await access(result.under.path);
  assert.equal(results[0].under.path, first.under.path);
  const names = await readdir(folder);
  assert.equal(names.filter((name) => name.startsWith("old-")).length, 0);
  assert.equal(names.filter((name) => name.startsWith(".work")).length, 0);
});

test("a frame render error rejects, and the next request tries again", async () => {
  const root = await workspace("draft-error-");
  const source = await darkSource(root);
  const { media, cache, video } = await setup(root, source, (value, length) =>
    addElement(value, length, "e", { ...edited, end: length }),
  );
  const render = media.draftFrame.bind(media);
  media.draftFrame = async () => {
    throw new Error("No frame.");
  };
  const request = { elementId: "e", seconds: 1 };
  await assert.rejects(() => cache.frame(video, request), /No frame/);
  media.draftFrame = render;
  assert.ok((await cache.frame(video, request)).under.url);
});
