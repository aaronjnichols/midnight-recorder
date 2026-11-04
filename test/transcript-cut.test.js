// Word cuts through the shared service. The server holds the words, so a cut
// needs only word IDs. All checks run in the command queue, before one save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Service, commands } from "../src/application/service.js";
import { timingRevision } from "../src/domain/inspection.js";

const token = (word, start, end) => ({
  word,
  start,
  end,
  probability: 0.9,
  segmentId: 0,
});
// Hello(0-1) big(2-3) wide(3-4) world(6-7) again(8-9), with pauses between.
const SPEECH = [
  token(" Hello", 0, 1),
  token(" big", 2, 3),
  token(" wide", 3, 4),
  token(" world", 6, 7),
  token(" again", 8, 9),
];
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));

function setup({ words = SPEECH, seconds = 10, videos = ["v"] } = {}) {
  const records = new Map(
    videos.map((id) => [
      id,
      {
        id,
        path: `C:/media/${id}.mp4`,
        metadata: {
          duration: seconds,
          hasAudio: true,
          width: 640,
          height: 360,
        },
        timeline: {
          segments: [{ start: 0, end: seconds }],
          speed: 1,
          muted: false,
          past: [],
          future: [],
        },
      },
    ]),
  );
  const file = new Map(videos.map((id) => [id, { size: 100, mtimeMs: 1 }]));
  const counts = { saves: 0, prepared: 0 };
  const service = new Service({
    library: {
      get: async (id) => {
        if (!records.has(id)) throw new Error("Video was not found.");
        return structuredClone(records.get(id));
      },
      update: async (id, patch) => {
        counts.saves++;
        records.set(id, { ...records.get(id), ...patch });
        return structuredClone(records.get(id));
      },
    },
    transcription: {
      capabilities: async () => ({ available: true }),
      fingerprint: async (video) => file.get(video.id),
      remove: async () => {},
      prepare: async () => {
        counts.prepared++;
        return {
          outcome: words.length ? "ready" : "no_speech",
          words,
          duration: seconds,
          audioSha256: "hash",
          identity: { model: "test" },
        };
      },
    },
  });
  return { service, records, counts, file };
}
async function transcribe(service, id = "v") {
  const job = await service.execute("transcript.start", { id });
  for (let i = 0; i < 200; i++) {
    const status = await service.execute("transcript.status", {
      jobId: job.id,
    });
    if (status.state === "complete") return status;
    await pause();
  }
  throw new Error("The job did not end.");
}
const page = (service, jobId, args = {}) =>
  service.execute("transcript.words", { jobId, ...args });

test("the catalog has the word commands, with the job, the video, and the revision", () => {
  const schema = (name) => commands.find((c) => c.name === name)?.inputSchema;
  assert.deepEqual(schema("transcript.words").required, ["jobId"]);
  assert.deepEqual(schema("transcript.selection").required, [
    "jobId",
    "from",
    "to",
  ]);
  assert.deepEqual(schema("transcript.cut").required, [
    "id",
    "jobId",
    "from",
    "to",
    "revision",
  ]);
  // A client gives IDs. It cannot give text or times.
  assert.deepEqual(Object.keys(schema("transcript.cut").properties).sort(), [
    "from",
    "id",
    "jobId",
    "revision",
    "to",
  ]);
});

test("the word view is live: cut, speed, and undo need no new recognition", async () => {
  const { service, counts } = setup();
  const job = await transcribe(service);
  const before = await page(service, job.id);
  assert.equal(before.total, 5);
  assert.equal(before.words[1].text, "big");
  assert.equal(before.revision, job.revision);
  assert.equal(before.sourceCurrent, true);
  assert.equal(before.timing, "estimated");
  assert.equal(before.outcome, "ready");
  assert.equal(before.audioAudible, true);

  await service.execute("edit.cut", { id: "v", start: 1.5, end: 4.5 });
  await service.execute("edit.configure", { id: "v", speed: 2 });
  const after = await page(service, job.id);
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(
    after.words.map((w) => w.state),
    ["kept", "removed", "removed", "kept", "kept"],
  );
  assert.equal(after.words[3].start, 1.5, "(6 - 3 seconds cut) / speed 2");
  await service.execute("edit.undo", { id: "v" });
  await service.execute("edit.undo", { id: "v" });
  assert.deepEqual(await page(service, job.id), before);
  assert.equal(counts.prepared, 1);
});

