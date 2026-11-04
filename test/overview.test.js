// Pure rules of the timeline overview: bounded plans, level scale, and the
// mapping of source data to the edited timeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  cut,
  trim,
  configure,
} from "../src/domain/timeline.js";
import {
  OVERVIEW_LIMITS,
  overviewPlan,
  overviewIdentity,
  levelByte,
  byteLevel,
  editedLevels,
  frameAtEdited,
  windowPlan,
} from "../src/domain/overview.js";

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not near ${expected}`,
  );

test("the plan has fixed limits for any video length", () => {
  const short = overviewPlan({ duration: 10, hasAudio: true });
  assert.equal(short.audio.bucketSeconds, 0.02);
  assert.equal(short.audio.buckets, 500);
  assert.equal(short.frames.times.length, 20);

  const long = overviewPlan({ duration: 36000, hasAudio: true });
  assert.ok(long.audio.buckets <= OVERVIEW_LIMITS.maxBuckets);
  assert.ok(long.audio.bucketSeconds * long.audio.buckets >= 36000);
  assert.equal(long.frames.times.length, OVERVIEW_LIMITS.maxFrames);

  assert.equal(overviewPlan({ duration: 10, hasAudio: false }).audio, null);
  // A very short video still has a frame.
  assert.equal(
    overviewPlan({ duration: 0.2, hasAudio: true }).frames.times.length,
    1,
  );
  // A whole number of samples for each bucket, so buckets do not drift.
  assert.ok(Number.isInteger(short.audio.samplesPerBucket));
  assert.ok(Number.isInteger(long.audio.samplesPerBucket));
  near(
    long.audio.bucketSeconds,
    long.audio.samplesPerBucket / OVERVIEW_LIMITS.sampleRate,
  );
});

test("frame times are inside the video and start spread out", () => {
  const { times } = overviewPlan({ duration: 100, hasAudio: true }).frames;
  assert.ok(times.every((t) => t > 0 && t < 100));
  assert.equal(new Set(times).size, times.length);
  // A time budget can stop the work early. The first frames must then cover
  // the full video, not only its start.
  const first = times.slice(0, 4).sort((a, b) => a - b);
  assert.ok(first[0] < 30, String(first));
  assert.ok(first[3] > 70, String(first));
  const sorted = [...times].sort((a, b) => a - b);
  const steps = sorted.slice(1).map((t, i) => t - sorted[i]);
  assert.ok(Math.max(...steps) - Math.min(...steps) < 1e-6, "Even spacing.");
});

test("the cache identity changes with the source file and the version", () => {
  const video = {
    id: "a",
    path: "/media/a.mp4",
    metadata: { duration: 10, width: 640, height: 360, hasAudio: true },
  };
  const file = { size: 100, mtimeMs: 5 };
  const base = overviewIdentity(video, file);
  assert.equal(overviewIdentity({ ...video }, { ...file }), base);
  assert.notEqual(overviewIdentity({ ...video, id: "b" }, file), base);
  assert.notEqual(overviewIdentity({ ...video, path: "/x" }, file), base);
  assert.notEqual(overviewIdentity(video, { ...file, size: 101 }), base);
  assert.notEqual(overviewIdentity(video, { ...file, mtimeMs: 6 }), base);
  assert.notEqual(
    overviewIdentity(
      { ...video, metadata: { ...video.metadata, duration: 11 } },
      file,
    ),
    base,
  );
  // Edits are not in the identity: the data comes from the source.
  assert.equal(
    overviewIdentity({ ...video, timeline: { speed: 2 } }, file),
    base,
  );
});

test("levels use one byte and keep quiet sound visible", () => {
  assert.equal(levelByte(0), 0);
  assert.equal(levelByte(1), 255);
  assert.equal(levelByte(2), 255, "Clipped.");
  assert.ok(levelByte(0.01) > 20, "Quiet sound shows.");
  near(byteLevel(levelByte(0.25)), Math.sqrt(0.25), 0.01);
});

// 10 seconds of source at 1 bucket for each second. Each bucket value is its
// second, so a mapped value tells which source second it came from.
const overview = {
  bucketSeconds: 1,
  levels: Uint8Array.from([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]),
};
const values = (result) => [...result].map((value) => Math.round(value * 255));

test("levels follow the edited time after a cut", () => {
  const timeline = cut(createTimeline(10), 2, 6);
  // Edited 0 to 2 is source 0 to 2. Edited 2 to 6 is source 6 to 10.
  assert.deepEqual(
    values(editedLevels(timeline, overview, { start: 0, end: 6, columns: 6 })),
    [0, 10, 60, 70, 80, 90],
  );
});

test("levels follow the edited time after a trim and at another speed", () => {
  const trimmed = trim(createTimeline(10), 4, 8);
  assert.deepEqual(
    values(editedLevels(trimmed, overview, { start: 0, end: 4, columns: 4 })),
    [40, 50, 60, 70],
  );
  const fast = configure(createTimeline(10), { speed: 2 });
  assert.deepEqual(
    values(editedLevels(fast, overview, { start: 0, end: 5, columns: 5 })),
    [10, 30, 50, 70, 90],
  );
  // At 0.5x, one second of source fills two columns.
  const slow = configure(createTimeline(10), { speed: 0.5 });
  assert.deepEqual(
    values(editedLevels(slow, overview, { start: 0, end: 4, columns: 4 })),
    [0, 0, 10, 10],
  );
});

test("a column shows the loudest bucket that it covers, also over a join", () => {
  const timeline = cut(createTimeline(10), 2, 8);
  // One column covers edited 0 to 4: source 0 to 2 and source 8 to 10.
  assert.deepEqual(
    values(editedLevels(timeline, overview, { start: 0, end: 4, columns: 1 })),
    [90],
  );
  // A column between two buckets has a value.
  const wide = editedLevels(createTimeline(10), overview, {
    start: 3.2,
    end: 3.4,
    columns: 2,
  });
  assert.deepEqual(values(wide), [30, 30]);
});

test("level columns stop at the end of the data and of the video", () => {
  const timeline = createTimeline(10);
  assert.deepEqual(
    values(editedLevels(timeline, overview, { start: 9, end: 12, columns: 3 })),
    [90, 0, 0],
  );
  const partial = { bucketSeconds: 1, levels: Uint8Array.from([50]) };
  assert.deepEqual(
    values(editedLevels(timeline, partial, { start: 0, end: 2, columns: 2 })),
    [50, 0],
  );
  assert.equal(
    editedLevels(timeline, overview, { start: 0, end: 1, columns: 0 }).length,
    0,
  );
});

test("the frame for an edited time comes from the kept source time", () => {
  const frames = [
    { seconds: 1, data: "a" },
    { seconds: 3, data: "b" },
    { seconds: 5, data: "c" },
    { seconds: 7, data: "d" },
  ];
  const plain = createTimeline(10);
  assert.equal(frameAtEdited(plain, frames, 0).data, "a");
  assert.equal(frameAtEdited(plain, frames, 2.9).data, "b");
  assert.equal(frameAtEdited(plain, frames, 9.9).data, "d");
  // Without the cut, 2.1 is near the frame at 3. After the cut, edited 2.1 is
  // source 6.1, so the frame at 7 is the nearest.
  assert.equal(frameAtEdited(plain, frames, 2.1).data, "b");
  const edited = cut(plain, 2, 6);
  assert.equal(frameAtEdited(edited, frames, 2.1).data, "d");
  assert.equal(frameAtEdited(edited, frames, 1.9).data, "a");
  assert.equal(frameAtEdited(plain, [], 1), null);
  // A time past the end is the last frame, not an error.
  assert.equal(frameAtEdited(plain, frames, 11).data, "d");
});

test("a frame from a removed part never shows as kept video", () => {
  const frames = [1, 3, 5, 7].map((seconds) => ({
    seconds,
    data: `${seconds}`,
  }));
  // Only source 2 to 2.2 stays. The frames at 1 and 3 are not in it.
  const short = configure(trim(createTimeline(10), 2, 2.2), { speed: 2 });
  assert.equal(frameAtEdited(short, frames, 0.05), null);
  // Two kept parts. Each time uses the frames of its own part.
  const parts = cut(createTimeline(10), 0.2, 9.8);
  const samples = [0.1, 0.25, 5, 9.75, 9.9].map((seconds) => ({
    seconds,
    data: `${seconds}`,
  }));
  assert.equal(frameAtEdited(parts, samples, 0.15).data, "0.1");
  assert.equal(frameAtEdited(parts, samples, 0.3).data, "9.9");
  // A part with no sample has no frame, not a frame of the other part.
  const none = [{ seconds: 0.1, data: "first" }];
  assert.equal(frameAtEdited(parts, none, 0.3), null);
  // The last frame stays usable at the end of a part.
  assert.equal(frameAtEdited(createTimeline(10), frames, 10).data, "7");
  // The end of a kept part is not in it: a frame at that time is removed.
  const edge = [{ seconds: 3, data: "next" }];
  assert.equal(frameAtEdited(trim(createTimeline(10), 2, 3), edge, 0.9), null);
});

test("an agent read has a limited window in the edited video", () => {
  const timeline = createTimeline(100);
  assert.deepEqual(windowPlan(timeline, {}), {
    start: 0,
    end: 100,
    buckets: 100,
  });
  assert.deepEqual(windowPlan(timeline, { start: 10, end: 20, buckets: 50 }), {
    start: 10,
    end: 20,
    buckets: 50,
  });
  assert.throws(() => windowPlan(timeline, { buckets: 0 }), /buckets/);
  assert.throws(() => windowPlan(timeline, { buckets: 5000 }), /buckets/);
  assert.throws(() => windowPlan(timeline, { start: 5, end: 5 }), /range/);
  assert.throws(() => windowPlan(timeline, { end: 101 }), /range/);
  assert.throws(() => windowPlan(timeline, { start: -1 }), /range/);
  assert.throws(() => windowPlan(timeline, { start: Number.NaN }), /range/);
  assert.throws(() => windowPlan(timeline, { end: Number.NaN }), /range/);
  assert.throws(() => windowPlan(timeline, { start: "1", end: 2 }), /range/);
  assert.throws(() => windowPlan(timeline, { end: Infinity }), /range/);
  assert.equal(
    windowPlan(trim(timeline, 0, 10), {}).end,
    10,
    "The default end is the edited end.",
  );
});
