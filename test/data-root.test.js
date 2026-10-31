import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("the default data folder is the same when a client starts in another folder", async () => {
  await mkdir(".local", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".local", "client-cwd-"));
  const clientURL = pathToFileURL(path.resolve("src/agent/client.js")).href;
  const env = { ...process.env };
  delete env.MIDNIGHT_DATA;
  const actual = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { dataRoot } from ${JSON.stringify(clientURL)}; process.stdout.write(dataRoot());`,
    ],
    { cwd, env, encoding: "utf8" },
  );
  assert.equal(actual, path.resolve(".local/data"));
});

test("an explicit data folder takes precedence over the default folder", async () => {
  await mkdir(".local", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".local", "explicit-root-"));
  const clientURL = pathToFileURL(path.resolve("src/agent/client.js")).href;
  const expected = path.join(cwd, "custom-data");
  const actual = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { dataRoot } from ${JSON.stringify(clientURL)}; process.stdout.write(dataRoot());`,
    ],
    { cwd, env: { ...process.env, MIDNIGHT_DATA: expected }, encoding: "utf8" },
  );
  assert.equal(actual, expected);
});