test("transcript.read and search keep the frozen view and report stale", async () => {
  const { service } = setup();
  const job = await transcribe(service);
  await service.execute("edit.cut", { id: "v", start: 1.5, end: 4.5 });
  const read = await service.execute("transcript.read", {
    jobId: job.id,
    detail: "words",
  });
  assert.equal(read.stale, true);
  assert.equal(read.revision, job.revision);
  assert.equal(read.words.length, 5, "The frozen timeline has all words.");
  const found = await service.execute("transcript.search", {
    jobId: job.id,
    query: "wide",
  });
  assert.equal(found.stale, true);
  assert.equal(found.matches.length, 1);
});

test("a selection reads the range and changes nothing", async () => {
  const { service, counts, records } = setup();
  const job = await transcribe(service);
  const selection = await service.execute("transcript.selection", {
    jobId: job.id,
    from: "w3",
    to: "w1",
  });
  assert.equal(selection.from, "w1");
  assert.equal(selection.to, "w3");
  assert.equal(selection.sourceStart, 2);
  assert.equal(selection.sourceEnd, 7);
  assert.equal(selection.text, "big wide world");
  assert.equal(selection.canCut, true);
  assert.equal(selection.revision, job.revision);
  assert.equal(selection.timing, "estimated");
  assert.equal(counts.saves, 0);
  assert.equal(records.get("v").timeline.past.length, 0);
});

test("a word cut is one save and one undo step, with the pauses between", async () => {
  const { service, counts } = setup();
  const job = await transcribe(service);
  const { revision } = await page(service, job.id);
  const result = await service.execute("transcript.cut", {
    id: "v",
    jobId: job.id,
    from: "w1",
    to: "w3",
    revision,
  });
  assert.equal(counts.saves, 1);
  assert.deepEqual(result.timeline.segments, [
    { start: 0, end: 2 },
    { start: 7, end: 10 },
  ]);
  assert.equal(result.timeline.past.length, 1);
  assert.equal(result.wordCut.keptWords, 3);
  assert.equal(result.wordCut.text, "big wide world");
  assert.equal(result.wordCut.start, 2);
  assert.equal(result.wordCut.end, 7);
  assert.equal(result.wordCut.length, 5);
  assert.ok(result.elementPlacement);
  assert.ok(result.videoFades);

  // The words show as removed, and undo returns them.
  assert.deepEqual(
    (await page(service, job.id)).words.map((w) => w.state),
    ["kept", "removed", "removed", "removed", "kept"],
  );
  const undone = await service.execute("edit.undo", { id: "v" });
  assert.deepEqual(undone.timeline.segments, [{ start: 0, end: 10 }]);
  const redone = await service.execute("edit.redo", { id: "v" });
  assert.deepEqual(redone.timeline.segments, result.timeline.segments);
});

test("a cut across an old cut excludes removed speech and clips partial words", async () => {
  const { service } = setup();
  const job = await transcribe(service);
  // Removes the end of big and all of wide: source 2.5 to 4.5.
  await service.execute("edit.cut", { id: "v", start: 2.5, end: 4.5 });
  const { revision, words } = await page(service, job.id);
  assert.equal(words[1].state, "partial");
  assert.equal(words[2].state, "removed");
  const result = await service.execute("transcript.cut", {
    id: "v",
    jobId: job.id,
    from: "w1",
    to: "w3",
    revision,
  });
  assert.deepEqual(result.timeline.segments, [
    { start: 0, end: 2 },
    { start: 7, end: 10 },
  ]);
  // The edited length: 2 to 2.5 and 4.5 to 7, not the old cut.
  assert.equal(result.wordCut.length, 3);
  assert.equal(result.wordCut.removedWords, 1);
});

