import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media, run } from "../src/adapters/media.js";
import {
  createTimeline,
  cut,
  configure,
  duration,
  sourceTime,
  editedTime,
} from "../src/domain/timeline.js";
import { addElement, describeElements } from "../src/domain/elements.js";
import { frameTimes, grayFrames, mean } from "../test-support/frames.js";
import { Service } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { FrameInspection } from "../src/adapters/inspection.js";

const WIDTH = 160,
  HEIGHT = 90,
  BITS = 10;

async function workspace(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  return mkdtemp(path.resolve(".local/claude-editing", prefix));
}

// A black 30 fps source. Each frame shows its own frame number as 10 white
// or black blocks at the top. Optional audio has a 30 ms 1 kHz burst at
// each multiple of 0.5 source seconds.
async function barcodeSource(root, seconds, audio) {
  const file = path.join(root, `barcode-${seconds}.mkv`);
  const boxes = Array.from(
    { length: BITS },
    (_, b) =>
      `drawbox=x=${b * 16}:y=0:w=16:h=16:color=white:t=fill:enable='eq(mod(floor(n/${2 ** b}),2),1)'`,
  );
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=${seconds}`,
  ];
  if (audio)
    args.push(
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs='0.5*sin(2*PI*1000*t)*lt(mod(t,0.5),0.03)':s=48000:d=${seconds}`,
    );
  args.push(
    "-vf",
    boxes.join(","),
    "-c:v",
    "libx264",
    "-qp",
    "0",
    "-pix_fmt",
    "yuv420p",
  );
  if (audio) args.push("-c:a", "pcm_s16le");
  args.push(file);
  await run("ffmpeg", args);
  return file;
}

const frameNumber = (frame) =>
  Array.from({ length: BITS }, (_, b) =>
    mean(frame, WIDTH, b * 16 + 4, 4, b * 16 + 12, 12) > 128 ? 2 ** b : 0,
  ).reduce((a, b) => a + b, 0);
// The label box is x 0.1 to 0.9 and y 0.5 to 0.9. Its fill is white.
const labelShown = (frame) => mean(frame, WIDTH, 40, 52, 120, 76) > 128;

// The source frame on screen at a source time.
const onScreen = (seconds, frames) =>
  Math.min(frames - 1, Math.floor(seconds * 30 + 1e-6));

// Check every encoded frame against the edited clock.
function checkFrames(output, timeline, sourceFrames, label) {
  const total = duration(timeline);
  const times = frameTimes(output);
  const frames = grayFrames(output, WIDTH, HEIGHT);
  const expected = Math.ceil(total * 30 - 1e-6);
  assert.equal(times.length, expected, "Frame count is ceil(duration x 30).");
  assert.equal(frames.length, expected);
  const errors = [];
  for (let n = 0; n < expected; n++) {
    const t = times[n];
    if (Math.abs(t - n / 30) > 1e-6) errors.push(`frame ${n} at ${t}`);
    const want = onScreen(sourceTime(timeline, n / 30), sourceFrames);
    const got = frameNumber(frames[n]);
    if (got !== want)
      errors.push(`frame ${n}: source ${got}, expected ${want}`);
    if (label) {
      const shown = n / 30 >= label.start && n / 30 < label.end;
      if (labelShown(frames[n]) !== shown)
        errors.push(`frame ${n} (${(n / 30).toFixed(6)} s): label ${!shown}`);
    }
  }
  assert.deepEqual(errors.slice(0, 8), [], `${errors.length} frame errors`);
}

const label = (extra) => ({
  type: "text",
  text: "L",
  x: 0.1,
  y: 0.5,
  width: 0.8,
  height: 0.4,
  size: 0.1,
  color: "#FFFFFF",
  background: "#FFFFFF",
  backgroundOpacity: 1,
  outline: "none",
  ...extra,
});

test("every encoded frame follows the edited clock, source content, and [start, end)", async () => {
  const root = await workspace("clock-");
  const source = await barcodeSource(root, 4, false);
  const media = new Media();
  const metadata = await media.probe(source);
  const base = createTimeline(metadata.duration);
  const cases = {
    // Review reproduction: label on source 1 to 2, cut 0.5 to 1.2, speed 2.
    // The label shows from edited 0.25 to 0.65.
    "cut and speed 2": configure(
      cut(addElement(base, 4, "a", label({ start: 1, end: 2 })), 0.5, 1.2),
      { speed: 2 },
    ),
    "speed 1.25": addElement(
      configure(base, { speed: 1.25 }),
      4,
      "a",
      label({ start: 0.2, end: 0.6 }),
    ),
    "speed 2": addElement(
      configure(base, { speed: 2 }),
      4,
      "a",
      label({ start: 0.125, end: 0.375 }),
    ),
    "speed 0.5": addElement(
      configure(base, { speed: 0.5 }),
      4,
      "a",
      label({ start: 0.3, end: 0.9 }),
    ),
    "speed 0.75": addElement(
      configure(base, { speed: 0.75 }),
      4,
      "a",
      label({ start: 0.4, end: 1.2 }),
    ),
    "near frame times": addElement(
      base,
      4,
      "a",
      label({ start: 1.00005, end: 2.00005 }),
    ),
  };
  for (const [name, timeline] of Object.entries(cases)) {
    const output = path.join(root, `${name.replaceAll(" ", "-")}.mp4`);
    await media.export({ path: source, metadata, timeline }, output);
    const [element] = describeElements(timeline);
    await test(name, () => checkFrames(output, timeline, 120, element));
  }
  assert.deepEqual(
    (({ start, end }) => [start, end])(
      describeElements(cases["cut and speed 2"])[0],
    ),
    [0.25, 0.65],
  );
});

