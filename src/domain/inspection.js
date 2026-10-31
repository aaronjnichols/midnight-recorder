import { duration } from "./timeline.js";

// 64-bit text hash from two 32-bit hashes. It finds changed edit states. It
// is not for security. Pure JS, so the UI can use the same function.
function hash(text) {
  let a = 0x811c9dc5,
    b = 0x9e3779b9 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return [a, b].map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

// Revision of everything that changes the rendered video: segments, speed,
// mute, and elements. Preview, inspection, and export use it.
export function editRevision(video) {
  const { segments, speed, muted, elements = [] } = video.timeline;
  return hash(JSON.stringify({ segments, speed, muted, elements }));
}

// Revision of the time mapping only. Transcripts use it, because elements do
// not change speech times. This is the same format as before elements.
export function timingRevision(video) {
  const { segments, speed, muted } = video.timeline;
  return JSON.stringify({ segments, speed, muted });
}

// True when a revision from a client still matches the video. An edit
// revision checks all edits. A transcript revision (JSON text) checks the
// time mapping only, so transcript times stay valid after element changes.
export function revisionMatches(video, revision) {
  return revision.startsWith("{")
    ? revision === timingRevision(video)
    : revision === editRevision(video);
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
  if (
    revision !== undefined &&
    (typeof revision !== "string" || !revisionMatches(video, revision))
  )
    throw new Error("The video edits changed. Inspect the video again.");
  const current = editRevision(video);
  return {
    timestamps: [...timestamps],
    width,
    grid,
    revision: current,
    duration: seconds,
  };
}
