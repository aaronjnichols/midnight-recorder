import { execFileSync } from "node:child_process";

// Decode one RGB frame at an output time. Output seeking decodes from the
// start, so the selected frame is exact for short test files.
export function frameAt(file, seconds, width, height) {
  const data = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-ss",
      String(seconds),
      "-frames:v",
      "1",
      "-vf",
      "format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (data.length !== width * height * 3)
    throw new Error(`Unexpected frame size ${data.length} at ${seconds}s.`);
  return {
    width,
    height,
    data,
    at(x, y) {
      const i = (y * width + x) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

// Count pixels that match a color test and give their bounds and center.
export function region(frame, match, area) {
  const {
    left = 0,
    top = 0,
    right = frame.width,
    bottom = frame.height,
  } = area || {};
  let count = 0,
    minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1,
    sumX = 0,
    sumY = 0;
  const rows = new Set();
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      if (!match(frame.at(x, y))) continue;
      count++;
      sumX += x;
      sumY += y;
      rows.add(y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return {
    count,
    minX,
    minY,
    maxX,
    maxY,
    centerX: count ? sumX / count : NaN,
    centerY: count ? sumY / count : NaN,
    rows: [...rows].sort((a, b) => a - b),
  };
}

// Groups of rows with matching pixels, separated by empty rows.
export function bands(rows) {
  const result = [];
  for (const y of rows) {
    const last = result.at(-1);
    if (last && y === last.end + 1) last.end = y;
    else result.push({ start: y, end: y });
  }
  return result;
}

// Exact presentation times of all video frames in a file, from integer
// timestamps and the stream time base.
export function frameTimes(file) {
  const info = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base:frame=best_effort_timestamp",
        "-show_frames",
        "-of",
        "json",
        file,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const [numerator, denominator] = info.streams[0].time_base
    .split("/")
    .map(Number);
  return info.frames.map(
    (f) => (Number(f.best_effort_timestamp) * numerator) / denominator,
  );
}

// All decoded frames as gray bytes, without frame rate conversion.
export function grayFrames(file, width, height) {
  const data = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-vf",
      "format=gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const size = width * height;
  const frames = [];
  for (let i = 0; i + size <= data.length; i += size)
    frames.push(data.subarray(i, i + size));
  return frames;
}

// Mean gray value of a rectangle in a gray frame.
export function mean(frame, width, left, top, right, bottom) {
  let sum = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) sum += frame[y * width + x];
  return sum / ((right - left) * (bottom - top));
}

export const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
export const isWhite = ([r, g, b]) => r > 190 && g > 190 && b > 190;
