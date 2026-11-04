// Rules of the direct timeline: pixels and times, zoom, the ruler, range drags,
// snapping, and lanes. No DOM or Electron dependency, so node:test checks it
// directly. All times are seconds in the edited video.
import { clock, playheadValue } from "./view-model.js";

// The shortest selection, the same as the shortest element or caption.
export const MIN_RANGE = 0.05;
// The shortest timing drag. Listed times are rounded, and they map to stored
// source times, so a drag stays just above the minimum of the domain.
export const LANE_MIN = MIN_RANGE + 1e-5;
// About 13 pixels for each frame at 30 frames per second.
export const MAX_PIXELS_PER_SECOND = 400;
export const ZOOM_STEP = 1.6;
// A press that moves less than this is a click, not a drag.
export const DRAG_THRESHOLD = 4;
export const SNAP_PIXELS = 6;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The time at a pointer position. rect is the box of the track on screen. It
// includes zoom and scroll, so there is no separate scroll calculation. The
// track ends give exactly 0 and exactly the edited duration.
export function timeAt(clientX, rect, total) {
  if (!(rect.width > 0)) return 0;
  return clamp((clientX - rect.left) / rect.width, 0, 1) * total;
}

// Zoom 1 shows the full video. The largest zoom has a fixed number of pixels
// for each second, so a long video can zoom further than a short one.
export function maxZoom(total, width) {
  if (!(total > 0) || !(width > 0)) return 1;
  return Math.max(1, (MAX_PIXELS_PER_SECOND * total) / width);
}

// A new zoom that keeps the time at anchorX in place. anchorX is in pixels
// from the left of the view. width is the view width, which is also the
// track width at zoom 1.
export function zoomAbout({ zoom, next, anchorX, scrollLeft, width, total }) {
  const target = clamp(next, 1, maxZoom(total, width));
  const fraction = (scrollLeft + anchorX) / (width * zoom);
  const most = width * target - width;
  return {
    zoom: target,
    scrollLeft: clamp(fraction * width * target - anchorX, 0, most),
  };
}

const STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200,
];

// The smallest ruler step with room for a label.
export function rulerStep(pxPerSecond, minimum = 72) {
  return (
    STEPS.find((step) => step * pxPerSecond >= minimum) ??
    STEPS[STEPS.length - 1]
  );
}

const tickLabel = (time, step) =>
  step < 1
    ? `${clock(time)}.${Math.round((time - Math.floor(time)) * 10) % 10}`
    : clock(time);

// The ruler ticks from start to end. Only this window is drawn, so a long
// video at a large zoom has few nodes. Each time comes from its index, so
// floating point error does not add up.
export function rulerTicks({ start, end, pxPerSecond }) {
  const step = rulerStep(pxPerSecond);
  const ticks = [];
  const first = Math.ceil(start / step - 1e-9);
  for (let index = first; index * step <= end + 1e-9; index++) {
    const time = Math.round(index * step * 1e6) / 1e6;
    ticks.push({ time, label: tickLabel(time, step) });
  }
  return ticks;
}

// The next range during a drag. mode is create, start, end, or move. anchor
// is the time at the start of the drag. lower and upper limit the range.
export function dragRange({
  mode,
  origin,
  anchor,
  time,
  total,
  lower = 0,
  upper = total,
  min = MIN_RANGE,
}) {
  // An interval shorter than the minimum: the range can fill it, and it
  // never leaves it.
  const least = Math.min(min, upper - lower);
  if (mode === "start")
    return {
      start: clamp(time, lower, Math.max(lower, origin.end - least)),
      end: origin.end,
    };
  if (mode === "end")
    return {
      start: origin.start,
      end: clamp(time, Math.min(upper, origin.start + least), upper),
    };
  if (mode === "move") {
    const length = origin.end - origin.start;
    // The fields show two decimals. A rounded move keeps the length.
    const delta = Math.round((time - anchor) * 100) / 100;
    const most = upper - length;
    const start = clamp(origin.start + delta, lower, most);
    return { start, end: start === most ? upper : start + length };
  }
  const from = clamp(anchor, lower, upper);
  const to = clamp(time, lower, upper);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  if (end - start >= least) return { start, end };
  return start + least <= upper
    ? { start, end: start + least }
    : { start: Math.max(lower, upper - least), end: upper };
}

