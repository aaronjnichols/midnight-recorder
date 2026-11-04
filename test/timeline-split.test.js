// Split marks and the parts that they make. A mark is metadata beside the kept
// segments: it stores a source time, it removes nothing, and the rendered video
// does not change.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HISTORY,
  MAX_SPLITS,
  MIN_PART,
  addSplit,
  configure,
  createTimeline,
  cut,
  duration,
  isEdited,
  keepPart,
  redo,
  removePart,
  removeSource,
  removeSplit,
  reset,
  splitCheck,
  splitsOf,
  timelineParts,
  trim,
  undo,
  withElements,
} from "../src/domain/timeline.js";
import {
  editRevision,
  structureRevision,
  timingRevision,
} from "../src/domain/inspection.js";

const near = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message ?? "time"}: ${actual} is not ${expected}`,
  );
const video = (timeline) => ({ timeline });

test("a split adds a mark and no time, and it is one undo step", () => {
  const before = createTimeline(10);
  const split = addSplit(before, 4);

  assert.deepEqual(split.segments, before.segments, "The segments stay.");
  assert.equal(duration(split), 10);
  assert.equal(split.past.length, 1);
  assert.deepEqual(splitsOf(split), [{ id: "s4000000", source: 4 }]);
  // No output changes, so no render or transcript revision changes.
  assert.equal(editRevision(video(split)), editRevision(video(before)));
  assert.equal(timingRevision(video(split)), timingRevision(video(before)));
  assert.notEqual(
    structureRevision(video(split)),
    structureRevision(video(before)),
  );
  assert.equal(isEdited(split, 10), false, "A split alone is not an edit.");
});

test("a mark stores a source time, so cuts and speed move its edited time", () => {
  // Kept source: 0 to 2 and 4 to 10. Edited at 1.5x: 8 / 1.5 long.
  const edited = configure(cut(createTimeline(10), 2, 4), { speed: 1.5 });
  const total = duration(edited);
  const split = addSplit(edited, 3);
  // Edited 3 is 4.5 kept source seconds: 2 in the first segment, 2.5 after 4.
  near(splitsOf(split)[0].source, 6.5, "source");

  const parts = timelineParts(split);
  assert.equal(parts.length, 3);
  near(parts[0].end, 2 / 1.5);
  near(parts[1].start, 2 / 1.5);
  near(parts[1].end, 3);
  near(parts[2].start, 3);
  assert.equal(parts[2].end, total, "The last part ends at the exact end.");
  assert.deepEqual(
    parts.map((p) => p.seamBefore),
    [null, "cut", "split"],
  );

  // A speed change moves the edited time. The source time stays.
  const faster = configure(split, { speed: 1 });
  assert.equal(splitsOf(faster)[0].source, splitsOf(split)[0].source);
  near(timelineParts(faster)[2].start, 4.5);
});

test("a split near the start, the end, a join, or a mark saves nothing", () => {
  const edited = configure(cut(addSplit(createTimeline(10), 7), 2, 4), {
    speed: 1.5,
  });
  const total = duration(edited);
  const parts = timelineParts(edited);
  const history = edited.past.length;

  for (const [seconds, reason] of [
    [0, /start/],
    [MIN_PART / 2, /start/],
    [total, /end/],
    [total - MIN_PART / 2, /end/],
    // The exact join, and rounded values from a list.
    [parts[0].end, /join/],
    [parts[1].start + 1e-7, /join/],
    [parts[1].start - MIN_PART / 2, /join/],
    // The exact mark, and the rounded value of a mark.
    [parts[2].start, /already/],
    [Math.round(parts[2].start * 1e6) / 1e6, /already/],
    [parts[2].start + MIN_PART / 2, /already/],
  ]) {
    const check = splitCheck(edited, seconds);
    assert.equal(check.ok, false, `${seconds} is not valid`);
    assert.match(check.reason, reason);
    assert.throws(() => addSplit(edited, seconds), reason);
  }
  for (const seconds of [NaN, Infinity, -1, total + 1])
    assert.throws(() => addSplit(edited, seconds), /within the edited video/);
  assert.equal(edited.past.length, history);
});

test("a time exactly at the shortest part is a valid split", () => {
  const timeline = createTimeline(10);
  assert.equal(splitCheck(timeline, MIN_PART).ok, true);
  assert.equal(splitCheck(timeline, 10 - MIN_PART).ok, true);
  // Off a frame, and with more digits than microseconds.
  const split = addSplit(timeline, 1.23456789);
  assert.equal(splitsOf(split)[0].source, 1.234568);
  assert.equal(splitsOf(split)[0].id, "s1234568");
});

test("a video with only a floating-point rest refuses a split normally", () => {
  const tiny = trim(createTimeline(10), 1, 1.0000005);
  assert.deepEqual(timelineParts(tiny), []);
  for (const seconds of [0, 1e-7]) {
    const check = splitCheck(tiny, seconds);
    assert.equal(check.ok, false);
    assert.match(check.reason, /too short/);
    assert.throws(() => addSplit(tiny, seconds), /too short/);
  }
  assert.throws(() => removePart(tiny, "p1-2"), /not in the edited video/);
});

test("the shortest part holds after the time is rounded to microseconds", () => {
  for (const speed of [0.5, 0.75, 0.876543, 1, 1.234567, 1.25, 1.5, 2]) {
    const timeline = configure(createTimeline(10), { speed });
    const total = duration(timeline);
    for (const [seconds, index] of [
      [MIN_PART, 0],
      [total - MIN_PART, 1],
    ]) {
      const part = timelineParts(addSplit(timeline, seconds))[index];
      assert.ok(
        part.end - part.start >= MIN_PART - 1e-9,
        `${speed}: a part of ${part.end - part.start} seconds`,
      );
    }
  }
  // A part with no room on the microsecond grid for both sides.
  const narrow = configure(trim(createTimeline(10), 1, 1 + 0.1), {
    speed: 1.234567,
  });
  const middle = duration(narrow) / 2;
  const check = splitCheck(narrow, middle);
  assert.equal(check.ok, false, "Two parts cannot both reach the minimum.");
});

test("marks keep their order, their count has a limit, and the check is first", () => {
  let timeline = createTimeline(1000);
  for (let n = MAX_SPLITS; n >= 1; n--) timeline = addSplit(timeline, n);
  assert.equal(splitsOf(timeline).length, MAX_SPLITS);
  assert.deepEqual(
    splitsOf(timeline)
      .slice(0, 3)
      .map((s) => s.source),
    [1, 2, 3],
  );
  const history = timeline.past.length;
  assert.equal(history, Math.min(MAX_SPLITS, MAX_HISTORY));
  assert.match(splitCheck(timeline, 500).reason, /at most 200 splits/);
  assert.throws(() => addSplit(timeline, 500), /at most 200 splits/);
});

test("undo and redo restore marks in the shared history", () => {
  const first = addSplit(createTimeline(10), 4);
  const second = withElements(first, [{ id: "e" }]);
  const third = cut(second, 3, 5);
  assert.deepEqual(
    splitsOf(third),
    [],
    "The cut removed the time of the mark.",
  );
  const back = undo(third);
  assert.deepEqual(splitsOf(back), [{ id: "s4000000", source: 4 }]);
  assert.deepEqual(splitsOf(undo(undo(back))), []);
  const forward = redo(redo(undo(undo(back))));
  assert.deepEqual(splitsOf(forward), [{ id: "s4000000", source: 4 }]);
  assert.deepEqual(splitsOf(redo(forward)), []);
});

test("an old library and old history entries read as no marks", () => {
  const old = {
    segments: [{ start: 0, end: 10 }],
    speed: 1,
    muted: false,
    past: [{ segments: [{ start: 0, end: 5 }], speed: 1, muted: false }],
    future: [],
  };
  assert.deepEqual(splitsOf(old), []);
  assert.equal(timelineParts(old).length, 1);
  // A mark, then an undo to the old entry: the key does not stay behind.
  const split = addSplit(old, 3);
  assert.equal(split.past.length, 2);
  const back = undo(undo(split));
  assert.equal("splits" in back, false);
  // Empty marks do not add a key, so old states stay equal.
  assert.equal("splits" in createTimeline(10), false);
  assert.equal("splits" in undo(addSplit(createTimeline(10), 3)), false);
  assert.equal(
    "splits" in addSplit(createTimeline(10), 3).past[0],
    false,
    "No key in a state without marks.",
  );
});

test("reset clears marks with the timeline scopes only", () => {
  const timeline = addSplit(createTimeline(10), 4);
  for (const scope of ["all", "timeline"]) {
    const clean = reset(timeline, 10, scope);
    assert.deepEqual(splitsOf(clean), [], scope);
    assert.equal("splits" in clean, false, scope);
    assert.equal(clean.past.length, 2, `${scope}: one step`);
    assert.deepEqual(splitsOf(undo(clean)), splitsOf(timeline), scope);
  }
  for (const scope of ["elements", "captions"])
    assert.deepEqual(splitsOf(reset(timeline, 10, scope)), splitsOf(timeline));
});

test("trim and cut remove marks at or outside the kept source", () => {
  const timeline = addSplit(addSplit(addSplit(createTimeline(10), 2), 5), 8);
  assert.deepEqual(
    splitsOf(trim(timeline, 3, 9)).map((s) => s.source),
    [5, 8],
  );
  // A mark on the new edge is not inside a segment.
  assert.deepEqual(
    splitsOf(trim(timeline, 2, 8)).map((s) => s.source),
    [5],
  );
  assert.deepEqual(
    splitsOf(cut(timeline, 4, 6)).map((s) => s.source),
    [2, 8],
  );
});

test("removeSplit joins two parts and removes no time", () => {
  const timeline = addSplit(addSplit(createTimeline(10), 2), 5);
  const parts = timelineParts(timeline);
  assert.equal(parts[1].splitBefore, "s2000000");
  assert.equal(parts[1].splitAfter, "s5000000");
  const joined = removeSplit(timeline, parts[1].splitAfter);
  assert.deepEqual(
    splitsOf(joined).map((s) => s.source),
    [2],
  );
  assert.equal(joined.past.length, 3);
  assert.deepEqual(joined.segments, timeline.segments);
  assert.throws(() => removeSplit(timeline, "s1"), /not found/);
});

test("part IDs come from the source span, so they survive other changes", () => {
  const timeline = addSplit(createTimeline(10), 4);
  const [left, right] = timelineParts(timeline);
  assert.equal(left.id, "p0-4000000");
  assert.equal(right.id, "p4000000-10000000");
  const faster = configure(timeline, { speed: 2 });
  assert.equal(timelineParts(faster)[1].id, right.id, "Speed: same footage.");
  near(timelineParts(faster)[1].start, 2);
  const inside = addSplit(timeline, 7);
  assert.equal(timelineParts(inside)[0].id, left.id);
  assert.notEqual(timelineParts(inside)[1].id, right.id, "Other footage.");
});

test("removing a part cuts exactly its source and is one undo step", () => {
  const timeline = configure(addSplit(addSplit(createTimeline(10), 3), 7), {
    speed: 1.25,
  });
  const part = timelineParts(timeline)[1];
  const removed = removePart(timeline, part.id);
  assert.deepEqual(removed.segments, [
    { start: 0, end: 3 },
    { start: 7, end: 10 },
  ]);
  assert.equal(removed.past.length, timeline.past.length + 1);
  assert.deepEqual(splitsOf(removed), [], "Marks on the new edges end.");
  assert.deepEqual(undo(removed).segments, timeline.segments);
  assert.deepEqual(splitsOf(undo(removed)), splitsOf(timeline));
});

test("keeping a part leaves exactly its source and is one undo step", () => {
  const timeline = configure(addSplit(addSplit(createTimeline(10), 3), 7), {
    speed: 1.25,
  });
  const part = timelineParts(timeline)[1];
  const kept = keepPart(timeline, part.id);
  assert.deepEqual(kept.segments, [{ start: 3, end: 7 }]);
  assert.equal(kept.past.length, timeline.past.length + 1);
  near(duration(kept), 4 / 1.25);
  assert.deepEqual(undo(kept).segments, timeline.segments);
});

test("part commands reject an unknown part, the only part, and leave no history", () => {
  const whole = createTimeline(10);
  const [only] = timelineParts(whole);
  assert.throws(() => removePart(whole, only.id), /leave some video/);
  assert.throws(() => keepPart(whole, only.id), /full edited video/);
  assert.throws(() => removePart(whole, "p1-2"), /not in the edited video/);
  assert.throws(() => keepPart(whole, "p1-2"), /not in the edited video/);
  assert.equal(whole.past.length, 0);
});

test("removeSource subtracts one source interval from all kept segments", () => {
  // Kept: 0 to 2, 4 to 6, 8 to 10.
  const timeline = cut(cut(createTimeline(10), 2, 4), 4, 6);
  assert.deepEqual(timeline.segments, [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
    { start: 8, end: 10 },
  ]);
  const removed = removeSource(timeline, 1, 9);
  assert.deepEqual(removed.segments, [
    { start: 0, end: 1 },
    { start: 9, end: 10 },
  ]);
  assert.equal(removed.past.length, timeline.past.length + 1);
  // Removed source is not an edit.
  assert.throws(() => removeSource(timeline, 2.5, 3.5), /already removed/);
  assert.throws(() => removeSource(timeline, -5, 50), /leave some video/);
  assert.throws(() => removeSource(timeline, 5, 5), /valid/);
  assert.throws(() => removeSource(timeline, NaN, 5), /valid/);
  // A piece shorter than the stored precision does not stay.
  assert.deepEqual(removeSource(createTimeline(10), 0, 4.9999999999).segments, [
    { start: 4.9999999999, end: 10 },
  ]);
  assert.deepEqual(removeSource(createTimeline(10), 1e-9, 5).segments, [
    { start: 5, end: 10 },
  ]);
});

test("structureRevision changes with marks, segments, and speed only", () => {
  const timeline = addSplit(createTimeline(10), 4);
  const base = structureRevision(video(timeline));
  assert.equal(
    structureRevision(video(withElements(timeline, [{ id: "e" }]))),
    base,
    "Elements do not change the structure.",
  );
  assert.equal(
    structureRevision(video(configure(timeline, { muted: true }))),
    base,
    "Mute does not change the structure.",
  );
  assert.notEqual(
    structureRevision(video(configure(timeline, { speed: 2 }))),
    base,
  );
  assert.notEqual(structureRevision(video(cut(timeline, 1, 2))), base);
  assert.notEqual(structureRevision(video(addSplit(timeline, 6))), base);
  // Undo returns to the same structure.
  assert.equal(structureRevision(video(undo(addSplit(timeline, 6)))), base);
});
