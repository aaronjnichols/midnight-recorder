import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  access,
  readdir,
  open,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Service } from "../src/application/service.js";
import { Media, run } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { FrameInspection } from "../src/adapters/inspection.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";
import { inspectionPlan } from "../src/domain/inspection.js";
import { createTimeline } from "../src/domain/timeline.js";

async function setup() {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "inspection-"));
  const source = await createInspectionSource(root);
  const media = new Media();
  const library = new Library(root);
  const previews = new PreviewCache(root, media);
  const service = new Service({
    library,
    media,
    previews,
    inspection: new FrameInspection(media, previews),
  });
  const video = await service.execute("library.import", { path: source });
  return { root, source, service, video };
}

async function complete(service, job) {
  for (let i = 0; i < 300; i++) {
    const state = await service.execute("export.status", { jobId: job.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") return state.result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Inspection did not finish.");
}

function pixel(file, x, y) {
  return [
    ...execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `format=rgb24,crop=1:1:${x}:${y}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ]),
  ];
}

test("frame inspection follows a cut and speed change without changing the source", async () => {
  const { service, video, source } = await setup();
  const original = await readFile(source);
  await service.execute("edit.cut", { id: video.id, start: 1, end: 3 });
  await service.execute("edit.configure", { id: video.id, speed: 2 });
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [0.75],
    width: 480,
  });
  assert.equal(job.kind, "inspection");
  const result = await complete(service, job);
  const [frame] = result.frames;
  assert.equal(frame.requestedSeconds, 0.75);
  assert.ok(frame.seconds <= 0.75 && frame.seconds > 0.71);
  assert.ok(
    Math.abs(frame.sourceSeconds - (3 + (frame.seconds - 0.5) * 2)) < 1e-6,
  );
  assert.deepEqual([frame.width, frame.height], [480, 270]);
  assert.deepEqual(result.videoSize, { width: 960, height: 540 });
  const rightButton = pixel(frame.path, 350, 170);
  assert.ok(rightButton[1] > 150 && rightButton[0] > 100, String(rightButton));
  assert.ok(pixel(frame.path, 65, 170).every((v) => v < 70));
  assert.deepEqual(await readFile(source), original);
  assert.equal((await service.execute("app.status")).recording.state, "idle");
});

test("slow-speed inspection selects the visible frame at the requested edited time", async () => {
  const { service, video } = await setup();
  await service.execute("edit.configure", { id: video.id, speed: 0.5 });
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [4, 11.999],
    width: 480,
  });
  const result = await complete(service, job);
  const left = pixel(result.frames[0].path, 65, 170);
  assert.ok(
    left[1] > 150 && left[2] > 150,
    `At edited time 4, source time 2 must show the left button: ${left}`,
  );
  assert.equal(result.frames[0].seconds, 4);
  assert.equal(result.frames[0].sourceSeconds, 2);
  const end = pixel(result.frames[1].path, 350, 170);
  assert.ok(end[1] > 150, String(end));
  assert.ok(result.frames[1].seconds > 11.8 && result.frames[1].seconds < 12);
});

test("inspection selects an exact frame boundary without decimal rounding", async () => {
  const { service, video } = await setup();
  await service.execute("edit.configure", { id: video.id, speed: 0.5 });
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [1 / 15, 1 / 15 - 0.00001],
  });
  const result = await complete(service, job);
  assert.ok(Math.abs(result.frames[0].seconds - 1 / 15) < 1e-9);
  // The output has 30 frames per second at every speed. The frame before
  // 1/15 is at 1/30.
  assert.ok(Math.abs(result.frames[1].seconds - 1 / 30) < 1e-9);
});

test("multiple frames keep request order, report stale edits, and return image data", async () => {
  const { service, video } = await setup();
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [3, 0, 3, 5.999],
    grid: true,
  });
  const result = await complete(service, job);
  const inspected = await service.execute("inspect.result", { jobId: job.id });
  assert.equal(inspected.stale, false);
  assert.deepEqual(
    inspected.frames.map((f) => f.requestedSeconds),
    [3, 0, 3, 5.999],
  );
  assert.equal(inspected.frames[0].path, inspected.frames[2].path);
  assert.ok(Math.abs(inspected.frames[3].seconds - 179 / 30) < 1e-6);
  assert.deepEqual(inspected.grid, { columns: 10, rows: 10 });
  assert.deepEqual(
    Buffer.from(inspected.frames[0].data, "base64"),
    await readFile(result.frames[0].path),
  );
  const gridPixel = pixel(result.frames[0].path, 96, 200);
  assert.ok(
    gridPixel.every((v) => v > 100),
    String(gridPixel),
  );
  await service.execute("edit.trim", { id: video.id, start: 0, end: 2 });
  const stale = await service.execute("inspect.result", {
    jobId: job.id,
    includeImages: false,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.revision, result.revision);
  assert.equal(stale.frames[0].data, undefined);
  await assert.rejects(
    () =>
      service.execute("inspect.start", {
        id: video.id,
        timestamps: [1],
        revision: result.revision,
      }),
    /edits changed/,
  );
  await service.execute("library.delete", { id: video.id });
  await assert.rejects(() => access(result.frames[0].path), /ENOENT/);
  await assert.rejects(
    () => service.execute("inspect.result", { jobId: job.id }),
    /not found/,
  );
});

test("inspection rejects invalid times and excessive image sizes before it starts work", () => {
  const video = { timeline: createTimeline(6) };
  for (const timestamps of [
    undefined,
    [],
    Array(13).fill(1),
    [-1],
    [6],
    [Infinity],
    [NaN],
    [null],
    ["1"],
  ])
    assert.throws(
      () => inspectionPlan(video, { timestamps }),
      /timestamps|timestamp/,
    );
  for (const width of [0, 159, 1921, 960.5, Infinity, "960"])
    assert.throws(
      () => inspectionPlan(video, { timestamps: [0], width }),
      /Width/,
    );
  assert.throws(
    () => inspectionPlan(video, { timestamps: [0], grid: "true" }),
    /Grid/,
  );
});

test("inspection does not block recording controls and protects files during rendering", async () => {
  let finish;
  const video = { id: "video", timeline: createTimeline(6) };
  const service = new Service({
    library: { get: async () => video },
    inspection: {
      prepare: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const job = await service.execute("inspect.start", {
    id: "video",
    timestamps: [0],
  });
  assert.equal((await service.execute("app.status")).recording.state, "idle");
  await assert.rejects(
    () => service.execute("library.delete", { id: "video" }),
    /Wait/,
  );
  await assert.rejects(
    () => service.execute("inspect.result", { jobId: job.id }),
    /still running/,
  );
  finish({
    revision: inspectionPlan(video, { timestamps: [0] }).revision,
    frames: [],
  });
  await complete(service, job);
  const failed = new Service({
    library: { get: async () => video },
    inspection: {
      prepare: async () => {
        throw new Error("Decoder failed");
      },
    },
  });
  const broken = await failed.execute("inspect.start", {
    id: "video",
    timestamps: [0],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await failed.execute("export.status", { jobId: broken.id })).state,
    "failed",
  );
  await assert.rejects(
    () => failed.execute("inspect.result", { jobId: broken.id }),
    /Decoder failed/,
  );
});

test("portrait frames fit the height limit and a failed extraction removes its temporary folder", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "inspect-portrait-"));
  const source = path.join(root, "portrait.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=720x1280:r=30:d=0.2",
    "-c:v",
    "libx264",
    source,
  ]);
  const media = new Media();
  const previews = new PreviewCache(root, media);
  const video = {
    id: "portrait",
    path: source,
    metadata: await media.probe(source),
    timeline: createTimeline(0.2),
  };
  const plan = inspectionPlan(video, { timestamps: [0], width: 1920 });
  const inspector = new FrameInspection(media, previews);
  const result = await inspector.prepare(video, plan);
  assert.deepEqual(
    [result.frames[0].width, result.frames[0].height],
    [608, 1080],
  );
  const directory = previews.directory(video.id);
  const before = await readdir(directory);
  inspector.media = { ...media, ffmpeg: "missing-midnight-ffmpeg" };
  await assert.rejects(() => inspector.prepare(video, plan), /ENOENT/);
  assert.deepEqual(await readdir(directory), before);
});

test("large inline images fail with a paths-only recovery option", async () => {
  const { service, video } = await setup();
  const job = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [0],
  });
  const result = await complete(service, job);
  const file = await open(result.frames[0].path, "r+");
  try {
    await file.truncate(8 * 1024 * 1024 + 1);
  } finally {
    await file.close();
  }
  await assert.rejects(
    () => service.execute("inspect.result", { jobId: job.id }),
    /Images exceed 8 MiB/,
  );
  const paths = await service.execute("inspect.result", {
    jobId: job.id,
    includeImages: false,
  });
  assert.equal(paths.frames[0].path, result.frames[0].path);
  assert.equal(paths.frames[0].data, undefined);
});
