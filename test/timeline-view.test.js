// Pure rules of the direct timeline: pixels to time, zoom, ruler, range drags,
// snapping, and lanes. No DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  configure,
  cut,
  duration,
} from "../src/domain/timeline.js";
import {
  applyCaptions,
  cueLimits,
  describeCaptions,
  updateCue,
} from "../src/domain/captions.js";
import {
  addElement,
  describeElements,
  updateElement,
} from "../src/domain/elements.js";
import {
  LANE_MIN,
  MIN_RANGE,
  MAX_PIXELS_PER_SECOND,
  timeAt,
  maxZoom,
  zoomAbout,
  rulerStep,
  rulerTicks,
  dragRange,
  draftValues,
  handleKey,
  overviewNote,
  snapTime,
  keepInView,
  packLanes,
  timingChanges,
} from "../src/ui/timeline-view.js";

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} is not near ${expected}`,
  );

test("a pointer position maps to a time and stops at the track ends", () => {
  const rect = { left: 100, width: 500 };
  near(timeAt(100, rect, 10), 0);
  near(timeAt(350, rect, 10), 5);
  near(timeAt(600, rect, 10), 10);
  assert.equal(timeAt(20, rect, 10), 0, "Before the track is the start.");
  // The exact end, also when the time is not a round number.
  const total = 10 / 1.5;
  assert.equal(timeAt(900, rect, total), total);
  assert.equal(timeAt(600, rect, total), total);
});

test("the rectangle of a zoomed and scrolled track gives the same mapping", () => {
  // At zoom 4 the track is 4000 px wide. It scrolled 1500 px, so its left
  // edge is at -1500 + the scroller position. No separate scroll math exists.
  const left = 40 - 1500;
  const rect = { left, width: 4000 };
  near(timeAt(40 + 1500, rect, 20), 15);
  near(timeAt(40 + 500, rect, 20), 10);
});

test("zoom has a limit from the pixels for each second", () => {
  // 30 seconds on 1000 px is 33.3 px/s, so 12x gives 400 px/s.
  near(maxZoom(30, 1000), (MAX_PIXELS_PER_SECOND * 30) / 1000);
  assert.equal(maxZoom(1, 1000), 1, "A short video needs no zoom.");
  assert.equal(maxZoom(0, 1000), 1);
  assert.equal(maxZoom(10, 0), 1);
});

test("zoom keeps the time under the anchor in place", () => {
  const width = 1000;
  const total = 100;
  const before = { zoom: 2, scrollLeft: 300 };
  const anchorX = 250;
  const at = ((before.scrollLeft + anchorX) / (width * before.zoom)) * total;
  const after = zoomAbout({ ...before, next: 3, anchorX, width, total });
  assert.equal(after.zoom, 3);
  near(((after.scrollLeft + anchorX) / (width * after.zoom)) * total, at, 1e-6);
  // Limits: never below Fit, never past the maximum, never scrolled past the
  // ends.
  assert.deepEqual(
    zoomAbout({ zoom: 2, scrollLeft: 900, next: 0.5, anchorX, width, total }),
    { zoom: 1, scrollLeft: 0 },
  );
  const most = zoomAbout({
    zoom: 2,
    scrollLeft: 0,
    next: 1e9,
    anchorX: 0,
    width,
    total,
  });
  assert.equal(most.zoom, maxZoom(total, width));
  const end = zoomAbout({
    zoom: 2,
    scrollLeft: 1000,
    next: 1.5,
    anchorX: 1000,
    width,
    total,
  });
  assert.ok(end.scrollLeft <= width * 1.5 - width);
});

test("ruler steps stay readable at each zoom", () => {
  assert.equal(rulerStep(400), 0.2);
  assert.equal(rulerStep(100), 1);
  assert.equal(rulerStep(30), 5);
  assert.equal(rulerStep(1), 120);
  assert.equal(rulerStep(0.1), 1200);
  const ticks = rulerTicks({ start: 8, end: 12.5, pxPerSecond: 100 });
  assert.deepEqual(
    ticks.map((t) => t.time),
    [8, 9, 10, 11, 12],
  );
  assert.deepEqual(
    ticks.map((t) => t.label),
    ["0:08", "0:09", "0:10", "0:11", "0:12"],
  );
  const fine = rulerTicks({ start: 0, end: 0.5, pxPerSecond: 400 });
  assert.deepEqual(
    fine.map((t) => t.label),
    ["0:00.0", "0:00.2", "0:00.4"],
  );
  const long = rulerTicks({ start: 3540, end: 3700, pxPerSecond: 2 });
  assert.deepEqual(
    long.map((t) => t.label),
    ["59:00", "1:00:00", "1:01:00"],
  );
  // Floating point does not add a tick or a wrong label.
  const many = rulerTicks({ start: 0, end: 3, pxPerSecond: 200 });
  assert.equal(many.at(-1).label, "0:03.0");
  assert.equal(many.length, 7);
});

test("keys move a handle in small and large steps inside its limits", () => {
  const limits = { min: 0, max: 9.95 };
  const key = (name, value, shiftKey = false) =>
    handleKey({ key: name, shiftKey }, value, limits);
  near(key("ArrowRight", 2), 2.1);
  near(key("ArrowLeft", 2), 1.9);
  near(key("ArrowUp", 2), 2.1);
  near(key("ArrowDown", 2), 1.9);
  near(key("ArrowRight", 2, true), 3);
  near(key("ArrowLeft", 2, true), 1);
  near(key("PageUp", 2), 7);
  near(key("PageDown", 7), 2);
  assert.equal(key("Home", 5), 0);
  assert.equal(key("End", 5), 9.95);
  assert.equal(key("ArrowRight", 9.95), 9.95, "It stops at the limit.");
  assert.equal(key("ArrowLeft", 0.05), 0);
  assert.equal(key("a", 5), null, "Another key is not for the handle.");
});

test("a new selection follows the pointer in both directions", () => {
  const drag = (anchor, time) =>
    dragRange({ mode: "create", anchor, time, total: 10 });
  assert.deepEqual(drag(2, 5), { start: 2, end: 5 });
  assert.deepEqual(drag(5, 2), { start: 2, end: 5 });
  assert.deepEqual(drag(5, -3), { start: 0, end: 5 });
  assert.deepEqual(drag(5, 30), { start: 5, end: 10 });
  // A very short drag still gives a range that an edit accepts.
  const short = drag(5, 5.01);
  near(short.end - short.start, MIN_RANGE);
  const atEnd = drag(10, 9.99);
  near(atEnd.end, 10);
  near(atEnd.end - atEnd.start, MIN_RANGE);
});

test("a handle stops at the other handle and at the ends", () => {
  const origin = { start: 2, end: 6 };
  const handle = (mode, time) =>
    dragRange({ mode, origin, time, total: 10, anchor: 0 });
  assert.deepEqual(handle("start", 3), { start: 3, end: 6 });
  assert.deepEqual(handle("start", -1), { start: 0, end: 6 });
  near(handle("start", 9).start, 6 - MIN_RANGE);
  assert.equal(handle("start", 9).end, 6);
  assert.deepEqual(handle("end", 8), { start: 2, end: 8 });
  assert.deepEqual(handle("end", 50), { start: 2, end: 10 });
  near(handle("end", 0).end, 2 + MIN_RANGE);
  assert.equal(handle("end", 0).start, 2);
});

test("a selection moves without a change of length and stops at the ends", () => {
  const origin = { start: 2, end: 5 };
  const move = (delta, total = 10) =>
    dragRange({ mode: "move", origin, anchor: 3, time: 3 + delta, total });
  assert.deepEqual(move(1), { start: 3, end: 6 });
  assert.deepEqual(move(-1), { start: 1, end: 4 });
  assert.deepEqual(move(-20), { start: 0, end: 3 });
  assert.deepEqual(move(20), { start: 7, end: 10 });
  // The exact end at a fractional speed stays exact.
  const total = 10 / 1.5;
  const moved = move(20, total);
  assert.equal(moved.end, total);
  near(moved.end - moved.start, 3);
});

test("a time range can have lower and upper limits", () => {
  const args = { origin: { start: 4, end: 5 }, total: 20, lower: 3, upper: 6 };
  assert.deepEqual(dragRange({ ...args, mode: "start", time: 1, anchor: 0 }), {
    start: 3,
    end: 5,
  });
  assert.deepEqual(dragRange({ ...args, mode: "end", time: 19, anchor: 0 }), {
    start: 4,
    end: 6,
  });
  assert.deepEqual(dragRange({ ...args, mode: "move", anchor: 4, time: 19 }), {
    start: 5,
    end: 6,
  });
  assert.deepEqual(dragRange({ ...args, mode: "move", anchor: 4, time: 0 }), {
    start: 3,
    end: 4,
  });
});

test("draft values show two decimals and keep the exact end", () => {
  const total = 10 / 1.5;
  assert.deepEqual(draftValues({ start: 1.234, end: 3.456 }, total), {
    start: "1.23",
    end: "3.46",
  });
  assert.deepEqual(draftValues({ start: 0, end: total }, total), {
    start: "0",
    end: String(total),
  });
  // Near the end is the end. The field value is the exact end.
  assert.equal(
    draftValues({ start: 1, end: total - 0.001 }, total).end,
    String(total),
  );
  // A start near the end stays before it after rounding.
  const late = draftValues({ start: total - 0.05, end: total }, total);
  assert.ok(Number(late.start) < Number(late.end));
});

test("snapping uses the nearest point in the tolerance", () => {
  const points = [0, 3, 3.5, 10];
  assert.equal(snapTime(3.1, points, 0.2), 3);
  assert.equal(snapTime(3.3, points, 0.2), 3.5);
  assert.equal(snapTime(5, points, 0.2), 5);
  assert.equal(snapTime(9.95, points, 0.1), 10);
});

test("the view follows a time only when the time is out of view", () => {
  const view = { scrollLeft: 500, width: 1000, margin: 40 };
  assert.equal(keepInView({ ...view, x: 900 }), 500, "In view.");
  assert.equal(keepInView({ ...view, x: 1600 }), 1560);
  assert.equal(keepInView({ ...view, x: 100 }), 60);
  assert.equal(keepInView({ ...view, x: 10 }), 0, "Not before the start.");
});

test("lanes put overlapping items on different rows", () => {
  const rows = packLanes(
    [
      { id: "a", start: 0, end: 4 },
      { id: "b", start: 1, end: 3 },
      { id: "c", start: 5, end: 6 },
      { id: "d", start: 2, end: 8 },
    ],
    2,
  );
  const of = (id) => rows.find((item) => item.id === id);
  assert.equal(of("a").row, 0);
  assert.equal(of("b").row, 1);
  assert.equal(of("c").row, 0);
  // No free row: the item stays on the last row, and the data tells it.
  assert.equal(of("d").row, 1);
  assert.equal(of("d").overflow, true);
  assert.equal(of("a").overflow, false);
});

test("a timing drag sends only the times that changed", () => {
  const origin = { start: 1, end: 3 };
  assert.deepEqual(timingChanges(origin, { start: 1, end: 3 }, 10), {});
  assert.deepEqual(timingChanges(origin, { start: 1.25, end: 3 }, 10), {
    start: 1.25,
  });
  assert.deepEqual(timingChanges(origin, { start: 2, end: 4 }, 10), {
    start: 2,
    end: 4,
  });
  // The exact end stays exact and is not past the video.
  const total = 10 / 1.5;
  assert.equal(
    timingChanges(origin, { start: 1, end: total }, total).end,
    total,
  );
});

test("a timing drag keeps the precision that makes it valid", () => {
  // The smallest length from a start with microseconds. Rounding to
  // milliseconds gives 0.049544 seconds, which the domain rejects.
  const origin = { start: 0.123456, end: 1 };
  const next = dragRange({ mode: "end", origin, time: 0.12, total: 2 });
  const changes = timingChanges(origin, next, 2);
  near(changes.end - origin.start, MIN_RANGE, 1e-6);
  assert.ok(changes.end - origin.start >= MIN_RANGE - 5e-6);
  // A stop at the next caption stays at its exact start.
  const stop = dragRange({
    mode: "end",
    origin: { start: 1, end: 1.2 },
    time: 9,
    total: 10,
    upper: 1.456789,
  });
  assert.equal(timingChanges({ start: 1, end: 1.2 }, stop, 10).end, 1.456789);
  // Floating point noise in a time does not make a new value.
  assert.deepEqual(
    timingChanges(origin, { start: 0.1234560001, end: 1 }, 2),
    {},
  );
});

test("a range stays inside an interval that is shorter than the minimum", () => {
  const within = (range, lower, upper) => {
    assert.ok(range.start >= lower, `Start ${range.start}.`);
    assert.ok(range.end <= upper, `End ${range.end}.`);
    assert.ok(range.end > range.start, JSON.stringify(range));
  };
  const total = 1 / 30;
  const origin = { start: 0, end: total };
  within(dragRange({ mode: "create", anchor: 0, time: 0.01, total }), 0, total);
  within(dragRange({ mode: "start", origin, time: 0.03, total }), 0, total);
  within(dragRange({ mode: "end", origin, time: 0, total }), 0, total);
  within(
    dragRange({ mode: "move", origin, anchor: 0, time: 1, total }),
    0,
    total,
  );
  const limits = { total: 10, lower: 0.2, upper: 0.23 };
  within(
    dragRange({ ...limits, mode: "create", anchor: 0.22, time: 0.21 }),
    0.2,
    0.23,
  );
  within(
    dragRange({
      ...limits,
      mode: "start",
      origin: { start: 0.2, end: 0.23 },
      time: 0.3,
    }),
    0.2,
    0.23,
  );
  within(
    dragRange({
      ...limits,
      mode: "end",
      origin: { start: 0.2, end: 0.23 },
      time: 0,
    }),
    0.2,
    0.23,
  );
});

test("the track tells the true state of the sound and frames", () => {
  const note = (audio, frames, muted = false) =>
    overviewNote({ audio: { state: audio }, frames: { state: frames }, muted });
  assert.equal(note("ready", "ready"), null, "Nothing to tell.");
  assert.match(note("reading", "reading").text, /Reading/);
  assert.equal(note("reading", "reading").retry, false);
  assert.match(note("ready", "reading").text, /Reading frames/);
  assert.match(note("none", "ready").text, /no sound/i);
  assert.equal(note("none", "ready").retry, false);
  assert.match(note("silent", "ready").text, /silent/i);
  assert.match(note("ready", "ready", true).text, /Muted/);
  assert.match(note("none", "ready", true).text, /no sound/i);
  assert.match(note("failed", "ready").text, /Cannot read the sound/);
  assert.equal(note("failed", "ready").retry, true);
  assert.match(note("ready", "failed").text, /Cannot read the frames/);
  assert.equal(note("ready", "failed").retry, true);
  assert.match(note("failed", "failed").text, /Cannot read/);
  assert.match(note("ready", "partial").text, /Some frames/);
  assert.equal(note("ready", "partial").retry, false);
});

// Captions with these source times. Each has the ID of its first letter.
function captioned(timeline, cues) {
  let index = 0;
  const ids = () => cues[index++][0];
  return applyCaptions(
    timeline,
    cues.map(([, sourceStart, sourceEnd]) => ({
      sourceStart,
      sourceEnd,
      text: "Words",
      check: false,
    })),
    { ids },
  ).timeline;
}
const cueEnd = (timeline, id) =>
  timeline.captions.cues.find((cue) => cue.id === id).sourceEnd;
const cueStart = (timeline, id) =>
  timeline.captions.cues.find((cue) => cue.id === id).sourceStart;
// A drag of one cue edge as far as it goes, sent to the real domain rule.
function dragCue(timeline, id, mode, time) {
  const row = describeCaptions(timeline).cues.find((cue) => cue.id === id);
  const origin = { start: row.start, end: row.end };
  const total = duration(timeline);
  const next = dragRange({
    mode,
    origin,
    time,
    total,
    min: LANE_MIN,
    ...cueLimits(timeline, id),
  });
  return updateCue(timeline, 20, id, timingChanges(origin, next, total));
}

test("a caption stops at the captions around it, at any speed", () => {
  for (const speed of [1, 1.5, 0.876543, 2, 0.5]) {
    const timeline = configure(
      captioned(createTimeline(20), [
        ["a", 1, 1.5],
        ["b", 3, 4],
        ["c", 6, 7],
      ]),
      { speed },
    );
    const longer = dragCue(timeline, "b", "end", 1000);
    assert.ok(cueEnd(longer, "b") <= 6, `${speed}: end before the next cue.`);
    assert.ok(cueEnd(longer, "b") > 5.99, `${speed}: end near the next cue.`);
    const earlier = dragCue(timeline, "b", "start", 0);
    assert.ok(cueStart(earlier, "b") >= 1.5, `${speed}: after the last cue.`);
    assert.ok(cueStart(earlier, "b") < 1.51, `${speed}: near the last cue.`);
  }
});

test("a caption that a cut hides still limits the caption beside it", () => {
  // Source 3 to 6 is cut, with the hidden caption in it.
  const timeline = cut(
    captioned(createTimeline(20), [
      ["a", 2, 3],
      ["h", 4, 5],
      ["c", 7, 8],
    ]),
    3,
    6,
  );
  const a = cueLimits(timeline, "a");
  near(a.upper, 3, 0.001, "A stops at the join, before the hidden caption.");
  const longer = dragCue(timeline, "a", "end", 1000);
  assert.ok(cueEnd(longer, "a") <= 3);
  const c = cueLimits(timeline, "c");
  near(c.lower, 3, 0.001, "C stops at the join, after the hidden caption.");
  const earlier = dragCue(timeline, "c", "start", 0);
  assert.ok(cueStart(earlier, "c") >= 6);
  // The first and last captions go to the video ends.
  const open = captioned(createTimeline(20), [["a", 2, 3]]);
  assert.deepEqual(cueLimits(open, "a"), { lower: 0, upper: 20 });
});

test("the shortest element drag is valid at a speed with long decimals", () => {
  const timeline = configure(createTimeline(20), { speed: 0.876543 });
  const added = addElement(timeline, 20, "e", {
    type: "rectangle",
    start: 0.00004,
    end: 2,
    timeBase: "source",
  });
  const [element] = describeElements(added);
  const origin = { start: element.start, end: element.end };
  const total = duration(added);
  const next = dragRange({
    mode: "end",
    origin,
    time: 0,
    total,
    min: LANE_MIN,
  });
  const changes = timingChanges(origin, next, total);
  const shorter = updateElement(added, 20, "e", changes);
  const [result] = describeElements(shorter);
  assert.ok(result.end - result.start >= MIN_RANGE, String(result.end));
  assert.ok(result.end - result.start < MIN_RANGE + 0.001);
});
