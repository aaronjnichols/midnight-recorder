import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media, run } from "../src/adapters/media.js";
import { createTimeline, cut } from "../src/domain/timeline.js";
import { addElement, describeElements } from "../src/domain/elements.js";
import {
  frameAt,
  region,
  bands,
  isRed,
  isWhite,
  frameTimes,
} from "../test-support/frames.js";

// A plain dark 640 x 360 source at 30 frames per second.
async function plainSource(root, name = "source.mp4", seconds = 3) {
  const file = path.join(root, name);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x1e2127:s=640x360:r=30:d=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

async function workspace(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  return mkdtemp(path.resolve(".local/claude-editing", prefix));
}

const label = (extra) => ({
  type: "text",
  text: "MIDNIGHT",
  start: 1,
  end: 2,
  x: 0.25,
  y: 0.25,
  width: 0.5,
  height: 0.5,
  size: 0.1,
  background: "#FF0000",
  backgroundOpacity: 1,
  outline: "none",
  ...extra,
});

test("real export draws text in its box only during its edited interval", async () => {
  const root = await workspace("render-");
  const source = await plainSource(root);
  const original = await readFile(source);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label(),
  );
  const output = path.join(root, "text.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  for (const seconds of [0.5, 0.96, 2, 2.5]) {
    const frame = frameAt(output, seconds, 640, 360);
    assert.equal(region(frame, isRed).count, 0, `No box at ${seconds}s.`);
    assert.equal(region(frame, isWhite).count, 0, `No text at ${seconds}s.`);
  }
  for (const seconds of [1, 1.5, 1.96]) {
    const frame = frameAt(output, seconds, 640, 360);
    const box = region(frame, isRed);
    // Box from x 160 to 479 and y 90 to 269 (0.25 to 0.75 of the frame).
    for (const [actual, expected] of [
      [box.minX, 160],
      [box.maxX, 479],
      [box.minY, 90],
      [box.maxY, 269],
    ])
      assert.ok(
        Math.abs(actual - expected) <= 2,
        `${seconds}s box ${JSON.stringify(box)}`,
      );
    const text = region(frame, isWhite);
    assert.ok(text.count > 300, `Text pixels at ${seconds}s: ${text.count}`);
    assert.ok(text.minX > 160 && text.maxX < 479 && text.minY > 90);
    assert.ok(Math.abs(text.centerX - 320) < 10, String(text.centerX));
    assert.ok(Math.abs(text.centerY - 180) < 10, String(text.centerY));
    assert.equal(bands(text.rows).length, 1, "One line of text.");
  }
  assert.deepEqual(await readFile(source), original);
});

test("a frame shows text only when its time is in [start, end)", async () => {
  // Review reproduction. Frames at 30 fps are at 1 and 2 seconds. The
  // frame at 1 is before start. The frame at 2 is before end.
  const root = await workspace("render-edge-");
  const source = await plainSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label({ start: 1.00005, end: 2.00005 }),
  );
  const output = path.join(root, "edge.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  // Output seeking selects the first frame at or after the time.
  for (const [seconds, frame, shown] of [
    [0.95, "29 (0.967 s)", false],
    [1, "30 (1.000 s)", false],
    [1.02, "31 (1.033 s)", true],
    [2, "60 (2.000 s)", true],
    [2.02, "61 (2.033 s)", false],
  ])
    assert.equal(
      region(frameAt(output, seconds, 640, 360), isRed).count > 10000,
      shown,
      `Frame ${frame}`,
    );
});