test("a cut changes no elements or captions, and reports the affected captions", async () => {
  const { service, records } = setup();
  const job = await transcribe(service);
  await service.execute("element.add", {
    id: "v",
    type: "text",
    text: "Label",
    start: 2,
    end: 3,
  });
  await service.execute("captions.add", {
    id: "v",
    text: "Big and wide",
    start: 2,
    end: 4,
  });
  await service.execute("captions.add", {
    id: "v",
    text: "World",
    start: 6,
    end: 7,
  });
  const before = structuredClone(records.get("v").timeline);
  const { revision } = await page(service, job.id);
  const result = await service.execute("transcript.cut", {
    id: "v",
    jobId: job.id,
    from: "w1",
    to: "w1",
    revision,
  });
  assert.deepEqual(result.timeline.elements, before.elements);
  assert.deepEqual(result.timeline.captions, before.captions);
  assert.equal(result.captionPlacement.partial, 1, "Big and wide is Part cut.");
  assert.equal(result.captionPlacement.removed, 0);
  assert.equal(result.elementPlacement.at(-1).visibility, "none");
});

test("a word across a split mark stays one word, and a cut keeps other marks", async () => {
  const { service } = setup();
  const job = await transcribe(service);
  await service.execute("edit.split", { id: "v", seconds: 2.5 });
  await service.execute("edit.split", { id: "v", seconds: 8.5 });
  const { revision, words } = await page(service, job.id);
  assert.equal(words.length, 5);
  assert.equal(words[1].state, "kept", "A mark is not a cut.");
  const result = await service.execute("transcript.cut", {
    id: "v",
    jobId: job.id,
    from: "w1",
    to: "w1",
    revision,
  });
  assert.deepEqual(
    result.timeline.splits.map((s) => s.source),
    [8.5],
    "The mark in the cut ended. The other mark stays.",
  );
});

test("an old revision, another video, and unknown words save nothing", async () => {
  const { service, counts } = setup({ videos: ["v", "other"] });
  const job = await transcribe(service);
  const { revision } = await page(service, job.id);
  const cutWords = (args) =>
    service.execute("transcript.cut", {
      id: "v",
      jobId: job.id,
      from: "w1",
      to: "w2",
      revision,
      ...args,
    });
  await assert.rejects(cutWords({ id: "other" }), /other video|another video/);
  await assert.rejects(cutWords({ from: "w99" }), /was not found/);
  await assert.rejects(cutWords({ revision: "old" }), /edits changed/);
  await assert.rejects(cutWords({ jobId: "none" }), /not found/);
  await assert.rejects(cutWords({ text: "big" }), /Unknown argument/);
  await assert.rejects(cutWords({ start: 2 }), /Unknown argument/);
  assert.equal(counts.saves, 0);

  // A changed timing map: the same IDs with the old revision.
  await service.execute("edit.configure", { id: "v", speed: 1.5 });
  const saves = counts.saves;
  await assert.rejects(cutWords({}), /edits changed/);
  assert.equal(counts.saves, saves);
});

test("a video that is not the job source is never edited", async () => {
  const { service, records } = setup({ videos: ["a", "b"] });
  const first = await transcribe(service, "a");
  const { revision } = await page(service, first.id);
  await assert.rejects(
    service.execute("transcript.cut", {
      id: "b",
      jobId: first.id,
      from: "w1",
      to: "w1",
      revision,
    }),
    /another video/,
  );
  assert.equal(records.get("b").timeline.past.length, 0);
  assert.equal(records.get("a").timeline.past.length, 0);
});

test("a changed source file stops a cut, also with the same job hash", async () => {
  const { service, counts, file, records } = setup();
  const job = await transcribe(service);
  const { revision } = await page(service, job.id);
  const args = { id: "v", jobId: job.id, from: "w1", to: "w1", revision };

  file.set("v", { size: 100, mtimeMs: 2 });
  const view = await page(service, job.id);
  assert.equal(view.sourceCurrent, false, "The view tells it.");
  await assert.rejects(
    service.execute("transcript.cut", args),
    /source file changed/,
  );
  file.set("v", { size: 200, mtimeMs: 1 });
  await assert.rejects(
    service.execute("transcript.cut", args),
    /source file changed/,
  );
  // The same file again.
  file.set("v", { size: 100, mtimeMs: 1 });
  const record = records.get("v");
  records.set("v", {
    ...record,
    metadata: { ...record.metadata, duration: 9 },
  });
  await assert.rejects(
    service.execute("transcript.cut", args),
    /source file changed/,
  );
  records.set("v", record);
  assert.equal(counts.saves, 0);
  await service.execute("transcript.cut", args);
  assert.equal(counts.saves, 1);
});

