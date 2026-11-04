// One history entry. Entries from before elements, video fades, captions, or
// split marks existed have no such keys. Those states had none, so restore()
// reads them as empty, 0, or no captions. A state without marks has no splits
// key, so old states stay equal.
const snapshot = ({
  segments,
  speed,
  muted,
  elements = [],
  fadeIn = 0,
  fadeOut = 0,
  captions = null,
  splits = [],
}) => ({
  segments: structuredClone(segments),
  speed,
  muted,
  elements: structuredClone(elements),
  fadeIn,
  fadeOut,
  captions: structuredClone(captions),
  ...(splits.length ? { splits: structuredClone(splits) } : {}),
});
function restore({ splits: _, ...timeline }, state) {
  return {
    ...timeline,
    segments: state.segments,
    speed: state.speed,
    muted: state.muted,
    elements: state.elements ?? [],
    fadeIn: state.fadeIn ?? 0,
    fadeOut: state.fadeOut ?? 0,
    captions: state.captions ?? null,
    ...(state.splits?.length ? { splits: state.splits } : {}),
  };
}

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

// The part of a fade that is complete at an output frame, 0 to 1. The FFmpeg
// fade filter counts whole frames: it rounds the start and the length to
// frames, and a fade has at least one frame. This is measured against real
// exports, so a short fade is not a smooth line in seconds.
export function fadeShare(frame, rate, start, length) {
  const frames = Math.max(1, Math.round(length * rate));
  const share = (frame - Math.round(start * rate)) / frames;
  return Math.min(1, Math.max(0, share));
}

