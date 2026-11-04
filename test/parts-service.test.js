// Split and part commands through the shared service, with the real library
// file. A rejected command saves nothing and adds no history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Service, commands } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";
import { MAX_HISTORY, MAX_SPLITS, MIN_PART } from "../src/domain/timeline.js";

async function setup(seconds = 10) {
  await mkdir(".local/loom-next/media", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/loom-next/media", "parts-"));
  const library = new Library(root);
  const saves = { count: 0 };
  const update = library.update.bind(library);
  library.update = (...args) => {
    saves.count++;
    return update(...args);
  };
  const file = path.join(root, "source.mp4");
  await writeFile(file, "not read");
  const service = new Service({
    library,
    media: {
      probe: async () => ({
        duration: seconds,
        width: 640,
        height: 360,
        hasAudio: true,
      }),
    },
  });
  const video = await service.execute("library.import", { path: file });
  return { root, library, saves, service, video, id: video.id };
}
const revisionOf = async (service, id) =>
  (await service.execute("parts.list", { id })).revision;

test("the catalog has the part commands with their required arguments", () => {
  const required = (name) =>
    commands.find((c) => c.name === name)?.inputSchema.required;
  assert.deepEqual(required("edit.split"), ["id", "seconds"]);
  assert.deepEqual(required("edit.unsplit"), ["id", "splitId", "revision"]);
  assert.deepEqual(required("parts.list"), ["id"]);
  assert.deepEqual(required("edit.keepPart"), ["id", "partId", "revision"]);
  assert.deepEqual(required("edit.removePart"), ["id", "partId", "revision"]);
});

test("edit.split saves one mark, and the file keeps it", async () => {
  const { service, library, saves, id } = await setup();
  const result = await service.execute("edit.split", { id, seconds: 4.25 });
  assert.equal(saves.count, 1);
  assert.equal(result.timeline.past.length, 1);
  assert.deepEqual(result.timeline.segments, [{ start: 0, end: 10 }]);
  assert.deepEqual(result.split, {
    id: "s4250000",
    source: 4.25,
    start: 4.25,
  });
  assert.equal(result.parts.length, 2);
  assert.ok(result.elementPlacement);
  assert.ok(result.videoFades);
  const stored = await library.get(id);
  assert.deepEqual(stored.timeline.splits, [{ id: "s4250000", source: 4.25 }]);
});

test("an invalid split saves nothing", async () => {
  const { service, saves, id } = await setup();
  await service.execute("edit.split", { id, seconds: 5 });
  const before = saves.count;
  for (const seconds of [0, 10, 5, 5 + MIN_PART / 2, 99])
    await assert.rejects(service.execute("edit.split", { id, seconds }));
  assert.equal(saves.count, before);
  assert.equal((await service.library.get(id)).timeline.past.length, 1);
});

test("edit.split with an old revision saves nothing", async () => {
  const { service, saves, id } = await setup();
  const revision = await revisionOf(service, id);
  await service.execute("edit.cut", { id, start: 1, end: 2 });
  const before = saves.count;
  await assert.rejects(
    service.execute("edit.split", { id, seconds: 4, revision }),
    /changed/,
  );
  assert.equal(saves.count, before);
  const latest = await revisionOf(service, id);
  await service.execute("edit.split", { id, seconds: 4, revision: latest });
  assert.equal(saves.count, before + 1);
});

test("parts.list gives parts, marks, the revision, and the limits", async () => {
  const { service, id } = await setup();
  await service.execute("edit.configure", { id, speed: 2 });
  await service.execute("edit.split", { id, seconds: 1 });
  await service.execute("edit.cut", { id, start: 3, end: 4 });
  const list = await service.execute("parts.list", { id });
  assert.deepEqual(
    list.parts.map(({ start, end, seamBefore }) => [start, end, seamBefore]),
    [
      [0, 1, null],
      [1, 3, "split"],
      [3, 4, "cut"],
    ],
  );
  assert.deepEqual(list.parts[1].id, "p2000000-6000000");
  assert.deepEqual(list.splits, [{ id: "s2000000", source: 2, start: 1 }]);
  assert.equal(list.duration, 4);
  assert.deepEqual(list.limits, {
    splits: MAX_SPLITS,
    shortestPart: MIN_PART,
  });
  assert.equal(typeof list.revision, "string");
});

test("edit.removePart is guarded and one undo step", async () => {
  const { service, saves, id } = await setup();
  await service.execute("edit.split", { id, seconds: 3 });
  await service.execute("edit.split", { id, seconds: 7 });
  const { parts, revision } = await service.execute("parts.list", { id });
  const before = saves.count;

  for (const args of [
    { partId: parts[1].id },
    { partId: parts[1].id, revision: "old" },
    { partId: "p1-2", revision },
  ])
    await assert.rejects(
      service.execute("edit.removePart", { id, ...args }),
      /revision|changed|not in the edited video/,
    );
  assert.equal(saves.count, before, "A rejected command saves nothing.");

  const result = await service.execute("edit.removePart", {
    id,
    partId: parts[1].id,
    revision,
  });
  assert.equal(saves.count, before + 1);
  assert.deepEqual(result.timeline.segments, [
    { start: 0, end: 3 },
    { start: 7, end: 10 },
  ]);
  assert.equal(result.timeline.past.length, 3);
  assert.ok(result.elementPlacement);
  const undone = await service.execute("edit.undo", { id });
  assert.deepEqual(undone.timeline.segments, [{ start: 0, end: 10 }]);
  assert.equal(undone.timeline.splits.length, 2);
});

test("edit.keepPart keeps exactly one part and rejects an old view", async () => {
  const { service, saves, id } = await setup();
  await service.execute("edit.configure", { id, speed: 1.5 });
  await service.execute("edit.split", { id, seconds: 2 });
  const { parts, revision } = await service.execute("parts.list", { id });
  // Speed changes the view of the parts, so the old revision is not valid.
  await service.execute("edit.configure", { id, speed: 1 });
  const before = saves.count;
  await assert.rejects(
    service.execute("edit.keepPart", { id, partId: parts[1].id, revision }),
    /changed/,
  );
  assert.equal(saves.count, before);
  const latest = await revisionOf(service, id);
  const result = await service.execute("edit.keepPart", {
    id,
    partId: parts[1].id,
    revision: latest,
  });
  assert.deepEqual(result.timeline.segments, [{ start: 3, end: 10 }]);
});

test("edit.unsplit removes a mark, keeps the time, and is guarded", async () => {
  const { service, saves, id } = await setup();
  await service.execute("edit.split", { id, seconds: 3 });
  const { splits, revision } = await service.execute("parts.list", { id });
  await assert.rejects(
    service.execute("edit.unsplit", {
      id,
      splitId: splits[0].id,
      revision: "old",
    }),
    /changed/,
  );
  await assert.rejects(
    service.execute("edit.unsplit", { id, splitId: "s1", revision }),
    /not found/,
  );
  const before = saves.count;
  const result = await service.execute("edit.unsplit", {
    id,
    splitId: splits[0].id,
    revision,
  });
  assert.equal(saves.count, before + 1);
  assert.equal(result.timeline.past.length, 2);
  assert.equal(result.parts.length, 1);
  assert.equal("splits" in result.timeline, false);
});

test("library.revision shows a split, also when the history is full", async () => {
  const { service, library, id } = await setup();
  // A full history: the undo count cannot show the next change.
  const stored = await library.get(id);
  await library.update(id, {
    timeline: {
      ...stored.timeline,
      past: Array.from({ length: MAX_HISTORY }, () => ({
        segments: stored.timeline.segments,
        speed: 1,
        muted: false,
      })),
    },
  });
  const before = await service.execute("library.revision", { id });
  assert.equal(before.history.undo, MAX_HISTORY);
  await service.execute("edit.split", { id, seconds: 4 });
  const after = await service.execute("library.revision", { id });
  assert.equal(after.history.undo, MAX_HISTORY);
  assert.equal(after.revision, before.revision, "The render does not change.");
  assert.notEqual(after.structureRevision, before.structureRevision);
});

test("a library file from before splits loads and accepts a split", async () => {
  const { root, service, id } = await setup();
  const file = path.join(root, "library.json");
  const records = JSON.parse(await readFile(file, "utf8"));
  assert.equal("splits" in records[0].timeline, false);
  assert.equal((await service.execute("parts.list", { id })).parts.length, 1);
  assert.equal(
    (await service.execute("edit.split", { id, seconds: 2 })).parts.length,
    2,
  );
});
