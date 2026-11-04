import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Service, commands } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";
import { editRevision } from "../src/domain/inspection.js";
import { TEXT_CONFLICT } from "../src/domain/elements.js";

async function setup({ frame } = {}) {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/claude-editing", "draft-"));
  const source = path.join(root, "input.mp4");
  await writeFile(source, "video");
  const requests = [];
  const service = new Service({
    library: new Library(path.join(root, "data")),
    media: { probe: async () => ({ duration: 10, width: 640, height: 360 }) },
    previews: {
      remove: async () => {},
      frame:
        frame ??
        (async (video, request) => {
          requests.push({ video, request });
          return { seconds: request.seconds, under: { url: "file:///u.png" } };
        }),
    },
  });
  const video = await service.execute("library.import", { path: source });
  const added = await service.execute("element.add", {
    id: video.id,
    type: "text",
    text: "Before",
    start: 1,
    end: 5,
  });
  return { service, video: added.video, element: added.element, requests };
}

const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timeout.");
};
const finished = (service, jobId) =>
  until(async () => {
    const job = await service.execute("export.status", { jobId });
    return job.state === "running" ? null : job;
  });

test("preview.frame is a shared read command that runs as a job", async () => {
  const command = commands.find((c) => c.name === "preview.frame");
  assert.ok(command, "The shared command list has preview.frame.");
  assert.deepEqual(command.inputSchema.required, [
    "id",
    "seconds",
    "elementId",
  ]);
  const { service, video, element, requests } = await setup();
  const before = (await service.execute("library.get", { id: video.id }))
    .timeline;
  const job = await service.execute("preview.frame", {
    id: video.id,
    seconds: 2,
    elementId: element.id,
  });
  assert.equal(job.kind, "frame");
  assert.equal(job.state, "running");
  const done = await finished(service, job.id);
  assert.equal(done.state, "complete");
  assert.equal(done.result.under.url, "file:///u.png");
  assert.deepEqual(requests[0].request, {
    seconds: 2,
    elementId: element.id,
  });
  // A read command saves nothing.
  const after = await service.execute("library.get", { id: video.id });
  assert.deepEqual(after.timeline, before);
});

test("the frame job has a copy of the edit state from the command", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let seen;
  const { service, video, element } = await setup({
    frame: async (copy) => {
      await gate;
      seen = copy;
      return {};
    },
  });
  const job = await service.execute("preview.frame", {
    id: video.id,
    seconds: 2,
    elementId: element.id,
  });
  await service.execute("element.update", {
    id: video.id,
    elementId: element.id,
    text: "Later",
  });
  release();
  await finished(service, job.id);
  assert.equal(seen.timeline.elements[0].text, "Before");
});

test("a frame job does not hold the command queue", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { service, video, element } = await setup({
    frame: () => gate,
  });
  await service.execute("preview.frame", {
    id: video.id,
    seconds: 2,
    elementId: element.id,
  });
  // A save does not wait for FFmpeg.
  const saved = await service.execute("element.update", {
    id: video.id,
    elementId: element.id,
    text: "Saved during the frame",
  });
  assert.equal(saved.element.text, "Saved during the frame");
  release({});
});

test("preview.frame rejects a stale revision, a missing element, and a bad time", async () => {
  const { service, video, element } = await setup();
  const args = { id: video.id, seconds: 2, elementId: element.id };
  await assert.rejects(
    () => service.execute("preview.frame", { ...args, revision: "stale" }),
    /edits changed/,
  );
  const job = await service.execute("preview.frame", {
    ...args,
    revision: editRevision(video),
  });
  assert.equal(job.kind, "frame");
  await assert.rejects(
    () => service.execute("preview.frame", { ...args, elementId: "gone" }),
    /Element was not found/,
  );
  for (const seconds of [-1, 11])
    await assert.rejects(
      () => service.execute("preview.frame", { ...args, seconds }),
      /outside the edited range/,
    );
});

test("a failed frame reports the error in the job", async () => {
  const { service, video, element } = await setup({
    frame: async () => {
      throw new Error("FFmpeg failed.");
    },
  });
  const job = await service.execute("preview.frame", {
    id: video.id,
    seconds: 2,
    elementId: element.id,
  });
  const done = await finished(service, job.id);
  assert.equal(done.state, "failed");
  assert.equal(done.error, "FFmpeg failed.");
});

test("finished frame jobs do not fill app.status", async () => {
  const { service, video, element } = await setup();
  for (let i = 0; i < 40; i++) {
    const job = await service.execute("preview.frame", {
      id: video.id,
      seconds: 2,
      elementId: element.id,
    });
    await finished(service, job.id);
  }
  const { jobs } = await service.execute("app.status");
  assert.ok(jobs.length <= 16, `Jobs: ${jobs.length}`);
});

// Review B2: a delete removes the jobs of a video, so a late end must not
// bring one back.
for (const [name, end] of [
  ["a failure", (release, fail) => fail(new Error("The video was deleted."))],
  ["a result", (release) => release({ under: { url: "file:///late.png" } })],
])
  test(`${name} after a delete does not bring the frame job back`, async () => {
    let release, fail;
    const { service, video, element } = await setup({
      frame: () =>
        new Promise((resolve, reject) => {
          release = resolve;
          fail = reject;
        }),
    });
    const job = await service.execute("preview.frame", {
      id: video.id,
      seconds: 2,
      elementId: element.id,
    });
    await until(() => release);
    await service.execute("library.delete", { id: video.id });
    end(release, fail);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { jobs } = await service.execute("app.status");
    assert.equal(
      jobs.some((entry) => entry.videoId === video.id),
      false,
      "No job of the deleted video.",
    );
    await assert.rejects(
      () => service.execute("export.status", { jobId: job.id }),
      /was not found/,
    );
  });

test("element.update with expectedText saves only over the same text", async () => {
  const update = commands.find((c) => c.name === "element.update");
  assert.ok(update.inputSchema.properties.expectedText);
  assert.deepEqual(update.inputSchema.required, ["id", "elementId"]);
  const { service, video, element } = await setup();
  const args = { id: video.id, elementId: element.id };
  const first = await service.execute("element.update", {
    ...args,
    text: "After",
    expectedText: "Before",
  });
  assert.equal(first.element.text, "After");
  assert.equal(first.video.timeline.past.length, 2);
  await assert.rejects(
    () =>
      service.execute("element.update", {
        ...args,
        text: "Lost",
        expectedText: "Before",
      }),
    (error) => error.message.includes(TEXT_CONFLICT),
  );
  const saved = await service.execute("library.get", { id: video.id });
  assert.equal(saved.timeline.elements[0].text, "After");
  assert.equal(saved.timeline.past.length, 2, "A conflict adds no history.");
});

test("expectedText is a guard only and is not stored", async () => {
  const { service, video, element } = await setup();
  const { element: updated } = await service.execute("element.update", {
    id: video.id,
    elementId: element.id,
    text: "After",
    expectedText: "Before",
  });
  assert.equal("expectedText" in updated, false);
  // Without the guard, element.update works as before.
  const { element: plain } = await service.execute("element.update", {
    id: video.id,
    elementId: element.id,
    text: "Plain",
  });
  assert.equal(plain.text, "Plain");
});

test("expectedText applies to text elements only", async () => {
  const { service, video } = await setup();
  const { element } = await service.execute("element.add", {
    id: video.id,
    type: "rectangle",
    start: 1,
    end: 2,
  });
  await assert.rejects(
    () =>
      service.execute("element.update", {
        id: video.id,
        elementId: element.id,
        x: 0.2,
        expectedText: "Anything",
      }),
    /does not use expectedText/,
  );
});
