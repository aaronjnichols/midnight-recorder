import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("speech setup explains downloads and rejects incomplete existing-runtime options", async () => {
  const run = promisify(execFile);
  const help = await run(process.execPath, [
    "scripts/setup-transcription.mjs",
    "--help",
  ]);
  assert.match(help.stdout, /local|offline/i);
  assert.match(help.stdout, /download/i);
  await assert.rejects(
    run(process.execPath, [
      "scripts/setup-transcription.mjs",
      "--python",
      "missing",
    ]),
    (e) => /both --python and --model/.test(e.stderr),
  );
});
