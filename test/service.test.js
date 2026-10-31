import { test } from "node:test";
import assert from "node:assert/strict";
import { Service, commands } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";
import { createTimeline } from "../src/domain/timeline.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

test("record commands enforce state and keep a failed stop available for retry", async () => {
  let fail = true;
  const service = new Service({
    capture: {
      sources: async () => [{ id: "screen:1", name: "Screen 1" }],
      devices: async () => [],
      start: async () => ({}),
      pause: async () => ({}),
      resume: async () => ({}),
      stop: async () => {
        if (fail) throw new Error("Disk full");
        return "recording.webm";
      },
      cancel: async () => ({}),
    },
    media: { probe: async () => ({ duration: 10 }) },
    library: { import: async () => ({ id: "saved" }) },
  });
  assert.equal(
    (await service.execute("recording.start", { sourceId: "screen:1" })).state,
    "recording",
  );
  await assert.rejects(
    () => service.execute("recording.start", { sourceId: "screen:1" }),
    /active/,
  );
  assert.equal((await service.execute("recording.pause")).state, "paused");
  assert.equal((await service.execute("recording.resume")).state, "recording");
  await assert.rejects(() => service.execute("recording.stop"), /Disk full/);
  assert.equal(
    (await service.execute("app.status")).recording.state,
    "recording",
  );
  fail = false;
  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.equal((await service.execute("app.status")).recording.state, "idle");
  await assert.rejects(
    () => service.execute("recording.pause"),
    /No recording/,
  );
  await assert.rejects(
    () => service.execute("recording.start", { unknown: true }),
    /Unknown/,
  );
  assert.ok(commands.every((command) => command.inputSchema.type === "object"));
});

test("a capture failure pauses the recording once and keeps Stop available", async () => {
  let pauses = 0,
    cancels = 0;
  const service = new Service({
    capture: {
      start: async () => {},
      pause: async () => pauses++,
      stop: async () => "pending.webm",
      cancel: async () => cancels++,
    },
    media: { probe: async () => ({ duration: 2 }) },
    library: { import: async () => ({ id: "saved" }) },
  });
  const started = await service.execute("recording.start", {
    cameraOnly: true,
  });
  await service.execute("recording.fail", {
    recordingId: started.id,
    error: "Disk full",
  });
  assert.equal(pauses, 1);
  const failed = (await service.execute("app.status")).recording;
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Disk full");
  await service.execute("recording.fail", {
    recordingId: started.id,
    error: "Later error",
  });
  assert.equal(pauses, 1);
  assert.equal(
    (await service.execute("app.status")).recording.error,
    "Disk full",
  );
  assert.equal(cancels, 0);
  await assert.rejects(() => service.execute("recording.resume"), /not paused/);
  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.equal(cancels, 1);
  await service.execute("recording.fail", {
    recordingId: started.id,
    error: "Late error",
  });
  assert.equal((await service.execute("app.status")).recording.state, "idle");
  const next = await service.execute("recording.start", { cameraOnly: true });
  await service.execute("recording.fail", {
    recordingId: started.id,
    error: "Stale error",
  });
  assert.equal((await service.execute("app.status")).recording.id, next.id);
  assert.equal(
    (await service.execute("app.status")).recording.state,
    "recording",
  );
});

for (const action of ["stop", "cancel"])
  test(`a failure received during ${action} cannot change a finished recording`, async () => {
    let finish, entered;
    const active = new Promise((resolve) => (entered = resolve));
    const wait = async () => {
      entered();
      await new Promise((resolve) => (finish = resolve));
    };
    const service = new Service({
      capture: {
        start: async () => {},
        stop: async () => {
          if (action === "stop") await wait();
          return "pending.webm";
        },
        cancel: async () => {
          if (action === "cancel") await wait();
        },
        pause: async () => assert.fail("A finished recording must not pause."),
      },
      media: { probe: async () => ({ duration: 2 }) },
      library: { import: async () => ({ id: "saved" }) },
    });
    const recording = await service.execute("recording.start", {
      cameraOnly: true,
    });
    const done = service.execute(`recording.${action}`);
    await active;
    const failed = service.execute("recording.fail", {
      recordingId: recording.id,
      error: "Late write error",
    });
    finish();
    await done;
    await failed;
    assert.deepEqual((await service.execute("app.status")).recording, {
      state: "idle",
    });
  });

