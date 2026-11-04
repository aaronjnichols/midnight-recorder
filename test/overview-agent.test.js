// The overview commands through the shared service, the CLI, and MCP. Reads
// run in the background, so state commands do not wait for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/agent/server.js";
import { Service, commands } from "../src/application/service.js";
import { Media } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { TimelineOverview } from "../src/adapters/overview.js";

async function workspace(prefix) {
  await mkdir(".local/loom-redesign/media", { recursive: true });
  return mkdtemp(path.resolve(".local/loom-redesign/media", prefix));
}
// 6 seconds: a tone, 2 seconds of silence, and a tone.
function patternVideo(root) {
  const file = path.join(root, "pattern.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x336699:s=320x180:r=30:d=6",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=48000:d=6",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}

// A read that the test finishes by hand.
function fakeOverview({ audio = "ready" } = {}) {
  const calls = [];
  const summary = (video) => ({
    identity: `id-${video.id}`,
    cached: false,
    audio: { state: audio },
    frames: { state: "ready", count: 0 },
  });
  return {
    calls,
    prepare(video, { signal, onProgress }) {
      return new Promise((resolve, reject) => {
        const call = {
          video,
          signal,
          finish: () => resolve(summary(video)),
          fail: (error) => reject(error),
          progress: () => onProgress?.({ audio: { state: audio } }),
        };
        calls.push(call);
        signal.addEventListener("abort", () =>
          reject(new Error("The operation was aborted.")),
        );
      });
    },
    read: async (video) => ({
      identity: `id-${video.id}`,
      duration: video.metadata.duration,
      audio: {
        state: audio,
        ...(audio === "ready" ? { levels: "", bucketSeconds: 1 } : {}),
      },
      frames: { state: "reading", items: [] },
    }),
  };
}
function fakeLibrary(ids = ["a", "b"]) {
  const videos = new Map(
    ids.map((id) => [
      id,
      {
        id,
        title: id,
        path: `/${id}.mp4`,
        metadata: { duration: 10, width: 320, height: 180, hasAudio: true },
        timeline: {
          segments: [{ start: 0, end: 10 }],
          speed: 1,
          muted: false,
          past: [],
          future: [],
        },
      },
    ]),
  );
  return {
    get: async (id) => {
      if (!videos.has(id)) throw new Error("Video not found.");
      return videos.get(id);
    },
    update: async (id, patch) => {
      Object.assign(videos.get(id), patch);
      return videos.get(id);
    },
    remove: async (id) => videos.delete(id),
  };
}
const waitFor = async (check, message) => {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
};

test("the commands are in the shared catalog", () => {
  for (const name of ["overview.start", "overview.cancel", "overview.result"])
    assert.ok(
      commands.some((command) => command.name === name),
      name,
    );
});

test(
  "CLI and MCP read real levels that follow the current edits",
  { timeout: 120000 },
  async (t) => {
    const root = await workspace("overview-agent-");
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const service = new Service({
      library: new Library(root),
      media,
      previews,
      overview: new TimelineOverview(media, previews),
    });
    const server = await serve(service, root);
    t.after(() => server.close());
    const env = { ...process.env, MIDNIGHT_DATA: root };
    const cli = async (name, args) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ["src/agent/cli.js", name, JSON.stringify(args)],
            { env },
          )
        ).stdout,
      );
    const video = await cli("library.import", { path: patternVideo(root) });
    const job = await cli("overview.start", { id: video.id });
    assert.equal(job.kind, "overview");
    let status;
    for (let i = 0; i < 400; i++) {
      status = await cli("export.status", { jobId: job.id });
      if (status.state === "complete") break;
      assert.notEqual(status.state, "failed", status.error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.state, "complete");
    assert.equal(status.result.audio.state, "ready");
    assert.equal(status.result.frames.state, "ready");
    assert.ok(
      JSON.stringify(status).length < 1000,
      "A job record has no sample data.",
    );

    // Three equal parts of the source: tone, silence, tone.
    const read = await cli("overview.result", { jobId: job.id, buckets: 3 });
    assert.equal(read.window.timeBase, "edited");
    const [first, second, third] = read.window.levels;
    assert.ok(first > 0.5 && third > 0.5, String(read.window.levels));
    assert.ok(second < first, String(read.window.levels));
    assert.equal(read.frames.items, undefined, "No images by default.");
    assert.equal(read.audio.levels, undefined, "No raw levels by default.");
    assert.ok(JSON.stringify(read).length < 2000);

    // A window of the silence.
    const quiet = await cli("overview.result", {
      jobId: job.id,
      start: 2.2,
      end: 3.8,
      buckets: 4,
    });
    assert.ok(
      Math.max(...quiet.window.levels) < 0.05,
      String(quiet.window.levels),
    );

    // A cut changes the mapping with no new read. The revision tells it.
    await cli("edit.cut", { id: video.id, start: 0, end: 2 });
    const edited = await cli("overview.result", { jobId: job.id, buckets: 2 });
    assert.notEqual(edited.revision, read.revision);
    assert.equal(edited.editedDuration, 4);
    assert.equal(edited.sourceDuration, read.sourceDuration);
    assert.ok(edited.window.levels[0] < edited.window.levels[1]);
    // The same video has the same job: no new read.
    assert.equal((await cli("overview.start", { id: video.id })).id, job.id);

    // includeData has the source data for a display.
    const full = await cli("overview.result", {
      jobId: job.id,
      includeData: true,
    });
    assert.ok(full.audio.levels.length > 100);
    assert.equal(full.frames.items.length, 12);
    assert.ok(full.frames.items[0].data.length > 100);

    const client = new Client({ name: "overview-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/agent/mcp.js"],
      env,
    });
    await client.connect(transport);
    t.after(() => client.close());
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "overview.result"));
    const answer = await client.callTool({
      name: "overview.result",
      arguments: { jobId: job.id, buckets: 2 },
    });
    const mcp = JSON.parse(answer.content[0].text);
    assert.deepEqual(
      mcp.window,
      edited.window,
      "MCP and CLI give the same result.",
    );
    // MCP has one text block. It does not carry images by default.
    assert.equal(answer.content.length, 1);
    assert.equal(mcp.frames.items, undefined);
    assert.equal(mcp.audio.levels, undefined);
    assert.ok(answer.content[0].text.length < 2000);
  },
);

