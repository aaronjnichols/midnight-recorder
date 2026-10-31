// One history entry. Entries from before elements existed have no elements
// key. Those states had no elements, so restore() reads them as empty.
const snapshot = ({ segments, speed, muted, elements = [] }) => ({
  segments: structuredClone(segments),
  speed,
  muted,
  elements: structuredClone(elements),
});
const restore = (timeline, state) => ({
  ...timeline,
  segments: state.segments,
  speed: state.speed,
  muted: state.muted,
  elements: state.elements ?? [],
});

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
    !timeline.elements?.length
  );
}

// Replace the element list and record one history entry.
export function withElements(timeline, elements) {
  return change(timeline, { elements });
}

function change(timeline, value) {
  return {
    ...timeline,
    ...value,
    past: [...timeline.past, snapshot(timeline)],
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
    past: [...timeline.past, snapshot(timeline)],
    future: timeline.future.slice(1),
  };
}

export function configure(
  timeline,
  { speed = timeline.speed, muted = timeline.muted },
) {
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
    throw new Error("Speed must be between 0.5 and 2.");
  if (typeof muted !== "boolean")
    throw new Error("Muted must be true or false.");
  return change(timeline, { speed, muted });
}

// Return to the original video. Scope "timeline" resets segments, speed, and
// mute. Scope "elements" removes all elements. Scope "all" does both.
export function reset(timeline, sourceDuration, scope = "all") {
  if (!["all", "timeline", "elements"].includes(scope))
    throw new Error("Invalid scope. Use all, timeline, or elements.");
  const fresh = createTimeline(sourceDuration);
  const value = {};
  if (scope !== "elements")
    Object.assign(value, {
      segments: fresh.segments,
      speed: fresh.speed,
      muted: fresh.muted,
    });
  if (scope !== "timeline") value.elements = [];
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
