// The timeline overview on real media with FFmpeg. The sound and the picture
// have a known pattern, so the test checks real values and real pixels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media } from "../src/adapters/media.js";
import { PreviewCache } from "../src/adapters/preview.js";
import { TimelineOverview } from "../src/adapters/overview.js";
import { createTimeline, cut } from "../src/domain/timeline.js";
import { editedLevels, frameAtEdited } from "../src/domain/overview.js";

async function workspace() {
  await mkdir(".local/loom-redesign/media", { recursive: true });
  return mkdtemp(path.resolve(".local/loom-redesign/media", "overview-"));
}

// 6 seconds: red with a tone, green with silence, blue with a tone.
export function patternVideo(root, name = "pattern") {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=48000:d=6",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "3:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}
function picture(
  root,
  name,
  { size = "320x180", audio = null, seconds = 3 } = {},
) {
  const file = path.join(root, `${name}.mp4`);
  const inputs = [
    "-f",
    "lavfi",
    "-i",
    `color=c=0x336699:s=${size}:r=30:d=${seconds}`,
  ];
  if (audio) inputs.push("-f", "lavfi", "-i", audio);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    ...inputs,
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac"] : []),
    file,
  ]);
  return file;
}
const sourceOf = async (media, id, file) => ({
  id,
  path: file,
  metadata: await media.probe(file),
  timeline: createTimeline((await media.probe(file)).duration),
});
// The average color of a JPEG, from a 1 x 1 decode.
function color(base64, root) {
  const file = path.join(root, "frame.jpg");
  return writeFile(file, Buffer.from(base64, "base64")).then(() =>
    [
      ...execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]),
    ].slice(0, 3),
  );
}
const levelsOf = (data) => ({
  bucketSeconds: data.audio.bucketSeconds,
  levels: Buffer.from(data.audio.levels, "base64"),
});

test(
  "real sound levels and frames match the source and follow a cut",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const overview = new TimelineOverview(media, new PreviewCache(root, media));
    const video = await sourceOf(media, "pattern", patternVideo(root));
    const summary = await overview.prepare(video);
    assert.equal(summary.cached, false);
    assert.equal(summary.audio.state, "ready");
    assert.equal(summary.frames.state, "ready");
    assert.equal(summary.frames.count, 12);
    const data = await overview.read(video);
    assert.equal(data.identity, summary.identity);

    // Sound: a level in the tone, none in the silence.
    const source = levelsOf(data);
    assert.equal(data.audio.bucketSeconds, 0.02);
    assert.ok(Math.abs(source.levels.length - 300) <= 2, source.levels.length);
    const at = (timeline, start, end) =>
      Math.max(...editedLevels(timeline, source, { start, end, columns: 1 }));
    const plain = video.timeline;
    assert.ok(at(plain, 0.5, 1.5) > 0.5, "Tone at the start.");
    assert.ok(at(plain, 2.3, 3.7) < 0.05, "Silence in the middle.");
    assert.ok(at(plain, 4.5, 5.5) > 0.5, "Tone at the end.");
    // Without a new decode, a cut of the first tone moves the silence.
    const edited = cut(plain, 0, 2);
    assert.ok(at(edited, 0.3, 1.7) < 0.05, "The silence comes first now.");
    assert.ok(at(edited, 2.5, 3.5) > 0.5);

    // Frames: real pictures at their times.
    const frames = data.frames.items;
    assert.equal(frames.length, 12);
    assert.deepEqual(
      frames.map((f) => f.seconds),
      [...frames.map((f) => f.seconds)].sort((a, b) => a - b),
      "Frames are in time order.",
    );
    assert.ok(data.frames.width <= 160 && data.frames.height <= 90);
    const pixel = (timeline, time) =>
      color(frameAtEdited(timeline, frames, time).data, root);
    const [red] = [await pixel(plain, 1)];
    assert.ok(red[0] > 180 && red[1] < 90 && red[2] < 90, String(red));
    const green = await pixel(plain, 3);
    assert.ok(green[1] > 90 && green[0] < 90 && green[2] < 90, String(green));
    const blue = await pixel(plain, 5);
    assert.ok(blue[2] > 180 && blue[0] < 90, String(blue));
    // After the cut, edited time 1 is source time 3: green.
    const moved = await pixel(edited, 1);
    assert.ok(moved[1] > 90 && moved[0] < 90, String(moved));
  },
);

