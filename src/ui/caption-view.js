// Pure view values for the caption editor. No DOM access, so tests can run
// them without Electron.
import { captionsOf } from "../domain/captions.js";
import { placement } from "../domain/elements.js";

// Edited time as m:ss.s.
function clockTenths(seconds) {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = ((tenths - minutes * 600) / 10).toFixed(1).padStart(4, "0");
  return `${minutes}:${rest}`;
}
export const cueTimeText = (start, end) =>
  `${clockTenths(start)} to ${clockTenths(end)}`;

// One row for each cue, in time order. current is the cue at the playhead.
export function cueRows(timeline, selectedId, now = -1) {
  const captions = captionsOf(timeline);
  return (captions?.cues ?? []).map((cue) => {
    const shown = placement(timeline, cue);
    const visible = shown.visibility !== "none";
    return {
      id: cue.id,
      text: cue.text.split("\n").join(" / "),
      check: Boolean(cue.check),
      visibility: shown.visibility,
      start: shown.start,
      end: shown.end,
      timeText: visible
        ? cueTimeText(shown.start, shown.end)
        : "Cut from the video",
      // The short time at the start of a row, as in a transcript.
      startText: visible ? clockTenths(shown.start) : "Cut",
      selected: cue.id === selectedId,
      current: visible && now >= shown.start && now < shown.end,
    };
  });
}

// What the caption section shows for a video. capability is the result of
// transcript.capabilities, or null before the check is complete.
export function captionState(video, capability) {
  const captions = captionsOf(video.timeline);
  const count = captions?.cues.length ?? 0;
  const toCheck = captions?.cues.filter((c) => c.check).length ?? 0;
  const silent = video.metadata.hasAudio === false;
  return {
    exists: Boolean(captions),
    enabled: captions?.enabled ?? false,
    style: captions?.style ?? null,
    count,
    toCheck,
    countText: count
      ? `${count} caption${count === 1 ? "" : "s"}${toCheck ? ` · ${toCheck} to check` : ""}`
      : "No captions",
    audio: silent
      ? "This video has no sound, so speech recognition cannot make captions. You can add captions by hand."
      : video.timeline.muted
        ? "Sound is muted in this edit. Captions still show in the video."
        : "",
    setup:
      capability && !capability.available
        ? "Speech recognition is not set up on this computer. To set it up, run npm run setup:transcription in the app folder, then start the app again. You can still add captions by hand."
        : "",
    canGenerate: Boolean(capability?.available) && !silent,
    generateLabel: count
      ? "Make new captions from speech"
      : "Make captions from speech",
  };
}

const TONES = {
  applied: "ok",
  draft: "warn",
  no_speech: "warn",
  no_audio: "warn",
  cancelled: "warn",
  failed: "error",
};

// Progress and actions for a caption job from captions.status.
export function jobView(status) {
  const { state, progress: p = {} } = status;
  return {
    running: ["running", "cancelling", "applying"].includes(state),
    progress:
      state === "running" && p.phase === "speech" && p.totalRegions
        ? p.completedRegions / p.totalRegions
        : null,
    canCancel: state === "running",
    canApply: state === "draft",
    // Speech that is not in the captions is a warning after an apply.
    tone:
      state === "applied" && status.warning ? "warn" : (TONES[state] ?? "busy"),
    text: status.message,
  };
}

// Times for a new caption at the playhead: until the next caption, at most
// length seconds, and never after the edited end. The times are not rounded,
// so a fractional edited end, for example 6.666... at 1.5x speed, stays
// valid. error is "inside" when a caption shows at the playhead, or "short"
// when the gap is shorter than shortest seconds.
export function captionGap(rows, now, total, length = 2, shortest = 0.3) {
  const start = Math.min(Math.max(0, now), total);
  const shown = rows.filter((r) => r.visibility !== "none");
  if (shown.some((r) => start >= r.start && start < r.end))
    return { error: "inside" };
  const end = Math.min(
    total,
    start + length,
    ...shown.filter((r) => r.start > start).map((r) => r.start),
  );
  return end - start < shortest ? { error: "short" } : { start, end };
}

// Caption area positions. The area height stays the same.
export const POSITIONS = {
  bottom: { y: 0.8, verticalAlign: "bottom" },
  middle: { y: 0.425, verticalAlign: "middle" },
  top: { y: 0.05, verticalAlign: "top" },
};
export function positionOf(style) {
  for (const [name, value] of Object.entries(POSITIONS))
    if (
      Math.abs(style.y - value.y) < 1e-6 &&
      style.verticalAlign === value.verticalAlign
    )
      return name;
  return "custom";
}