test("a running read does not block state commands or edits", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  const job = await service.execute("overview.start", { id: "a" });
  assert.equal(job.state, "running");
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  // The read is still running. These commands answer.
  assert.equal(
    (await service.execute("app.status")).jobs.some((j) => j.id === job.id),
    true,
  );
  assert.equal(
    (await service.execute("library.revision", { id: "a" })).id,
    "a",
  );
  await service.execute("edit.configure", { id: "a", muted: true });
  // A second start joins the running job.
  assert.equal(
    (await service.execute("overview.start", { id: "a" })).id,
    job.id,
  );
  await assert.rejects(
    service.execute("overview.result", { jobId: job.id }),
    /not ready/,
  );
  overview.calls[0].finish();
  await waitFor(
    async () =>
      (await service.execute("export.status", { jobId: job.id })).state ===
      "complete",
    "The job did not complete.",
  );
  assert.equal(
    (await service.execute("overview.start", { id: "a" })).id,
    job.id,
    "A complete job answers again.",
  );
});

test("sound can be read while frames are still being read", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  const job = await service.execute("overview.start", { id: "a" });
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  overview.calls[0].progress();
  const status = await service.execute("export.status", { jobId: job.id });
  assert.equal(status.state, "running");
  assert.equal(status.progress.audio.state, "ready");
  const read = await service.execute("overview.result", { jobId: job.id });
  assert.equal(read.audio.state, "ready");
  assert.equal(read.frames.state, "reading");
  overview.calls[0].finish();
});

test("reads run one at a time, in order", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  await service.execute("overview.start", { id: "a" });
  await service.execute("overview.start", { id: "b" });
  await waitFor(() => overview.calls.length === 1, "The first read.");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(overview.calls.length, 1, "The second read waits.");
  overview.calls[0].finish();
  await waitFor(() => overview.calls.length === 2, "The second read.");
  assert.equal(overview.calls[1].video.id, "b");
  overview.calls[1].finish();
});

