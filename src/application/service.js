import * as timeline from "../domain/timeline.js";
import { randomUUID } from "node:crypto";
import { inspectionPlan, editRevision } from "../domain/inspection.js";
import { transcriptCommands, TranscriptJobs } from "./transcripts.js";

const field = (type, description, extra = {}) => ({
  type,
  description,
  ...extra,
});
const string = (description) => field("string", description, { minLength: 1 });
const number = (description) => field("number", description);
const boolean = (description) => field("boolean", description);
const define = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});

export const commands = [
  ...transcriptCommands,
  define(
    "inspect.result",
    "Read a completed inspection. Returns PNG images and frame coordinates. Check stale before placing elements. Use includeImages false for paths only. Images total at most 8 MiB.",
    {
      jobId: string("Inspection job ID from inspect.start."),
      includeImages: boolean("Include image data. Default true."),
    },
    ["jobId"],
  ),
  define(
    "inspect.start",
    "Read frames from the edited video. Returns a job ID. Poll export.status, then call inspect.result for images. Times are seconds. Selects the frame at or before each time. This can first render a full preview.",
    {
      id: string("Video ID."),
      timestamps: field(
        "array",
        "From 1 to 12 edited times, before the video end.",
        { items: { type: "number", minimum: 0 }, minItems: 1, maxItems: 12 },
      ),
      width: field(
        "number",
        "Maximum image width. Default 960. Height is at most 1080. Images do not enlarge.",
        { minimum: 160, maximum: 1920 },
      ),
      grid: boolean("Show a grid with 10 rows and 10 columns. Default false."),
      revision: string(
        "Optional revision from an earlier inspection. Reject changed edits.",
      ),
    },
    ["id", "timestamps"],
  ),
  define("app.status", "Read recording state and export jobs."),
  define("capture.sources", "List screens and windows."),
  define("capture.devices", "List microphones and cameras."),
  define(
    "recording.start",
    "Start a local recording. Select a screen or use cameraOnly.",
    {
      sourceId: string("Screen or window ID from capture.sources."),
      title: string("Recording title."),
      microphoneId: string("Microphone ID, or default."),
      cameraId: string("Camera ID, or default."),
      cameraOnly: boolean("Record the camera without a screen."),
      systemAudio: boolean("Include system audio."),
      frameRate: field("number", "Frames per second.", {
        enum: [15, 24, 30, 60],
      }),
    },
  ),
  define(
    "recording.fail",
    "Report a capture failure. Keep pending data for Stop or Cancel.",
    {
      recordingId: string("ID of the recording that failed."),
      error: string("Capture error message."),
    },
    ["recordingId", "error"],
  ),
  ...["pause", "resume", "stop", "cancel"].map((action) =>
    define(
      `recording.${action}`,
      `${action[0].toUpperCase() + action.slice(1)} the active recording.`,
    ),
  ),
  define("library.list", "List or search local videos.", {
    query: string("Title search text."),
  }),
  define(
    "library.import",
    "Copy a video into the local library.",
    {
      path: string("Absolute source file path."),
      title: string("Video title."),
    },
    ["path"],
  ),
  ...["get", "delete"].map((action) =>
    define(
      `library.${action}`,
      `${action === "get" ? "Read" : "Delete"} a local video.`,
      { id: string("Video ID.") },
      ["id"],
    ),
  ),
  define(
    "library.rename",
    "Change a video title.",
    { id: string("Video ID."), title: string("New title.") },
    ["id", "title"],
  ),
  ...["trim", "cut"].map((action) =>
    define(
      `edit.${action}`,
      `${action === "trim" ? "Keep" : "Remove"} a time range in the edited video. Times are seconds.`,
      {
        id: string("Video ID."),
        start: number("Start time."),
        end: number("End time."),
      },
      ["id", "start", "end"],
    ),
  ),
  define(
    "edit.configure",
    "Set speed or mute audio.",
    {
      id: string("Video ID."),
      speed: number("Speed from 0.5 to 2."),
      muted: boolean("Mute audio."),
    },
    ["id"],
  ),
  ...["undo", "redo", "reset"].map((action) =>
    define(
      `edit.${action}`,
      `${action} video edits.`,
      { id: string("Video ID.") },
      ["id"],
    ),
  ),
  define(
    "export.start",
    "Export an edited MP4. Returns a job ID.",
    { id: string("Video ID."), path: string("New absolute MP4 path.") },
    ["id", "path"],
  ),
  define(
    "export.status",
    "Read an export job.",
    { jobId: string("Export job ID.") },
    ["jobId"],
  ),
  define(
    "preview.start",
    "Prepare an exact edited preview. Poll export.status with the returned job ID.",
    {
      id: string("Video ID."),
      revision: string(
        "Optional JSON of segments, speed, and muted. Reject a stale edit state.",
      ),
    },
    ["id"],
  ),
  define(
    "app.view",
    "Select the library or recorder view.",
    { view: field("string", "App view.", { enum: ["library", "recorder"] }) },
    ["view"],
  ),
  define(
    "playback.open",
    "Open a video in the editor.",
    { id: string("Video ID.") },
    ["id"],
  ),
  ...["play", "pause", "status"].map((action) =>
    define(`playback.${action}`, `${action} the video preview.`),
  ),
  define(
    "playback.seek",
    "Seek to a time in the edited video.",
    { seconds: number("Edited time in seconds.") },
    ["seconds"],
  ),
  define(
    "playback.configure",
    "Set preview volume. This does not change exports.",
    { volume: number("Volume from 0 to 1.") },
    ["volume"],
  ),
  define(
    "playback.fullscreen",
    "Enter or leave fullscreen video preview.",
    { enabled: boolean("Fullscreen state.") },
    ["enabled"],
  ),
];

