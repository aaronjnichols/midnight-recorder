// One history entry. Entries from before elements, video fades, or captions
// existed have no such keys. Those states had none, so restore() reads them
// as empty, 0, or no captions.
const snapshot = ({
  segments,
  speed,
  muted,
  elements = [],
  fadeIn = 0,
  fadeOut = 0,
  captions = null,
}) => ({
  segments: structuredClone(segments),
  speed,
  muted,
  elements: structuredClone(elements),
  fadeIn,
  fadeOut,
  captions: structuredClone(captions),
});
const restore = (timeline, state) => ({
  ...timeline,
  segments: state.segments,
  speed: state.speed,
  muted: state.muted,
  elements: state.elements ?? [],
  fadeIn: state.fadeIn ?? 0,
  fadeOut: state.fadeOut ?? 0,
  captions: state.captions ?? null,
});

export const MAX_VIDEO_FADE = 10;

// Video fade from black at the start and to black at the end, in edited
// seconds. If both together are longer than the edited video, both get
// shorter in proportion. The stored values do not change.
export function videoFades(timeline) {
  const fadeIn = timeline.fadeIn ?? 0,
    fadeOut = timeline.fadeOut ?? 0;
  const total = duration(timeline);
  const scale = fadeIn + fadeOut > total ? total / (fadeIn + fadeOut) : 1;
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return {
    fadeIn,
    fadeOut,
    actualFadeIn: round(fadeIn * scale),
    actualFadeOut: round(fadeOut * scale),
  };
}

export function createTimeline(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("Video duration must be positive.");
  return {
    segments: [{ start: 0, end: seconds }],
    speed: 1,
    muted: false,
    past: [],
    future: [],
  };
}

export function duration(timeline) {
  return (
    timeline.segments.reduce((sum, s) => sum + s.end - s.start, 0) /
    timeline.speed
  );
}

export function isEdited(timeline, sourceDuration) {
  const [first] = timeline.segments;
  return !(
    timeline.segments.length === 1 &&
    first.start === 0 &&
    first.end === sourceDuration &&
    timeline.speed === 1 &&
    !timeline.muted &&
    !timeline.elements?.length &&
    !timeline.fadeIn &&
    !timeline.fadeOut &&
    !timeline.captions
  );
}

// Replace the element list and record one history entry.
export function withElements(timeline, elements) {
  return change(timeline, { elements });
}

// Replace the caption track (or null) and record one history entry.
export function withCaptions(timeline, captions) {
  return change(timeline, { captions });
}

// Undo keeps the latest steps. Each step stores a full copy of the edit
// state, including captions, so a limit keeps the library file and its
// reads bounded.
export const MAX_HISTORY = 100;
const remember = (past, state) => [...past, state].slice(-MAX_HISTORY);

function change(timeline, value) {
  return {
    ...timeline,
    ...value,
    past: remember(timeline.past, snapshot(timeline)),
    future: [],
  };
}

export function trim(timeline, start, end) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start >= duration(timeline) ||
    end <= start ||
    end > duration(timeline) + 1e-6
  ) {
    throw new Error("Select a valid time range within the edited video.");
  }
  let offset = 0;
  const segments = [];
  for (const segment of timeline.segments) {
    const length = (segment.end - segment.start) / timeline.speed;
    const left = Math.max(0, start - offset);
    const right = Math.min(length, end - offset);
    if (right > left)
      segments.push({
        start: segment.start + left * timeline.speed,
        end: segment.start + right * timeline.speed,
      });
    offset += length;
  }
  return change(timeline, { segments });
}

export function undo(timeline) {
  if (!timeline.past.length) return timeline;
  return {
    ...restore(timeline, timeline.past.at(-1)),
    past: timeline.past.slice(0, -1),
    future: [snapshot(timeline), ...timeline.future],
  };
}

export function redo(timeline) {
  if (!timeline.future.length) return timeline;
  return {
    ...restore(timeline, timeline.future[0]),
    past: remember(timeline.past, snapshot(timeline)),
    future: timeline.future.slice(1),
  };
}

