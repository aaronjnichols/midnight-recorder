// Shared commands for the timeline overview: real sound levels and frames of
// a source video. Jobs run outside the command queue, one at a time, so a long
// read does not block playback or state commands.
import { randomUUID } from "node:crypto";
import { duration } from "../domain/timeline.js";
import { editRevision } from "../domain/inspection.js";
import {
  OVERVIEW_LIMITS,
  editedLevels,
  windowPlan,
} from "../domain/overview.js";

const string = (description) => ({ type: "string", description, minLength: 1 });
const number = (description, minimum, maximum) => ({
  type: "number",
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const define = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});

export const overviewCommands = [
  define(
    "overview.start",
    "Read sound levels and sampled frames of a source video for a timeline. Returns a job ID at once. Poll export.status, then call overview.result. The result is cached. Trim, cut, and speed do not need a new read.",
    { id: string("Video ID.") },
    ["id"],
  ),
  define(
    "overview.cancel",
    "Stop a running overview job. Poll export.status until its state is cancelled. Several callers can share a read. With holder, only this caller leaves, and the read stops when no caller needs it. Without holder, the read stops for all callers.",
    {
      jobId: string("Overview job ID from overview.start."),
      holder: string("The holder value from your overview.start result."),
    },
    ["jobId"],
  ),
  define(
    "overview.result",
    "Read an overview after its job is complete, or when export.status has progress: the sound is then ready and frames.state is reading. audio.state is ready, silent, none, or failed. frames.state is ready, partial, reading, or failed. window.levels are from 0 to 1, the loudest sound in each equal part of the edited time range, mapped through the current edits. revision tells which edits it used. Levels are relative to full scale with a square root curve, not decibels.",
    {
      jobId: string("Overview job ID from overview.start."),
      start: number("Window start in edited seconds. Default 0.", 0),
      end: number("Window end in edited seconds. Default the edited end.", 0),
      buckets: number(
        `Number of levels in the window, 1 to ${OVERVIEW_LIMITS.maxWindowBuckets}. Default 100.`,
        1,
        OVERVIEW_LIMITS.maxWindowBuckets,
      ),
      includeData: {
        type: "boolean",
        description:
          "Include all source levels and frame images as base64. Default false. For a timeline display. Use inspect.start to view frames.",
      },
    },
    ["jobId"],
  ),
];

const round = (value) => Math.round(value * 1000) / 1000;

