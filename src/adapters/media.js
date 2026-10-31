import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  mkdir,
  mkdtemp,
  stat,
  copyFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { elementsOf, renderPlan } from "../domain/elements.js";
import { duration } from "../domain/timeline.js";

export function run(executable, args, { signal, cwd } = {}) {
  // A configured path with a folder, such as tools/ffmpeg.exe, is relative
  // to this process folder, also when FFmpeg runs in another folder. A plain
  // name, such as ffmpeg, is found on PATH.
  const command =
    cwd && /[\\/]/.test(executable) ? path.resolve(executable) : executable;
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      windowsHide: true,
      signal,
      cwd,
    });
    let output = "",
      error = "";
    process.stdout.on("data", (chunk) => {
      output += chunk;
    });
    process.stderr.on("data", (chunk) => {
      error = (error + chunk).slice(-12000);
    });
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(error || `${executable} exited with code ${code}.`)),
    );
  });
}

// Font files for each family, regular then bold. The first file that exists
// is used. Each font covers a fixed character set. There is no fallback.
const windowsFonts = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
export const FONT_FILES = {
  sans: [
    [
      path.join(windowsFonts, "segoeui.ttf"),
      path.join(windowsFonts, "segoeuib.ttf"),
    ],
    [
      path.join(windowsFonts, "arial.ttf"),
      path.join(windowsFonts, "arialbd.ttf"),
    ],
    [
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
  ],
  serif: [
    [
      path.join(windowsFonts, "georgia.ttf"),
      path.join(windowsFonts, "georgiab.ttf"),
    ],
    [
      path.join(windowsFonts, "times.ttf"),
      path.join(windowsFonts, "timesbd.ttf"),
    ],
    [
      "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
    ],
  ],
  mono: [
    [
      path.join(windowsFonts, "consola.ttf"),
      path.join(windowsFonts, "consolab.ttf"),
    ],
    [
      path.join(windowsFonts, "cour.ttf"),
      path.join(windowsFonts, "courbd.ttf"),
    ],
    [
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    ],
  ],
};

async function fontFile(fonts, family, bold) {
  for (const pair of fonts[family] || []) {
    const file = pair[bold ? 1 : 0];
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  throw new Error(`No font file was found for the ${family} font.`);
}

const ffColor = (hex, alpha) => `0x${hex.slice(1)}@${alpha}`;
const seconds = (value) => value.toFixed(7);
// Frames with a time in [start, end) show the element. Elements are drawn on
// the final output clock, so frame n is at n / 30 seconds. Element times
// have microsecond precision. An offset of half a microsecond compares the
// frame time at microsecond precision and absorbs floating-point error.
const EDGE = 0.0000005;

// Write each text to its own UTF-8 file and copy each font file into the
// work folder. The filter graph contains only generated file names and
// numbers. User text and file paths never become filter syntax.
async function overlayFilters(plan, work, fonts) {
  const copied = new Map();
  const filters = [];
  for (const [index, op] of plan.entries()) {
    const key = `${op.font}-${op.bold ? "bold" : "regular"}`;
    if (!copied.has(key)) {
      const source = await fontFile(fonts, op.font, op.bold);
      const name = `font-${copied.size}${path.extname(source).toLowerCase()}`;
      await copyFile(source, path.join(work, name));
      copied.set(key, name);
    }
    const textName = `text-${index}.txt`;
    await writeFile(path.join(work, textName), op.text, "utf8");
    const align = { left: "L", center: "C", right: "R" }[op.align];
    const valign = { top: "T", middle: "M", bottom: "B" }[op.verticalAlign];
    const options = [
      `fontfile=${copied.get(key)}`,
      `textfile=${textName}`,
      "expansion=none",
      `fontsize=${op.fontSize}`,
      `fontcolor=${ffColor(op.color, op.opacity)}`,
      // The box with its border is exactly the element box. The border
      // width is the padding around the inner text box.
      `x=${op.x + op.padding}`,
      `y=${op.y + op.padding}`,
      `boxw=${op.width - 2 * op.padding}`,
      `boxh=${op.height - 2 * op.padding}`,
      "box=1",
      `boxborderw=${op.padding}`,
      `boxcolor=${
        op.background === "none"
          ? "0x000000@0"
          : ffColor(op.background, op.backgroundOpacity)
      }`,
      `text_align=${align}+${valign}`,
    ];
    if (op.outlineWidth)
      options.push(
        `borderw=${op.outlineWidth}`,
        `bordercolor=${ffColor(op.outline, op.opacity)}`,
      );
    options.push(
      `enable='gte(t,${seconds(op.start - EDGE)})*lt(t,${seconds(op.end - EDGE)})'`,
    );
    filters.push(`drawtext=${options.join(":")}`);
  }
  return filters;
}

// Output clock. The exported video has 30 frames per second from edited time
// 0. Frame n is at exactly n / 30 seconds. There are ceil(duration x 30)
// frames, so the last frame starts before the edited end. Frame n shows the
// source frame that is on screen at sourceTime(n / 30). Elements are drawn
// after this filter, on the same frames that the MP4 contains.
export const FRAME_RATE = 30;
// Ticks per second for exact edited times. Source frames on the 30 fps grid
// are whole numbers of ticks (1 frame = 1,000,000 ticks).
const TICKS = 30000000;
// A frame less than 1 microsecond after an output frame time counts as at
// that time. The domain uses the same tolerance at cut boundaries.
const NEAR = TICKS / 1000000;
const term = (value) => (value < 0 ? `-${-value}` : `+${value}`);

export function videoClock(segments, speed, total) {
  const frames = Math.max(1, Math.ceil(total * FRAME_RATE - 1e-6));
  const select = [],
    timing = [];
  let elapsed = 0,
    previous;
  for (const segment of segments) {
    const start = segment.start * TICKS,
      end = segment.end * TICKS;
    // A source frame belongs to the first segment that ends after it.
    const range =
      previous === undefined
        ? `lt(PTS,${end})`
        : `gte(PTS,${previous})*lt(PTS,${end})`;
    // Keep each source frame that is on screen during the segment. This
    // includes the frame that started before the segment start.
    select.push(`${range}*gt(PTS,${start - 1000000})`);
    // Edited time of the frame. A frame from before the segment start is
    // at the segment start.
    timing.push(
      `${range}*((max(PTS,${start})${term(elapsed * TICKS - start)})/${speed})`,
    );
    elapsed += segment.end - segment.start;
    previous = end;
  }
  // The end of the input maps to the edited end.
  timing.push(`gte(PTS,${previous})*${(elapsed * TICKS) / speed}`);
  return [
    `fps=${FRAME_RATE}`,
    `settb=1/${TICKS}`,
    // The select filter names the timestamp pts. The setpts filter names it PTS.
    `select='${select.join("+").replaceAll("PTS", "pts")}'`,
    `setpts='max(0,${timing.join("+")}-${NEAR})'`,
    // Each output frame shows the last source frame at or before its time.
    `fps=${FRAME_RATE}:start_time=0:round=up`,
    // Hold the last frame if the video track ends before the edited end.
    "tpad=stop_mode=clone:stop=-1",
    `trim=end_frame=${frames}`,
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "setsar=1",
  ].join(",");
}

// Audio on the same edited clock. Each segment gets an exact number of
// samples from its exact start in the joined source time, so small rounding
// differences do not add up over many cuts. One speed change then applies
// to the joined audio, and the result has exactly round(duration x rate)
// samples. A segment shorter than one sample adds nothing.
export function audioClock(segments, speed, sampleRate) {
  const filters = [],
    labels = [];
  let elapsed = 0;
  for (const s of segments) {
    const first = Math.round(elapsed * sampleRate);
    elapsed += s.end - s.start;
    const samples = Math.round(elapsed * sampleRate) - first;
    if (samples <= 0) continue;
    labels.push(`[a${labels.length}]`);
    // Fill gaps on the source clock before trimming each segment.
    filters.push(
      `[0:a]aresample=async=1:first_pts=0,apad,atrim=start=${s.start}:end=${s.end},asetpts=PTS-${s.start}/TB,apad=whole_len=${samples},atrim=end_sample=${samples}${labels.at(-1)}`,
    );
  }
  if (!labels.length) return [];
  const total = Math.round((elapsed / speed) * sampleRate);
  filters.push(
    `${labels.join("")}concat=n=${labels.length}:v=0:a=1${speed === 1 ? "" : `,atempo=${speed}`},apad=whole_len=${total},atrim=end_sample=${total}[a]`,
  );
  return filters;
}

export class Media {
  constructor({
    ffmpeg = "ffmpeg",
    ffprobe = "ffprobe",
    fonts = FONT_FILES,
  } = {}) {
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.fonts = fonts;
  }
  // Size of the rendered frame: the displayed size after rotation, made even
  // in the same way as the export scale filter.
  async frameSize(file) {
    return (await this.renderInfo(file)).frame;
  }
  // The rendered frame size and the sample rate of the first audio stream.
  async renderInfo(file) {
    const info = JSON.parse(
      await run(this.ffprobe, [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        file,
      ]),
    );
    const stream = info.streams?.find((s) => s.codec_type === "video");
    if (!stream) throw new Error("The file has no video track.");
    const sampleRate = Number(
      info.streams.find((s) => s.codec_type === "audio")?.sample_rate,
    );
    const rotation = Number(
      stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        stream.tags?.rotate ??
        0,
    );
    // FFmpeg rounds the rotation to whole degrees (half away from zero). It
    // turns the frame only for 90 or 270 degrees. It rotates other angles
    // inside the same frame size.
    const degrees = Math.sign(rotation) * Math.round(Math.abs(rotation));
    const turned = ((degrees % 180) + 180) % 180 === 90;
    const width = turned ? stream.height : stream.width;
    const height = turned ? stream.width : stream.height;
    return {
      frame: {
        width: Math.floor(width / 2) * 2,
        height: Math.floor(height / 2) * 2,
      },
      sampleRate: sampleRate > 0 ? sampleRate : undefined,
    };
  }
  async extractAudio(video, output, { signal } = {}) {
    await run(
      this.ffmpeg,
      [
        "-v",
        "error",
        "-i",
        video.path,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        `aresample=async=1:first_pts=0,apad,atrim=end=${video.metadata.duration}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      { signal },
    );
  }
  async probe(file) {
    const info = JSON.parse(
      await run(this.ffprobe, [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ]),
    );
    const video = info.streams.find((s) => s.codec_type === "video");
    if (!video) throw new Error("The file has no video track.");
    let seconds = Number(info.format.duration || video.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      const scan = await run(this.ffmpeg, [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
        "-progress",
        "pipe:1",
      ]);
      const values = [...scan.matchAll(/out_time_us=(\d+)/g)];
      seconds = Number(values.at(-1)?.[1]) / 1e6;
    }
    if (!Number.isFinite(seconds) || seconds <= 0)
      throw new Error("Cannot read video duration.");
    return {
      duration: seconds,
      width: video.width,
      height: video.height,
      hasAudio: info.streams.some((s) => s.codec_type === "audio"),
    };
  }
  async export(video, output) {
    if (path.extname(output).toLowerCase() !== ".mp4")
      throw new Error("Export path must end with .mp4.");
    try {
      await stat(output);
      throw new Error("Export file already exists. Select a new path.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    const temporary = path.join(
      path.dirname(path.resolve(output)),
      `.midnight-${randomUUID()}.mp4`,
    );
    const { segments, speed, muted } = video.timeline;
    const source = path.resolve(video.path);
    const info = await this.renderInfo(source);
    // Edited-time drawing operations on the output clock.
    const plan = elementsOf(video.timeline).length
      ? renderPlan(video.timeline, info.frame)
      : [];
    const total = duration(video.timeline);
    const filters = [
      `[0:v]${videoClock(segments, speed, total)}[${plan.length ? "base" : "v"}]`,
    ];
    if (video.metadata.hasAudio && !muted && !info.sampleRate)
      throw new Error("Cannot read the audio sample rate.");
    const sound =
      video.metadata.hasAudio && !muted
        ? audioClock(segments, speed, info.sampleRate)
        : [];
    filters.push(...sound);
    const audio = sound.length > 0;
    // FFmpeg reads the filter graph from a file in the work folder. Many
    // cuts and elements make a graph that is too long for a Windows command
    // line.
    const args = [
      "-v",
      "error",
      "-n",
      "-i",
      source,
      "-/filter_complex",
      "graph.txt",
      "-map",
      "[v]",
    ];
    if (audio) args.push("-map", "[a]", "-c:a", "aac");
    // The filter graph makes the final 30 fps clock. The encoder keeps
    // these frame times without frame rate conversion.
    args.push(
      "-fps_mode",
      "passthrough",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      temporary,
    );
    // FFmpeg runs in a new work folder, so the filter graph can refer to
    // the graph, text, and font files by plain generated names.
    const work = await mkdtemp(path.join(os.tmpdir(), "midnight-render-"));
    try {
      if (plan.length)
        filters.push(
          `[base]${(await overlayFilters(plan, work, this.fonts)).join(",")}[v]`,
        );
      await writeFile(path.join(work, "graph.txt"), filters.join(";"), "utf8");
      await run(this.ffmpeg, args, { cwd: work });
      const metadata = await this.probe(temporary);
      await copyFile(temporary, output, constants.COPYFILE_EXCL);
      return { path: path.resolve(output), metadata };
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}
