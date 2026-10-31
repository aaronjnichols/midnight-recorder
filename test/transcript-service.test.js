import { test } from "node:test";
import assert from "node:assert/strict";
import { Service, commands } from "../src/application/service.js";

const video = {
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
const pause = () => new Promise((r) => setTimeout(r, 5));
test('a transcript cache lock leaves the source available for a delete retry',async()=>{
 let removed=false;
 const service=new Service({library:{remove:async()=>{removed=true;}},transcription:{remove:async()=>{throw Error('cache locked');}}});
 await assert.rejects(service.execute('library.delete',{id:'v'}),/cache locked/);
 assert.equal(removed,false);
});
async function finished(service, id) {
  for (let i = 0; i < 100; i++) {
    const j = await service.execute("transcript.status", { jobId: id });
    if (!["running", "cancelling"].includes(j.state)) return j;
    await pause();
  }
  throw Error("timeout");
}

test("shared speech commands return bounded results and flag changed edits", async () => {
  assert.ok(commands.some((c) => c.name === "transcript.start"));
  let record = structuredClone(video);
  const service = new Service({
    library: {
      get: async () => record,
      update: async (id, patch) => (record = { ...record, ...patch }),
    },
    transcription: {
      capabilities: async () => ({ available: true }),
      prepare: async () => ({
        outcome: "ready",
        words: [{ word: "Hello", start: 1, end: 2 }],
        duration: 10,
        identity: { model: "test" },
      }),
    },
  });
  assert.equal(
    (await service.execute("transcript.capabilities")).available,
    true,
  );
  const job = await service.execute("transcript.start", { id: "v" });
  assert.equal(job.state, "running");
  const done = await finished(service, job.id);
  assert.equal(done.state, "complete");
  assert.equal(done.result.words, undefined);
  const result = await service.execute("transcript.read", {
    jobId: job.id,
    detail: "words",
  });
  assert.equal(result.words[0].start, 1);
  assert.equal(result.stale, false);
  await service.execute("edit.configure", { id: "v", speed: 2 });
  assert.equal(
    (
      await service.execute("transcript.search", {
        jobId: job.id,
        query: "hello",
      })
    ).stale,
    true,
  );
  const next = await service.execute("transcript.start", { id: "v" });
  await finished(service, next.id);
  assert.equal(
    (
      await service.execute("transcript.read", {
        jobId: next.id,
        detail: "words",
      })
    ).words[0].start,
    0.5,
  );
  await assert.rejects(
    service.execute("transcript.start", { id: "v", language: "fr" }),
    /English|language/i,
  );
  await assert.rejects(
    service.execute("transcript.start", { id: "v", vocabulary: [1] }),
    /vocabulary/i,
  );
});

test("cancellation releases one speech slot and protects source deletion until stopped", async () => {
  let stopped = false,
    removed = false;
  const service = new Service({
    library: {
      get: async () => structuredClone(video),
      remove: async () => ({ deleted: "v" }),
    },
    transcription: {
      remove: async () => {
        removed = true;
      },
      prepare: async (v, o, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              setTimeout(() => {
                stopped = true;
                reject(new Error("cancelled"));
              }, 20),
            { once: true },
          );
        }),
    },
  });
  const job = await service.execute("transcript.start", { id: "v" });
  assert.equal(
    (await service.execute("transcript.start", { id: "v" })).id,
    job.id,
  );
  await assert.rejects(
    service.execute("transcript.start", { id: "v", vocabulary: ["different"] }),
    /active/,
  );
  await assert.rejects(service.execute("library.delete", { id: "v" }), /Wait/);
  assert.equal(
    (await service.execute("transcript.cancel", { jobId: job.id })).state,
    "cancelling",
  );
  await assert.rejects(service.execute("library.delete", { id: "v" }), /Wait/);
  assert.equal((await finished(service, job.id)).state, "cancelled");
  assert.equal(stopped, true);
  assert.equal(
    (await service.execute("library.delete", { id: "v" })).deleted,
    "v",
  );
  assert.equal(removed, true);
  await assert.rejects(
    service.execute("transcript.status", { jobId: job.id }),
    /not found/,
  );
});
