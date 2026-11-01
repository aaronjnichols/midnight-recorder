import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/agent/server.js";
import { Service } from "../src/application/service.js";
import { Media } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { FrameInspection } from "../src/adapters/inspection.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";
import { frameAt, region, isWhite } from "../test-support/frames.js";

// Recognized words in source seconds, like the local speech engine gives.
const WORDS = [
  [" Open", 0.5, 0.8, 0],
  [" the", 0.8, 0.9, 0],
  [" settings.", 0.9, 1.4, 0],
  [" Click", 3.2, 3.5, 1],
  [" Save.", 3.5, 3.9, 1],
].map(([word, start, end, segmentId]) => ({
  word,
  start,
  end,
  probability: 0.9,
  segmentId,
}));

test("CLI and MCP make, read, correct, and inspect captions", async (t) => {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(
    path.resolve(".local/claude-editing", "caption-agent-"),
  );
  const source = await createInspectionSource(root);
  const media = new Media();
  const previews = new PreviewCache(root, media);
  let recognitions = 0;
  const service = new Service({
    library: new Library(root),
    media,
    previews,
    inspection: new FrameInspection(media, previews),
    transcription: {
      capabilities: async () => ({ available: true }),
      prepare: async () => {
        recognitions++;
        return {
          outcome: "ready",
          words: WORDS,
          duration: 6,
          cached: false,
          identity: { model: "test" },
          audioSha256: "test",
        };
      },
    },
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
  const client = new Client({ name: "caption-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/agent/mcp.js"],
      env,
    }),
  );
  const mcp = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["captions.generate", "captions.list", "captions.update"])
    assert.ok(tools.includes(name), name);

  const video = await cli("library.import", { path: source });
  const job = await cli("captions.generate", { id: video.id });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await mcp("captions.status", { jobId: job.jobId });
    if (status.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status.state, "draft", status.error);
  assert.match(status.message, /ready/);
  const page = await mcp("captions.draft", { jobId: job.jobId, limit: 1 });
  assert.equal(page.count, 2);
  assert.equal(page.cues.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.equal(page.cues[0].text, "Open the settings.");
  const applied = await cli("captions.apply", {
    jobId: job.jobId,
    revision: page.revision,
  });
  assert.equal(applied.added, 2);
  assert.equal(applied.timing, "estimated");
  const listed = await cli("captions.list", { id: video.id });
  assert.deepEqual(listed, await mcp("captions.list", { id: video.id }));
  assert.equal(listed.audioAudible, false, "The fixture has no sound.");
  assert.deepEqual(
    listed.cues.map((c) => [c.text, c.start, c.end]),
    [
      ["Open the settings.", 0.5, 1.7],
      ["Click Save.", 3.2, 4.2],
    ],
  );
  // A correction with characters that mean something to shells and FFmpeg.
  const fixed = `Click "Save"; then 100% done`;
  const updated = await cli("captions.update", {
    id: video.id,
    cueId: listed.cues[1].id,
    text: fixed,
  });
  assert.equal(updated.cue.text, fixed);
  assert.equal(updated.video, undefined, "A summary, not the video.");
  const styled = await mcp("captions.configure", {
    id: video.id,
    size: 0.06,
  });
  assert.equal(styled.captions.style.size, 0.06);
  assert.equal(recognitions, 1, "A style change does not run speech again.");
  const invalid = await client.callTool({
    name: "captions.configure",
    arguments: { id: video.id, fill: "#FFFFFF" },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Unknown argument: fill/);
  const window = await mcp("captions.list", {
    id: video.id,
    start: 3,
    end: 4,
    limit: 1,
  });
  assert.equal(window.matches, 1);
  assert.equal(window.cues[0].text, fixed);

  // Inspect frames before, during, and after a caption.
  const inspection = await mcp("inspect.start", {
    id: video.id,
    timestamps: [0.3, 1, 2.5, 3.6],
    revision: window.revision,
  });
  for (let i = 0; i < 600; i++) {
    const state = await cli("export.status", { jobId: inspection.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const result = await mcp("inspect.result", {
    jobId: inspection.id,
    includeImages: false,
  });
  assert.equal(result.stale, false);
  const area = { left: 0, top: 400, right: 960, bottom: 540 };
  const white = result.frames.map(
    (f) => region(frameAt(f.path, 0, 960, 540), isWhite, area).count,
  );
  assert.ok(white[0] === 0 && white[2] === 0, JSON.stringify(white));
  assert.ok(white[1] > 300 && white[3] > 300, JSON.stringify(white));

  // Undo the style and the correction, then export.
  await mcp("edit.undo", { id: video.id });
  await cli("edit.undo", { id: video.id });
  const reverted = await mcp("captions.list", { id: video.id });
  assert.equal(reverted.cues[1].text, "Click Save.");
  assert.equal(reverted.style.size, 0.045);
  const output = path.join(root, "captioned.mp4");
  const exported = await cli("export.start", { id: video.id, path: output });
  for (let i = 0; i < 600; i++) {
    const state = await mcp("export.status", { jobId: exported.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(region(frameAt(output, 1, 960, 540), isWhite, area).count > 300);
  assert.equal(region(frameAt(output, 2.5, 960, 540), isWhite, area).count, 0);
});