// The level of the picture at an output frame: 1 is full and 0 is black.
export function videoFadeLevel(timeline, frame, rate) {
  const { actualFadeIn, actualFadeOut } = videoFades(timeline);
  const fadeOutStart = Math.max(0, duration(timeline) - actualFadeOut);
  return (
    (actualFadeIn > 0 ? fadeShare(frame, rate, 0, actualFadeIn) : 1) *
    (actualFadeOut > 0
      ? 1 - fadeShare(frame, rate, fadeOutStart, actualFadeOut)
      : 1)
  );
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

function change({ splits, ...timeline }, value) {
  const next = {
    ...timeline,
    ...value,
    past: remember(timeline.past, snapshot({ ...timeline, splits })),
    future: [],
  };
  // A mark that is not inside a kept segment has no use. Undo restores it.
  const marks = (value.splits ?? splits ?? []).filter((mark) =>
    next.segments.some((segment) => inside(mark.source, segment)),
  );
  if (marks.length) next.splits = marks;
  else delete next.splits;
  return next;
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
// mute, video fades, and split marks. Scope "elements" removes all labels and
// shapes. Scope "captions" removes the captions. Scope "all" does all of these.
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
      splits: [],
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

// Split marks. A mark is a source time beside the kept segments. It removes
// nothing, and the renderer, the transcript, and the captions do not read it,
// so a split cannot change the output. A mark and a cut join divide the edited
// video into parts. Parts are derived: they are never stored.
export const MAX_SPLITS = 200;
// The shortest part that a split can make, in edited seconds. It is the same
// as the shortest selection. A later cut or speed change can make a part
// shorter.
export const MIN_PART = 0.05;

const microseconds = (seconds) => Math.round(seconds * 1e6);
const inside = (source, { start, end }) =>
  source > start + BOUNDARY && source < end - BOUNDARY;

export const splitsOf = (timeline) => timeline.splits ?? [];

// The parts of the edited video, in order. A part ID has the source span of
// the part, so an old ID cannot name other footage. seamBefore tells what is
// at the start of a part: a cut join, a split mark, or nothing.
export function timelineParts(timeline) {
  const { segments, speed } = timeline;
  const parts = [];
  let elapsed = 0;
  for (const [index, segment] of segments.entries()) {
    const edges = [
      { source: segment.start, seam: index ? "cut" : null, split: null },
      ...splitsOf(timeline)
        .filter((mark) => inside(mark.source, segment))
        .map((mark) => ({
          source: mark.source,
          seam: "split",
          split: mark.id,
        })),
      { source: segment.end, seam: null, split: null },
    ];
    const edited = (source) => (elapsed + source - segment.start) / speed;
    for (const [n, from] of edges.slice(0, -1).entries()) {
      const to = edges[n + 1];
      // A floating-point rest of an earlier edit has no time to show.
      if (to.source - from.source < BOUNDARY) continue;
      parts.push({
        id: `p${microseconds(from.source)}-${microseconds(to.source)}`,
        index: parts.length,
        start: edited(from.source),
        end: edited(to.source),
        sourceStart: from.source,
        sourceEnd: to.source,
        seamBefore: from.seam,
        splitBefore: from.split,
        splitAfter: to.split,
      });
    }
    elapsed += segment.end - segment.start;
  }
  if (parts.length) parts.at(-1).end = duration(timeline);
  return parts;
}

// Tells if a split can go at an edited time, and why not. The check uses edited
// seconds, the same as the user sees, so a fractional speed cannot make a
// repeated mark. The app disables its button with the same check.
export function splitCheck(timeline, seconds) {
  const refuse = (reason) => ({ ok: false, reason });
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > duration(timeline) + BOUNDARY
  )
    return refuse("Select a split time within the edited video.");
  const parts = timelineParts(timeline);
  if (!parts.length) return refuse("This video is too short to split.");
  const part = parts.find((item) => seconds < item.end) ?? parts.at(-1);
  const fromStart = seconds - part.start,
    fromEnd = part.end - seconds;
  const near = (distance) => distance < MIN_PART - 1e-9;
  if (near(fromStart) || near(fromEnd)) {
    const first = near(fromStart) && (!near(fromEnd) || fromStart <= fromEnd);
    const seam = first ? part.seamBefore : parts[part.index + 1]?.seamBefore;
    return refuse(
      seam === "split"
        ? "The video already has a split at this time."
        : seam === "cut"
          ? "This time is at a join between kept parts. Move the playhead."
          : `This time is at the ${first ? "start" : "end"} of the video. Move the playhead.`,
    );
  }
  if (splitsOf(timeline).length >= MAX_SPLITS)
    return refuse(
      `A video can have at most ${MAX_SPLITS} splits. Remove a split or use Undo.`,
    );
  const source = gridTime(part, seconds, timeline.speed);
  return source === undefined
    ? refuse("There is no room for a split at this time. Move the playhead.")
    : { ok: true, source };
}

// A stored time has microsecond precision. Rounding can move a time just inside
// the shortest part, so this takes the nearest microsecond with room on both
// sides. Undefined when there is none.
function gridTime(part, seconds, speed) {
  const tick = (part.sourceStart + (seconds - part.start) * speed) * 1e6;
  const room = (source) =>
    (source - part.sourceStart) / speed >= MIN_PART - 1e-9 &&
    (part.sourceEnd - source) / speed >= MIN_PART - 1e-9;
  return [Math.round(tick), Math.ceil(tick), Math.floor(tick)]
    .map((value) => value / 1e6)
    .find(room);
}

// One history step. The kept segments do not change.
export function addSplit(timeline, seconds) {
  const check = splitCheck(timeline, seconds);
  if (!check.ok) throw new Error(check.reason);
  const mark = { id: `s${microseconds(check.source)}`, source: check.source };
  return change(timeline, {
    splits: [...splitsOf(timeline), mark].sort((a, b) => a.source - b.source),
  });
}

export function removeSplit(timeline, splitId) {
  const marks = splitsOf(timeline);
  if (!marks.some((mark) => mark.id === splitId))
    throw new Error("This split was not found. Read parts.list again.");
  return change(timeline, {
    splits: marks.filter((mark) => mark.id !== splitId),
  });
}

// Subtract one source interval from the kept segments, as one history step.
// It uses source times, so there is no round trip through edited time. A rest
// shorter than the stored precision does not stay.
export function removeSource(timeline, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("Select a valid source time range.");
  const segments = [];
  let removed = 0;
  for (const segment of timeline.segments) {
    const from = Math.max(segment.start, start),
      to = Math.min(segment.end, end);
    if (to <= from) {
      segments.push({ start: segment.start, end: segment.end });
      continue;
    }
    removed += to - from;
    if (from - segment.start >= BOUNDARY)
      segments.push({ start: segment.start, end: from });
    if (segment.end - to >= BOUNDARY)
      segments.push({ start: to, end: segment.end });
  }
  if (removed < BOUNDARY)
    throw new Error("This part of the video is already removed.");
  if (!segments.length) throw new Error("A cut must leave some video.");
  return change(timeline, { segments });
}

function findPart(timeline, partId) {
  const part = timelineParts(timeline).find((item) => item.id === partId);
  if (!part)
    throw new Error(
      "This part is not in the edited video. Read parts.list again.",
    );
  return part;
}

export function removePart(timeline, partId) {
  const { sourceStart, sourceEnd } = findPart(timeline, partId);
  return removeSource(timeline, sourceStart, sourceEnd);
}

export function keepPart(timeline, partId) {
  const { sourceStart, sourceEnd } = findPart(timeline, partId);
  if (timelineParts(timeline).length === 1)
    throw new Error("This part is the full edited video.");
  return change(timeline, {
    segments: [{ start: sourceStart, end: sourceEnd }],
  });
}

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
