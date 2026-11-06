import {
  shortcutActions,
  shortcutKey,
  shortcutKeys,
} from "../domain/shortcuts.js";
// View logic for the desktop page. This module has no DOM or Electron
// dependency, so node:test can check it directly.

export function clock(value) {
  const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

// Edited time as m:ss.t. The tenth is cut, not rounded, so 0:01.9 never shows
// 0:02.0 before the second changes.
export function clockTenths(value) {
  const time = Number.isFinite(value) && value > 0 ? value : 0;
  return `${clock(time)}.${Math.floor((time - Math.floor(time)) * 10)}`;
}

const count = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;

// The true state of the edits for the top bar. A command in progress comes
// first. A field that the user changed is not saved until it loses focus. A
// rejected command stays until the next change is saved.
export function saveState({ saving, failed, dirty }) {
  if (saving)
    return { state: "saving", text: "Saving…", detail: "Saving your change." };
  if (dirty)
    return {
      state: "dirty",
      text: "Not saved yet",
      detail:
        "A field has a change. Leave the field or press Enter to save it.",
    };
  if (failed)
    return {
      state: "failed",
      text: "Not saved",
      detail: "The last change was not saved. The message tells the reason.",
    };
  return {
    state: "saved",
    text: "Saved",
    detail:
      "All edits are saved in the library. The source file does not change.",
  };
}

export function libraryView({ total, shown, query = "" }) {
  const search = query.trim();
  const caption = search
    ? `${shown} of ${count(total, "video")}`
    : total
      ? count(total, "video")
      : "No videos";
  let empty = null;
  if (!shown)
    empty = search
      ? {
          kind: "search",
          title: `No videos match “${search}”.`,
          text: "Check the spelling, or search for a different title.",
        }
      : {
          kind: "library",
          title: "Your video library is empty.",
          text: "Record your screen or camera, or import a video file.",
        };
  return { caption, empty };
}

const exportLabels = {
  running: "Exporting",
  complete: "Exported",
  failed: "Export failed",
};

function exportRow(job) {
  const file = job.path || "";
  const split = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return {
    id: job.id,
    state: job.state,
    label: exportLabels[job.state] || job.state,
    file: file.slice(split + 1),
    folder: split > 0 ? file.slice(0, split) : "",
    path: file,
    error: job.error || "",
  };
}

// Preview and inspection jobs share the job list. Only exports write a file
// that the user asked for.
export function exportRows(jobs, videoId) {
  return jobs
    .filter((job) => job.kind === "export" && job.videoId === videoId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map(exportRow);
}

// Returns exports that finished since the last call. `known` keeps the last
// state of each job. A job that finished before the first read is reported
// only if it started after `since`.
export function finishedExports(known, jobs, since = Infinity) {
  const finished = [];
  for (const job of jobs) {
    if (job.kind !== "export") continue;
    const before = known.get(job.id);
    const done = job.state !== "running";
    if (
      done &&
      (before === "running" ||
        (before === undefined && Date.parse(job.startedAt) >= since))
    )
      finished.push(exportRow(job));
    known.set(job.id, job.state);
  }
  return finished;
}

// Removes the transport prefix that Electron adds to errors from the main
// process. The service keeps the full message for CLI and MCP clients.
export function readableError(message) {
  return String(message ?? "").replace(
    /^Error invoking remote method '[^']*': (?:Error: )?/,
    "",
  );
}

export function recordingView(recording = { state: "idle" }) {
  const view = {
    active: true,
    tone: recording.state,
    label: "",
    short: "",
    detail: "",
    canPause: false,
    pauseLabel: "Pause",
    canStop: false,
    canCancel: true,
    cancelLabel: "Cancel recording",
    showTime: false,
  };
  switch (recording.state) {
    case "idle":
      return { ...view, active: false };
    case "countdown":
      return {
        ...view,
        label: `Starts in ${recording.remaining}`,
        short: `Starts in ${recording.remaining}`,
        detail: "Get ready. The app starts to record after the countdown.",
        cancelLabel: "Cancel countdown",
      };
    case "starting":
      return {
        ...view,
        label: "Starting",
        short: "Starting",
        detail: "The app starts the capture.",
        canCancel: false,
      };
    case "recording":
      return {
        ...view,
        label: "Recording",
        short: "Recording",
        detail: "A red border shows while the app records.",
        canPause: true,
        canStop: true,
        showTime: true,
      };
    case "paused":
      return {
        ...view,
        label: "Paused",
        short: "Paused",
        detail:
          "Select Resume to continue. The border is amber during the pause.",
        canPause: true,
        pauseLabel: "Resume",
        canStop: true,
        showTime: true,
      };
    case "failed":
      return {
        ...view,
        label: `Recording failed: ${readableError(recording.error)}`,
        short: "Recording failed",
        error: readableError(recording.error),
        detail:
          "Select Stop and save to try again. Cancel recording deletes the recording.",
        canStop: true,
        showTime: true,
      };
    case "stopped": {
      // Capture is complete. The service sets error only after a save step
      // fails, and sets saved after the library import.
      if (recording.error === undefined)
        return {
          ...view,
          tone: "saving",
          label: "Saving",
          short: "Saving",
          detail: "The app adds the recording to the library.",
          canCancel: false,
          showTime: true,
        };
      const error = readableError(recording.error);
      if (recording.saved) {
        const title = recording.saved.title;
        return {
          ...view,
          tone: "cleanup",
          label: `Saved. Cleanup failed: ${error}`,
          short: "Saved. Cleanup failed",
          error,
          detail: `${title ? `“${title}”` : "The video"} is in the library. Select Stop and save to try the cleanup again. Cancel recording keeps the saved video.`,
          canStop: true,
          showTime: true,
        };
      }
      return {
        ...view,
        label: `Not saved: ${error}`,
        short: "Not saved",
        error,
        detail:
          "The app did not add the recording to the library. Select Stop and save to try again. Cancel recording deletes the recording.",
        canStop: true,
        showTime: true,
      };
    }
    default:
      return {
        ...view,
        label: String(recording.state),
        short: String(recording.state),
        detail: "Wait for the recorder.",
      };
  }
}

// Range fields show two decimals. At fractional speeds the edited end has more
// decimals, for example 6.666... at 1.5x. A value within half of the display
// step after the end means the end.
const halfStep = 0.005;
const twoDecimals = (value) => Math.round(value * 100) / 100;

export function playheadValue(seconds, total) {
  const time = Math.min(Math.max(seconds, 0), total);
  return String(total - time < halfStep ? total : twoDecimals(time));
}

// Returns the values to send to edit.trim or edit.cut. The end is never after
// the edited duration.
export function rangeCheck(startText, endText, total) {
  const start = Number(startText);
  const typedEnd = Number(endText);
  const end = Math.min(typedEnd, total);
  const valid =
    startText !== "" &&
    endText !== "" &&
    start >= 0 &&
    // Floating point sums can fall below the shown maximum, for example
    // 2.675 + 0.005 gives 2.6799999999999997.
    typedEnd <= total + halfStep + 1e-9 &&
    end > start;
  return {
    valid,
    full: valid && start <= 0 && end >= total - 1e-6,
    start,
    end,
    maximum: String(twoDecimals(total)),
  };
}

const textEntry = (target) => {
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable)
    return true;
  if (tag !== "INPUT") return false;
  return ![
    "checkbox",
    "radio",
    "range",
    "button",
    "submit",
    "reset",
    "color",
    "file",
  ].includes(String(target.type || "text").toLowerCase());
};

