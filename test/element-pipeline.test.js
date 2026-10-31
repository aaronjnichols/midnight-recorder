import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import { Service } from "../src/application/service.js";
import { Media } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { FrameInspection } from "../src/adapters/inspection.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";
import { frameAt, region, isRed } from "../test-support/frames.js";
import { execFileSync } from "node:child_process";

async function setup(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/claude-editing", prefix));
  const source = await createInspectionSource(root);
  const media = new Media();
  const previews = new PreviewCache(root, media);
  const service = new Service({
    library: new Library(root),
    media,
    previews,
    inspection: new FrameInspection(media, previews),
  });
  const video = await service.execute("library.import", { path: source });
  return { root, service, video };
}

// Bounded wait for a background job. It does not assume a render time.
async function complete(service, job) {
  for (let i = 0; i < 600; i++) {
    const state = await service.execute("export.status", { jobId: job.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("The job did not finish.");
}

// A red label box at x 0.4 to 0.6 and y 0.4 to 0.6 for the full video.
const redBox = (id) => ({
  id,
  type: "text",
  text: "Box",
  start: 0,
  end: 6,
  x: 0.4,
  y: 0.4,
  width: 0.2,
  height: 0.2,
  background: "#FF0000",
  backgroundOpacity: 1,
  outline: "none",
});

function pngRegion(file, match) {
  const [width, height] = execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    file,
  ])
    .toString()
    .trim()
    .split(",")
    .map(Number);
  return { width, height, ...region(frameAt(file, 0, width, height), match) };
}

test("the preview cache key includes elements, so an old preview cannot hide them", async () => {
  const { service, video } = await setup("pipeline-preview-");
  const plain = (
    await complete(
      service,
      await service.execute("preview.start", { id: video.id }),
    )
  ).result;
  const before = (await stat(plain.path)).mtimeMs;
  assert.equal(region(frameAt(plain.path, 1, 960, 540), isRed).count, 0);
  const { video: edited } = await service.execute(
    "element.add",
    redBox(video.id),
  );
  const { revision } = await service.execute("element.list", { id: video.id });
  const withText = (
    await complete(
      service,
      await service.execute("preview.start", { id: video.id, revision }),
    )
  ).result;
  assert.notEqual(withText.path, plain.path);
  const box = region(frameAt(withText.path, 1, 960, 540), isRed);
  assert.ok(Math.abs(box.minX - 384) <= 2 && Math.abs(box.maxX - 575) <= 2);
  assert.ok(edited.timeline.elements.length === 1);
  await service.execute("edit.undo", { id: video.id });
  const again = (
    await complete(
      service,
      await service.execute("preview.start", { id: video.id }),
    )
  ).result;
  assert.equal(again.path, plain.path, "The first preview is used again.");
  assert.equal((await stat(again.path)).mtimeMs, before);
  await assert.rejects(
    service.execute("preview.start", { id: video.id, revision }),
    /edits changed/,
  );
});

test("inspection revisions include elements and frames use the element coordinates", async () => {
  const { service, video } = await setup("pipeline-inspect-");
  const first = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [1],
    width: 480,
  });
  await complete(service, first);
  const old = await service.execute("inspect.result", {
    jobId: first.id,
    includeImages: false,
  });
  assert.equal(pngRegion(old.frames[0].path, isRed).count, 0);
  await service.execute("element.add", redBox(video.id));
  const stale = await service.execute("inspect.result", {
    jobId: first.id,
    includeImages: false,
  });
  assert.equal(stale.stale, true);
  await assert.rejects(
    service.execute("inspect.start", {
      id: video.id,
      timestamps: [1],
      revision: old.revision,
    }),
    /edits changed/,
  );
  const list = await service.execute("element.list", { id: video.id });
  const next = await service.execute("inspect.start", {
    id: video.id,
    timestamps: [1],
    width: 480,
    revision: list.revision,
  });
  await complete(service, next);
  const result = await service.execute("inspect.result", {
    jobId: next.id,
    includeImages: false,
  });
  assert.equal(result.stale, false);
  assert.equal(result.revision, list.revision);
  // Map image pixels to 0 to 1 as inspect.result describes.
  const box = pngRegion(result.frames[0].path, isRed);
  const [element] = list.elements;
  for (const [actual, expected] of [
    [box.minX / box.width, element.x],
    [(box.maxX + 1) / box.width, element.x + element.width],
    [box.minY / box.height, element.y],
    [(box.maxY + 1) / box.height, element.y + element.height],
  ])
    assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ${expected}`);
});

test("an export uses the edits at its start and records that revision", async () => {
  const { root, service, video } = await setup("pipeline-export-");
  const { element } = await service.execute("element.add", redBox(video.id));
  const { revision } = await service.execute("element.list", { id: video.id });
  const output = path.join(root, "export.mp4");
  const job = await service.execute("export.start", {
    id: video.id,
    path: output,
    revision,
  });
  assert.equal(job.revision, revision);
  // This edit is after the export started. It must not change the export.
  await service.execute("element.remove", {
    id: video.id,
    elementId: element.id,
  });
  const done = await complete(service, job);
  assert.equal(done.revision, revision);
  const box = region(frameAt(output, 1, 960, 540), isRed);
  assert.ok(box.count > 5000, String(box.count));
  await assert.rejects(
    service.execute("export.start", {
      id: video.id,
      path: path.join(root, "stale.mp4"),
      revision,
    }),
    /edits changed/,
  );
});

test("text elements do not make a transcript stale", async () => {
  let record = {
    id: "v",
    metadata: { duration: 10, hasAudio: true },
    timeline: {
      segments: [{ start: 0, end: 10 }],
      speed: 1,
      muted: false,
      past: [],
      future: [],
    },
  };
  const service = new Service({
    library: {
      get: async () => record,
      update: async (id, patch) => (record = { ...record, ...patch }),
    },
    transcription: {
      prepare: async () => ({
        outcome: "ready",
        words: [{ word: "Hello", start: 1, end: 2 }],
        duration: 10,
        identity: { model: "test" },
      }),
    },
  });
  const job = await service.execute("transcript.start", { id: "v" });
  for (let i = 0; i < 100; i++) {
    if (
      (await service.execute("transcript.status", { jobId: job.id })).state ===
      "complete"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const before = await service.execute("transcript.read", { jobId: job.id });
  await service.execute("element.add", {
    id: "v",
    type: "text",
    text: "Caption",
    start: 1,
    end: 2,
  });
  const after = await service.execute("transcript.read", { jobId: job.id });
  assert.equal(after.stale, false);
  assert.equal(after.revision, before.revision);
  await service.execute("edit.cut", { id: "v", start: 0, end: 1 });
  assert.equal(
    (await service.execute("transcript.read", { jobId: job.id })).stale,
    true,
  );
});