test("cancel stops a running read and a read in the queue", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  const first = await service.execute("overview.start", { id: "a" });
  const second = await service.execute("overview.start", { id: "b" });
  await waitFor(() => overview.calls.length === 1, "The first read.");
  const queued = await service.execute("overview.cancel", { jobId: second.id });
  assert.equal(queued.state, "cancelling");
  const running = await service.execute("overview.cancel", { jobId: first.id });
  assert.equal(running.state, "cancelling");
  assert.equal(overview.calls[0].signal.aborted, true);
  const state = (job) =>
    service.execute("export.status", { jobId: job.id }).then((j) => j.state);
  await waitFor(
    async () =>
      (await state(first)) === "cancelled" &&
      (await state(second)) === "cancelled",
    "The jobs did not stop.",
  );
  assert.equal(overview.calls.length, 1, "The queued read does no work.");
  await assert.rejects(
    service.execute("overview.result", { jobId: first.id }),
    /not ready/,
  );
  // A new start after a cancel reads again.
  const next = await service.execute("overview.start", { id: "a" });
  assert.notEqual(next.id, first.id);
  await waitFor(() => overview.calls.length === 2, "No new read.");
  overview.calls[1].finish();
});

test("a video delete stops its read and does not wait for the user", async () => {
  const overview = fakeOverview();
  const removed = [];
  const service = new Service({
    library: fakeLibrary(),
    overview,
    previews: { remove: async (id) => removed.push(id) },
  });
  const job = await service.execute("overview.start", { id: "a" });
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  await service.execute("library.delete", { id: "a" });
  assert.equal(overview.calls[0].signal.aborted, true);
  assert.deepEqual(removed, ["a"]);
  await assert.rejects(
    service.execute("export.status", { jobId: job.id }),
    /not found/,
  );
});