// Why the player cannot play or seek now, or null. The picture of a text
// session or of a saved draft is one still frame, so the player must not move
// under it. A saved draft holds until the exact frame is on the screen, which
// is after the preview data loads.
export function playbackBlock(action, { ready, typing, holding }) {
  if (!["seek", "play"].includes(action)) return null;
  if (typing)
    return "A text edit is open. Select Done or Cancel, then try again.";
  if (!ready || holding)
    return "The edited preview is still being prepared. Poll playback.status until ready is true.";
  return null;
}

// A key that belongs to a native control does not run an app action.
export function shortcut(event, context) {
  if (event.defaultPrevented || context.dialog) return null;
  const key = shortcutKey(event);
  const target = event.target || {};
  if (!key || textEntry(target)) return null;
  const tag = String(target.tagName || "").toUpperCase();
  const arrow = ["ArrowLeft", "ArrowRight"].includes(event.key);
  if (arrow && (tag === "INPUT" || target.getAttribute?.("role") === "tab"))
    return null;
  if (event.key === " " && ["BUTTON", "INPUT", "SUMMARY", "A"].includes(tag))
    return null;
  const binding = shortcutActions.find(
    (item) =>
      item.scope === context.view &&
      shortcutKeys(item, context.shortcutOverrides).includes(key),
  );
  if (!binding) return null;
  const id = binding.id;
  if (id === "delete-element" || id === "edit-text")
    return context.selected ? { local: id } : null;
  if (id === "undo") return context.canUndo ? { command: "edit.undo" } : null;
  if (id === "redo") return context.canRedo ? { command: "edit.redo" } : null;
  if (id === "fullscreen")
    return {
      command: "playback.fullscreen",
      args: { enabled: !context.fullscreen },
    };
  if (id === "search" || id.startsWith("zoom-")) return { local: id };
  if (!context.ready) return null;
  if (id === "play")
    return { command: context.paused ? "playback.play" : "playback.pause" };
  if (id.startsWith("seek-")) {
    const step =
      (id.endsWith("-small") ? 1 : 5) * (id.startsWith("seek-back") ? -1 : 1);
    const seconds = Math.min(
      context.duration,
      Math.max(0, context.seconds + step),
    );
    return { command: "playback.seek", args: { seconds } };
  }
  return { local: id };
}