test("shared commands import, edit, undo, export, rename, and delete a video", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "service-"));
  const source = path.join(root, "input.webm");
  await writeFile(source, "video");
  const service = new Service({
    library: new Library(path.join(root, "data")),
    media: {
      probe: async () => ({ duration: 10 }),
      export: async (video, output) => ({
        path: output,
        seconds:
          video.timeline.segments[0].end - video.timeline.segments[0].start,
      }),
    },
  });
  const video = await service.execute("library.import", {
    path: source,
    title: "First",
  });
  await service.execute("edit.trim", { id: video.id, start: 2, end: 8 });
  assert.equal(
    (await service.execute("library.get", { id: video.id })).timeline
      .segments[0].start,
    2,
  );
  await service.execute("edit.undo", { id: video.id });
  assert.equal(
    (await service.execute("library.get", { id: video.id })).timeline
      .segments[0].start,
    0,
  );
  await service.execute("edit.redo", { id: video.id });
  const job = await service.execute("export.start", {
    id: video.id,
    path: path.join(root, "out.mp4"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const done = await service.execute("export.status", { jobId: job.id });
  assert.equal(done.state, "complete");
  assert.equal(done.result.seconds, 6);
  await service.execute("library.rename", { id: video.id, title: "Renamed" });
  assert.equal(
    (await service.execute("library.list", { query: "named" })).length,
    1,
  );
  await service.execute("library.delete", { id: video.id });
  assert.deepEqual(await service.execute("library.list"), []);
});

test("save retry keeps the stopped file and does not import twice after cleanup fails", async () => {
  let stops = 0,
    imports = 0,
    failImport = true,
    failCleanup = true;
  const service = new Service({
    capture: {
      start: async () => {},
      stop: async () => {
        stops++;
        return "pending.webm";
      },
      cancel: async () => {
        if (failCleanup) throw new Error("Cleanup failed");
      },
    },
    media: { probe: async () => ({ duration: 2 }) },
    library: {
      import: async () => {
        imports++;
        if (failImport) throw new Error("Import failed");
        return { id: "saved" };
      },
    },
  });
  await service.execute("recording.start", { sourceId: "screen:1" });
  await assert.rejects(
    () => service.execute("recording.stop"),
    /Import failed/,
  );
  assert.equal(
    (await service.execute("app.status")).recording.state,
    "stopped",
  );
  failImport = false;
  await assert.rejects(
    () => service.execute("recording.stop"),
    /Cleanup failed/,
  );
  failCleanup = false;
  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.equal(stops, 1);
  assert.equal(imports, 2);
});

test("a stopped recording reports save progress, an import error, and cleanup after save", async () => {
  const pushed = [];
  let failImport = true,
    failCleanup = true;
  const service = new Service({
    recordingFeedback: {
      prepare: async () => {},
      update: (recording) => pushed.push(structuredClone(recording)),
    },
    capture: {
      start: async () => {},
      pause: async () => {},
      stop: async () => "pending.webm",
      cancel: async () => {
        if (failCleanup) throw new Error("Cleanup failed");
      },
    },
    media: { probe: async () => ({ duration: 2 }) },
    library: {
      import: async () => {
        if (failImport) throw new Error("Import failed");
        return { id: "saved", title: "Demo" };
      },
    },
  });
  const status = async () => (await service.execute("app.status")).recording;
  const started = await service.execute("recording.start", {
    cameraOnly: true,
  });
  // A capture error must not show as a save error while the save runs.
  await service.execute("recording.fail", {
    recordingId: started.id,
    error: "Disk full",
  });
  pushed.length = 0;
  await assert.rejects(service.execute("recording.stop"), /Import failed/);
  const stopped = pushed.filter((recording) => recording.state === "stopped");
  assert.equal(stopped[0].error, undefined, "Saving has no error.");
  assert.equal(stopped.at(-1).error, "Import failed");
  let current = await status();
  assert.equal(current.state, "stopped");
  assert.equal(current.error, "Import failed");
  assert.equal(current.saved, undefined);

  pushed.length = 0;
  failImport = false;
  await assert.rejects(service.execute("recording.stop"), /Cleanup failed/);
  assert.equal(pushed[0].state, "stopped");
  assert.equal(pushed[0].error, undefined, "A retry clears the old error.");
  current = await status();
  assert.equal(current.state, "stopped");
  assert.deepEqual(current.saved, { id: "saved", title: "Demo" });
  assert.equal(current.error, "Cleanup failed");

  failCleanup = false;
  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.deepEqual(await status(), { state: "idle" });
});

test("agents can open videos, control playback, and select the app view", async () => {
  const requests = [];
  const service = new Service({
    library: { get: async (id) => ({ id, path: "source.mp4" }) },
    playback: {
      request: async (action, args) => {
        requests.push({ action, args });
        return { action, ...args };
      },
    },
  });
  await service.execute("playback.open", { id: "video" });
  assert.equal(requests[0].args.video.id, "video");
  await service.execute("playback.play");
  await service.execute("playback.seek", { seconds: 1.5 });
  await service.execute("playback.pause");
  await service.execute("app.view", { view: "library" });
  assert.deepEqual(
    requests.map((r) => r.action),
    ["open", "play", "seek", "pause", "view"],
  );
  await service.execute("playback.configure", { volume: 0.25 });
  await service.execute("playback.fullscreen", { enabled: true });
  await assert.rejects(
    () => service.execute("playback.configure", { volume: 2 }),
    /Volume/,
  );
  await assert.rejects(
    () => service.execute("playback.seek", { seconds: -1 }),
    /positive|negative|range/,
  );
});

test("preview rendering runs as a background job and keeps recording controls available", async () => {
  let finish;
  const service = new Service({
    // Library records always have a timeline. Jobs record its revision.
    library: { get: async (id) => ({ id, timeline: createTimeline(2) }) },
    previews: {
      prepare: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const job = await service.execute("preview.start", { id: "video" });
  assert.equal(job.state, "running");
  assert.equal((await service.execute("app.status")).recording.state, "idle");
  finish({ url: "file:///preview.mp4" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await service.execute("export.status", { jobId: job.id })).result.url,
    "file:///preview.mp4",
  );
});

test("a stale preview request cannot render a different edit state", async () => {
  const service = new Service({
    library: {
      get: async (id) => ({
        id,
        timeline: { segments: [{ start: 0, end: 2 }], speed: 1, muted: false },
      }),
    },
  });
  await assert.rejects(
    () =>
      service.execute("preview.start", { id: "video", revision: "old-state" }),
    /edits changed/,
  );
});

test("deleting a video removes cached previews and their job results", async () => {
  let removed = false;
  const service = new Service({
    library: {
      get: async (id) => ({ id, timeline: createTimeline(2) }),
      remove: async (id) => ({ deleted: id }),
    },
    previews: {
      prepare: async () => ({ url: "file:///cached.mp4" }),
      remove: async () => {
        removed = true;
      },
    },
  });
  const job = await service.execute("preview.start", { id: "video" });
  await new Promise((resolve) => setImmediate(resolve));
  await service.execute("library.delete", { id: "video" });
  assert.equal(removed, true);
  await assert.rejects(
    () => service.execute("export.status", { jobId: job.id }),
    /not found/,
  );
});
