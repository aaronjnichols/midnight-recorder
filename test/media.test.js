import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media } from "../src/adapters/media.js";
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

test("real FFmpeg export preserves the source audio delay", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "audio-delay-"));
  const source = createDelayedAudioSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const output = path.join(root, "edited.mp4");
  await media.export(
    { path: source, metadata, timeline: createTimeline(metadata.duration) },
    output,
  );
  const { firstSound } = readSound(output);
  assert.ok(
    Math.abs(firstSound - 1) < 0.06,
    `Expected sound at 1 second, got ${firstSound}`,
  );
});

test("real FFmpeg export keeps the remaining audio delay after a cut and speed change", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "audio-edit-"));
  const source = createDelayedAudioSource(root);
  const original = await readFile(source);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = configure(
    cut(createTimeline(metadata.duration), 0.25, 0.5),
    { speed: 2 },
  );
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const sound = readSound(output);
  assert.ok(Math.abs(sound.firstSound - 0.375) < 0.06, JSON.stringify(sound));
  assert.ok(Math.abs((await media.probe(output)).duration - 1.375) < 0.1);
  assert.deepEqual(await readFile(source), original);
});

test("real FFmpeg export keeps a segment before the first audio frame silent", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "audio-silence-"));
  const source = createDelayedAudioSource(root);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = trim(createTimeline(metadata.duration), 0.1, 0.6);
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const sound = readSound(output);
  assert.equal(sound.firstSound, -1);
  assert.equal(sound.peak, 0);
  assert.ok(Math.abs(sound.duration - 0.5) < 0.06, JSON.stringify(sound));
  assert.ok(Math.abs((await media.probe(output)).duration - 0.5) < 0.06);
});

test("real FFmpeg export applies cuts and speed to video and audio", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "media-"));
  const source = path.join(root, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    source,
  ]);
  const media = new Media();
  const metadata = await media.probe(source);
  assert.equal(metadata.hasAudio, true);
  const timeline = configure(cut(createTimeline(metadata.duration), 1, 2), {
    speed: 2,
  });
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  const result = await media.probe(output);
  assert.ok(Math.abs(result.duration - 1.5) < 0.15, JSON.stringify(result));
  assert.equal(result.hasAudio, true);
  await assert.rejects(
    () => media.export({ path: source, metadata, timeline }, output),
    /exist/i,
  );
  const invalidOutput = path.join(root, "invalid.mp4");
  await assert.rejects(() =>
    media.export(
      {
        path: source,
        metadata,
        timeline: { ...timeline, segments: [{ start: 100, end: 101 }] },
      },
      invalidOutput,
    ),
  );
  await assert.rejects(() => access(invalidOutput), /ENOENT/);
});

test("export keeps the selected duration for a video with sparse frames", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "sparse-"));
  const source = path.join(root, "source.webm");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=30",
    "-t",
    "3",
    "-vf",
    "select='lt(n,14)+gte(n,84)'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libvpx-vp9",
    source,
  ]);
  const media = new Media();
  const metadata = await media.probe(source);
  const timeline = (await import("../src/domain/timeline.js")).trim(
    createTimeline(metadata.duration),
    0.25,
    1.25,
  );
  const output = path.join(root, "edited.mp4");
  await media.export({ path: source, metadata, timeline }, output);
  assert.ok(Math.abs((await media.probe(output)).duration - 1) < 0.1);
});
