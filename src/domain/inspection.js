import { duration } from "./timeline.js";

export function editRevision(video) {
  const { segments, speed, muted } = video.timeline;
  return JSON.stringify({ segments, speed, muted });
}

export function inspectionPlan(
  video,
  { timestamps, width = 960, grid = false, revision } = {},
) {
  if (
    !Array.isArray(timestamps) ||
    timestamps.length < 1 ||
    timestamps.length > 12
  )
    throw new Error("Select from 1 to 12 timestamps.");
  const seconds = duration(video.timeline);
  if (timestamps.some((t) => !Number.isFinite(t) || t < 0 || t >= seconds))
    throw new Error(
      "Each timestamp must be at least zero and before the edited video end.",
    );
  if (!Number.isInteger(width) || width < 160 || width > 1920)
    throw new Error("Width must be an integer from 160 to 1920.");
  if (typeof grid !== "boolean") throw new Error("Grid must be true or false.");
  const current = editRevision(video);
  if (revision !== undefined && revision !== current)
    throw new Error("The video edits changed. Inspect the video again.");
  return {
    timestamps: [...timestamps],
    width,
    grid,
    revision: current,
    duration: seconds,
  };
}
