import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, access } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Media } from "../src/adapters/media.js";
import { PreviewCache } from "../src/adapters/preview.js";
import {
  createTimeline,
  cut,
  configure,
  trim,
} from "../src/domain/timeline.js";
import {
  createDelayedAudioSource,
  readSound,
} from "../test-support/audio-fixture.js";

test("an edited preview replaces an obsolete render that moved audio forward", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "preview-audio-"));
  const source = createDelayedAudioSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = configure(
    trim(createTimeline(metadata.duration), 0.25, 2.75),
    { speed: 2 },
  );
  const video = { id: "delayed-audio", path: source, metadata, timeline };
  const cache = new PreviewCache(root, media);
  const { segments, speed, muted } = timeline;
  const oldKey = createHash("sha256")
    .update(
      JSON.stringify({
        id: video.id,
        path: source,
        metadata,
        segments,
        speed,
        muted,
      }),
    )
    .digest("hex");
  const oldOutput = path.join(cache.directory(video.id), oldKey + ".mp4");
  await mkdir(cache.directory(video.id), { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    source,
    "-filter_complex",
    "[0:v]trim=start=0.25:end=2.75,setpts=(PTS-STARTPTS)/2[v];[0:a]atrim=start=0.25:end=2.75,asetpts=PTS-STARTPTS,atempo=2[a]",
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    oldOutput,
  ]);
  assert.ok(readSound(oldOutput).firstSound < 0.06);
  const preview = await cache.prepare(video);
  const sound = readSound(preview.path);
  assert.ok(Math.abs(sound.firstSound - 0.375) < 0.06, JSON.stringify(sound));
  assert.notEqual(preview.path, oldOutput);
  const reopened = new PreviewCache(root, {
    probe: (file) => media.probe(file),
    export: () => {
      throw new Error("The current preview must be reused.");
    },
  });
  assert.equal((await reopened.prepare(video)).url, preview.url);
});

test("a preview from the render before the exact output clock is not reused", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "preview-clock-"));
  const source = createDelayedAudioSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = cut(createTimeline(metadata.duration), 0.5, 1.2);
  const video = { id: "old-clock", path: source, metadata, timeline };
  const cache = new PreviewCache(root, media);
  const { segments, speed, muted } = timeline;
  // The key that the previous renderer (render version 2) used.
  const oldKey = createHash("sha256")
    .update(
      JSON.stringify({
        renderVersion: 2,
        id: video.id,
        path: source,
        metadata,
        segments,
        speed,
        muted,
      }),
    )
    .digest("hex");
  const oldOutput = path.join(cache.directory(video.id), oldKey + ".mp4");
  await mkdir(cache.directory(video.id), { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-i", source, "-t", "1", oldOutput]);
  const preview = await cache.prepare(video);
  assert.notEqual(preview.path, oldOutput);
  assert.ok(Math.abs(preview.metadata.duration - 2.3) < 0.04);
});

test("an edited preview removes boundary content and reuses the cached file", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "preview-"));
  const source = path.join(root, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:size=320x240:rate=30:duration=1",
    "-f",
    "lavfi",
    "-i",
    "color=lime:size=320x240:rate=30:duration=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=blue:size=320x240:rate=30:duration=1.5",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    source,
  ]);
  const original = await readFile(source);
  const media = new Media();
  const metadata = await media.probe(source);
  const video = {
    id: "test-video",
    path: source,
    metadata,
    timeline: cut(createTimeline(metadata.duration), 0.9, 1.6),
  };
  const cache = new PreviewCache(root, media);
  const preview = await cache.prepare(video);
  const frame = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "0.95",
    "-i",
    preview.path,
    "-vf",
    "scale=1:1,format=rgb24",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  assert.ok(
    frame[2] > 200 && frame[0] < 20 && frame[1] < 20,
    `Expected blue after cut: ${[...frame]}`,
  );
  assert.deepEqual(await readFile(source), original);
  assert.equal((await cache.prepare(video)).url, preview.url);
  await cache.remove(video.id);
  await assert.rejects(() => access(preview.path), /ENOENT/);
});
