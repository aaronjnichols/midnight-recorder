// Split, parts, and word cuts through the running service: the CLI process and
// the MCP server use the same queue, and one history. The real media adapter
// renders the result. A fake speech runner gives known words. acceptance and the
// practice script use the real speech engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/agent/server.js";
import { Service } from "../src/application/service.js";
import { Media } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { LocalTranscriber } from "../src/adapters/transcriber.js";

async function workspace(prefix) {
  await mkdir(".local/loom-next/media", { recursive: true });
  return mkdtemp(path.resolve(".local/loom-next/media", prefix));
}
function sampleVideo(root) {
  const file = path.join(root, "sample.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=10",
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
const token = (word, start, end) => ({
  word,
  start,
  end,
  probability: 0.9,
  segmentId: 0,
});
const speech = {
  identity: async () => ({ engine: "fake" }),
  capabilities: async () => ({ available: true }),
  transcribe: async () => ({
    words: [
      token(" One", 0.5, 1),
      token(" two", 2, 2.5),
      token(" three", 3, 3.5),
      token(" four", 5, 5.5),
      token(" five", 7, 7.5),
    ],
  }),
};

test(
  "split, part, and word commands work through the CLI and MCP",
  { timeout: 180000 },
  async (t) => {
    const root = await workspace("parts-agent-");
    const media = new Media();
    const library = new Library(root);
    const service = new Service({
      library,
      media,
      previews: new PreviewCache(root, media),
      transcription: new LocalTranscriber(root, media, { runner: speech }),
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
            { env, maxBuffer: 16 * 1024 * 1024 },
          )
        ).stdout,
      );
    const client = new Client({ name: "parts-test", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["src/agent/mcp.js"],
        env,
      }),
    );
    t.after(() => client.close());
    const mcp = async (name, args) => {
      const answer = await client.callTool({ name, arguments: args });
      assert.notEqual(answer.isError, true, answer.content[0].text);
      return JSON.parse(answer.content[0].text);
    };

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "edit.split",
      "edit.unsplit",
      "edit.keepPart",
      "edit.removePart",
      "parts.list",
      "transcript.words",
      "transcript.selection",
      "transcript.cut",
    ])
      assert.ok(names.includes(name), name);

    const video = await cli("library.import", { path: sampleVideo(root) });
    const id = video.id;

    // A split from the CLI shows in MCP, and it saves one history step.
    const split = await cli("edit.split", { id, seconds: 6.1234567 });
    assert.equal(split.timeline.past.length, 1);
    assert.equal(split.split.source, 6.123457);
    const listed = await mcp("parts.list", { id });
    assert.equal(listed.parts.length, 2);
    assert.equal(listed.revision, split.structureRevision);

    // A second client with an old view changes nothing.
    await mcp("edit.split", { id, seconds: 8 });
    await assert.rejects(
      cli("edit.removePart", {
        id,
        partId: listed.parts[1].id,
        revision: listed.revision,
      }),
      /changed/,
    );

    // A second list, and a removal by MCP. Undo by CLI uses one history.
    const next = await cli("parts.list", { id });
    assert.equal(next.parts.length, 3);
    const removed = await mcp("edit.removePart", {
      id,
      partId: next.parts[2].id,
      revision: next.revision,
    });
    assert.deepEqual(removed.timeline.segments, [{ start: 0, end: 8 }]);
    assert.deepEqual(
      (await cli("edit.undo", { id })).timeline.segments,
      video.timeline.segments,
    );

    // Words, with the same IDs through both clients.
    const job = await cli("transcript.start", { id });
    let status;
    for (let i = 0; i < 400; i++) {
      status = await mcp("transcript.status", { jobId: job.id });
      if (status.state === "complete") break;
      assert.equal(status.state, "running", status.error);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status.state, "complete");
    const fromCli = await cli("transcript.words", { jobId: job.id });
    const fromMcp = await mcp("transcript.words", { jobId: job.id });
    assert.deepEqual(fromMcp, fromCli);
    assert.deepEqual(
      fromCli.words.map((w) => w.text),
      ["One", "two", "three", "four", "five"],
    );
    assert.equal(fromCli.sourceCurrent, true);
    const preview = await mcp("transcript.selection", {
      jobId: job.id,
      from: "w3",
      to: "w1",
    });
    assert.equal(preview.text, "two three four");
    assert.equal(preview.sourceStart, 2);
    assert.equal(preview.sourceEnd, 5.5);

    const history = (await cli("library.get", { id })).timeline.past.length;
    const result = await mcp("transcript.cut", {
      id,
      jobId: job.id,
      from: "w1",
      to: "w3",
      revision: fromCli.revision,
    });
    assert.equal(result.timeline.past.length, history + 1);
    assert.deepEqual(result.timeline.segments, [
      { start: 0, end: 2 },
      { start: 5.5, end: 10 },
    ]);
    // A late client with the old revision cannot cut again.
    await assert.rejects(
      cli("transcript.cut", {
        id,
        jobId: job.id,
        from: "w4",
        to: "w4",
        revision: fromCli.revision,
      }),
      /edits changed/,
    );
    // No new recognition for the current view.
    const after = await cli("transcript.words", { jobId: job.id });
    assert.deepEqual(
      after.words.map((w) => w.state),
      ["kept", "removed", "removed", "removed", "kept"],
    );

    // A real render of the word cut: 3.5 seconds less.
    const output = path.join(root, "word-cut.mp4");
    const started = await cli("export.start", { id, path: output });
    for (let i = 0; i < 400; i++) {
      const state = await cli("export.status", { jobId: started.id });
      if (state.state === "complete") break;
      assert.equal(state.state, "running", state.error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { duration } = await media.probe(output);
    assert.ok(Math.abs(duration - 6.5) < 0.1, `${duration} seconds`);

    // A replaced source file stops a cut through the transport.
    const edited = await cli("transcript.words", { jobId: job.id });
    await writeFile(video.path, "another file");
    assert.equal(
      (await cli("transcript.words", { jobId: job.id })).sourceCurrent,
      false,
    );
    await assert.rejects(
      cli("transcript.cut", {
        id,
        jobId: job.id,
        from: "w4",
        to: "w4",
        revision: edited.revision,
      }),
      /source file changed/,
    );
  },
);