test("a delete waits for a read that is cancelling", async () => {
  const overview = fakeOverview();
  // This read ends some time after the cancel, like a child process.
  const prepare = overview.prepare;
  overview.prepare = (video, options) =>
    prepare(video, { ...options, signal: new AbortController().signal });
  const removed = [];
  const service = new Service({
    library: fakeLibrary(),
    overview,
    previews: { remove: async (id) => removed.push(id) },
  });
  const job = await service.execute("overview.start", { id: "a" });
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  await service.execute("overview.cancel", { jobId: job.id });
  const deleted = service.execute("library.delete", { id: "a" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(removed, [], "The files stay while the read runs.");
  overview.calls[0].finish();
  await deleted;
  assert.deepEqual(removed, ["a"]);
});

test("a cancel after the read does not report complete", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  const prepare = overview.prepare;
  // The read ignores the signal and returns a result after the cancel.
  overview.prepare = (video, options) =>
    prepare(video, { ...options, signal: new AbortController().signal });
  const job = await service.execute("overview.start", { id: "a" });
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  await service.execute("overview.cancel", { jobId: job.id });
  overview.calls[0].finish();
  await waitFor(
    async () =>
      (await service.execute("export.status", { jobId: job.id })).state ===
      "cancelled",
    "The state is not cancelled.",
  );
});

test("a shared read stops only when no caller needs it", async () => {
  const overview = fakeOverview();
  const service = new Service({ library: fakeLibrary(), overview });
  const page = await service.execute("overview.start", { id: "a" });
  const agent = await service.execute("overview.start", { id: "a" });
  assert.equal(agent.id, page.id, "The second caller joins the read.");
  assert.notEqual(agent.holder, page.holder);
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  // The page leaves. The agent still needs the read.
  const after = await service.execute("overview.cancel", {
    jobId: page.id,
    holder: page.holder,
  });
  assert.equal(after.state, "running");
  assert.equal(overview.calls[0].signal.aborted, false);
  // The last caller leaves.
  await service.execute("overview.cancel", {
    jobId: agent.id,
    holder: agent.holder,
  });
  assert.equal(overview.calls[0].signal.aborted, true);
  // A cancel without a holder is a decision for all callers.
  const other = await service.execute("overview.start", { id: "b" });
  await service.execute("overview.start", { id: "b" });
  await waitFor(() => overview.calls.length === 2, "The second read.");
  await service.execute("overview.cancel", { jobId: other.id });
  assert.equal(overview.calls[1].signal.aborted, true);
});

test("completed overview jobs have a limit", async () => {
  const overview = fakeOverview();
  const ids = Array.from({ length: 30 }, (_, i) => `v${i}`);
  const service = new Service({ library: fakeLibrary(ids), overview });
  for (const [index, id] of ids.entries()) {
    await service.execute("overview.start", { id });
    await waitFor(() => overview.calls.length === index + 1, "No read.");
    overview.calls[index].finish();
    await waitFor(
      () => [...service.jobs.values()].every((job) => job.state !== "running"),
      "The job did not end.",
    );
  }
  const kept = [...service.jobs.values()].filter((j) => j.kind === "overview");
  assert.ok(kept.length <= 16, `${kept.length} jobs.`);
  assert.equal(kept.at(-1).videoId, "v29", "The latest job stays.");
  assert.equal(service.overviewJobs.entries.size, kept.length);
});

test(
  "a changed source file reads again instead of an old job",
  { timeout: 120000 },
  async () => {
    const root = await workspace("overview-changed-");
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const service = new Service({
      library: new Library(root),
      media,
      previews,
      overview: new TimelineOverview(media, previews),
    });
    const video = await service.execute("library.import", {
      path: patternVideo(root),
    });
    const complete = (job) =>
      waitFor(
        async () =>
          (await service.execute("export.status", { jobId: job.id })).state ===
          "complete",
        "The read did not complete.",
      );
    const first = await service.execute("overview.start", { id: video.id });
    await complete(first);
    await utimes(video.path, new Date(), new Date(Date.now() + 5000));
    const second = await service.execute("overview.start", { id: video.id });
    assert.notEqual(second.id, first.id);
    await complete(second);
    assert.equal(
      (await service.execute("overview.result", { jobId: second.id })).audio
        .state,
      "ready",
    );
  },
);

test(
  "a damaged cache recovers through the shared commands",
  { timeout: 120000 },
  async () => {
    const root = await workspace("overview-recover-");
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const service = new Service({
      library: new Library(root),
      media,
      previews,
      overview: new TimelineOverview(media, previews),
    });
    const video = await service.execute("library.import", {
      path: patternVideo(root),
    });
    const complete = (job) =>
      waitFor(
        async () =>
          (await service.execute("export.status", { jobId: job.id })).state ===
          "complete",
        "The read did not complete.",
      );
    const first = await service.execute("overview.start", { id: video.id });
    await complete(first);
    const folder = previews.directory(video.id);
    const [name] = (await readdir(folder)).filter((file) =>
      file.startsWith("overview-"),
    );
    await writeFile(path.join(folder, name), '{"version":1,"ident');
    // A retry reads the source again. It does not answer with the old job.
    const second = await service.execute("overview.start", { id: video.id });
    assert.notEqual(second.id, first.id);
    await complete(second);
    const read = await service.execute("overview.result", { jobId: second.id });
    assert.equal(read.audio.state, "ready");
    assert.equal(read.frames.count, 12);
  },
);

test("a failed part can read again, and bad arguments give clear errors", async () => {
  const overview = fakeOverview({ audio: "failed" });
  const service = new Service({ library: fakeLibrary(), overview });
  const job = await service.execute("overview.start", { id: "a" });
  await waitFor(() => overview.calls.length === 1, "The read did not start.");
  overview.calls[0].finish();
  await waitFor(
    async () =>
      (await service.execute("export.status", { jobId: job.id })).state ===
      "complete",
    "The job did not complete.",
  );
  const retry = await service.execute("overview.start", { id: "a" });
  assert.notEqual(retry.id, job.id, "A failed part reads again.");
  await waitFor(() => overview.calls.length === 2, "No retry.");
  overview.calls[1].finish();

  await assert.rejects(
    service.execute("overview.result", { jobId: job.id, buckets: 0 }),
    /buckets/,
  );
  await assert.rejects(
    service.execute("overview.result", { jobId: job.id, end: 99 }),
    /range/,
  );
  await assert.rejects(
    service.execute("overview.result", { jobId: "none" }),
    /not found/,
  );
  await assert.rejects(
    new Service({ library: fakeLibrary() }).execute("overview.start", {
      id: "a",
    }),
    /not available/,
  );
  await assert.rejects(
    service.execute("overview.start", { id: "missing" }),
    /not found/,
  );
});

test(
  "a real delete during a read leaves no cache file",
  { timeout: 120000 },
  async () => {
    const root = await workspace("overview-delete-");
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const service = new Service({
      library: new Library(root),
      media,
      previews,
      overview: new TimelineOverview(media, previews),
    });
    const video = await service.execute("library.import", {
      path: patternVideo(root),
    });
    await service.execute("overview.start", { id: video.id });
    await service.execute("library.delete", { id: video.id });
    const left = await readdir(previews.directory(video.id)).catch(() => []);
    assert.deepEqual(left, []);
  },
);
