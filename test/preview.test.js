import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, access } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media } from "../src/adapters/media.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { createTimeline, cut } from "../src/domain/timeline.js";

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