function validate(command, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Arguments must be an object.");
  for (const key of Object.keys(args)) {
    const spec = command.inputSchema.properties[key];
    if (!spec) throw new Error(`Unknown argument: ${key}.`);
    if (
      (spec.type === "array"
        ? !Array.isArray(args[key])
        : typeof args[key] !== spec.type) ||
      (spec.type === "number" && !Number.isFinite(args[key]))
    )
      throw new Error(`Invalid ${key}. Expected ${spec.type}.`);
    if (spec.minLength && !args[key].trim())
      throw new Error(`${key} must not be empty.`);
    if (spec.enum && !spec.enum.includes(args[key]))
      throw new Error(`Invalid ${key}.`);
  }
  for (const key of command.inputSchema.required)
    if (!(key in args)) throw new Error(`Missing argument: ${key}.`);
}

export class Service {
  constructor({
    library,
    media,
    capture,
    playback,
    previews,
    inspection,
    transcription,
  }) {
    Object.assign(this, {
      library,
      media,
      capture,
      playback,
      previews,
      inspection,
      transcription,
    });
    this.recording = { state: "idle" };
    this.jobs = new Map();
    this.transcriptJobs = new TranscriptJobs(this);
    this.queue = Promise.resolve();
  }
  execute(name, args = {}) {
    const command = commands.find((c) => c.name === name);
    if (!command) return Promise.reject(new Error(`Unknown command: ${name}.`));
    try {
      validate(command, args);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue.then(() => this.dispatch(name, args));
    this.queue = result.catch(() => {});
    return result;
  }
  async dispatch(name, args) {
    if (name.startsWith("transcript."))
      return this.transcriptJobs.execute(name, args);
    if (name === "app.status")
      return { recording: this.recording, jobs: [...this.jobs.values()] };
    if (name === "app.view") return this.playback.request("view", args);
    if (name === "playback.open")
      return this.playback.request("open", {
        video: await this.library.get(args.id),
      });
    if (name.startsWith("playback.")) {
      if (name === "playback.seek" && args.seconds < 0)
        throw new Error("Seek time must not be negative.");
      if (name === "playback.configure" && (args.volume < 0 || args.volume > 1))
        throw new Error("Volume must be between 0 and 1.");
      return this.playback.request(name.slice(9), args);
    }
    if (name === "capture.sources") return this.capture.sources();
    if (name === "capture.devices") return this.capture.devices();
    if (name === "library.list") return this.library.list(args.query);
    if (name === "library.get") return this.library.get(args.id);
    if (name === "library.import")
      return this.library.import(
        args.path,
        await this.media.probe(args.path),
        args.title,
      );
    if (name === "library.rename")
      return this.library.update(args.id, { title: args.title.trim() });
    if (name === "library.delete") {
      if (
        [...this.jobs.values()].some(
          (j) =>
            j.videoId === args.id &&
            ["running", "cancelling"].includes(j.state),
        )
      )
        throw new Error("Wait for the export before deleting this video.");
      await this.previews?.remove(args.id);
      await this.transcription?.remove(args.id);
      const result = await this.library.remove(args.id);
      this.transcriptJobs.remove(args.id);
      for (const [id, job] of this.jobs)
        if (job.videoId === args.id) this.jobs.delete(id);
      return result;
    }
    if (name === "inspect.result") {
      const job = this.jobs.get(args.jobId);
      if (!job || job.kind !== "inspection")
        throw new Error("Inspection job was not found.");
      if (job.state !== "complete")
        throw new Error(
          job.error || "Inspection is still running. Poll export.status.",
        );
      const video = await this.library.get(job.videoId);
      const result = {
        ...job.result,
        stale: job.result.revision !== editRevision(video),
      };
      return args.includeImages === false
        ? result
        : this.inspection.images(result);
    }
    if (name.startsWith("edit.")) {
      const video = await this.library.get(args.id);
      const action = name.slice(5);
      let edited;
      if (action === "trim" || action === "cut")
        edited = timeline[action](video.timeline, args.start, args.end);
      if (action === "configure")
        edited = timeline.configure(video.timeline, args);
      if (action === "undo" || action === "redo")
        edited = timeline[action](video.timeline);
      if (action === "reset") {
        const fresh = timeline.createTimeline(video.metadata.duration);
        edited = {
          ...fresh,
          past: [
            ...video.timeline.past,
            {
              segments: video.timeline.segments,
              speed: video.timeline.speed,
              muted: video.timeline.muted,
            },
          ],
        };
      }
      return this.library.update(args.id, { timeline: edited });
    }
    if (
      name === "export.start" ||
      name === "preview.start" ||
      name === "inspect.start"
    ) {
      const video = await this.library.get(args.id);
      const plan =
        name === "inspect.start" ? inspectionPlan(video, args) : undefined;
      if (name === "preview.start" && args.revision) {
        const { segments, speed, muted } = video.timeline;
        if (args.revision !== JSON.stringify({ segments, speed, muted }))
          throw new Error("The video edits changed. Open the video again.");
      }
      const job = {
        id: randomUUID(),
        videoId: args.id,
        kind:
          name === "inspect.start"
            ? "inspection"
            : name === "preview.start"
              ? "preview"
              : "export",
        path: args.path,
        state: "running",
        startedAt: new Date().toISOString(),
      };
      this.jobs.set(job.id, job);
      Promise.resolve()
        .then(() =>
          name === "inspect.start"
            ? this.inspection.prepare(video, plan)
            : name === "preview.start"
              ? this.previews.prepare(video)
              : this.media.export(video, args.path),
        )
        .then(
          (result) => {
            this.jobs.set(job.id, { ...job, state: "complete", result });
          },
          (error) => {
            this.jobs.set(job.id, {
              ...job,
              state: "failed",
              error: error.message,
            });
          },
        );
      return job;
    }
    if (name === "export.status") {
      if (!this.jobs.has(args.jobId))
        throw new Error("Export job was not found.");
      return this.jobs.get(args.jobId);
    }
    if (name === "recording.start") {
      if (this.recording.state !== "idle")
        throw new Error("A recording is already active.");
      if (!args.sourceId && !args.cameraOnly)
        throw new Error("Select a source or use cameraOnly.");
      const id = randomUUID();
      await this.capture.start({ ...args, recordingId: id });
      this.recording = {
        id,
        state: "recording",
        startedAt: new Date().toISOString(),
        options: args,
      };
      return this.recording;
    }
    if (name === "recording.fail") {
      if (
        this.recording.id === args.recordingId &&
        ["recording", "paused"].includes(this.recording.state)
      ) {
        this.recording = {
          ...this.recording,
          state: "failed",
          error: args.error,
        };
        await this.capture.pause();
      }
      return this.recording;
    }
    if (name.startsWith("recording.")) {
      if (this.recording.state === "idle")
        throw new Error("No recording is active.");
      if (name === "recording.pause") {
        if (this.recording.state !== "recording")
          throw new Error("Recording is already paused.");
        await this.capture.pause();
        this.recording = { ...this.recording, state: "paused" };
      }
      if (name === "recording.resume") {
        if (this.recording.state !== "paused")
          throw new Error("Recording is not paused.");
        await this.capture.resume();
        this.recording = { ...this.recording, state: "recording" };
      }
      if (name === "recording.cancel") {
        await this.capture.cancel();
        this.recording = { state: "idle" };
      }
      if (name === "recording.stop") {
        if (!this.recording.file) {
          const file = await this.capture.stop();
          this.recording = { ...this.recording, state: "stopped", file };
        }
        if (!this.recording.saved) {
          const file = this.recording.file;
          const video = await this.library.import(
            file,
            await this.media.probe(file),
            this.recording.options.title || "Untitled recording",
          );
          this.recording = { ...this.recording, saved: video };
        }
        const video = this.recording.saved;
        await this.capture.cancel();
        this.recording = { state: "idle" };
        return video;
      }
      return this.recording;
    }
    throw new Error(`Command has no handler: ${name}.`);
  }
}
