import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media, run } from "../src/adapters/media.js";
import { createTimeline, configure } from "../src/domain/timeline.js";
import { addElement, orderElement } from "../src/domain/elements.js";
import { frameAt, region, isRed } from "../test-support/frames.js";

async function workspace(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  return mkdtemp(path.resolve(".local/claude-editing", prefix));
}

async function source(root, color = "black", seconds = 3, audio = false) {
  const file = path.join(root, `${color}.mkv`);
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=640x360:r=30:d=${seconds}`,
  ];
  if (audio)
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "pcm_s16le");
  await run("ffmpeg", [...args, file]);
  return file;
}

async function render(root, file, timeline, name) {
  const media = new Media();
  const metadata = await media.probe(file);
  const output = path.join(root, `${name}.mp4`);
  await media.export({ path: file, metadata, timeline }, output);
  return output;
}

const isGreen = ([r, g, b]) => g > 180 && r < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 180 && r < 90 && g < 90;
const isYellow = ([r, g, b]) => r > 180 && g > 180 && b < 90;
const gray = (frame, x, y) => {
  const [r, g, b] = frame.at(x, y);
  return (r + g + b) / 3;
};

test("rectangles and ellipses render fill, an inside line, and layer order", async () => {
  const root = await workspace("shape-render-");
  const file = await source(root);
  let timeline = createTimeline(3);
  const solid = { fillOpacity: 1, start: 0, end: 3 };
  // Red A: x 64 to 319, y 36 to 179.
  timeline = addElement(timeline, 3, "a", {
    type: "rectangle",
    ...solid,
    x: 0.1,
    y: 0.1,
    width: 0.4,
    height: 0.4,
    fill: "#FF0000",
    stroke: "none",
  });
  // Blue B over A with a 7-pixel green line inside its box: x 192 to 447,
  // y 108 to 251.
  timeline = addElement(timeline, 3, "b", {
    type: "rectangle",
    ...solid,
    x: 0.3,
    y: 0.3,
    width: 0.4,
    height: 0.4,
    fill: "#0000FF",
    stroke: "#00FF00",
    strokeWidth: 0.02,
  });
  // Yellow ellipse in the box x 384 to 575, y 216 to 323.
  timeline = addElement(timeline, 3, "c", {
    type: "ellipse",
    ...solid,
    x: 0.6,
    y: 0.6,
    width: 0.3,
    height: 0.3,
    fill: "#FFFF00",
    stroke: "none",
  });
  const output = await render(root, file, timeline, "shapes");
  const frame = frameAt(output, 1, 640, 360);
  const red = region(frame, isRed);
  for (const [actual, expected] of [
    [red.minX, 64],
    [red.minY, 36],
    [red.maxX, 319],
    [red.maxY, 179],
  ])
    assert.ok(Math.abs(actual - expected) <= 2, JSON.stringify(red));
  // B is above A where they overlap, so this point is blue, not red.
  assert.ok(isBlue(frame.at(260, 150)), String(frame.at(260, 150)));
  // The line is inside the box edge: green at the box edge, blue inside it.
  const line = region(frame, isGreen, {
    left: 180,
    top: 160,
    right: 230,
    bottom: 200,
  });
  assert.ok(
    Math.abs(line.minX - 192) <= 1 && Math.abs(line.maxX - 198) <= 1,
    JSON.stringify(line),
  );
  assert.ok(isBlue(frame.at(205, 180)));
  // The ellipse fills its center but not the corners of its box.
  assert.ok(isYellow(frame.at(480, 270)));
  assert.ok(isYellow(frame.at(388, 270)));
  assert.ok(!isYellow(frame.at(390, 222)), String(frame.at(390, 222)));
  // Move B to the bottom layer. Now A is in front where they overlap.
  const reordered = await render(
    root,
    file,
    orderElement(timeline, "b", 0),
    "reordered",
  );
  assert.ok(isRed(frameAt(reordered, 1, 640, 360).at(260, 150)));
});

test("review: very small shapes with a line render without an invalid drawing", async () => {
  const root = await workspace("tiny-shape-");
  const file = path.join(root, "small.mkv");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:r=30:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  // A 3 x 1 pixel ellipse and a 2 x 2 pixel rectangle with the default line.
  let timeline = addElement(createTimeline(1), 1, "e", {
    type: "ellipse",
    start: 0,
    end: 1,
    x: 0.2,
    y: 0.2,
    width: 0.02,
    height: 0.01,
  });
  timeline = addElement(timeline, 1, "r", {
    type: "rectangle",
    start: 0,
    end: 1,
    x: 0.6,
    y: 0.6,
    width: 0.0125,
    height: 0.02,
  });
  const media = new Media();
  const metadata = await media.probe(file);
  const output = path.join(root, "tiny.mp4");
  await media.export({ path: file, metadata, timeline }, output);
  const frame = frameAt(output, 0.5, 160, 90);
  // The line color (#EBCB8B) covers the small shapes.
  const lit = (x, y) => frame.at(x, y)[0] > 60;
  assert.ok(lit(33, 18) || lit(34, 18), String(frame.at(33, 18)));
  assert.ok(lit(96, 54), String(frame.at(96, 54)));
});

test("review: element opacity and fades apply once to the composed element", async () => {
  const root = await workspace("compose-render-");
  const black = await source(root, "black", 3);
  const white = await source(root, "white", 3);
  const at = (frame, x, y) => frame.at(x, y);
  const near = (actual, expected, label) =>
    assert.ok(
      actual.every((v, i) => Math.abs(v - expected[i]) < 18),
      `${label}: ${actual}, expected ${expected}`,
    );
  // Rectangle A: white fill and white line at opacity 0.5. Rectangle B:
  // fill opacity 0.5 under an opaque white line, at opacity 0.5.
  let timeline = addElement(createTimeline(3), 3, "a", {
    type: "rectangle",
    start: 0,
    end: 3,
    x: 0.05,
    y: 0.1,
    width: 0.4,
    height: 0.5,
    fill: "#FFFFFF",
    fillOpacity: 1,
    stroke: "#FFFFFF",
    strokeWidth: 0.04,
    opacity: 0.5,
  });
  timeline = addElement(timeline, 3, "b", {
    type: "rectangle",
    start: 0,
    end: 3,
    x: 0.55,
    y: 0.1,
    width: 0.4,
    height: 0.5,
    fill: "#FFFFFF",
    fillOpacity: 0.5,
    stroke: "#FFFFFF",
    strokeWidth: 0.04,
    opacity: 0.5,
  });
  // Text: white glyph on a gray box, fading in from 1 to 2 seconds.
  timeline = addElement(timeline, 3, "t", {
    type: "text",
    text: "I",
    start: 1,
    end: 3,
    x: 0.3,
    y: 0.65,
    width: 0.4,
    height: 0.35,
    size: 0.3,
    bold: true,
    color: "#FFFFFF",
    background: "#808080",
    backgroundOpacity: 1,
    outline: "none",
    fadeIn: 1,
  });
  const output = await render(root, black, timeline, "compose");
  const frame = frameAt(output, 1.5, 640, 360);
  // A: the line (x 32 to 45) and the center have the same value.
  near(at(frame, 36, 110), [128, 128, 128], "A line");
  near(at(frame, 160, 110), [128, 128, 128], "A center");
  // B: the opaque line is twice as bright as the half-opacity fill.
  near(at(frame, 356, 110), [128, 128, 128], "B line");
  near(at(frame, 480, 110), [64, 64, 64], "B center");
  // Text at half of its fade: the glyph is white over the box, then half.
  const full = frameAt(output, 2.5, 640, 360);
  near(at(full, 320, 300), [255, 255, 255], "Glyph (full)");
  near(at(full, 220, 300), [128, 128, 128], "Box (full)");
  near(at(frame, 320, 300), [128, 128, 128], "Glyph at half fade");
  near(at(frame, 220, 300), [64, 64, 64], "Box at half fade");

  // A red arrow with a black outline at opacity 0.5 on white.
  const arrow = addElement(createTimeline(3), 3, "r", {
    type: "arrow",
    start: 0,
    end: 3,
    x1: 0.1,
    y1: 0.5,
    x2: 0.9,
    y2: 0.5,
    color: "#FF0000",
    strokeWidth: 0.05,
    outline: "#000000",
    opacity: 0.5,
  });
  const red = frameAt(
    await render(root, white, arrow, "arrow-opacity"),
    1,
    640,
    360,
  );
  // The shaft is 18 pixels high around y 180. Inside the shaft, also near
  // its edge where the outline overlaps, the color is the same.
  near(at(red, 200, 180), [255, 128, 128], "Shaft center");
  near(at(red, 200, 173), [255, 128, 128], "Shaft edge");
});

test("an arrow ends exactly at its tip", async () => {
  const root = await workspace("arrow-render-");
  const file = await source(root);
  const timeline = addElement(createTimeline(3), 3, "a", {
    type: "arrow",
    start: 0,
    end: 3,
    x1: 0.1,
    y1: 0.9,
    x2: 0.5,
    y2: 0.5,
    color: "#00FF00",
    strokeWidth: 0.02,
    outline: "none",
  });
  const frame = frameAt(
    await render(root, file, timeline, "arrow"),
    1,
    640,
    360,
  );
  const arrow = region(frame, isGreen);
  // Tip at (320, 180). It is the rightmost and highest arrow point.
  assert.ok(Math.abs(arrow.maxX - 319) <= 2, JSON.stringify(arrow));
  assert.ok(Math.abs(arrow.minY - 180) <= 2, JSON.stringify(arrow));
  // The tail is at (64, 324).
  assert.ok(Math.abs(arrow.minX - 64) <= 6 && Math.abs(arrow.maxY - 324) <= 6);
  // On the shaft line, not beside it.
  assert.ok(isGreen(frame.at(192, 252)), String(frame.at(192, 252)));
  assert.ok(!isGreen(frame.at(192, 230)));
});

test("element fades and video fades change opacity at the expected frames", async () => {
  const root = await workspace("fade-render-");
  const file = await source(root, "black", 4, true);
  // White rectangle from 1 to 3 seconds: fade in 1 s, fade out 0.5 s.
  let timeline = addElement(createTimeline(4), 4, "r", {
    type: "rectangle",
    start: 1,
    end: 3,
    x: 0,
    y: 0,
    width: 0.5,
    height: 1,
    fill: "#FFFFFF",
    fillOpacity: 1,
    stroke: "none",
    fadeIn: 1,
    fadeOut: 0.5,
  });
  // White text box on the right half with the same fades.
  timeline = addElement(timeline, 4, "t", {
    type: "text",
    text: "T",
    start: 1,
    end: 3,
    x: 0.5,
    y: 0,
    width: 0.5,
    height: 1,
    color: "#FFFFFF",
    background: "#FFFFFF",
    backgroundOpacity: 1,
    outline: "none",
    fadeIn: 1,
    fadeOut: 0.5,
  });
  const output = await render(root, file, timeline, "element-fades");
  for (const [seconds, level] of [
    [0.9, 0],
    [1, 0],
    [1.5, 128],
    [2, 255],
    [2.5, 255],
    [2.75, 128],
  ]) {
    const frame = frameAt(output, seconds, 640, 360);
    // The text sample is on the text box, away from the letter.
    for (const [x, y] of [
      [160, 180],
      [600, 40],
    ])
      assert.ok(
        Math.abs(gray(frame, x, y) - level) < 22,
        `${x === 160 ? "Shape" : "Text box"} at ${seconds} s: ${gray(frame, x, y)}, expected ${level}`,
      );
  }
  // Video fade from black and to black, with the sound.
  const white = await source(root, "white", 4, true);
  const faded = await render(
    root,
    white,
    configure(createTimeline(4), { fadeIn: 1, fadeOut: 1 }),
    "video-fades",
  );
  for (const [seconds, level] of [
    [0, 0],
    [0.5, 128],
    [2, 255],
    [3.5, 128],
  ])
    assert.ok(
      Math.abs(gray(frameAt(faded, seconds, 640, 360), 320, 180) - level) < 22,
      `Video at ${seconds} s`,
    );
  const samples = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      faded,
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const level = (from, to) => {
    let peak = 0;
    for (let i = Math.floor(from * 8000); i < to * 8000; i++)
      peak = Math.max(peak, Math.abs(samples.readFloatLE(i * 4)));
    return peak;
  };
  const full = level(1.5, 2.5);
  assert.ok(level(0, 0.05) < full * 0.1, "Sound starts silent.");
  assert.ok(Math.abs(level(0.45, 0.55) / full - 0.5) < 0.12, "Half at 0.5 s.");
  assert.ok(level(3.9, 3.98) < full * 0.15, "Sound ends silent.");
});
