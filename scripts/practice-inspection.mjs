import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { _electron } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInspectionSource } from "../test-support/inspection-fixture.js";

// Exercise the real desktop service. Keep the normal library unchanged.
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local", "inspection-practice-"));
const source = await createInspectionSource(root);
const env = { ...process.env, MIDNIGHT_DATA: root };
const cli = async (name, args = {}) =>
  JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ["src/agent/cli.js", name, JSON.stringify(args)],
        { env },
      )
    ).stdout,
  );
const client = new Client({ name: "inspection-practice", version: "1.0.0" });
let app;
try {
  app = await _electron.launch({ args: ["."], env });
  const page =
    app.windows().find((p) => p.url().endsWith("/ui/index.html")) ||
    (await app.waitForEvent("window", {
      predicate: async (page) => {
        await page.waitForLoadState();
        return page.url().endsWith("/ui/index.html");
      },
    }));
  await page.waitForSelector("#library-view h1");
  const video = await cli("library.import", {
    path: source,
    title: "Frame inspection practice",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/agent/mcp.js"],
      env,
    }),
  );
  const inspect = async (name, timestamps, grid = false) => {
    const job = await cli("inspect.start", { id: video.id, timestamps, grid });
    let status;
    for (let i = 0; i < 300; i++) {
      status = await cli("export.status", { jobId: job.id });
      if (status.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.state, "complete", status.error);
    const result = await client.callTool({
      name: "inspect.result",
      arguments: { jobId: job.id },
    });
    assert.notEqual(result.isError, true);
    const images = result.content.filter((item) => item.type === "image");
    assert.equal(images.length, timestamps.length);
    const metadata = JSON.parse(result.content[0].text);
    for (const [index, image] of images.entries()) {
      const output = path.join(root, `${name}-${index + 1}.png`);
      await writeFile(output, Buffer.from(image.data, "base64"));
      metadata.frames[index].savedImage = output;
    }
    await writeFile(
      path.join(root, `${name}.json`),
      JSON.stringify(metadata, null, 2),
    );
    return metadata;
  };
  const single = await inspect("single", [2]);
  const sequence = await inspect("sequence", [0, 2.9, 3, 4.5, 5.9], true);
  assert.equal(sequence.frames[2].seconds, 3);
  await cli("edit.cut", { id: video.id, start: 1, end: 2 });
  await cli("edit.configure", { id: video.id, speed: 0.5 });
  const edited = await inspect("edited", [1, 3.9, 4, 8, 9.9]);
  assert.equal(edited.frames[2].seconds, 4);
  assert.equal(edited.frames[2].sourceSeconds, 3);
  const report = { root, videoId: video.id, source, single, sequence, edited };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        root,
        report: path.join(root, "report.json"),
        images: [
          single.frames[0].savedImage,
          sequence.frames[2].savedImage,
          edited.frames[2].savedImage,
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => {});
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
}