test(
  "the cache file is reused and is in the preview folder of the video",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const overview = new TimelineOverview(media, previews);
    const video = await sourceOf(media, "cache", patternVideo(root));
    const first = await overview.prepare(video);
    const files = await readdir(previews.directory("cache"));
    assert.deepEqual(
      files.filter((f) => f.startsWith("overview-")),
      [`overview-${first.identity}.json`],
    );
    assert.deepEqual(
      files.filter((f) => f.endsWith(".tmp")),
      [],
      "A completed write leaves no temporary file.",
    );

    // A reader that cannot run FFmpeg still reads the cache.
    const broken = new Media({ ffmpeg: "missing-ffmpeg-test" });
    const again = new TimelineOverview(broken, previews);
    const second = await again.prepare(video);
    assert.equal(second.cached, true);
    assert.equal(second.identity, first.identity);
    assert.equal(second.audio.state, "ready");
    assert.equal((await again.read(video)).frames.items.length, 12);

    // Deleting the previews of the video deletes the cache.
    await previews.remove("cache");
    await assert.rejects(stat(previews.directory("cache")));
  },
);

test(
  "no sound, silent sound, a portrait picture, and a short video have honest results",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const overview = new TimelineOverview(media, new PreviewCache(root, media));

    const none = await sourceOf(media, "none", picture(root, "none"));
    const noSound = await overview.prepare(none);
    assert.equal(noSound.audio.state, "none");
    assert.equal(noSound.frames.state, "ready");
    assert.equal((await overview.read(none)).audio.levels, undefined);

    const quiet = await sourceOf(
      media,
      "quiet",
      picture(root, "quiet", { audio: "anullsrc=r=48000:cl=mono" }),
    );
    assert.equal((await overview.prepare(quiet)).audio.state, "silent");

    const tall = await sourceOf(
      media,
      "tall",
      picture(root, "tall", { size: "360x640" }),
    );
    await overview.prepare(tall);
    const { frames } = await overview.read(tall);
    assert.ok(
      frames.height > frames.width,
      JSON.stringify([frames.width, frames.height]),
    );
    assert.ok(frames.height <= 90);

    const brief = await sourceOf(
      media,
      "brief",
      picture(root, "brief", { seconds: 0.3 }),
    );
    assert.equal((await overview.prepare(brief)).frames.count, 1);
  },
);

test(
  "a failed read gives a state and no cache, and the other part still works",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const video = await sourceOf(media, "fail", patternVideo(root));

    const broken = new TimelineOverview(
      new Media({ ffmpeg: "missing-ffmpeg-test" }),
      previews,
    );
    const failed = await broken.prepare(video);
    assert.equal(failed.audio.state, "failed");
    assert.equal(failed.frames.state, "failed");
    assert.match(failed.audio.error, /missing-ffmpeg-test|ENOENT/);
    await assert.rejects(
      stat(previews.directory("fail")).then(async () => {
        const files = await readdir(previews.directory("fail"));
        if (!files.some((f) => f.startsWith("overview-")))
          throw new Error("none");
      }),
    );
    // The next attempt with a working FFmpeg reads the source.
    const fixed = new TimelineOverview(media, previews);
    assert.equal((await fixed.prepare(video)).audio.state, "ready");

    // A video file without the sound that the metadata says it has.
    const silent = await sourceOf(media, "stale", picture(root, "stale"));
    const claimed = {
      ...silent,
      metadata: { ...silent.metadata, hasAudio: true },
    };
    const result = await fixed.prepare(claimed);
    assert.equal(result.audio.state, "failed");
    assert.equal(result.frames.state, "ready", "Frames do not need the sound.");
  },
);

test(
  "frame times are the decoded source times, not the requested times",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const overview = new TimelineOverview(media, new PreviewCache(root, media));
    const video = await sourceOf(media, "times", patternVideo(root));
    await overview.prepare(video);
    const { frames } = await overview.read(video);
    // The source has 30 frames per second, so a decoded time is n / 30. The
    // plan asks for 0.25, which is between two frames.
    for (const { seconds } of frames.items) {
      const frame = seconds * 30;
      assert.ok(Math.abs(frame - Math.round(frame)) < 0.01, String(seconds));
    }
    assert.notEqual(frames.items[0].seconds, 0.25);
  },
);

test(
  "frame times use the same zero-based clock as the export",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const overview = new TimelineOverview(media, new PreviewCache(root, media));
    // The packet times of this file start after 2 seconds.
    const shifted = path.join(root, "shifted.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      patternVideo(root),
      "-c",
      "copy",
      "-output_ts_offset",
      "2",
      shifted,
    ]);
    const start = Number(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=start_time",
        "-of",
        "csv=p=0",
        shifted,
      ]).toString(),
    );
    assert.ok(start > 1.5, `The fixture starts at ${start}.`);
    const video = await sourceOf(media, "shifted", shifted);
    await overview.prepare(video);
    const { frames, duration } = await overview.read(video);
    assert.equal(frames.items.length, 12);
    assert.ok(frames.items[0].seconds < 0.5, String(frames.items[0].seconds));
    assert.ok(frames.items.at(-1).seconds < duration, "Not past the video.");
    // The picture at a time is the same as in the source: red, then green.
    const at = (time) =>
      color(frameAtEdited(video.timeline, frames.items, time).data, root);
    const first = await at(1);
    assert.ok(first[0] > 180 && first[1] < 90, String(first));
    const middle = await at(3);
    assert.ok(middle[1] > 90 && middle[0] < 90, String(middle));
  },
);

