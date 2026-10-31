import { execFileSync } from "node:child_process";
import path from "node:path";

export function createDelayedAudioSource(root) {
  const source = path.join(root, "source.mkv");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x120:rate=30:duration=3",
    "-itsoffset",
    "1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-c:a",
    "pcm_s16le",
    source,
  ]);
  return source;
}

export function readSound(file) {
  const samples = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  let firstSound = -1;
  let peak = 0;
  for (let offset = 0; offset < samples.length; offset += 4) {
    const value = Math.abs(samples.readFloatLE(offset));
    peak = Math.max(peak, value);
    if (firstSound < 0 && value > 0.02) firstSound = offset / 4 / 48000;
  }
  return { firstSound, peak, duration: samples.length / 4 / 48000 };
}