test("a source that cannot be verified stops a cut", async () => {
  const { service, counts } = setup();
  // The check fails at the start and now, so the two values cannot agree.
  service.transcription.fingerprint = async () => {
    throw new Error("locked");
  };
  const job = await transcribe(service);
  const view = await page(service, job.id);
  assert.equal(view.sourceCurrent, false);
  const selection = await service.execute("transcript.selection", {
    jobId: job.id,
    from: "w1",
    to: "w1",
  });
  assert.equal(selection.sourceCurrent, false);
  await assert.rejects(
    service.execute("transcript.cut", {
      id: "v",
      jobId: job.id,
      from: "w1",
      to: "w1",
      revision: view.revision,
    }),
    /source file changed|cannot be checked/,
  );
  assert.equal(counts.saves, 0);
});

test("a source check with no usable result also stops a cut", async () => {
  const bad = [
    ["no method", undefined],
    ["no result", async () => null],
    ["nothing", async () => undefined],
    ["text", async () => "file"],
    ["no size", async () => ({ mtimeMs: 1 })],
    ["no time", async () => ({ size: 1 })],
    ["text size", async () => ({ size: "1", mtimeMs: 1 })],
    ["not a number", async () => ({ size: NaN, mtimeMs: 1 })],
    ["infinite", async () => ({ size: 1, mtimeMs: Infinity })],
  ];
  for (const [name, fingerprint] of bad) {
    const { service, counts } = setup();
    if (fingerprint) service.transcription.fingerprint = fingerprint;
    else delete service.transcription.fingerprint;
    const job = await transcribe(service);
    const view = await page(service, job.id);
    assert.equal(view.sourceCurrent, false, name);
    await assert.rejects(
      service.execute("transcript.cut", {
        id: "v",
        jobId: job.id,
        from: "w1",
        to: "w1",
        revision: view.revision,
      }),
      /cannot be checked/,
      name,
    );
    assert.equal(counts.saves, 0, name);
    // The read views stay available. They change nothing.
    assert.equal(view.words.length, 5, name);
    assert.equal(
      (await service.execute("transcript.read", { jobId: job.id })).stale,
      false,
      name,
    );
  }
});

test("a file that disappears after the job also stops a cut", async () => {
  const { service, counts } = setup();
  const job = await transcribe(service);
  const view = await page(service, job.id);
  service.transcription.fingerprint = async () => {
    throw new Error("missing");
  };
  assert.equal((await page(service, job.id)).sourceCurrent, false);
  await assert.rejects(
    service.execute("transcript.cut", {
      id: "v",
      jobId: job.id,
      from: "w1",
      to: "w1",
      revision: view.revision,
    }),
    /source file changed|cannot be checked/,
  );
  assert.equal(counts.saves, 0);
});

test("a source that changes during recognition gives no words", async () => {
  const { service, file } = setup();
  const prepare = service.transcription.prepare;
  service.transcription.prepare = async (...args) => {
    const result = await prepare(...args);
    file.set("v", { size: 999, mtimeMs: 9 });
    return result;
  };
  const job = await service.execute("transcript.start", { id: "v" });
  let status;
  for (let i = 0; i < 200; i++) {
    status = await service.execute("transcript.status", { jobId: job.id });
    if (status.state !== "running") break;
    await pause();
  }
  assert.equal(status.state, "failed");
  assert.match(status.error, /source file changed/);
  await assert.rejects(page(service, job.id), /source file changed/);
});

