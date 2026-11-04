// Reads the timeline overview of a source video with FFmpeg. One audio pass
// streams through fixed memory. Frames come from a limited number of seeks.
// One deadline covers the full read. The result goes to one cache file in the
// preview folder of the video, so a video delete also deletes it.
import path from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { stream } from "./media.js";
import {
  OVERVIEW_LIMITS,
  frameBox,
  levelByte,
  overviewIdentity,
  overviewPlan,
  validOverview,
} from "../domain/overview.js";

// Below about -70 dB of full scale, a track has no sound to show.
const SILENT_RMS = 0.0003;
// Three failed seeks in a row stop the frame read.
const MAX_FAILURES = 3;
// Results that the cache does not keep, so a retry can read the source again.
const MEMORY = 4;

export class TimelineOverview {
  constructor(media, previews, options = {}) {
    Object.assign(this, { media, previews });
    this.now = options.now ?? Date.now;
    this.totalSeconds = options.totalSeconds ?? OVERVIEW_LIMITS.totalSeconds;
    this.frameSeconds = options.frameSeconds ?? OVERVIEW_LIMITS.frameSeconds;
    this.maxFrameBytes = options.maxFrameBytes ?? OVERVIEW_LIMITS.maxFrameBytes;
    this.memory = new Map();
  }
  async identity(video) {
    const { size, mtimeMs } = await stat(video.path);
    return overviewIdentity(video, { size, mtimeMs });
  }
  file(video, identity) {
    return path.join(
      this.previews.directory(video.id),
      `overview-${identity}.json`,
    );
  }
  // A cache file that is not there or that is damaged is a miss.
  async cached(video, identity) {
    let data;
    try {
      data = JSON.parse(await readFile(this.file(video, identity), "utf8"));
    } catch (error) {
      if (error.code && error.code !== "ENOENT") throw error;
      return null;
    }
    return validOverview(data, identity) ? data : null;
  }
  // The sound comes first and is fast. onProgress tells that it can be read
  // while the frames continue.
  async prepare(video, { signal, onProgress } = {}) {
    const identity = await this.identity(video);
    const saved = await this.cached(video, identity);
    if (saved) return summary(saved, true);
    const plan = overviewPlan(video.metadata);
    const deadline = this.now() + this.totalSeconds * 1000;
    const data = {
      version: OVERVIEW_LIMITS.version,
      identity,
      videoId: video.id,
      duration: video.metadata.duration,
      audio: await this.#audio(video, plan.audio, signal, deadline),
      frames: { state: "reading", items: [] },
    };
    this.#remember(data);
    onProgress?.({ audio: { state: data.audio.state } });
    try {
      data.frames = await this.#frames(video, plan.frames, signal, deadline);
      signal?.throwIfAborted();
      // A failed part reads again next time, so it does not go in the cache.
      if (data.audio.state !== "failed" && data.frames.state !== "failed") {
        await this.#save(video, data, signal);
        this.memory.delete(identity);
      }
    } catch (error) {
      this.memory.delete(identity);
      throw error;
    }
    return summary(data, false);
  }
  #remember(data) {
    this.memory.set(data.identity, data);
    for (const key of this.memory.keys())
      if (this.memory.size > MEMORY) this.memory.delete(key);
  }
  // True when read can answer. A damaged or deleted cache file needs a new
  // read, also if an earlier job completed.
  async available(video, identity) {
    return (
      this.memory.has(identity) ||
      Boolean(await this.cached(video, identity).catch(() => null))
    );
  }
  async read(video) {
    const identity = await this.identity(video);
    const data =
      (await this.cached(video, identity)) ?? this.memory.get(identity);
    if (!data) throw new Error("Run overview.start for this video first.");
    return data;
  }
  // A rename makes the file complete or not there, also after a crash. A
  // cancel removes only the temporary file of this read.
  async #save(video, data, signal) {
    const file = this.file(video, data.identity);
    signal?.throwIfAborted();
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data), { signal });
      signal?.throwIfAborted();
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  async #audio(video, plan, signal, deadline) {
    if (!plan) return { state: "none" };
    const limit = AbortSignal.timeout(Math.max(1, deadline - this.now()));
    const levels = new Uint8Array(plan.buckets);
    let count = 0,
      filled = 0,
      squares = 0,
      loudest = 0,
      spare = null;
    const finish = () => {
      if (!filled) return;
      const rms = Math.sqrt(squares / filled) / 32768;
      if (count < levels.length) levels[count++] = levelByte(rms);
      if (rms > loudest) loudest = rms;
      filled = squares = 0;
    };
    const read = (chunk) => {
      // A chunk can end in the middle of a 16-bit sample.
      const bytes = spare ? Buffer.concat([spare, chunk]) : chunk;
      const end = bytes.length - (bytes.length % 2);
      spare = end < bytes.length ? bytes.subarray(end) : null;
      for (let at = 0; at < end; at += 2) {
        const sample = bytes.readInt16LE(at);
        squares += sample * sample;
        if (++filled === plan.samplesPerBucket) finish();
      }
    };
    try {
      await stream(
        this.media.ffmpeg,
        [
          "-v",
          "error",
          "-i",
          video.path,
          "-map",
          "0:a:0",
          "-vn",
          // The same clock as the export: a late audio start stays late.
          "-af",
          `aresample=async=1:first_pts=0,apad,atrim=end=${video.metadata.duration}`,
          "-ar",
          String(plan.sampleRate),
          "-ac",
          "1",
          "-f",
          "s16le",
          "pipe:1",
        ],
        read,
        { signal: signals(signal, limit) },
      );
      finish();
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        state: "failed",
        error: limit.aborted
          ? "The sound read took too long."
          : shortError(error),
      };
    }
    const ready = {
      bucketSeconds: plan.bucketSeconds,
      count,
      loudest: levelByte(loudest),
    };
    if (loudest < SILENT_RMS) return { state: "silent", ...ready };
    return {
      state: "ready",
      ...ready,
      levels: Buffer.from(levels.buffer, 0, count).toString("base64"),
    };
  }
  async #frames(video, plan, signal, totalDeadline) {
    const deadline = Math.min(
      totalDeadline,
      this.now() + this.frameSeconds * 1000,
    );
    const tooLong = {
      state: "failed",
      error: "The frame read took too long.",
      items: [],
    };
    const left = deadline - this.now();
    if (left <= 0) return tooLong;
    let box, start;
    const limit = AbortSignal.timeout(Math.ceil(left));
    try {
      const info = await this.media.renderInfo(video.path, {
        signal: signals(signal, limit),
      });
      box = frameBox(info.frame);
      start = info.start ?? 0;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (limit.aborted) return tooLong;
      return { state: "failed", error: shortError(error), items: [] };
    }
    const items = [];
    let failures = 0,
      lastError = "";
    for (const seconds of plan.times) {
      signal?.throwIfAborted();
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        lastError ||= tooLong.error;
        break;
      }
      try {
        const frame = await this.#frame(video, seconds, box, signal, remaining);
        if (frame.bytes.length) {
          items.push({
            // The source clock of the export starts at the start of the file.
            seconds: Math.max(
              0,
              frame.decoded === null ? seconds : frame.decoded - start,
            ),
            data: frame.bytes.toString("base64"),
          });
          failures = 0;
        } else if (++failures >= MAX_FAILURES) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = shortError(error);
        if (++failures >= MAX_FAILURES) break;
      }
    }
    items.sort((a, b) => a.seconds - b.seconds);
    if (!items.length)
      return {
        state: "failed",
        error: lastError || "The file gave no frames.",
        items,
      };
    return {
      state: items.length === plan.times.length ? "ready" : "partial",
      ...box,
      items,
    };
  }
  // One frame. FFmpeg keeps the source time with -copyts, and showinfo logs
  // the decoded time, which is the first frame at or after the request. A cut
  // can then tell which kept part has this frame.
  async #frame(video, seconds, box, signal, remaining) {
    const limit = new AbortController();
    const chunks = [];
    let size = 0;
    const log = await stream(
      this.media.ffmpeg,
      [
        "-v",
        "info",
        "-hide_banner",
        "-copyts",
        "-ss",
        seconds.toFixed(3),
        "-i",
        video.path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        `showinfo,scale=${box.width}:${box.height}`,
        "-c:v",
        "mjpeg",
        "-q:v",
        "5",
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      (chunk) => {
        size += chunk.length;
        if (size > this.maxFrameBytes) limit.abort();
        else chunks.push(chunk);
      },
      {
        signal: signals(
          signal,
          AbortSignal.any([
            limit.signal,
            AbortSignal.timeout(Math.ceil(remaining)),
          ]),
        ),
      },
    );
    const time = /pts_time:\s*([0-9.]+)/.exec(log)?.[1];
    return {
      decoded: time === undefined ? null : Number(time),
      bytes: Buffer.concat(chunks),
    };
  }
}

const signals = (signal, limit) =>
  signal ? AbortSignal.any([signal, limit]) : limit;
const shortError = (error) =>
  String(error.message || error)
    .trim()
    .split("\n")
    .at(-1)
    .slice(0, 300);

// The small result for job records and status reads. It has no sample data.
function summary(data, cached) {
  const { audio, frames } = data;
  return {
    identity: data.identity,
    cached,
    audio: {
      state: audio.state,
      ...(audio.error ? { error: audio.error } : {}),
      ...(audio.count ? { count: audio.count } : {}),
      ...(audio.bucketSeconds ? { bucketSeconds: audio.bucketSeconds } : {}),
    },
    frames: {
      state: frames.state,
      count: frames.items.length,
      ...(frames.error ? { error: frames.error } : {}),
      ...(frames.width ? { width: frames.width, height: frames.height } : {}),
    },
  };
}
