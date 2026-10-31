import path from "node:path";
import { writeFile } from "node:fs/promises";
import { Media, run } from "../../src/adapters/media.js";
import { Library } from "../../src/adapters/library.js";
import { PreviewCache } from "../../src/adapters/preview.js";
import { FrameInspection } from "../../src/adapters/inspection.js";
import { Service } from "../../src/application/service.js";

const root = path.resolve(".local/transcript-practice");
const source = path.join(root, "narrated-settings.mp4");
const font =
  process.platform === "win32"
    ? "fontfile='C\\:/Windows/Fonts/arial.ttf':"
    : "";
await run("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "color=c=0x1e2127:s=960x540:r=30:d=54",
  "-i",
  path.join(root, "clean.wav"),
  "-vf",
  [
    "drawbox=x=40:y=40:w=880:h=60:color=0x434c5e:t=fill",
    `drawtext=${font}text='Example settings':x=65:y=55:fontsize=30:fontcolor=white`,
    "drawbox=x=120:y=330:w=160:h=70:color=0x88c0d0:t=fill:enable='lt(t,29)'",
    `drawtext=${font}text='Save':x=160:y=350:fontsize=28:fontcolor=black:enable='lt(t,29)'`,
    "drawbox=x=680:y=330:w=160:h=70:color=0xa3be8c:t=fill:enable='gte(t,29)'",
    `drawtext=${font}text='Save':x=720:y=350:fontsize=28:fontcolor=black:enable='gte(t,29)'`,
  ].join(","),
  "-c:v",
  "libx264",
  "-c:a",
  "aac",
  "-pix_fmt",
  "yuv420p",
  source,
]);
const media = new Media();
const previews = new PreviewCache(path.join(root, "data"), media);
const service = new Service({
  library: new Library(path.join(root, "data")),
  media,
  previews,
  inspection: new FrameInspection(media, previews),
});
const video = await service.execute("library.import", {
  path: source,
  title: "Timed transcript practice",
});
await service.execute("edit.cut", { id: video.id, start: 2, end: 5 });
const edited = await service.execute("edit.configure", {
  id: video.id,
  speed: 1.5,
});
const output = path.join(root, `edited-${video.id}.mp4`);
const job = await service.execute("export.start", {
  id: video.id,
  path: output,
});
let state;
for (let i = 0; i < 600; i++) {
  state = await service.execute("export.status", { jobId: job.id });
  if (state.state !== "running") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (state.state !== "complete")
  throw new Error(state.error || "Export did not finish.");
await run("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  output,
  "-vn",
  "-af",
  "aresample=async=1:first_pts=0",
  "-ar",
  "16000",
  "-ac",
  "1",
  path.join(root, "edited.wav"),
]);
await writeFile(
  path.join(root, "video.json"),
  JSON.stringify({ video, edited, output }, null, 2),
);
console.log(
  JSON.stringify({
    source,
    edited: output,
    duration: state.result.metadata.duration,
  }),
);
