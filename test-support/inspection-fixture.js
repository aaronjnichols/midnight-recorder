import path from "node:path";
import { run } from "../src/adapters/media.js";

export async function createInspectionSource(root) {
  const file = path.join(root, "settings-demo.mp4");
  const font =
    process.platform === "win32"
      ? "fontfile='C\\:/Windows/Fonts/arial.ttf':"
      : "";
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x1e2127:s=960x540:r=30:d=6",
    "-vf",
    [
      "drawbox=x=40:y=40:w=880:h=60:color=0x434c5e:t=fill",
      `drawtext=${font}text='Example settings':x=65:y=55:fontsize=30:fontcolor=white`,
      "drawbox=x=120:y=330:w=160:h=70:color=0x88c0d0:t=fill:enable='lt(t,3)'",
      `drawtext=${font}text='Save':x=160:y=350:fontsize=28:fontcolor=black:enable='lt(t,3)'`,
      "drawbox=x=680:y=330:w=160:h=70:color=0xa3be8c:t=fill:enable='gte(t,3)'",
      `drawtext=${font}text='Save':x=720:y=350:fontsize=28:fontcolor=black:enable='gte(t,3)'`,
    ].join(","),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}