test(
  "a stalled frame size read stops with cancel and with the time limit",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const video = await sourceOf(media, "stall", patternVideo(root));
    const stalled = Object.create(media);
    stalled.renderInfo = (_, { signal } = {}) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () =>
          reject(new Error("The probe was aborted.")),
        ),
      );
    const controller = new AbortController();
    const running = new TimelineOverview(stalled, previews).prepare(video, {
      signal: controller.signal,
      onProgress: () => setTimeout(() => controller.abort(), 20),
    });
    await assert.rejects(running, /abort/i);

    // The same stall with a short limit gives a state, not a wait. A limit
    // timer does not keep a process open, so this test keeps its own.
    const open = setInterval(() => {}, 50);
    const limited = new TimelineOverview(stalled, previews, {
      frameSeconds: 0.2,
    });
    const summary = await limited
      .prepare(video)
      .finally(() => clearInterval(open));
    assert.equal(summary.frames.state, "failed");
    assert.equal(summary.audio.state, "ready");
  },
);

test(
  "one deadline covers the full read, and a frame has a size limit",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const video = await sourceOf(media, "budget", patternVideo(root));
    let clock = 0;
    const slow = new TimelineOverview(media, previews, {
      now: () => (clock += 1000),
      totalSeconds: 2.5,
    });
    const late = await slow.prepare(video);
    assert.equal(late.frames.state, "failed");
    assert.match(late.frames.error, /too long/i);
    assert.equal(late.frames.count, 0, "No seek after the deadline.");

    const small = new TimelineOverview(media, previews, { maxFrameBytes: 10 });
    const result = await small.prepare(video);
    assert.equal(result.frames.state, "failed");
    assert.equal(result.frames.count, 0);
  },
);

test(
  "a cancel during the cache write leaves no cache and no temporary file",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const video = await sourceOf(media, "publish", patternVideo(root));
    const controller = new AbortController();
    let calls = 0;
    // The second path request is the start of the cache write.
    const watched = {
      directory: (id) => {
        if (++calls === 2) controller.abort();
        return previews.directory(id);
      },
    };
    await assert.rejects(
      new TimelineOverview(media, watched).prepare(video, {
        signal: controller.signal,
      }),
      /abort/i,
    );
    const files = await readdir(previews.directory("publish")).catch(() => []);
    assert.deepEqual(files, []);
  },
);

test(
  "a damaged cache file reads the source again",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const overview = new TimelineOverview(media, previews);
    const video = await sourceOf(media, "damaged", patternVideo(root));
    const good = await overview.prepare(video);
    const file = path.join(
      previews.directory("damaged"),
      `overview-${good.identity}.json`,
    );
    for (const bad of [
      '{"version":1,"ident',
      "null",
      JSON.stringify({ version: 1, identity: good.identity }),
      JSON.stringify({ version: 999, identity: good.identity }),
      JSON.stringify({
        version: 1,
        identity: good.identity,
        audio: { state: "ready" },
        frames: { state: "ready", items: [{ seconds: "x" }] },
      }),
    ]) {
      await writeFile(file, bad);
      const again = await overview.prepare(video);
      assert.equal(again.cached, false, bad);
      assert.equal(again.audio.state, "ready");
      assert.equal(again.frames.count, 12);
      assert.equal((await overview.prepare(video)).cached, true);
    }
  },
);

test(
  "cancel stops the read and a time limit keeps frames from the full video",
  { timeout: 120000 },
  async () => {
    const root = await workspace();
    const media = new Media();
    const previews = new PreviewCache(root, media);
    const video = await sourceOf(media, "limit", patternVideo(root));

    const controller = new AbortController();
    const running = new TimelineOverview(media, previews).prepare(video, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(running, /abort/i);
    const files = await readdir(previews.directory("limit")).catch(() => []);
    assert.deepEqual(
      files.filter((f) => f.startsWith("overview-")),
      [],
      "A cancelled read leaves no cache.",
    );

    // A time limit of about two frames: the first frames are spread out.
    let clock = 0;
    const limited = new TimelineOverview(media, previews, {
      now: () => (clock += 1000),
      frameSeconds: 2.5,
    });
    const summary = await limited.prepare(video);
    assert.equal(summary.frames.state, "partial");
    assert.ok(summary.frames.count >= 1 && summary.frames.count < 12);
    assert.equal(
      summary.audio.state,
      "ready",
      "The sound does not use this limit.",
    );
  },
);
