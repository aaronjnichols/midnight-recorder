import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run } from "../src/adapters/media.js";

const root = path.resolve(".local/transcript-agent-practice");
await mkdir(root, { recursive: true });
const env = { ...process.env, MIDNIGHT_DATA: root };
const cli = async (name, args = {}) =>
  JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ["src/agent/cli.js", name, JSON.stringify(args)],
        { env, maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout,
  );
const wait = async (name, id) => {
  for (let i = 0; i < 900; i++) {
    const job = await cli(name, { jobId: id });
    if (!["running", "cancelling"].includes(job.state)) {
      assert.equal(job.state, "complete", job.error);
      return job;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("Job timeout");
};
const client = new Client({ name: "transcription-practice", version: "1.0.0" });
const mcp = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.notEqual(r.isError, true, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
};
let app;
const launch = async () => {
  app = await _electron.launch({ args: ["."], env });
  const page =
    app.windows().find((p) => p.url().endsWith("/ui/index.html")) ||
    (await app.waitForEvent("window", {
      predicate: async (p) => {
        await p.waitForLoadState();
        return p.url().endsWith("/ui/index.html");
      },
    }));
  await page.waitForSelector("#library-view h1");
};
const close = async () => {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
    app = null;
  }
};
try {
  await launch();
  const capabilities = await cli("transcript.capabilities");
  assert.equal(capabilities.available, true, JSON.stringify(capabilities));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/agent/mcp.js"],
      env,
    }),
  );
  // The commands that this practice uses. The catalog can have more.
  const listed = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const name of [
    "transcript.capabilities",
    "transcript.start",
    "transcript.status",
    "transcript.read",
    "transcript.search",
    "transcript.cancel",
  ])
    assert.ok(listed.has(name), `MCP does not have ${name}.`);
  let video = (
    await cli("library.list", { query: "Speech validation viewport" })
  )[0];
  video ??= await cli("library.import", {
    path: path.resolve(".local/transcript-validation/viewport.mp4"),
    title: "Speech validation viewport",
  });
  await cli("edit.reset", { id: video.id });
  await cli("edit.trim", { id: video.id, start: 0, end: 95 });
  const started = Date.now();
  const job = await cli("transcript.start", { id: video.id });
  const done = await wait("transcript.status", job.id);
  const search = await mcp("transcript.search", {
    jobId: job.id,
    query: "blue z axis",
    contextSeconds: 3,
  });
  assert.equal(search.stale, false);
  assert.ok(search.matches.length > 0);
  const first = await mcp("transcript.read", {
    jobId: job.id,
    start: 0,
    end: 30,
    detail: "words",
    limit: 5,
  });
  assert.ok(first.nextOffset);
  const second = await cli("transcript.read", {
    jobId: job.id,
    start: 0,
    end: 30,
    detail: "words",
    limit: 5,
    offset: first.nextOffset,
  });
  assert.notEqual(first.words[0].start, second.words[0].start);
  const inspect = async (label, hit, revision) => {
    const j = await cli("inspect.start", {
      id: video.id,
      timestamps: hit.inspectionTimestamps,
      width: 960,
      revision,
    });
    await wait("export.status", j.id);
    const result = await client.callTool({
      name: "inspect.result",
      arguments: { jobId: j.id },
    });
    assert.notEqual(result.isError, true);
    const images = result.content.filter((c) => c.type === "image");
    assert.equal(images.length, 3);
    const metadata = JSON.parse(result.content[0].text);
    for (let i = 0; i < images.length; i++)
      await writeFile(
        path.join(root, `${label}-${i + 1}.png`),
        Buffer.from(images[i].data, "base64"),
      );
    return metadata;
  };
  const before = await inspect("before", search.matches[0], search.revision);
  await cli("edit.cut", { id: video.id, start: 0, end: 20 });
  await cli("edit.configure", { id: video.id, speed: 1.5 });
  assert.equal(
    (await mcp("transcript.search", { jobId: job.id, query: "blue z axis" }))
      .stale,
    true,
  );
  const editedJob = await mcp("transcript.start", { id: video.id });
  const editedDone = await wait("transcript.status", editedJob.id);
  assert.equal(editedDone.result.cached, true);
  const editedSearch = await mcp("transcript.search", {
    jobId: editedJob.id,
    query: "blue z axis",
  });
  assert.ok(
    Math.abs(
      editedSearch.matches[0].start - (search.matches[0].start - 20) / 1.5,
    ) < 1e-6,
  );
  const after = await inspect(
    "after",
    editedSearch.matches[0],
    editedSearch.revision,
  );
  await cli("edit.configure", { id: video.id, muted: true });
  const muted = await cli("transcript.start", { id: video.id });
  await wait("transcript.status", muted.id);
  assert.equal(
    (await mcp("transcript.read", { jobId: muted.id })).audioAudible,
    false,
  );
  const invalid = await client.callTool({
    name: "transcript.read",
    arguments: { jobId: muted.id, limit: 1000 },
  });
  assert.equal(invalid.isError, true);
  await assert.rejects(
    cli("transcript.search", { jobId: muted.id, query: "!!!" }),
  );
  await close();
  await launch();
  const restarted = await cli("transcript.start", { id: video.id });
  const restartedDone = await wait("transcript.status", restarted.id);
  assert.equal(restartedDone.result.cached, true);
  const silencePath = path.join(root, "silence.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=size=160x90:duration=8:rate=10",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=16000:cl=mono",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    silencePath,
  ]);
  const silent = await cli("library.import", {
    path: silencePath,
    title: "Speech validation silence",
  });
  const silenceJob = await cli("transcript.start", { id: silent.id });
  const silence = await wait("transcript.status", silenceJob.id);
  assert.equal(silence.result.outcome, "no_speech");
  const noAudioPath = path.join(root, "no-audio.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    silencePath,
    "-an",
    "-c:v",
    "copy",
    noAudioPath,
  ]);
  const noAudio = await cli("library.import", { path: noAudioPath });
  const noAudioJob = await cli("transcript.start", { id: noAudio.id });
  assert.equal(
    (await wait("transcript.status", noAudioJob.id)).result.outcome,
    "no_audio",
  );
  assert.equal(
    (await cli("transcript.read", { jobId: noAudioJob.id })).audioAudible,
    false,
  );
  const cancelJob = await cli("transcript.start", {
    id: video.id,
    vocabulary: ["Viewport", "Navigation"],
  });
  let cancelProgress;
  for (let i = 0; i < 100; i++) {
    const status = await cli("transcript.status", { jobId: cancelJob.id });
    assert.equal(status.state, "running");
    if (status.progress.completedRegions >= 1) {
      cancelProgress = status.progress;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    cancelProgress?.completedRegions >= 1,
    "The worker must report speech progress before cancellation.",
  );
  await cli("transcript.cancel", { jobId: cancelJob.id });
  let cancelled;
  for (let i = 0; i < 100; i++) {
    cancelled = await cli("transcript.status", { jobId: cancelJob.id });
    if (cancelled.state === "cancelled") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await cli("library.get", { id: video.id })).id, video.id);
  const report = {
    elapsedSeconds: (Date.now() - started) / 1000,
    capabilities,
    videoId: video.id,
    job: done,
    search,
    before,
    editedSearch,
    after,
    cacheAfterEdit: editedDone.result.cached,
    cacheAfterRestart: restartedDone.result.cached,
    silence: silence.result,
    invalidMcp: invalid.isError,
    cancelState: cancelled.state,
    cancelProgress,
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({ result: "PASS", report: path.join(root, "report.json") }),
  );
} finally {
  await client.close().catch(() => {});
  await close();
}