test("unusual text renders as data in a folder with filter characters", async () => {
  // Characters that have a meaning in FFmpeg filter syntax, drawtext
  // expansion, ASS markup, Windows paths, or shells.
  const danger =
    "'; drawbox=c=red:t=fill:w=640:h=360 ,[x] \\N {\\b1} %{pts} %{n} C:\\Temp\\a'b \"q\" é ü ß";
  const root = await workspace("render lib's [x], 100% ;=é-");
  const source = await plainSource(root, "in put's [1].mp4");
  const media = new Media();
  const metadata = await media.probe(source);
  const make = (text) =>
    addElement(createTimeline(metadata.duration), metadata.duration, "a", {
      ...label({ text, size: 0.05 }),
      background: "none",
      x: 0,
      width: 1,
    });
  const two = path.join(root, "two lines, 'quoted' [ok].mp4");
  await media.export(
    { path: source, metadata, timeline: make(`${danger}\nSecond line`) },
    two,
  );
  const one = path.join(root, "one line.mp4");
  await media.export({ path: source, metadata, timeline: make(danger) }, one);
  const early = frameAt(two, 1.1, 640, 360);
  const late = frameAt(two, 1.9, 640, 360);
  assert.equal(region(early, isRed).count, 0, "Text cannot add a filter.");
  const text = region(early, isWhite);
  assert.ok(text.count > 300, String(text.count));
  // Expansion is off, so %{pts} and %{n} do not change between frames.
  // Lossy encoding changes some pixel values, so compare the text masks.
  let changed = 0;
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++)
      if (isWhite(early.at(x, y)) !== isWhite(late.at(x, y))) changed++;
  assert.ok(changed < text.count * 0.02, `Changed text pixels: ${changed}`);
  const lines = bands(text.rows);
  assert.equal(lines.length, 2, JSON.stringify(lines));
  const single = bands(region(frameAt(one, 1.5, 640, 360), isWhite).rows);
  assert.equal(single.length, 1, JSON.stringify(single));
  // The first line is the same text, so it has the same height.
  assert.ok(
    Math.abs(
      single[0].end - single[0].start - (lines[0].end - lines[0].start),
    ) <= 2,
  );
  assert.equal(region(frameAt(two, 0.5, 640, 360), isWhite).count, 0);
});

test("real export keeps text on its source content after a cut and speed change", async () => {
  const root = await workspace("render-edit-");
  // Red frames for source 1 to 2 seconds, blue frames at other times.
  const source = path.join(root, "marked.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=640x360:r=30:d=3",
    "-vf",
    "drawbox=x=0:y=0:w=640:h=60:color=red:t=fill:enable='between(t,1,1.99)'",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    source,
  ]);
  const media = new Media();
  const metadata = await media.probe(source);
  const { cut, configure } = await import("../src/domain/timeline.js");
  // The label is on source 1 to 2, the red frames.
  let timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label({ background: "#FFFFFF", text: "X", y: 0.5, height: 0.25 }),
  );
  // Remove source 0.5 to 1.2, then play at double speed. The label now
  // shows from edited 0.25 to 0.65.
  timeline = configure(cut(timeline, 0.5, 1.2), { speed: 2 });
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const white = { left: 160, top: 180, right: 480, bottom: 270 };
  for (const [seconds, shown] of [
    [0.2, false],
    [0.3, true],
    [0.6, true],
    [0.7, false],
  ]) {
    const frame = frameAt(output, seconds, 640, 360);
    const marker = isRed(frame.at(320, 20));
    const box = region(frame, isWhite, white).count > 1000;
    assert.equal(box, shown, `Label at ${seconds}s`);
    // The label shows on the same frames as its source content.
    assert.equal(marker, shown, `Source marker at ${seconds}s`);
  }
});

test("element coordinates use the displayed frame of a rotated source", async () => {
  const root = await workspace("render-rotated-");
  const plain = await plainSource(root, "plain.mp4", 1);
  const rotated = path.join(root, "rotated.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-display_rotation",
    "90",
    "-i",
    plain,
    "-c",
    "copy",
    rotated,
  ]);
  const media = new Media();
  assert.deepEqual(await media.frameSize(rotated), { width: 360, height: 640 });
  const metadata = await media.probe(rotated);
  const timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label({
      start: 0,
      end: 1,
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.25,
      text: "R",
    }),
  );
  const output = path.join(root, "rotated-text.mp4");
  await media.export({ path: rotated, metadata, timeline }, output);
  const box = region(frameAt(output, 0.5, 360, 640), isRed);
  assert.ok(Math.abs(box.maxX - 179) <= 2, JSON.stringify(box));
  assert.ok(Math.abs(box.maxY - 159) <= 2, JSON.stringify(box));
  assert.ok(box.minX <= 1 && box.minY <= 1, JSON.stringify(box));
});

test("element coordinates use the FFmpeg frame size for any display rotation", async () => {
  const root = await workspace("render-angle-");
  const plain = await plainSource(root, "plain.mp4", 1);
  const media = new Media();
  for (const angle of [45, 90, 135, 180, 270, 30]) {
    const file = path.join(root, `rotated-${angle}.mp4`);
    await run("ffmpeg", [
      "-v",
      "error",
      "-display_rotation",
      String(angle),
      "-i",
      plain,
      "-c",
      "copy",
      file,
    ]);
    // FFmpeg turns right angles. It keeps the frame size for other angles.
    const png = path.join(root, `decoded-${angle}.png`);
    await run("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", png]);
    const [width, height] = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      png,
    ])
      .toString()
      .trim()
      .split(",")
      .map(Number);
    assert.deepEqual(
      await media.frameSize(file),
      { width, height },
      `Rotation ${angle}`,
    );
  }
  // Text on the 45 degree source uses the 640 x 360 output frame.
  const source = path.join(root, "rotated-45.mp4");
  const metadata = await media.probe(source);
  const timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label({ start: 0, end: 1 }),
  );
  const output = path.join(root, "angle-text.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const result = await media.probe(output);
  assert.deepEqual([result.width, result.height], [640, 360]);
  const box = region(frameAt(output, 0.5, 640, 360), isRed);
  for (const [actual, expected] of [
    [box.minX, 160],
    [box.maxX, 479],
    [box.minY, 90],
    [box.maxY, 269],
  ])
    assert.ok(Math.abs(actual - expected) <= 2, JSON.stringify(box));
});

