import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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

test("CLI starts frame inspection and MCP returns viewable image content", async (t) => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "inspect-agent-"));
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
  const video = await cli("library.import", { path: source });
  const job = await cli("inspect.start", {
    id: video.id,
    timestamps: [0, 3],
    width: 480,
  });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await cli("export.status", { jobId: job.id });
    if (status.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.state, "complete", status.error);
  const paths = await cli("inspect.result", {
    jobId: job.id,
    includeImages: false,
  });
  assert.equal(paths.frames[0].data, undefined);
  const client = new Client({ name: "inspection-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/agent/mcp.js"],
      env,
    }),
  );
  const result = await client.callTool({
    name: "inspect.result",
    arguments: { jobId: job.id },
  });
  assert.equal(result.isError, undefined);
  const images = result.content.filter((c) => c.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].mimeType, "image/png");
  assert.deepEqual(
    Buffer.from(images[0].data, "base64"),
    await readFile(paths.frames[0].path),
  );
  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.frames[0].data, undefined);
  assert.equal(metadata.frames[1].seconds, 3);
  assert.equal(metadata.stale, false);
  const noImages = await client.callTool({
    name: "inspect.result",
    arguments: { jobId: job.id, includeImages: false },
  });
  assert.equal(noImages.content.length, 1);
  const invalid = await client.callTool({
    name: "inspect.start",
    arguments: { id: video.id, timestamps: [6] },
  });
  assert.equal(invalid.isError, true);
});
