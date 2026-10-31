const snapshot = ({ segments, speed, muted }) => ({
  segments: structuredClone(segments),
  speed,
  muted,
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
    ...timeline,
    ...timeline.past.at(-1),
    past: timeline.past.slice(0, -1),
    future: [snapshot(timeline), ...timeline.future],
  };
}

export function redo(timeline) {
  if (!timeline.future.length) return timeline;
  return {
    ...timeline,
    ...timeline.future[0],
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

export function sourceTime(timeline, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration(timeline))
    throw new Error("Seek time is outside the edited range.");
  let remaining = seconds * timeline.speed;
  for (const segment of timeline.segments) {
    const length = segment.end - segment.start;
    if (remaining < length) return segment.start + remaining;
    remaining -= length;
  }
  return timeline.segments.at(-1).end;
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
