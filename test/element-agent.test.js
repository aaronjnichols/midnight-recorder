import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/agent/server.js";
import { Service, commands } from "../src/application/service.js";
import { Media } from "../src/adapters/media.js";
import { Library } from "../src/adapters/library.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { FrameInspection } from "../src/adapters/inspection.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";

test("CLI and MCP give the same element commands, results, and errors", async (t) => {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/claude-editing", "agent-"));
  const source = await createInspectionSource(root);
  const media = new Media();
  const previews = new PreviewCache(root, media);
  const service = new Service({
    library: new Library(root),
    media,
    previews,
    inspection: new FrameInspection(media, previews),
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
  const client = new Client({ name: "element-test", version: "1.0.0" });
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

  // Both transports list the same schemas as the shared service.
  const tools = (await client.listTools()).tools;
  const help = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ["src/agent/cli.js", "help"],
        {
          env,
        },
      )
    ).stdout,
  ).commands;
  for (const name of ["element.add", "element.update", "element.list"]) {
    const shared = commands.find((c) => c.name === name).inputSchema;
    assert.deepEqual(tools.find((c) => c.name === name).inputSchema, shared);
    assert.deepEqual(help.find((c) => c.name === name).inputSchema, shared);
  }

  const video = await cli("library.import", { path: source });
  // Text with quotes, backslashes, braces, a line break, and non-ASCII
  // characters goes through the command line without change.
  const text = 'Say "hi" \\ C:\\Temp {x} %{pts}\nCafé ✓';
  const added = await cli("element.add", {
    id: video.id,
    type: "text",
    text,
    start: 1,
    end: 4,
    x: 0.4,
    y: 0.4,
    width: 0.2,
    height: 0.2,
    background: "#FF0000",
    backgroundOpacity: 1,
  });
  assert.equal(added.element.text, text);
  const updated = await mcp("element.update", {
    id: video.id,
    elementId: added.element.id,
    text: `${text} ü`,
    y: 0.5,
  });
  assert.equal(updated.element.text, `${text} ü`);
  const fromCli = await cli("element.list", { id: video.id });
  const fromMcp = await mcp("element.list", { id: video.id });
  assert.deepEqual(fromCli, fromMcp);
  assert.equal(fromMcp.elements[0].y, 0.5);

  // The same error from both transports.
  const bad = { id: video.id, elementId: added.element.id, x: 0.9 };
  const cliError = await promisify(execFile)(
    process.execPath,
    ["src/agent/cli.js", "element.update", JSON.stringify(bad)],
    { env },
  ).catch((error) => error);
  assert.equal(cliError.code, 1);
  await assert.rejects(mcp("element.update", bad), (error) => {
    assert.equal(error.message.trim(), cliError.stderr.trim());
    assert.match(error.message, /inside the frame/);
    return true;
  });

  // An agent inspects the frame with the revision from element.list.
  const job = await mcp("inspect.start", {
    id: video.id,
    timestamps: [2],
    width: 480,
    revision: fromMcp.revision,
  });
  let status;
  for (let i = 0; i < 600; i++) {
    status = await cli("export.status", { jobId: job.id });
    if (status.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.state, "complete", status.error);
  const inspected = await client.callTool({
    name: "inspect.result",
    arguments: { jobId: job.id },
  });
  const metadata = JSON.parse(inspected.content[0].text);
  assert.equal(metadata.stale, false);
  assert.equal(metadata.revision, fromCli.revision);
  assert.equal(inspected.content.filter((c) => c.type === "image").length, 1);

  // Undo through the CLI removes the update made through MCP.
  await cli("edit.undo", { id: video.id });
  const undone = await mcp("element.list", { id: video.id });
  assert.equal(undone.elements[0].text, text);
  assert.notEqual(undone.revision, fromMcp.revision);
});
