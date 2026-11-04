import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp } from "node:fs/promises";
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
import { TEXT_CONFLICT } from "../src/domain/elements.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";

test("CLI and MCP give the draft frame and the text guard", async (t) => {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(
    path.resolve(".local/claude-editing", "draft-agent-"),
  );
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
  const client = new Client({ name: "draft-test", version: "1.0.0" });
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

  const tools = (await client.listTools()).tools;
  const help = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ["src/agent/cli.js", "help"],
        { env },
      )
    ).stdout,
  ).commands;
  for (const name of ["preview.frame", "element.update"]) {
    const shared = commands.find((c) => c.name === name);
    const mcpTool = tools.find((c) => c.name === name);
    const cliTool = help.find((c) => c.name === name);
    assert.deepEqual(mcpTool.inputSchema, shared.inputSchema, name);
    assert.deepEqual(cliTool.inputSchema, shared.inputSchema, name);
  }

  const video = await cli("library.import", { path: source, title: "Agent" });
  const { element } = await cli("element.add", {
    id: video.id,
    type: "text",
    text: "Agent text",
    start: 0,
    end: 6,
  });
  const args = { id: video.id, seconds: 1, elementId: element.id };
  const finish = async (run, job) => {
    let state = job;
    while (state.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = await run("export.status", { jobId: job.id });
    }
    assert.equal(state.state, "complete", state.error);
    return state.result;
  };
  const fromCli = await finish(cli, await cli("preview.frame", args));
  const fromMcp = await finish(mcp, await mcp("preview.frame", args));
  assert.deepEqual(fromMcp, fromCli);
  await access(fromCli.under.path);
  assert.deepEqual(fromCli.frame, { width: 960, height: 540 });

  // The same guard and the same error from both clients.
  const stale = {
    id: video.id,
    elementId: element.id,
    text: "Overwrite",
    expectedText: "Not this text",
  };
  await assert.rejects(
    () => mcp("element.update", stale),
    (error) => error.message.includes(TEXT_CONFLICT),
  );
  await assert.rejects(
    () => cli("element.update", stale),
    (error) => error.message.includes(TEXT_CONFLICT),
  );
  const { element: saved } = await mcp("element.update", {
    ...stale,
    expectedText: "Agent text",
  });
  assert.equal(saved.text, "Overwrite");
});