// The text for the selection fields: two decimals, and the exact end.
export function draftValues({ start, end }, total) {
  return {
    start: playheadValue(start, total),
    end: playheadValue(end, total),
  };
}

// A key on a handle. Returns the new value, or null if the key is not for
// the handle.
export function handleKey({ key, shiftKey }, value, { min, max }) {
  const small = shiftKey ? 1 : 0.1;
  const change = {
    ArrowRight: small,
    ArrowUp: small,
    ArrowLeft: -small,
    ArrowDown: -small,
    PageUp: 5,
    PageDown: -5,
  }[key];
  if (key === "Home") return min;
  if (key === "End") return max;
  return change === undefined ? null : clamp(value + change, min, max);
}

// The nearest point in the tolerance, or the time. Floating point sums can
// fall just outside a tolerance, so the check has a small margin.
export function snapTime(time, points, tolerance) {
  let best = time,
    distance = tolerance + 1e-9;
  for (const point of points) {
    const gap = Math.abs(point - time);
    if (gap <= distance) {
      best = point;
      distance = gap;
    }
  }
  return best;
}

// The scroll position that shows x. A position in view does not move the
// view. Otherwise x goes near the left of the view, so playback continues
// across the full width.
export function keepInView({ x, scrollLeft, width, margin = 40 }) {
  if (x >= scrollLeft + margin && x <= scrollLeft + width - margin)
    return scrollLeft;
  return Math.max(0, x - margin);
}

// Puts items on rows so that items on a row do not overlap. If no row is
// free, the item goes on the last row and has overflow true.
export function packLanes(items, rows) {
  const ends = new Array(rows).fill(-Infinity);
  return [...items]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((item) => {
      const free = ends.findIndex((end) => end <= item.start);
      const row = free === -1 ? rows - 1 : free;
      ends[row] = Math.max(ends[row], item.end);
      return { ...item, row, overflow: free === -1 };
    });
}

// The times that a timing drag changed. A drag sends only these keys, so a
// stored time that a cut hides stays. Times have the microsecond precision of
// stored times: a coarser value can move a valid stop past the shortest
// length or into the next caption. A time at the edited end is the exact end.
export function timingChanges(origin, next, total) {
  const changes = {};
  for (const key of ["start", "end"]) {
    if (Math.abs(next[key] - origin[key]) < 5e-7) continue;
    changes[key] =
      Math.abs(next[key] - total) < 5e-7
        ? total
        : Math.round(next[key] * 1e6) / 1e6;
  }
  return changes;
}

// The line on the track that tells the state of the sound and the frames.
// Returns null when the track shows all of it. retry is true when a new read
// can help.
export function overviewNote({ audio, frames, muted }) {
  const failed = audio.state === "failed" || frames.state === "failed";
  if (audio.state === "failed" && frames.state === "failed")
    return { text: "Cannot read the sound or the frames", retry: true };
  if (audio.state === "failed")
    return { text: "Cannot read the sound", retry: true };
  if (frames.state === "failed")
    return { text: "Cannot read the frames", retry: true };
  if (audio.state === "reading")
    return { text: "Reading the sound and frames…", retry: failed };
  if (audio.state === "none")
    return { text: "No sound in this video", retry: false };
  if (audio.state === "silent")
    return { text: "The sound track is silent", retry: false };
  if (muted) return { text: "Muted in this edit", retry: false };
  if (frames.state === "reading")
    return { text: "Reading frames…", retry: false };
  if (frames.state === "partial")
    return { text: "Some frames only. The read took too long.", retry: false };
  return null;
}
