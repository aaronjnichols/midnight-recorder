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
import { captionPlan } from "../domain/captions.js";
import { duration, videoFades } from "../domain/timeline.js";

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

const enable = (op) =>
  `enable='gte(t,${seconds(op.start - EDGE)})*lt(t,${seconds(op.end - EDGE)})'`;
const decimal = (value) => String(Math.round(value * 10000) / 10000);
const rgb = (hex) =>
  [1, 3, 5]
    .map((i) => decimal(parseInt(hex.slice(i, i + 2), 16) / 255))
    .join(" ");

// A drawvg (vector graphics) script for a shape or an arrow. It contains only
// numbers and fixed commands. A rectangle or ellipse line is inside its box.
// The script draws the element at full opacity with its own style alphas
// (fillOpacity). Element opacity and fades apply later to the whole element.
export function shapeScript(op) {
  const alpha = decimal;
  const lines = [];
  if (op.type === "arrow") {
    if (!op.points.length) return "";
    const outline = `M ${op.points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
    if (op.outlineWidth)
      lines.push(
        "setlinejoin round",
        `setrgba ${rgb(op.outline)} 1`,
        `setlinewidth ${op.outlineWidth * 2}`,
        outline,
        "stroke",
      );
    lines.push(`setrgba ${rgb(op.color)} 1`, outline, "fill");
  } else {
    const draw = (inset) =>
      op.type === "rectangle"
        ? `rect ${decimal(op.x + inset)} ${decimal(op.y + inset)} ${decimal(op.width - 2 * inset)} ${decimal(op.height - 2 * inset)}`
        : `ellipse ${decimal(op.x + op.width / 2)} ${decimal(op.y + op.height / 2)} ${decimal(op.width / 2 - inset)} ${decimal(op.height / 2 - inset)}`;
    if (op.fill !== "none")
      lines.push(
        `setrgba ${rgb(op.fill)} ${alpha(op.fillOpacity)}`,
        draw(0),
        "fill",
      );
    // A line that is at least half of the smaller side covers the whole
    // shape. Fill the shape with the line color. An inset path would have
    // no size, which Cairo rejects.
    if (op.strokeWidth && Math.min(op.width, op.height) <= 2 * op.strokeWidth)
      lines.push(`setrgba ${rgb(op.stroke)} 1`, draw(0), "fill");
    else if (op.strokeWidth)
      lines.push(
        `setrgba ${rgb(op.stroke)} 1`,
        `setlinewidth ${op.strokeWidth}`,
        draw(op.strokeWidth / 2),
        "stroke",
      );
  }
  return lines.join("\n") + "\n";
}

// drawtext options for a text element. colors gives the text, box, and
// outline colors, so the same geometry can draw a color pass and a mask.
// name gives the filter an instance name, for runtime commands.
function textOptions(op, files, colors, name = "drawtext") {
  const align = { left: "L", center: "C", right: "R" }[op.align];
  const valign = { top: "T", middle: "M", bottom: "B" }[op.verticalAlign];
  const options = [
    `fontfile=${files.font}`,
    `textfile=${files.text}`,
    "expansion=none",
    `fontsize=${op.fontSize}`,
    `fontcolor=${colors.text}`,
    // The box with its border is exactly the element box. The border width
    // is the padding around the inner text box.
    `x=${op.x + op.padding}`,
    `y=${op.y + op.padding}`,
    `boxw=${op.width - 2 * op.padding}`,
    `boxh=${op.height - 2 * op.padding}`,
    "box=1",
    `boxborderw=${op.padding}`,
    `boxcolor=${colors.box}`,
    `text_align=${align}+${valign}`,
  ];
  if (op.outlineWidth)
    options.push(`borderw=${op.outlineWidth}`, `bordercolor=${colors.outline}`);
  return `${name}=${options.join(":")}`;
}

// Captions use one drawtext filter for all cues, not one drawtext filter for
// each cue. A sendcmd script sets the text of this filter and turns it on
// when a cue starts, and turns it off when the cue ends. sendcmd compares
// each frame time with the time range of each cue, which is small work. sendcmd sends a command when the frame time (rounded to the
// microsecond) is in [start, end). Cue times have microsecond precision, so
// this is the same [start, end) rule as the enable expression of elements.
const CAPTION_FILTER = "drawtext@captions";
const isAlphanumeric = (byte) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a);
const microseconds = (value) => {
  const us = Math.round(value * 1e6);
  return `${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, "0")}`;
};

// The sendcmd script for the cues, as bytes. In the text, each byte that is
// not an ASCII letter or digit has a backslash before it. sendcmd reads an
// argument with av_get_token, which copies an escaped byte as it is. So no
// byte of the text can end the argument, start a command, or be a comment,
// and UTF-8 text stays the same bytes. The text option is a plain string,
// and expansion is off, so drawtext shows the text as written.
export function captionScript(cues) {
  const bytes = [];
  const add = (text) => bytes.push(...Buffer.from(text, "latin1"));
  for (const cue of cues) {
    add(
      `${microseconds(cue.start)}-${microseconds(cue.end)} [enter] ${CAPTION_FILTER} text `,
    );
    for (const byte of Buffer.from(cue.text, "utf8")) {
      if (!isAlphanumeric(byte)) bytes.push(0x5c);
      bytes.push(byte);
    }
    add(`, ${CAPTION_FILTER} enable 1, [leave] ${CAPTION_FILTER} enable 0;\n`);
  }
  return Buffer.from(bytes);
}

// The caption filters, with their files in the work folder: the script, a
// text file with one space for the start, and the font.
async function captionFilters(plan, work, fonts) {
  const source = await fontFile(fonts, plan.font, plan.bold);
  const font = `caption-font${path.extname(source).toLowerCase()}`;
  await copyFile(source, path.join(work, font));
  await writeFile(path.join(work, "caption-start.txt"), " ", "utf8");
  await writeFile(path.join(work, "captions.cmd"), captionScript(plan.cues));
  const box = plan.background !== "none";
  return [
    "sendcmd=f=captions.cmd",
    `${textOptions(
      plan,
      { font, text: "caption-start.txt" },
      {
        text: ffColor(plan.color, 1),
        box: box
          ? ffColor(plan.background, plan.backgroundOpacity)
          : "0x000000@0",
        outline: ffColor(plan.outline === "none" ? "#000000" : plan.outline, 1),
      },
      CAPTION_FILTER,
    )}:enable=0`,
  ];
}

// The output frames that show an element: n from first to last - 1, where
// n / 30 is in [start, end).
const frameRange = (op) => {
  const first = Math.ceil((op.start - EDGE) * FRAME_RATE);
  return { first, count: Math.ceil((op.end - EDGE) * FRAME_RATE) - first };
};

// Write each text to its own UTF-8 file, each shape to its own script file,
// and copy each font file into the work folder. The filter graph contains
// only generated file names and numbers. User text and file paths never
// become filter syntax.
//
// Returns steps in layer order, bottom first. A step is a filter on the
// video, or a layer to put over the video. An element at full opacity
// without fades draws directly on the video. An element with opacity or
// fades draws at full opacity on its own transparent layer, and the
// opacity and fades then apply once to the whole layer. So overlapping
// parts of one element, for example a line over its fill or a letter over
// its box, do not get brighter.
async function overlayFilters(plan, work, fonts, frame) {
  const copied = new Map();
  const steps = [];
  for (const [index, op] of plan.entries()) {
    const direct = op.opacity >= 1 && !op.fadeIn && !op.fadeOut;
    const { first, count } = frameRange(op);
    if (count <= 0) continue;
    // A transparent or colored canvas for the element frames only, on the
    // same 30 fps clock as the video.
    const canvas = (color, format) =>
      `color=c=${color}:s=${frame.width}x${frame.height}:r=${FRAME_RATE}:d=${(count + 1) / FRAME_RATE},trim=end_frame=${count},setpts=PTS+${first},format=${format}`;
    const finish = [];
    if (op.opacity < 1)
      finish.push(`colorchannelmixer=aa=${decimal(op.opacity)}`);
    if (op.fadeIn)
      finish.push(
        `fade=t=in:st=${seconds(op.start)}:d=${seconds(op.fadeIn)}:alpha=1`,
      );
    if (op.fadeOut)
      finish.push(
        `fade=t=out:st=${seconds(op.end - op.fadeOut)}:d=${seconds(op.fadeOut)}:alpha=1`,
      );
    if (op.type !== "text") {
      const script = shapeScript(op);
      if (!script) continue;
      const name = `shape-${index}.vgs`;
      await writeFile(path.join(work, name), script, "utf8");
      if (direct) steps.push({ filter: `drawvg=file=${name}:${enable(op)}` });
      else
        steps.push({
          // drawvg (Cairo) writes premultiplied color on a transparent
          // canvas. unpremultiply gives straight alpha for the next filters
          // and for overlay.
          layer: [
            canvas("black@0", "rgba"),
            `drawvg=file=${name}`,
            "unpremultiply=inplace=1",
            ...finish,
          ].join(","),
        });
      continue;
    }
    const key = `${op.font}-${op.bold ? "bold" : "regular"}`;
    if (!copied.has(key)) {
      const source = await fontFile(fonts, op.font, op.bold);
      const name = `font-${copied.size}${path.extname(source).toLowerCase()}`;
      await copyFile(source, path.join(work, name));
      copied.set(key, name);
    }
    const files = { font: copied.get(key), text: `text-${index}.txt` };
    await writeFile(path.join(work, files.text), op.text, "utf8");
    const box = op.background !== "none";
    if (direct) {
      steps.push({
        filter: `${textOptions(op, files, {
          text: ffColor(op.color, 1),
          box: box
            ? ffColor(op.background, op.backgroundOpacity)
            : "0x000000@0",
          outline: ffColor(op.outline === "none" ? "#000000" : op.outline, 1),
        })}:${enable(op)}`,
      });
      continue;
    }
    // Text on a layer has two passes. The color pass draws the box and the
    // letters fully opaque. The mask pass draws the same shapes in white,
    // with the box at its background opacity. alphamerge makes the layer.
    const base = box ? op.background : op.color;
    const color = `${canvas(`0x${base.slice(1)}`, "rgb24")},${textOptions(
      op,
      files,
      {
        text: ffColor(op.color, 1),
        box: ffColor(base, box ? 1 : 0),
        outline: ffColor(op.outline === "none" ? "#000000" : op.outline, 1),
      },
    )}[tc${index}]`;
    const mask = `${canvas("black", "gray")},${textOptions(op, files, {
      text: "0xFFFFFF@1",
      box: box ? `0xFFFFFF@${op.backgroundOpacity}` : "0xFFFFFF@0",
      outline: "0xFFFFFF@1",
    })}[tm${index}]`;
    steps.push({
      layer: `${color};${mask};[tc${index}][tm${index}]alphamerge${finish.map((f) => `,${f}`).join("")}`,
    });
  }
  return steps;
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
export function audioClock(segments, speed, sampleRate, fades = []) {
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
    `${labels.join("")}concat=n=${labels.length}:v=0:a=1${speed === 1 ? "" : `,atempo=${speed}`},apad=whole_len=${total},atrim=end_sample=${total}${fades.map((f) => `,${f}`).join("")}[a]`,
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
    // Shown caption cues and their style, or null.
    const captions = captionPlan(video.timeline, info.frame);
    const total = duration(video.timeline);
    // Video fades from black and to black come after the elements, so the
    // elements fade with the picture. The sound fades at the same times.
    const fades = videoFades(video.timeline);
    const fade = (kind, filter) => {
      const list = [];
      if (fades.actualFadeIn > 0)
        list.push(`${filter}=t=in:st=0:d=${seconds(fades.actualFadeIn)}`);
      if (fades.actualFadeOut > 0)
        list.push(
          `${filter}=t=out:st=${seconds(Math.max(0, total - fades.actualFadeOut))}:d=${seconds(fades.actualFadeOut)}`,
        );
      return list;
    };
    const decorated =
      plan.length > 0 || captions !== null || fade("v", "fade").length > 0;
    const filters = [
      `[0:v]${videoClock(segments, speed, total)}[${decorated ? "base" : "v"}]`,
    ];
    if (video.metadata.hasAudio && !muted && !info.sampleRate)
      throw new Error("Cannot read the audio sample rate.");
    const sound =
      video.metadata.hasAudio && !muted
        ? audioClock(segments, speed, info.sampleRate, fade("a", "afade"))
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
      if (decorated) {
        // Direct filters run on the video in order. Each layer closes the
        // current chain and goes over it with overlay.
        let label = "base",
          chain = [],
          count = 0;
        for (const step of await overlayFilters(
          plan,
          work,
          this.fonts,
          info.frame,
        )) {
          if (step.filter) {
            chain.push(step.filter);
            continue;
          }
          const under = `s${count++}`;
          filters.push(`[${label}]${chain.join(",") || "null"}[${under}]`);
          const layer = `l${count}`;
          filters.push(`${step.layer}[${layer}]`);
          label = `s${count++}`;
          filters.push(
            `[${under}][${layer}]overlay=eof_action=pass:format=auto[${label}]`,
          );
          chain = [];
        }
        // Captions are over all elements. The video fades come after, so
        // the captions fade with the picture.
        if (captions)
          chain.push(...(await captionFilters(captions, work, this.fonts)));
        chain.push(...fade("v", "fade"));
        filters.push(`[${label}]${chain.join(",") || "null"}[v]`);
      }
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
