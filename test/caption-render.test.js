import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { Media, run, captionScript } from "../src/adapters/media.js";
import { createTimeline, cut, configure } from "../src/domain/timeline.js";
import { addElement } from "../src/domain/elements.js";
import {
  applyCaptions,
  configureCaptions,
  describeCaptions,
  CAPTION_LIMITS,
} from "../src/domain/captions.js";
import {
  frameAt,
  region,
  bands,
  isRed,
  isWhite,
} from "../test-support/frames.js";

async function plainSource(
  root,
  name = "source.mp4",
  seconds = 3,
  size = "640x360",
) {
  const file = path.join(root, name);
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x1e2127:s=${size}:r=30:d=${seconds}`,
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
let next = 0;
const ids = () => `cue${++next}`;
// Cues in source seconds, then the caption style.
function withCues(timeline, cues, style = {}) {
  const applied = applyCaptions(timeline, cues, { ids }).timeline;
  return Object.keys(style).length
    ? configureCaptions(applied, style)
    : applied;
}
const cue = (start, end, text) => ({
  sourceStart: start,
  sourceEnd: end,
  text,
});
// The output frame n, decoded. Output seeking selects the first frame at or
// after the time.
const frame = (file, n, width = 640, height = 360) =>
  frameAt(file, n / 30 - 0.001, width, height);

// Characters with a meaning in FFmpeg filter syntax, sendcmd syntax,
// drawtext expansion, and the command argument parser.
const HOSTILE =
  '\'; drawbox=c=red:t=fill ,[x] \\ {b} %{pts} "q" #h é ß\n' +
  "two; drawtext@captions enable 0, [leave] x";

test("caption script text escapes every byte that is not a letter or digit", () => {
  const file = captionScript([
    { start: 0.5, end: 1, text: "a b,c;d" },
    { start: 1, end: 1.000001, text: "é\n" },
  ]).toString("latin1");
  assert.equal(
    file,
    "0.500000-1.000000 [enter] drawtext@captions text a\\ b\\,c\\;d, drawtext@captions enable 1, [leave] drawtext@captions enable 0;\n" +
      "1.000000-1.000001 [enter] drawtext@captions text \\\xc3\\\xa9\\\n, drawtext@captions enable 1, [leave] drawtext@captions enable 0;\n",
  );
});

test("a caption renders the same pixels as a text element with its box and text", async () => {
  const root = await workspace("caption-render-");
  const source = await plainSource(root);
  const original = await readFile(source);
  const media = new Media();
  const metadata = await media.probe(source);
  const style = {
    x: 0.1,
    y: 0.55,
    width: 0.8,
    height: 0.35,
    size: 0.05,
    background: "#FF0000",
    backgroundOpacity: 1,
  };
  const captioned = withCues(
    createTimeline(metadata.duration),
    [cue(1, 2, HOSTILE)],
    style,
  );
  const labelled = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "a",
    {
      type: "text",
      text: HOSTILE,
      start: 1,
      end: 2,
      font: "sans",
      bold: true,
      color: "#FFFFFF",
      align: "center",
      verticalAlign: "bottom",
      outline: "#000000",
      ...style,
    },
  );
  const a = path.join(root, "caption.mp4"),
    b = path.join(root, "element.mp4");
  await media.export({ path: source, metadata, timeline: captioned }, a);
  await media.export({ path: source, metadata, timeline: labelled }, b);
  for (const n of [29, 30, 45, 59, 60]) {
    const left = frame(a, n),
      right = frame(b, n);
    let differ = 0;
    for (let i = 0; i < left.data.length; i++)
      if (Math.abs(left.data[i] - right.data[i]) > 2) differ++;
    assert.equal(differ, 0, `Frame ${n} differs in ${differ} values.`);
  }
  const shown = frame(a, 45);
  // The text cannot add a filter: only the caption box is red.
  const box = region(shown, isRed);
  assert.ok(
    Math.abs(box.minY - 198) <= 2 && Math.abs(box.maxY - 323) <= 2,
    JSON.stringify(box),
  );
  assert.equal(bands(region(shown, isWhite).rows).length, 2, "Two lines.");
  assert.equal(region(frame(a, 29), isRed).count, 0);
  assert.equal(region(frame(a, 60), isRed).count, 0);
  // Expansion is off, so %{pts} does not change between frames.
  const early = frame(a, 31),
    late = frame(a, 58);
  let changed = 0;
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++)
      if (isWhite(early.at(x, y)) !== isWhite(late.at(x, y))) changed++;
  assert.ok(changed < 20, `Changed text pixels: ${changed}`);
  assert.deepEqual(await readFile(source), original);
});

test("adjacent captions switch at the exact frame and a gap shows nothing", async () => {
  const root = await workspace("caption-edge-");
  const source = await plainSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = withCues(createTimeline(metadata.duration), [
    cue(0.5, 1, "I"),
    cue(1, 1.5, "WWWWWWWWWWWWWW"),
    // Fractional edges: frame 60 (2.000 s) is before the start.
    cue(2.00005, 2.50005, "MM"),
  ]);
  const output = path.join(root, "edges.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const width = (n) => {
    const text = region(frame(output, n), isWhite);
    return text.count ? text.maxX - text.minX : 0;
  };
  const expected = [
    [14, "none"],
    [15, "narrow"],
    [29, "narrow"],
    [30, "wide"],
    [44, "wide"],
    [45, "none"],
    [60, "none"],
    [61, "medium"],
    [75, "medium"],
    [76, "none"],
  ];
  for (const [n, kind] of expected) {
    const w = width(n);
    const actual =
      w === 0 ? "none" : w < 25 ? "narrow" : w > 150 ? "wide" : "medium";
    assert.equal(actual, kind, `Frame ${n}: width ${w}`);
  }
});

test("captions draw over shapes, follow cuts and speed, and fade with the video", async () => {
  const root = await workspace("caption-edit-");
  // Red marker frames for source 1 to 2 seconds.
  const source = path.join(root, "marked.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1e2127:s=640x360:r=30:d=3",
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
  // A blue rectangle under the caption area for the full video.
  let timeline = addElement(
    createTimeline(metadata.duration),
    metadata.duration,
    "box",
    {
      type: "rectangle",
      start: 0,
      end: 3,
      x: 0,
      y: 0.6,
      width: 1,
      height: 0.4,
      fill: "#0000FF",
      fillOpacity: 1,
      stroke: "none",
    },
  );
  timeline = withCues(timeline, [cue(1, 2, "XXXX")], { size: 0.1 });
  // Remove source 0.5 to 1.2, then play at double speed. The caption shows
  // from edited 0.25 to 0.65, with its source marker.
  timeline = configure(cut(timeline, 0.5, 1.2), { speed: 2 });
  assert.deepEqual(
    describeCaptions(timeline).cues.map((c) => [c.start, c.end, c.visibility]),
    [[0.25, 0.65, "partial"]],
  );
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const area = { left: 0, top: 216, right: 640, bottom: 360 };
  for (const [n, shown] of [
    [7, false],
    [8, true],
    [19, true],
    [20, false],
  ]) {
    const decoded = frame(output, n);
    assert.equal(isRed(decoded.at(320, 20)), shown, `Marker at frame ${n}`);
    assert.equal(
      region(decoded, isWhite, area).count > 200,
      shown,
      `Caption over the shape at frame ${n}`,
    );
    // The shape is under the caption at all times.
    const [r, g, b] = decoded.at(5, 350);
    assert.ok(b > 180 && r < 60 && g < 60, `Shape at frame ${n}`);
  }
  // A fade from black of 1 second: at frame 9 (0.3 s) the caption is dim.
  const faded = configure(timeline, { fadeIn: 1 });
  const dim = path.join(root, "faded.mp4");
  await media.export({ path: source, metadata, timeline: faded }, dim);
  const decoded = frame(dim, 9);
  let brightest = 0;
  for (let y = area.top; y < area.bottom; y++)
    for (let x = 0; x < 640; x++)
      brightest = Math.max(brightest, ...decoded.at(x, y));
  assert.ok(
    brightest > 40 && brightest < 140,
    `Brightest caption value ${brightest}`,
  );
  // Hidden captions do not render.
  const hidden = configureCaptions(timeline, { enabled: false });
  const off = path.join(root, "hidden.mp4");
  await media.export({ path: source, metadata, timeline: hidden }, off);
  assert.equal(region(frame(off, 12), isWhite, area).count, 0);
});

test(
  "the maximum number of long captions with cuts exports on Windows",
  { timeout: 300000 },
  async () => {
    const root = await workspace("caption-limit-");
    const source = await plainSource(root, "long.mp4", 30, "320x180");
    const media = new Media();
    const metadata = await media.probe(source);
    const text = `${"é;,'\\%{n} ".repeat(20).trim()}`;
    const cues = Array.from({ length: CAPTION_LIMITS.cues }, (_, i) =>
      cue(i * 0.06, i * 0.06 + 0.05, i === 250 ? "MARK" : text.slice(0, 190)),
    );
    let timeline = withCues(createTimeline(metadata.duration), cues, {
      background: "#FF0000",
      backgroundOpacity: 1,
    });
    for (let i = 19; i >= 0; i--)
      timeline = cut(timeline, 0.3 + i * 1.4, 0.35 + i * 1.4);
    const listed = describeCaptions(timeline, { limit: 200, offset: 200 });
    const mark = listed.cues.find((c) => c.text === "MARK");
    assert.ok(mark && mark.visibility === "full");
    const output = path.join(root, "limit.mp4");
    const started = Date.now();
    await media.export({ path: source, metadata, timeline }, output);
    const elapsed = Date.now() - started;
    const at = Math.ceil((mark.start + 1e-6) * 30);
    assert.ok(region(frame(output, at, 320, 180), isRed).count > 300);
    // One caption filter for all cues, not one filter per cue. A wide
    // bound: the work is small, but this computer can be busy.
    assert.ok(elapsed < 60000, `Export took ${elapsed} ms.`);
  },
);