test("a cut counts a caption that it clips further", async () => {
  const { service } = setup();
  const job = await transcribe(service);
  await service.execute("captions.add", {
    id: "v",
    text: "Long",
    start: 2,
    end: 6,
  });
  // The caption is already Part cut: source 3 to 4 is gone.
  await service.execute("edit.cut", { id: "v", start: 3, end: 4 });
  const { revision } = await page(service, job.id);
  // Word big (2 to 3) is in the caption. It clips the caption further.
  const result = await service.execute("transcript.cut", {
    id: "v",
    jobId: job.id,
    from: "w1",
    to: "w1",
    revision,
  });
  assert.deepEqual(result.captionPlacement, { partial: 1, removed: 0 });
  // Then a cut of the rest of the caption removes it.
  const next = await page(service, job.id);
  await service.execute("edit.cut", { id: "v", start: 2, end: 3.5 });
  const after = await page(service, job.id);
  assert.notEqual(after.revision, next.revision);
});

test("a selection with an old revision is rejected, and a split keeps it valid", async () => {
  const { service } = setup();
  const job = await transcribe(service);
  const { revision } = await page(service, job.id);
  const args = { jobId: job.id, from: "w1", to: "w2", revision };
  const proposal = await service.execute("transcript.selection", args);
  assert.equal(proposal.jobId, job.id);
  assert.equal(proposal.videoId, "v");
  assert.equal(proposal.from, "w1");
  assert.equal(proposal.to, "w2");
  assert.equal(proposal.revision, revision);
  assert.equal(proposal.sourceCurrent, true);

  // A split changes no timing, so the proposal stays valid.
  await service.execute("edit.split", { id: "v", seconds: 5 });
  assert.equal(
    (await service.execute("transcript.selection", args)).revision,
    revision,
  );
  await service.execute("edit.configure", { id: "v", speed: 2 });
  await assert.rejects(
    service.execute("transcript.selection", args),
    /edits changed/,
  );
});

test("a cut that is not possible saves nothing and tells the reason", async () => {
  const { service, counts } = setup({
    words: [token(" all", 0, 10)],
  });
  const job = await transcribe(service);
  const { revision } = await page(service, job.id);
  await assert.rejects(
    service.execute("transcript.cut", {
      id: "v",
      jobId: job.id,
      from: "w0",
      to: "w0",
      revision,
    }),
    /leave some video/,
  );
  assert.equal(counts.saves, 0);

  const other = setup();
  const second = await transcribe(other.service);
  await other.service.execute("edit.cut", { id: "v", start: 1.5, end: 4.5 });
  const after = await page(other.service, second.id);
  await assert.rejects(
    other.service.execute("transcript.cut", {
      id: "v",
      jobId: second.id,
      from: "w1",
      to: "w2",
      revision: after.revision,
    }),
    /already cut/,
  );
  assert.equal(other.counts.saves, 1, "Only the first cut.");
});

test("a job without speech has an empty view, and a running job has none", async () => {
  const { service } = setup({ words: [] });
  const job = await transcribe(service);
  const view = await page(service, job.id);
  assert.equal(view.outcome, "no_speech");
  assert.deepEqual(view.words, []);
  assert.equal(view.total, 0);

  let finish;
  const waiting = setup();
  waiting.service.transcription.prepare = () =>
    new Promise((resolve) => (finish = resolve));
  const running = await waiting.service.execute("transcript.start", {
    id: "v",
  });
  await assert.rejects(page(waiting.service, running.id), /not complete/);
  await pause();
  finish({ outcome: "no_speech", words: [], duration: 10 });
});

test("a deleted video has no word view", async () => {
  const { service, records } = setup();
  service.library.remove = async (id) => {
    records.delete(id);
    return { deleted: id };
  };
  const job = await transcribe(service);
  await service.execute("library.delete", { id: "v" });
  await assert.rejects(page(service, job.id), /not found/);
});

test("the revision is the transcript revision of inspect and export", async () => {
  const { service, records } = setup();
  const job = await transcribe(service);
  const view = await page(service, job.id);
  assert.equal(view.revision, timingRevision(records.get("v")));
});

test("the capability result gives the page limit", async () => {
  const { service } = setup();
  const result = await service.execute("transcript.capabilities");
  assert.equal(result.maxWordsPerPage, 1000);
});