// Keep the given source ranges. Cut from the end, so each cut uses source
// times while the speed is 1.
function keepOnly(seconds, kept) {
  let timeline = createTimeline(seconds);
  const gaps = [];
  let previous = 0;
  for (const [start, end] of kept) {
    if (start > previous) gaps.push([previous, start]);
    previous = end;
  }
  if (previous < seconds) gaps.push([previous, seconds]);
  for (const [start, end] of gaps.reverse())
    timeline = cut(timeline, start, end);
  return timeline;
}

function audioOnsets(file) {
  const samples = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const onsets = [];
  let last = -Infinity;
  for (let i = 0; i < samples.length / 4; i++) {
    if (Math.abs(samples.readFloatLE(i * 4)) < 0.05) continue;
    if (i - last > 4800) onsets.push(i / 48000);
    last = i;
  }
  return { onsets, duration: samples.length / 4 / 48000 };
}

for (const [name, speed, count, muted, tolerance] of [
  ["50 cuts at speed 1", 1, 50, false, 0.005],
  // At speeds other than 1, the time stretch (atempo) moves a burst by
  // about 10 to 18 ms. This is bounded and does not add up over cuts.
  ["20 cuts at speed 1.25", 1.25, 20, false, 0.02],
  ["20 cuts at speed 1.25, muted", 1.25, 20, true, 0],
])
  test(`${name} keep frame times, content, and audio on the edited clock`, async (t) => {
    const root = await workspace("clock-cuts-");
    const source = await barcodeSource(root, 20, true);
    const media = new Media();
    const metadata = await media.probe(source);
    // Kept ranges that do not start or end on frame times, with one very
    // short range (0.01 seconds) near the end.
    const step = 19 / count;
    const kept = Array.from({ length: count }, (_, i) => [
      0.013 + i * step,
      0.013 + i * step + step * 0.7,
    ]);
    kept.push([19.4, 19.41], [19.6, 19.95]);
    let timeline = keepOnly(metadata.duration, kept);
    timeline = configure(timeline, { speed, muted });
    assert.equal(timeline.segments.length, count + 2);
    const output = path.join(root, "cuts.mp4");
    await media.export({ path: source, metadata, timeline }, output);
    checkFrames(output, timeline, 600);
    const total = duration(timeline);
    const streams = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      output,
    ])
      .toString()
      .trim()
      .split(/\r?\n/);
    if (muted) {
      assert.deepEqual(streams, ["video"]);
      return;
    }
    const sound = audioOnsets(output);
    // AAC ends with at most one 1024-sample frame of padding.
    assert.ok(
      sound.duration > total - 0.002 && sound.duration < total + 0.03,
      `Audio ${sound.duration} s, edited ${total} s`,
    );
    // Each full burst is at its edited time, also after many cuts.
    const errors = [];
    for (let m = 0; m < 40; m++) {
      const at = m * 0.5;
      const inside = timeline.segments.some(
        (s) => s.start <= at - 0.005 && at + 0.035 <= s.end,
      );
      if (!inside) continue;
      const expected = editedTime(timeline, at);
      const nearest = sound.onsets.reduce((best, o) =>
        Math.abs(o - expected) < Math.abs(best - expected) ? o : best,
      );
      errors.push(Math.abs(nearest - expected));
    }
    t.diagnostic(
      `audio ${sound.duration.toFixed(5)} s for edited ${total.toFixed(5)} s; ${errors.length} bursts; largest error ${(Math.max(...errors) * 1000).toFixed(2)} ms; errors in ms ${errors.map((e) => (e * 1000).toFixed(1)).join(" ")}`,
    );
    assert.ok(errors.length >= 8, `Checked bursts: ${errors.length}`);
    // No accumulation: late bursts have the same error as early bursts.
    const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;
    assert.ok(
      Math.abs(average(errors.slice(-5)) - average(errors.slice(0, 5))) < 0.005,
      "The burst time error must not grow over the video.",
    );
    assert.ok(
      Math.max(...errors) < tolerance,
      `Burst time errors: ${errors.map((e) => e.toFixed(4)).join(" ")}`,
    );
  });

test("frame inspection reports times and source times of the encoded frames after many cuts", async () => {
  const root = await workspace("clock-inspect-");
  const source = await barcodeSource(root, 20, true);
  const media = new Media();
  const previews = new PreviewCache(root, media);
  const service = new Service({
    library: new Library(root),
    media,
    previews,
    inspection: new FrameInspection(media, previews),
  });
  const video = await service.execute("library.import", { path: source });
  // 40 cuts: keep 0.31 seconds of each 0.47 seconds of source.
  for (let i = 39; i >= 0; i--)
    await service.execute("edit.cut", {
      id: video.id,
      start: 0.31 + i * 0.47,
      end: 0.47 + i * 0.47,
    });
  const { timeline } = await service.execute("library.get", { id: video.id });
  const total = duration(timeline);
  const timestamps = [0.5, 3.01, 6.02, total - 1, total - 0.2, total - 0.001];
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps,
  });
  for (let i = 0; i < 600; i++) {
    const state = await service.execute("export.status", { jobId: job.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const result = await service.execute("inspect.result", {
    jobId: job.id,
    includeImages: false,
  });
  for (const frame of result.frames) {
    // The selected frame is the encoded frame at or before the request.
    const n = Math.floor(frame.requestedSeconds * 30 + 1e-6);
    assert.ok(Math.abs(frame.seconds - n / 30) < 1e-6, JSON.stringify(frame));
    const [image] = grayFrames(frame.path, WIDTH, HEIGHT);
    assert.equal(
      frameNumber(image),
      onScreen(frame.sourceSeconds, 600),
      `The image at ${frame.seconds} s must show source time ${frame.sourceSeconds} s.`,
    );
  }
});
