import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serve } from "../src/agent/server.js";
import { Service, commands } from "../src/application/service.js";

test("authenticated HTTP, CLI, and MCP use the same service commands", async (t) => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "agent-"));
  const service = new Service({
    // This test checks transport calls. Countdown timing has a separate test.
    scheduler: { setTimeout: () => 1, clearTimeout: () => {} },
    capture: {
      start: async () => {},
      pause: async () => {},
      cancel: async () => {},
    },
  });
  const server = await serve(service, root);
  t.after(() => server.close());
  const connection = JSON.parse(
    await readFile(path.join(root, "connection.json"), "utf8"),
  );
  const url = `http://127.0.0.1:${connection.port}/command`;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer " + "é".repeat(64) },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          origin: "https://example.com",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const env = { ...process.env, MIDNIGHT_DATA: root };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["src/agent/cli.js", "app.status"],
    { env },
  );
  assert.equal(JSON.parse(stdout).recording.state, "idle");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/agent/mcp.js"],
    env,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const list = await client.listTools();
  assert.deepEqual(
    list.tools.map((v) => v.name),
    commands.map((v) => v.name),
  );
  const result = await client.callTool({ name: "app.status", arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).recording.state, "idle");
  const started = await client.callTool({
    name: "recording.start",
    arguments: { cameraOnly: true },
  });
  const { id } = JSON.parse(started.content[0].text);
  await client.callTool({
    name: "recording.fail",
    arguments: { recordingId: id, error: "Disk full" },
  });
  const failed = await promisify(execFile)(
    process.execPath,
    ["src/agent/cli.js", "app.status"],
    { env },
  );
  assert.equal(JSON.parse(failed.stdout).recording.state, "failed");
  assert.equal(JSON.parse(failed.stdout).recording.error, "Disk full");
  const mcpFailed = await client.callTool({
    name: "app.status",
    arguments: {},
  });
  assert.equal(
    JSON.parse(mcpFailed.content[0].text).recording.error,
    "Disk full",
  );
  await client.callTool({ name: "recording.cancel", arguments: {} });
  const countdown = await promisify(execFile)(
    process.execPath,
    ["src/agent/cli.js", "recording.countdown", '{"cameraOnly":true}'],
    { env },
  );
  assert.equal(JSON.parse(countdown.stdout).state, "countdown");
  const countdownStatus = await client.callTool({
    name: "app.status",
    arguments: {},
  });
  assert.equal(
    JSON.parse(countdownStatus.content[0].text).recording.remaining,
    3,
  );
  await client.callTool({ name: "recording.cancel", arguments: {} });
  const mcpCountdown = await client.callTool({
    name: "recording.countdown",
    arguments: { cameraOnly: true },
  });
  assert.equal(JSON.parse(mcpCountdown.content[0].text).state, "countdown");
  await client.callTool({ name: "recording.cancel", arguments: {} });
});

test("agent requests preserve Unicode text across network chunks", async (t) => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "unicode-"));
  const server = await serve({ execute: async (command, args) => args }, root);
  t.after(() => server.close());
  const connection = JSON.parse(
    await readFile(path.join(root, "connection.json"), "utf8"),
  );
  const body = Buffer.from(
    JSON.stringify({ command: "echo", args: { title: "café" } }),
  );
  const split = body.indexOf(Buffer.from("é")) + 1;
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: connection.port,
        path: "/command",
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}` },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => resolve(JSON.parse(text)));
      },
    );
    request.on("error", reject);
    request.write(body.subarray(0, split));
    setTimeout(() => request.end(body.subarray(split)), 20);
  });
  assert.equal(result.result.title, "café");
});
