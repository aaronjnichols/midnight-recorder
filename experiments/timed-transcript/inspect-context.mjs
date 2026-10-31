import path from "node:path";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { mapWords, readWindow, findPhrase } from "./context.mjs";
import { Media, run } from "../../src/adapters/media.js";
import { Library } from "../../src/adapters/library.js";
import { PreviewCache } from "../../src/adapters/preview.js";
import { FrameInspection } from "../../src/adapters/inspection.js";
import { Service } from "../../src/application/service.js";

const root = path.resolve(".local/transcript-practice");
const regional = process.argv.includes("--regional");
const variant = regional ? "regions" : "words";
const sourceTranscript = JSON.parse(
  await readFile(path.join(root, `clean-${variant}.json`), "utf8"),
);
const { video, edited } = JSON.parse(
  await readFile(path.join(root, "video.json"), "utf8"),
);
const sourceWords = sourceTranscript.segments.flatMap((s) => s.words);
const words = mapWords(sourceWords, edited.timeline);
const hits = findPhrase(words, "save button", 2);
const direct = JSON.parse(
  await readFile(path.join(root, `edited-${variant}.json`), "utf8"),
);
const directHits = findPhrase(
  direct.segments.flatMap((s) => s.words),
  "save button",
  2,
);
const media = new Media();
const previews = new PreviewCache(path.join(root, "data"), media);
const service = new Service({
  library: new Library(path.join(root, "data")),
  media,
  previews,
  inspection: new FrameInspection(media, previews),
});
const timestamps = hits.map((hit) => (hit.start + hit.end) / 2);
const job = await service.execute("inspect.start", {
  id: video.id,
  timestamps,
  grid: true,
});
let state;
for (let i = 0; i < 600; i++) {
  state = await service.execute("export.status", { jobId: job.id });
  if (state.state !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (state.state !== "complete")
  throw new Error(state.error || "Inspection did not finish.");
const frames = await service.execute("inspect.result", {
  jobId: job.id,
  includeImages: false,
});
for (const [i, frame] of frames.frames.entries()) {
  frame.savedImage = path.join(root, `speech-${variant}-context-${i + 1}.png`);
  await copyFile(frame.path, frame.savedImage);
}
const noAudio = path.join(root, "no-audio.mp4");
await run("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  video.path,
  "-c:v",
  "copy",
  "-an",
  noAudio,
]);
const noAudioMetadata = await media.probe(noAudio);
const report = {
  transcriptVariant: variant,
  sourceTimeBasis: "Original audio seconds",
  editedTimeBasis: "Edited video seconds",
  videoId: video.id,
  revision: frames.revision,
  sourceDuration: sourceTranscript.duration,
  editedDuration: frames.duration,
  hits,
  directHits,
  frames,
  window: readWindow(words, 16, 21),
  partialWords: words.filter((w) => w.partial),
  noAudioStatus: noAudioMetadata.hasAudio ? "audio_present" : "no_audio",
  payloadBytes: {
    fullWords: JSON.stringify(words).length,
    window: JSON.stringify(readWindow(words, 16, 21)).length,
  },
};
await writeFile(
  path.join(root, `context-${variant}-report.json`),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      hits: hits.map((h) => ({
        start: h.start,
        end: h.end,
        context: h.context.map((w) => w.word.trim()).join(" "),
      })),
      directHits: directHits.map((h) => ({ start: h.start, end: h.end })),
      partialWords: report.partialWords,
      frames: frames.frames.map((f) => f.savedImage),
      payloadBytes: report.payloadBytes,
      noAudioStatus: report.noAudioStatus,
    },
    null,
    2,
  ),
);
