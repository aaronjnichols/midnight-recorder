import * as timeline from "../domain/timeline.js";
import { randomUUID } from "node:crypto";
import {
  inspectionPlan,
  editRevision,
  revisionMatches,
  structureRevision,
} from "../domain/inspection.js";
import { recordedSeconds } from "../domain/recording.js";
import { transcriptCommands, TranscriptJobs } from "./transcripts.js";
import { captionCommands, CaptionJobs } from "./captions.js";
import { overviewCommands, OverviewJobs } from "./overview.js";
import {
  partCommands,
  describeParts,
  editParts,
  isPartEdit,
  partResult,
} from "./parts.js";
import {
  elementCommands,
  executeElement,
  elementPlacement,
} from "./elements.js";

import {
  setShortcut,
  shortcutActions,
  shortcutSettings,
  validateShortcutOverrides,
} from "../domain/shortcuts.js";

const previewFrameEdge = 1920;
// Finished draft frame jobs that stay readable. One job is about one key
// press in the worst case, so they must not fill app.status.
const FINISHED_FRAME_JOBS = 15;

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
  ...overviewCommands,
  ...partCommands,
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
        "Optional revision from element.list or inspect.result: reject any changed edit. A transcript revision rejects only changed trim, cut, speed, or mute.",
      ),
    },
    ["id", "timestamps"],
  ),
  define("app.status", "Read recording state and export jobs."),
  define(
    "shortcuts.list",
    "List actions and their current keyboard shortcuts.",
  ),
  define(
    "shortcuts.set",
    "Replace the shortcuts for one action. Use shortcuts.list to find actions and key names.",
    {
      action: field("string", "Shortcut action ID.", {
        enum: shortcutActions.map(({ id }) => id),
      }),
      key: string(
        "Key combination, for example B or Control+Shift+B. Use Plus for the plus key.",
      ),
    },
    ["action", "key"],
  ),
  define("shortcuts.reset", "Restore all default keyboard shortcuts."),
  define("capture.sources", "List screens and windows."),
  define("capture.devices", "List microphones and cameras."),
  ...["start", "countdown"].map((action) =>
    define(
      `recording.${action}`,
      action === "countdown"
        ? "Start a 3, 2, 1 countdown, then record. Returns countdown state immediately. Poll app.status. Use recording.cancel to cancel."
        : "Start a local recording immediately. Select a screen or use cameraOnly.",
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
    "library.revision",
    "Read the edit revision, the structure revision, the title, and the undo and redo counts of a video. The revision changes after each edit that changes the rendered video, including elements and captions. The structure revision changes after a split, a cut, a trim, or a speed change. A small result for polling.",
    { id: string("Video ID.") },
    ["id"],
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
    "Set speed, mute audio, or set video fades. Values that you do not give stay the same. The result gives videoFades with the actual fade times.",
    {
      id: string("Video ID."),
      speed: number("Speed from 0.5 to 2."),
      muted: boolean("Mute audio."),
      fadeIn: field(
        "number",
        `Fade from black at the start of the edited video, in seconds, 0 to ${timeline.MAX_VIDEO_FADE}. The sound fades in at the same time. 0 is no fade. If fadeIn + fadeOut is longer than the video, both get shorter in proportion.`,
        { minimum: 0, maximum: timeline.MAX_VIDEO_FADE },
      ),
      fadeOut: field(
        "number",
        `Fade to black at the end of the edited video, in seconds, 0 to ${timeline.MAX_VIDEO_FADE}. The sound fades out at the same time. 0 is no fade.`,
        { minimum: 0, maximum: timeline.MAX_VIDEO_FADE },
      ),
    },
    ["id"],
  ),
  ...["undo", "redo"].map((action) =>
    define(
      `edit.${action}`,
      `${action} video edits. Trim, cut, split, speed, mute, element, and caption changes use one history. The history keeps the last ${timeline.MAX_HISTORY} steps.`,
      { id: string("Video ID.") },
      ["id"],
    ),
  ),
  define(
    "edit.reset",
    "Return to the original video. Undo with edit.undo.",
    {
      id: string("Video ID."),
      scope: field(
        "string",
        "Default all. timeline resets trim, cut, splits, speed, mute, and video fades. elements removes all labels and shapes. captions removes the captions.",
        { enum: timeline.RESET_SCOPES },
      ),
    },
    ["id"],
  ),
  ...elementCommands,
  ...captionCommands,
  define(
    "export.start",
    "Export an edited MP4 with its elements. Returns a job ID. The export uses the edits at the time of this command. Later edits do not change it.",
    {
      id: string("Video ID."),
      path: string("New absolute MP4 path."),
      revision: string(
        "Optional revision from element.list or inspect.result. Reject changed edits.",
      ),
    },
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
    "Prepare an exact edited preview with its elements. Poll export.status with the returned job ID.",
    {
      id: string("Video ID."),
      revision: string(
        "Optional edit revision from element.list. Reject a stale edit state.",
      ),
    },
    ["id"],
  ),
  define(
    "preview.frame",
    `Prepare the picture around one element at one frame, for a draft of that element. This reads only. Poll export.status with the returned job ID. The result gives under, the source frame and the layers below the element, and over, the layers above it with the captions on a transparent canvas, or null. Both are PNG paths, not image data. The element is in neither image, so the images stay valid while its text, style, or box changes. fadeOpacity is the black level of the video fades at this frame, and it is not in the images. The images are at most ${previewFrameEdge} pixels on the long edge. displayColor is bt709, smpte170m, or null. The PNG colors are the colors that Chromium shows for the exact preview, so they can differ from a plain FFmpeg RGB decode of the same frame: bt709 is the BT.709 matrix of an untagged video from 720 lines, smpte170m is SMPTE 170M primaries converted to sRGB, and null is no change. The exact picture is preview.start or export.start.`,
    {
      id: string("Video ID."),
      seconds: number("Edited time in seconds. The frame at or before it."),
      elementId: string("Element ID from element.add or element.list."),
      revision: string(
        "Optional edit revision from element.list. Reject a stale edit state.",
      ),
    },
    ["id", "seconds", "elementId"],
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
    shortcutStore,
    media,
    capture,
    playback,
    previews,
    inspection,
    overview,
    transcription,
    recordingFeedback,
    scheduler = { setTimeout, clearTimeout },
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      library,
      shortcutStore,
      media,
      capture,
      playback,
      previews,
      inspection,
      overview,
      transcription,
      recordingFeedback,
      scheduler,
      now,
    });
    this.recording = { state: "idle" };
    this.jobs = new Map();
    this.transcriptJobs = new TranscriptJobs(this);
    this.captionJobs = new CaptionJobs(this);
    this.overviewJobs = new OverviewJobs(this);
    this.queue = Promise.resolve();
  }
  async loadShortcuts() {
    if (this.shortcutOverrides) return this.shortcutOverrides;
    const stored = this.shortcutStore ? await this.shortcutStore.load() : {};
    this.shortcutOverrides = validateShortcutOverrides(stored);
    return stored;
  }
  execute(name, args = {}) {
    const command = commands.find((c) => c.name === name);
    if (!command) return Promise.reject(new Error(`Unknown command: ${name}.`));
    try {
      validate(command, args);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.dispatch(name, args));
  }
  // Commands and background work, such as a caption apply after speech
  // recognition, run one at a time in this queue.
  enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  // Draft frames are short reads, so only the latest stay in the job list. A
  // running job stays until it ends.
  forgetFrameJobs() {
    const finished = [...this.jobs.values()].filter(
      (job) => job.kind === "frame" && job.state !== "running",
    );
    for (const job of finished.slice(0, -FINISHED_FRAME_JOBS))
      this.jobs.delete(job.id);
  }
  setRecording(recording) {
    this.recording = recording;
    this.recordingFeedback?.update(recording);
    return recording;
  }
  timestamp() {
    return new Date(this.now()).toISOString();
  }
  // Clients that start later, such as a reloaded page or an agent, read the
  // recorded time from the shared state.
  recordingStatus() {
    if (!this.recording.startedAt) return this.recording;
    return {
      ...this.recording,
      recordedSeconds: recordedSeconds(this.recording, this.now()),
    };
  }
  async beginRecording(id, options) {
    this.setRecording({ id, state: "starting", options });
    try {
      await this.capture.start({ ...options, recordingId: id });
      return this.setRecording({
        id,
        state: "recording",
        startedAt: this.timestamp(),
        pausedSeconds: 0,
        options,
      });
    } catch (error) {
      this.setRecording({ state: "idle", error: error.message });
      throw error;
    }
  }
  scheduleCountdown(id) {
    this.countdownTimer = this.scheduler.setTimeout(() => {
      // Timer work uses the same queue as UI, CLI, and MCP commands.
      const result = this.queue.then(async () => {
        if (this.recording.id !== id || this.recording.state !== "countdown")
          return;
        if (this.recording.remaining > 1) {
          this.setRecording({
            ...this.recording,
            remaining: this.recording.remaining - 1,
          });
          this.scheduleCountdown(id);
        } else {
          this.countdownTimer = undefined;
          await this.beginRecording(id, this.recording.options);
        }
      });
      // A delayed start reports its error through app.status.
      this.queue = result.catch(() => {});
    }, 1000);
  }
  async dispatch(name, args) {
    if (name.startsWith("transcript."))
      return this.transcriptJobs.execute(name, args);
    if (name.startsWith("captions."))
      return this.captionJobs.execute(name, args);
    if (name.startsWith("overview."))
      return this.overviewJobs.execute(name, args);
    if (name === "library.revision") {
      const video = await this.library.get(args.id);
      return {
        id: video.id,
        title: video.title,
        revision: editRevision(video),
        structureRevision: structureRevision(video),
        history: {
          undo: video.timeline.past.length,
          redo: video.timeline.future.length,
        },
      };
    }
    if (name === "shortcuts.list")
      return shortcutSettings(await this.loadShortcuts());
    if (name === "shortcuts.set" || name === "shortcuts.reset") {
      const next =
        name === "shortcuts.reset"
          ? {}
          : setShortcut(await this.loadShortcuts(), args.action, args.key);
      await this.shortcutStore?.save(next);
      this.shortcutOverrides = next;
      return shortcutSettings(next);
    }
    if (name === "app.status")
      return {
        recording: this.recordingStatus(),
        jobs: [...this.jobs.values()],
        shortcutOverrides: this.shortcutOverrides,
      };
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
      // An overview read or a draft frame is not the user's work. The delete
      // stops an overview, and the preview cache drops a late frame.
      if (
        [...this.jobs.values()].some(
          (j) =>
            j.videoId === args.id &&
            !["overview", "frame"].includes(j.kind) &&
            ["running", "cancelling"].includes(j.state),
        )
      )
        throw new Error("Wait for the export before deleting this video.");
      await this.overviewJobs.stop(args.id);
      await this.previews?.remove(args.id);
      await this.transcription?.remove(args.id);
      const result = await this.library.remove(args.id);
      this.transcriptJobs.remove(args.id);
      this.overviewJobs.remove(args.id);
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
    if (name.startsWith("element.")) return executeElement(this, name, args);
    if (name === "parts.list")
      return describeParts(await this.library.get(args.id));
    if (name.startsWith("edit.")) {
      const video = await this.library.get(args.id);
      const action = name.slice(5);
      let edited;
      if (isPartEdit(action)) edited = editParts(action, video, args);
      if (action === "trim" || action === "cut")
        edited = timeline[action](video.timeline, args.start, args.end);
      if (action === "configure")
        edited = timeline.configure(video.timeline, args);
      if (action === "undo" || action === "redo")
        edited = timeline[action](video.timeline);
      if (action === "reset")
        edited = timeline.reset(
          video.timeline,
          video.metadata.duration,
          args.scope,
        );
      const saved = await this.library.update(args.id, { timeline: edited });
      // Report where elements show after this edit. This is not stored.
      return {
        ...saved,
        elementPlacement: elementPlacement(saved),
        videoFades: timeline.videoFades(saved.timeline),
        ...(isPartEdit(action) ? partResult(action, saved, video) : {}),
      };
    }
    if (
      name === "export.start" ||
      name === "preview.start" ||
      name === "preview.frame" ||
      name === "inspect.start"
    ) {
      // A deep copy of the edit state at this command. Later edits do not
      // change the running job.
      const video = structuredClone(await this.library.get(args.id));
      const revision = editRevision(video);
      const plan =
        name === "inspect.start" ? inspectionPlan(video, args) : undefined;
      if (
        name !== "inspect.start" &&
        args.revision &&
        !revisionMatches(video, args.revision)
      )
        throw new Error(
          name === "export.start"
            ? "The video edits changed. Read element.list or inspect the video again."
            : "The video edits changed. Open the video again.",
        );
      if (name === "preview.frame") {
        if (!video.timeline.elements?.some((e) => e.id === args.elementId))
          throw new Error("Element was not found.");
        if (
          args.seconds < 0 ||
          args.seconds > timeline.duration(video.timeline)
        )
          throw new Error("Seek time is outside the edited range.");
        this.forgetFrameJobs();
      }
      const job = {
        id: randomUUID(),
        videoId: args.id,
        kind: {
          "inspect.start": "inspection",
          "preview.start": "preview",
          "preview.frame": "frame",
          "export.start": "export",
        }[name],
        path: args.path,
        revision,
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
              : name === "preview.frame"
                ? this.previews.frame(video, {
                    seconds: args.seconds,
                    elementId: args.elementId,
                  })
                : this.media.export(video, args.path),
        )
        .then(
          (result) => ({ ...job, state: "complete", result }),
          (error) => ({ ...job, state: "failed", error: error.message }),
        )
        .then((ended) => {
          // A delete removes the jobs of a video, so a late end stays out.
          if (this.jobs.has(job.id)) this.jobs.set(job.id, ended);
        });
      return job;
    }
    if (name === "export.status") {
      if (!this.jobs.has(args.jobId))
        throw new Error("Export job was not found.");
      return this.jobs.get(args.jobId);
    }
    if (name === "recording.start" || name === "recording.countdown") {
      if (this.recording.state !== "idle")
        throw new Error("A recording is already active.");
      if (!args.sourceId && !args.cameraOnly)
        throw new Error("Select a source or use cameraOnly.");
      const id = randomUUID();
      await this.recordingFeedback?.prepare(args);
      if (name === "recording.start") return this.beginRecording(id, args);
      this.setRecording({
        id,
        state: "countdown",
        remaining: 3,
        options: { ...args },
      });
      this.scheduleCountdown(id);
      return this.recording;
    }
    if (name === "recording.fail") {
      if (
        this.recording.id === args.recordingId &&
        ["recording", "paused"].includes(this.recording.state)
      ) {
        // Capture stays paused after a failure. A failure during a pause keeps
        // the pause start time.
        this.setRecording({
          ...this.recording,
          state: "failed",
          error: args.error,
          pausedAt: this.recording.pausedAt ?? this.timestamp(),
        });
        await this.capture.pause();
      }
      return this.recording;
    }
    if (name.startsWith("recording.")) {
      if (this.recording.state === "idle")
        throw new Error("No recording is active.");
      if (this.recording.state === "countdown") {
        if (name !== "recording.cancel")
          throw new Error("Wait for the countdown or cancel it.");
        this.scheduler.clearTimeout(this.countdownTimer);
        this.countdownTimer = undefined;
        return this.setRecording({ state: "idle" });
      }
      if (name === "recording.pause") {
        if (this.recording.state !== "recording")
          throw new Error("Recording is already paused.");
        await this.capture.pause();
        this.setRecording({
          ...this.recording,
          state: "paused",
          pausedAt: this.timestamp(),
        });
      }
      if (name === "recording.resume") {
        if (this.recording.state !== "paused")
          throw new Error("Recording is not paused.");
        await this.capture.resume();
        const { pausedAt, ...recording } = this.recording;
        const paused = (this.now() - Date.parse(pausedAt)) / 1000;
        this.setRecording({
          ...recording,
          state: "recording",
          pausedSeconds:
            Math.round(
              ((recording.pausedSeconds || 0) +
                (Number.isFinite(paused) ? paused : 0)) *
                1000,
            ) / 1000,
        });
      }
      if (name === "recording.cancel") {
        await this.capture.cancel();
        this.setRecording({ state: "idle" });
      }
      if (name === "recording.stop") {
        // In the stopped state, error holds only the last save error. A save
        // in progress has no error.
        const { error: lastError, ...recording } = this.recording;
        if (!recording.file) {
          const file = await this.capture.stop();
          this.setRecording({
            ...recording,
            state: "stopped",
            file,
            stoppedAt: this.timestamp(),
          });
        } else if (lastError !== undefined) this.setRecording(recording);
        if (!this.recording.saved) {
          const file = this.recording.file;
          try {
            const video = await this.library.import(
              file,
              await this.media.probe(file),
              this.recording.options.title || "Untitled recording",
            );
            this.recording = { ...this.recording, saved: video };
          } catch (error) {
            this.setRecording({ ...this.recording, error: error.message });
            throw error;
          }
        }
        const video = this.recording.saved;
        try {
          await this.capture.cancel();
        } catch (error) {
          this.setRecording({ ...this.recording, error: error.message });
          throw error;
        }
        this.setRecording({ state: "idle" });
        return video;
      }
      return this.recording;
    }
    throw new Error(`Command has no handler: ${name}.`);
  }
}
