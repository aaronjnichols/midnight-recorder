import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Media, run } from "../src/adapters/media.js";
import * as worker from "../src/adapters/transcription-worker.js";

test("speech audio uses the source clock when an audio track starts late", async () => {
  const media = new Media();
  assert.equal(typeof media.extractAudio, "function");
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "speech-clock-"));
  const source = path.join(root, "offset.mkv"),
    audio = path.join(root, "audio.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=160x90:rate=10:duration=3",
    "-itsoffset",
    "1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  const video = { path: source, metadata: await media.probe(source) };
  await media.extractAudio(video, audio);
  const info = JSON.parse(
    await run("ffprobe", ["-v", "error", "-show_format", "-of", "json", audio]),
  );
  assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.02);
  // Read PCM to verify the leading second. The FFmpeg helper returns stdout only.
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(audio);
  const start = bytes.indexOf(Buffer.from("data")) + 8;
  const pcm = bytes.subarray(start);
  let early = 0,
    later = 0;
  for (let i = 0; i < 12000; i++)
    early = Math.max(early, Math.abs(pcm.readInt16LE(i * 2)));
  for (let i = 17000; i < 24000; i++)
    later = Math.max(later, Math.abs(pcm.readInt16LE(i * 2)));
  assert.equal(early, 0);
  assert.ok(later > 100);
});

test("an engine package update changes the transcript fingerprint in an open app", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "speech-identity-"));
  for (const file of [
    "model.bin",
    "config.json",
    "tokenizer.json",
    "vocabulary.txt",
  ])
    await writeFile(path.join(root, file), "fixture");
  let version = "one";
  const runner = new worker.PythonSpeechRunner({
    python: process.execPath,
    model: root,
    invoke: async () => ({ "faster-whisper": version }),
  });
  const before = await runner.identity();
  version = "two";
  const after = await runner.identity();
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(after.packages["faster-whisper"], "two");
});

test("missing speech setup reports a direct local setup command", async () => {
  assert.equal(typeof worker.PythonSpeechRunner, "function");
  const runner = new worker.PythonSpeechRunner({
    python: "does-not-exist",
    model: "does-not-exist",
  });
  const status = await runner.capabilities();
  assert.equal(status.available, false);
  assert.match(status.setup, /setup:transcription/);
});
