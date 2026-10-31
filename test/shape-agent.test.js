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
import { frameAt, region } from "../test-support/frames.js";

test("CLI and MCP add shapes, arrows, and fades and inspect the result", async (t) => {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(
    path.resolve(".local/claude-editing", "shape-agent-"),
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
  const client = new Client({ name: "shape-test", version: "1.0.0" });
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
  const video = await cli("library.import", { path: source });
  // The fixture Save button is at x 120 to 280, y 330 to 400 of 960 x 540
  // before source time 3. A highlight box around it and an arrow to its
  // center: (200, 365) is (0.2083, 0.6759).
  const box = await cli("element.add", {
    id: video.id,
    type: "rectangle",
    start: 0.5,
    end: 2.5,
    x: 0.115,
    y: 0.6,
    width: 0.18,
    height: 0.15,
    stroke: "#FF0000",
    strokeWidth: 0.01,
    fadeIn: 0.3,
  });
  assert.equal(box.element.type, "rectangle");
  const arrow = await mcp("element.add", {
    id: video.id,
    type: "arrow",
    start: 0.5,
    end: 2.5,
    x1: 0.5,
    y1: 0.4,
    x2: 0.2083,
    y2: 0.6759,
    color: "#00FF00",
    strokeWidth: 0.012,
  });
  assert.equal(arrow.element.x2, 0.2083);
  const changed = await cli("element.update", {
    id: video.id,
    elementId: arrow.element.id,
    fadeOut: 5,
  });
  // The arrow shows for 2 seconds, so a 5-second fade-out is shortened.
  assert.equal(changed.element.fadeOut, 5);
  assert.equal(changed.element.actualFadeOut, 2);
  await mcp("element.update", {
    id: video.id,
    elementId: arrow.element.id,
    fadeOut: 0.3,
  });
  const configured = await mcp("edit.configure", {
    id: video.id,
    fadeIn: 0.25,
    fadeOut: 0.5,
  });
  assert.equal(configured.videoFades.actualFadeOut, 0.5);
  const listed = await cli("element.list", { id: video.id });
  assert.deepEqual(listed, await mcp("element.list", { id: video.id }));
  assert.deepEqual(
    listed.elements.map((e) => e.type),
    ["rectangle", "arrow"],
  );
  const invalid = await client.callTool({
    name: "element.add",
    arguments: {
      id: video.id,
      type: "arrow",
      start: 0,
      end: 1,
      fill: "#FFFFFF",
    },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /does not use fill/);

  const job = await mcp("inspect.start", {
    id: video.id,
    timestamps: [1.5],
    revision: listed.revision,
  });
  for (let i = 0; i < 600; i++) {
    const state = await cli("export.status", { jobId: job.id });
    if (state.state === "failed") assert.fail(state.error);
    if (state.state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const result = await mcp("inspect.result", {
    jobId: job.id,
    includeImages: false,
  });
  const frame = frameAt(result.frames[0].path, 0, 960, 540);
  const green = region(frame, ([r, g, b]) => g > 180 && r < 100 && b < 100);
  // The arrow tip is at the button center.
  assert.ok(Math.abs(green.minX - 200) <= 3, JSON.stringify(green));
  assert.ok(Math.abs(green.maxY - 365) <= 3, JSON.stringify(green));
  const red = region(frame, ([r, g, b]) => r > 180 && g < 90 && b < 90);
  assert.ok(Math.abs(red.minX - 110) <= 2 && Math.abs(red.maxX - 282) <= 2);
});