export function configure(
  timeline,
  {
    speed = timeline.speed,
    muted = timeline.muted,
    fadeIn = timeline.fadeIn ?? 0,
    fadeOut = timeline.fadeOut ?? 0,
  },
) {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
    throw new Error("Speed must be between 0.5 and 2.");
  if (typeof muted !== "boolean")
    throw new Error("Muted must be true or false.");
  for (const [name, value] of [
    ["fadeIn", fadeIn],
    ["fadeOut", fadeOut],
  ])
    if (!Number.isFinite(value) || value < 0 || value > MAX_VIDEO_FADE)
      throw new Error(
        `${name} must be a number from 0 to ${MAX_VIDEO_FADE} seconds.`,
      );
  return change(timeline, { speed, muted, fadeIn, fadeOut });
}

export const RESET_SCOPES = ["all", "timeline", "elements", "captions"];

// Return to the original video. Scope "timeline" resets segments, speed,
// mute, and video fades. Scope "elements" removes all labels and shapes.
// Scope "captions" removes the captions. Scope "all" does all of these.
export function reset(timeline, sourceDuration, scope = "all") {
  if (!RESET_SCOPES.includes(scope))
    throw new Error("Invalid scope. Use all, timeline, elements, or captions.");
  const fresh = createTimeline(sourceDuration);
  const value = {};
  if (scope === "all" || scope === "timeline")
    Object.assign(value, {
      segments: fresh.segments,
      speed: fresh.speed,
      muted: fresh.muted,
      fadeIn: 0,
      fadeOut: 0,
    });
  if (scope === "all" || scope === "elements") value.elements = [];
  if (scope === "all" || scope === "captions") value.captions = null;
  return change(timeline, value);
}

export function cut(timeline, start, end) {
  const selected = trim(timeline, start, end);
  if (duration(selected) >= duration(timeline) - 1e-6)
    throw new Error("A cut must leave some video.");
  const segments = [];
  if (start > 0) segments.push(...trim(timeline, 0, start).segments);
  if (end < duration(timeline))
    segments.push(...trim(timeline, end, duration(timeline)).segments);
  return change(timeline, { segments });
}

// Stored and listed times have microsecond precision. An edited time less
// than 1 microsecond from a cut boundary is on the boundary. This also
// removes floating-point error, for example 0.088 * 1.25 < 0.11.
const BOUNDARY = 1e-6;

// Source time at an edited time. A time on a cut boundary maps to the first
// source time after the cut.
export function sourceTime(timeline, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration(timeline))
    throw new Error("Seek time is outside the edited range.");
  let remaining = seconds * timeline.speed;
  const tolerance = BOUNDARY * timeline.speed;
  for (const segment of timeline.segments) {
    const length = segment.end - segment.start;
    if (remaining < length - tolerance)
      return segment.start + Math.max(0, remaining);
    remaining -= length;
  }
  return timeline.segments.at(-1).end;
}

// Map an edited range to source seconds. The start maps to the first kept
// source time at that edited time. The end maps to the last kept source time
// before it. So a range that stops on a cut boundary does not include the
// source content after the cut.
export function sourceRange(timeline, start, end) {
  const total = duration(timeline);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > total + 1e-6
  )
    throw new Error(
      `Select a time range within the edited video, from 0 to ${total} seconds.`,
    );
  return {
    start: sourceTime(timeline, start),
    end: sourceEndTime(timeline, Math.min(end, total)),
  };
}

// Like sourceTime, but a time on a cut boundary maps to the end of the kept
// segment before the cut.
export function sourceEndTime(timeline, seconds) {
  let remaining = seconds * timeline.speed;
  const tolerance = BOUNDARY * timeline.speed;
  for (const segment of timeline.segments) {
    const length = segment.end - segment.start;
    if (remaining <= length + tolerance)
      return segment.start + Math.min(Math.max(0, remaining), length);
    remaining -= length;
  }
  return timeline.segments.at(-1).end;
}

// Length of a source range that is still in the edited video, in source
// seconds.
export function keptSourceSeconds(timeline, start, end) {
  return timeline.segments.reduce(
    (sum, s) =>
      sum + Math.max(0, Math.min(s.end, end) - Math.max(s.start, start)),
    0,
  );
}

export function editedTime(timeline, seconds) {
  let elapsed = 0;
  for (const segment of timeline.segments) {
    if (seconds <= segment.end)
      return (elapsed + Math.max(0, seconds - segment.start)) / timeline.speed;
    elapsed += segment.end - segment.start;
  }
  return elapsed / timeline.speed;
}
