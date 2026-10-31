import path from "node:path";
import { mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { run } from "./media.js";
import { sourceTime } from "../domain/timeline.js";

export class FrameInspection {
  constructor(media, previews) {
    Object.assign(this, { media, previews });
  }
  async images(result) {
    let bytes = 0;
    for (const frame of result.frames) bytes += (await stat(frame.path)).size;
    if (bytes > 8 * 1024 * 1024)
      throw new Error(
        "Images exceed 8 MiB. Use fewer timestamps or a smaller width, or set includeImages to false.",
      );
    const frames = [];
    for (const frame of result.frames)
      frames.push({
        ...frame,
        data: (await readFile(frame.path)).toString("base64"),
      });
    return { ...result, frames };
  }
  async prepare(video, plan) {
    const preview = await this.previews.prepare(video);
    const probe = JSON.parse(
      await run(this.media.ffprobe, [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,time_base:frame=best_effort_timestamp",
        "-show_frames",
        "-of",
        "json",
        preview.path,
      ]),
    );
    const info = probe.streams[0];
    const [numerator, denominator] = info.time_base.split("/").map(Number);
    const times = probe.frames.map(
      (frame) =>
        (Number(frame.best_effort_timestamp) * numerator) / denominator,
    );
    if (
      !times.length ||
      times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]))
    )
      throw new Error("Cannot read preview frame times.");
    const indices = plan.timestamps.map((t) => {
      let low = 0,
        high = times.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (times[middle] <= t + 1e-9) low = middle + 1;
        else high = middle;
      }
      return Math.max(0, low - 1);
    });
    const unique = [...new Set(indices)].sort((a, b) => a - b);
    const scale = Math.min(1, plan.width / info.width, 1080 / info.height);
    const width = Math.max(1, Math.round(info.width * scale));
    const height = Math.max(1, Math.round(info.height * scale));
    const parent = this.previews.directory(video.id);
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "frames-"));
    try {
      const filters = [
        `select='${unique.map((n) => `eq(n,${n})`).join("+")}'`,
        `scale=${width}:${height}`,
        "setsar=1",
      ];
      if (plan.grid) filters.push("drawgrid=w=iw/10:h=ih/10:t=1:c=white@0.45");
      await run(this.media.ffmpeg, [
        "-v",
        "error",
        "-n",
        "-i",
        preview.path,
        "-vf",
        filters.join(","),
        "-fps_mode",
        "vfr",
        "-frames:v",
        String(unique.length),
        path.join(directory, "%02d.png"),
      ]);
      const files = unique.map((_, i) =>
        path.join(directory, `${String(i + 1).padStart(2, "0")}.png`),
      );
      for (const file of files) {
        if (!(await stat(file)).size) throw new Error("Frame image is empty.");
      }
      return {
        videoId: video.id,
        revision: plan.revision,
        duration: plan.duration,
        videoSize: { width: info.width, height: info.height },
        coordinates:
          "Origin is top left. x increases right. y increases down. Divide image x by image width and image y by image height for coordinates from 0 to 1. Element x, y, width, and height use these coordinates.",
        grid: plan.grid ? { columns: 10, rows: 10 } : null,
        frames: indices.map((n, i) => ({
          requestedSeconds: plan.timestamps[i],
          seconds: times[n],
          sourceSeconds: sourceTime(
            video.timeline,
            Math.min(times[n], plan.duration),
          ),
          width,
          height,
          mimeType: "image/png",
          path: files[unique.indexOf(n)],
        })),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