test("a configured relative FFmpeg path works when text needs a work folder", async () => {
  // FFMPEG_PATH can be relative to the app folder. Text export runs FFmpeg
  // in a different working folder.
  const installed = execFileSync(
    process.platform === "win32" ? "where" : "which",
    ["ffmpeg"],
  )
    .toString()
    .split(/\r?\n/)[0]
    .trim();
  const relative = path.relative(process.cwd(), installed);
  assert.ok(
    !path.isAbsolute(relative) && /[\\/]/.test(relative),
    `Expected a relative path with a folder: ${relative}`,
  );
  const root = await workspace("render-relative-");
  const source = await plainSource(root, "source.mp4", 2);
  const media = new Media({ ffmpeg: relative });
  const metadata = await media.probe(source);
  const timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    label({ start: 0, end: 2 }),
  );
  const output = path.join(root, "relative.mp4");
  // Put the work folder at a different depth. The same relative path can
  // then not find FFmpeg from the work folder by chance.
  const temporary = path.join(root, "temp", "a", "b", "c", "d");
  await mkdir(temporary, { recursive: true });
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = temporary;
  try {
    await media.export({ path: source, metadata, timeline }, output);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  assert.ok(region(frameAt(output, 1, 640, 360), isRed).count > 10000);
  // A normal name from PATH still works.
  assert.equal(new Media().ffmpeg, "ffmpeg");
});

test(
  "a video with 50 cuts and the maximum 100 elements exports on Windows",
  { timeout: 300000 },
  async () => {
    const root = await workspace("render-limit-");
    const source = path.join(root, "long.mp4");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1e2127:s=320x180:r=30:d=20",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=20",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      source,
    ]);
    const media = new Media();
    const metadata = await media.probe(source);
    let timeline = createTimeline(metadata.duration);
    // 100 elements in a 10 x 10 grid. Only the first and last have a red
    // fill, so the test can find them.
    for (let i = 0; i < 100; i++)
      timeline = addElement(timeline, metadata.duration, `e${i}`, {
        type: "text",
        text: `T${i}`,
        start: i * 0.18,
        end: i * 0.18 + 1.5,
        x: (i % 10) * 0.1,
        y: Math.floor(i / 10) * 0.1,
        width: 0.1,
        height: 0.1,
        size: 0.05,
        background: i === 0 || i === 99 ? "#FF0000" : "none",
        backgroundOpacity: 1,
      });
    // 50 separate cuts. Cut from the end, so earlier edited times do not move.
    for (let i = 49; i >= 0; i--)
      timeline = cut(timeline, 0.3 + i * 0.39, 0.4 + i * 0.39);
    assert.equal(timeline.segments.length, 51);
    const output = path.join(root, "limit.mp4");
    await media.export({ path: source, metadata, timeline }, output);
    const result = await media.probe(output);
    // 15 edited seconds are exactly 450 frames at 30 fps. Cuts do not add
    // frames.
    const times = frameTimes(output);
    assert.equal(times.length, 450);
    assert.ok(
      times.every((t, n) => Math.abs(t - n / 30) < 1e-6),
      "Frame n is at n / 30 seconds.",
    );
    assert.ok(Math.abs(result.duration - 15) < 0.03, String(result.duration));
    assert.equal(result.hasAudio, true);
    const placed = Object.fromEntries(
      describeElements(timeline).map((e) => [e.id, e]),
    );
    for (const [id, cell] of [
      ["e0", { left: 0, top: 0, right: 32, bottom: 18 }],
      ["e99", { left: 288, top: 162, right: 320, bottom: 180 }],
    ]) {
      const { start, end } = placed[id];
      const frame = frameAt(output, (start + end) / 2, 320, 180);
      assert.ok(region(frame, isRed, cell).count > 300, `${id} is visible.`);
    }
  },
);
