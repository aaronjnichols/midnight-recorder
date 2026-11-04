// The page loader of the overview, with the real job service and a read that
// the test finishes by hand. It has no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/application/service.js";
import { createOverview } from "../src/ui/timeline-overview.js";

function setup() {
  const reads = [];
  const overview = {
    prepare(video, { signal }) {
      return new Promise((resolve, reject) => {
        reads.push({
          id: video.id,
          signal,
          finish: () =>
            resolve({
              identity: video.id,
              cached: false,
              audio: { state: "none" },
              frames: { state: "ready", count: 0 },
            }),
        });
        signal.addEventListener("abort", () =>
          reject(new Error("The operation was aborted.")),
        );
      });
    },
    read: async (video) => ({
      identity: video.id,
      duration: 10,
      audio: { state: "none" },
      frames: { state: "ready", width: 16, height: 9, items: [] },
    }),
  };
  const video = (id) => ({
    id,
    metadata: { duration: 10, hasAudio: false },
    timeline: {
      segments: [{ start: 0, end: 10 }],
      speed: 1,
      muted: false,
      past: [],
      future: [],
    },
  });
  const videos = { a: video("a"), b: video("b") };
  const service = new Service({
    overview,
    library: { get: async (id) => videos[id] },
  });
  // A reply that the test can hold.
  const held = [];
  let hold = null;
  const call = async (name, args) => {
    const result = await service.execute(name, args);
    if (hold?.(name, args)) {
      hold = null;
      await new Promise((resolve) => held.push(resolve));
    }
    return result;
  };
  return {
    reads,
    service,
    call,
    held,
    holdNext: (rule) => (hold = rule),
  };
}
const waitFor = async (check, message) => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

test("a late start reply does not cancel the read of the open video", async () => {
  const { reads, call, held, holdNext } = setup();
  const loader = createOverview({ call, onChange: () => {} });
  // Open A. Its reply is late. Open B, then A again, which joins the read.
  holdNext((name, args) => name === "overview.start" && args.id === "a");
  loader.load("a");
  await waitFor(() => held.length === 1, "The reply was not held.");
  loader.load("b");
  await waitFor(() => reads.length >= 1, "No read.");
  const again = loader.load("a");
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The first reply arrives now.
  held[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const read = reads.find((r) => r.id === "a");
  assert.equal(read.signal.aborted, false, "The open video keeps its read.");
  read.finish();
  await waitFor(
    () => reads.find((r) => r.id === "b")?.signal.aborted !== false,
    "B was not stopped.",
  ).catch(() => {});
  for (const item of reads) item.finish();
  await again;
  assert.equal(loader.view().videoId, "a");
  assert.equal(loader.view().frames.state, "ready");
});

test("the page does not stop a read that an agent needs", async () => {
  const { reads, service, call } = setup();
  const agent = await service.execute("overview.start", { id: "a" });
  const loader = createOverview({ call, onChange: () => {} });
  loader.load("a");
  await waitFor(() => reads.length === 1, "No read.");
  await new Promise((resolve) => setTimeout(resolve, 20));
  loader.clear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads[0].signal.aborted, false, "The agent keeps its read.");
  assert.equal(
    (await service.execute("export.status", { jobId: agent.id })).state,
    "running",
  );
  reads[0].finish();
});

test("the page stops its own read when it leaves the video", async () => {
  const { reads, call } = setup();
  const loader = createOverview({ call, onChange: () => {} });
  loader.load("a");
  await waitFor(() => reads.length === 1, "No read.");
  await new Promise((resolve) => setTimeout(resolve, 20));
  loader.clear();
  await waitFor(() => reads[0].signal.aborted, "The read did not stop.");
  assert.equal(loader.view().videoId, "");
});
