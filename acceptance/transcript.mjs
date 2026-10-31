import assert from "node:assert/strict";
import path from "node:path";
import { Media } from "../src/adapters/media.js";
import { PythonSpeechRunner } from "../src/adapters/transcription-worker.js";
import { LocalTranscriber } from "../src/adapters/transcriber.js";
import { writeFile } from "node:fs/promises";

// Public downloads stay outside Git. See docs/transcription-validation.md.
const root = path.resolve(".local/transcript-validation");
const media = new Media(),
  runner = new PythonSpeechRunner();
assert.equal(
  (await runner.capabilities()).available,
  true,
  "Run npm run setup:transcription first.",
);
const engine = new LocalTranscriber(path.join(root, "engine"), media, {
  runner,
});
for (const name of ["blender", "viewport", "nasa"]) {
  const video = { id: name, path: path.join(root, name + ".mp4") };
  video.metadata = await media.probe(video.path);
  const start = performance.now();
  const result = await engine.prepare(
    video,
    { language: "en", vocabulary: [] },
    { onProgress: (p) => console.log(name, JSON.stringify(p)) },
  );
  assert.equal(result.outcome, "ready");
  assert.ok(result.words.length > 100);
  assert.ok(
    result.words.every((w) => w.start >= 0 && w.end <= video.metadata.duration),
  );
  await writeFile(
    path.join(root, name + "-production.json"),
    JSON.stringify(
      { ...result, elapsedSeconds: (performance.now() - start) / 1000 },
      null,
      2,
    ),
  );
  console.log(
    name,
    "PASS",
    result.words.length,
    "words",
    result.cached ? "cache" : "fresh",
  );
}