export class OverviewJobs {
  constructor(service) {
    this.service = service;
    this.entries = new Map();
    this.chain = Promise.resolve();
  }
  // A job for this source that can answer. A failed part can read again. A
  // changed source file has another identity, so an old job does not answer.
  // A complete job answers only while its data can be read.
  async reusable(video, identity) {
    const { jobs, overview } = this.service;
    for (const job of jobs.values()) {
      if (job.kind !== "overview" || job.videoId !== video.id) continue;
      if (identity && job.identity !== identity) continue;
      if (job.state === "running") return job;
      if (
        job.state === "complete" &&
        job.result.audio.state !== "failed" &&
        job.result.frames.state !== "failed" &&
        (await (overview.available?.(video, identity) ?? true))
      )
        return job;
    }
    return null;
  }
  // Each caller of a shared read has a holder. See overview.cancel.
  join(job) {
    const holder = randomUUID();
    this.entries.get(job.id)?.holders.add(holder);
    return { ...job, holder };
  }
  // The newest completed jobs stay. A job that runs always stays.
  prune() {
    const { jobs } = this.service;
    const ended = [...jobs.values()].filter(
      (job) =>
        job.kind === "overview" &&
        !["running", "cancelling"].includes(job.state),
    );
    for (const job of ended.slice(
      0,
      Math.max(0, ended.length - OVERVIEW_LIMITS.maxJobs),
    )) {
      jobs.delete(job.id);
      this.entries.delete(job.id);
    }
  }
  async execute(name, args) {
    const { overview, library, jobs } = this.service;
    if (name === "overview.start") {
      if (!overview) throw new Error("The timeline overview is not available.");
      const video = structuredClone(await library.get(args.id));
      const identity = await overview.identity?.(video).catch(() => null);
      const existing = await this.reusable(video, identity);
      if (existing) return this.join(existing);
      const job = {
        id: randomUUID(),
        kind: "overview",
        videoId: video.id,
        state: "running",
        identity,
        startedAt: new Date().toISOString(),
      };
      const controller = new AbortController();
      jobs.set(job.id, job);
      const entry = { controller, holders: new Set() };
      this.entries.set(job.id, entry);
      // One read at a time. A job that was cancelled in the queue does no
      // work.
      entry.done = this.chain = this.chain.then(async () => {
        try {
          controller.signal.throwIfAborted();
          const result = await overview.prepare(video, {
            signal: controller.signal,
            onProgress: (progress) => {
              job.progress = progress;
            },
          });
          controller.signal.throwIfAborted();
          job.result = result;
          job.state = "complete";
        } catch (error) {
          job.state = controller.signal.aborted ? "cancelled" : "failed";
          if (job.state === "failed") job.error = error.message;
        }
        this.prune();
      });
      return this.join(job);
    }
    const job = jobs.get(args.jobId);
    if (!job || job.kind !== "overview")
      throw new Error("Overview job was not found.");
    if (name === "overview.cancel") {
      if (job.state === "running") {
        const entry = this.entries.get(job.id);
        if (args.holder) entry.holders.delete(args.holder);
        if (!args.holder || !entry.holders.size) {
          job.state = "cancelling";
          entry.controller.abort();
        }
      }
      // The state at this command. The job continues to change.
      return { ...job };
    }
    // The sound can be read before the frames are ready.
    if (job.state !== "complete" && !(job.state === "running" && job.progress))
      throw new Error(
        job.error || "The overview is not ready. Poll export.status.",
      );
    return this.result(job, args);
  }
  async result(job, args) {
    const { overview, library } = this.service;
    const video = await library.get(job.videoId);
    const data = await overview.read(video);
    const { audio, frames } = data;
    const plan = windowPlan(video.timeline, args);
    const levels =
      audio.state === "ready"
        ? {
            bucketSeconds: audio.bucketSeconds,
            levels: Buffer.from(audio.levels, "base64"),
          }
        : null;
    const window = {
      ...plan,
      timeBase: "edited",
      ...(levels
        ? {
            levels: Array.from(
              editedLevels(video.timeline, levels, {
                start: plan.start,
                end: plan.end,
                columns: plan.buckets,
              }),
              round,
            ),
          }
        : {}),
    };
    return {
      videoId: video.id,
      identity: data.identity,
      revision: editRevision(video),
      sourceDuration: data.duration,
      editedDuration: duration(video.timeline),
      muted: video.timeline.muted,
      audio: {
        state: audio.state,
        ...(audio.error ? { error: audio.error } : {}),
        ...(audio.bucketSeconds ? { bucketSeconds: audio.bucketSeconds } : {}),
        ...(audio.count ? { count: audio.count } : {}),
        ...(args.includeData && audio.levels ? { levels: audio.levels } : {}),
        ...(audio.loudest !== undefined ? { loudest: audio.loudest } : {}),
      },
      frames: {
        state: frames.state,
        count: frames.items.length,
        ...(frames.error ? { error: frames.error } : {}),
        ...(frames.width ? { width: frames.width, height: frames.height } : {}),
        ...(args.includeData ? { items: frames.items } : {}),
      },
      window,
    };
  }
  // A video delete stops its reads first, and waits for all reads that are
  // still active, so no read writes into a folder that the delete removes.
  async stop(videoId) {
    const active = [];
    for (const [id, entry] of this.entries) {
      const job = this.service.jobs.get(id);
      if (job?.videoId !== videoId) continue;
      if (!["running", "cancelling"].includes(job.state)) continue;
      job.state = "cancelling";
      entry.controller.abort();
      active.push(entry.done);
    }
    await Promise.all(active);
  }
  // The app closes: no read needs to finish.
  cancelAll() {
    for (const [id, entry] of this.entries) {
      const job = this.service.jobs.get(id);
      if (job?.state === "running") entry.controller.abort();
    }
  }
  remove(videoId) {
    for (const [id, job] of this.service.jobs)
      if (job.videoId === videoId) this.entries.delete(id);
  }
}
