// A split changes no output. Real FFmpeg renders of the same edits, with and
// without marks, have the same decoded frames and sound. The marks are off the
// frame grid, and the speed is fractional.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media } from "../src/adapters/media.js";
import { PreviewCache } from "../src/adapters/preview.js";
import {
  addSplit,
  configure,
  createTimeline,
  cut,
  duration,
  isEdited,
  splitsOf,
  withElements,
} from "../src/domain/timeline.js";
import {
  editRevision,
  structureRevision,
  timingRevision,
} from "../src/domain/inspection.js";
import { addCue } from "../src/domain/captions.js";
import { buildCues } from "../src/domain/captions.js";
import { readTranscript } from "../src/domain/transcript.js";
import { overviewIdentity } from "../src/domain/overview.js";

async function workspace(prefix) {
  await mkdir(".local/loom-next/media", { recursive: true });
  return mkdtemp(path.resolve(".local/loom-next/media", prefix));
}
// Moving picture and a tone, so a wrong frame or sample changes the hash.
function source(root) {
  const file = path.join(root, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=48000:duration=4",
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
const hashes = (file, stream) =>
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-map", stream, "-f", "framemd5", "-"],
    { maxBuffer: 16 * 1024 * 1024 },
  )
    .toString()
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));

const element = {
  id: "label",
  type: "text",
  text: "Label",
  sourceStart: 0.2,
  sourceEnd: 2.4,
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.2,
  font: "sans",
  bold: false,
  size: 0.08,
  color: "#FFFFFF",
  align: "left",
  verticalAlign: "top",
  background: "none",
  backgroundOpacity: 0.75,
  outline: "#000000",
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
};

test(
  "a real render with marks has the same frames and sound",
  { timeout: 120000 },
  async () => {
    const root = await workspace("split-render-");
    const file = source(root);
    const media = new Media();
    const metadata = await media.probe(file);
    // Kept source: 0 to 1 and 1.5 to the end, at 1.25x, with a label and a
    // caption. Cuts and speed make non-round edited times.
    const edited = addCue(
      withElements(
        configure(cut(createTimeline(metadata.duration), 1, 1.5), {
          speed: 1.25,
        }),
        [element],
      ),
      metadata.duration,
      "cue",
      { text: "Caption", start: 0.1, end: 1.3 },
    );
    // Marks off the 30 fps grid and with more digits than microseconds.
    let marked = edited;
    for (const seconds of [0.4166667, 1.2345678, 2.1111111])
      marked = addSplit(marked, seconds);
    assert.equal(splitsOf(marked).length, 3);

    const render = async (timeline, name) => {
      const output = path.join(root, name);
      await media.export({ path: file, metadata, timeline }, output);
      return output;
    };
    const plain = await render(edited, "plain.mp4");
    const split = await render(marked, "split.mp4");
    assert.deepEqual(hashes(split, "0:v:0"), hashes(plain, "0:v:0"));
    assert.deepEqual(hashes(split, "0:a:0"), hashes(plain, "0:a:0"));
    assert.deepEqual(
      (await media.probe(split)).duration,
      (await media.probe(plain)).duration,
    );
  },
);

test("a split has the same preview file and the same revisions", async () => {
  const timeline = configure(createTimeline(4), { speed: 1.5 });
  const marked = addSplit(timeline, 1.0000001);
  const video = (value) => ({
    id: "v",
    path: "C:/media/source.mp4",
    metadata: { duration: 4 },
    timeline: value,
  });
  assert.equal(editRevision(video(marked)), editRevision(video(timeline)));
  assert.equal(timingRevision(video(marked)), timingRevision(video(timeline)));
  assert.notEqual(
    structureRevision(video(marked)),
    structureRevision(video(timeline)),
  );
  assert.equal(duration(marked), duration(timeline));

  const root = await workspace("split-preview-");
  const cache = new PreviewCache(root, {
    export: async () => ({ metadata: {} }),
  });
  const first = await cache.prepare(video(timeline));
  const second = await cache.prepare(video(marked));
  assert.equal(second.path, first.path, "The same preview file.");
});

test("a split-only video still plays the source file", () => {
  assert.equal(isEdited(addSplit(createTimeline(4), 2), 4), false);
});

test("a split does not change transcript or caption output", () => {
  const words = [
    { word: " across", start: 1, end: 3, probability: 0.9, segmentId: 0 },
    { word: " after", start: 3.1, end: 3.6, probability: 0.9, segmentId: 0 },
  ];
  const data = { words, duration: 4 };
  const timeline = createTimeline(4);
  const marked = addSplit(timeline, 2);
  assert.deepEqual(
    readTranscript(data, marked, { detail: "words" }),
    readTranscript(data, timeline, { detail: "words" }),
    "No repeated word at the mark.",
  );
  assert.deepEqual(buildCues(words, marked), buildCues(words, timeline));
});

test("the overview of a source does not read marks", () => {
  const video = (timeline) => ({
    id: "v",
    path: "C:/media/source.mp4",
    metadata: { duration: 4 },
    timeline,
  });
  const file = { size: 1, mtimeMs: 2 };
  assert.equal(
    overviewIdentity(video(addSplit(createTimeline(4), 2)), file),
    overviewIdentity(video(createTimeline(4)), file),
  );
});

test("the source file does not change after a real split render", async () => {
  const root = await workspace("split-source-");
  const file = source(root);
  const before = await readFile(file);
  const media = new Media();
  const metadata = await media.probe(file);
  await media.export(
    {
      path: file,
      metadata,
      timeline: addSplit(createTimeline(metadata.duration), 1.5),
    },
    path.join(root, "out.mp4"),
  );
  assert.deepEqual(await readFile(file), before);
});
