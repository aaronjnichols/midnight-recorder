import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  trim,
  cut,
  configure,
  undo,
  redo,
  isEdited,
  reset,
} from "../src/domain/timeline.js";
import {
  elementsOf,
  addElement,
  updateElement,
  duplicateElement,
  orderElement,
  removeElement,
  describeElements,
  renderPlan,
} from "../src/domain/elements.js";
import {
  editRevision,
  timingRevision,
  inspectionPlan,
} from "../src/domain/inspection.js";

const text = (extra = {}) => ({
  type: "text",
  text: "Hello",
  start: 1,
  end: 3,
  ...extra,
});

test("element edits share the undo history and old history restores no elements", () => {
  // An old library record: no elements in the timeline or in its history.
  const old = {
    segments: [{ start: 2, end: 8 }],
    speed: 1,
    muted: false,
    past: [{ segments: [{ start: 0, end: 10 }], speed: 1, muted: false }],
    future: [],
  };
  const frozen = structuredClone(old);
  assert.deepEqual(elementsOf(old), []);
  const added = addElement(old, 10, "a", text());
  assert.deepEqual(old, frozen, "The input timeline must not change.");
  assert.deepEqual(
    elementsOf(added).map((e) => e.id),
    ["a"],
  );
  assert.equal(added.past.length, 2);
  const undone = undo(added);
  assert.deepEqual(elementsOf(undone), []);
  assert.deepEqual(undone.segments, [{ start: 2, end: 8 }]);
  const older = undo(undone);
  assert.deepEqual(older.segments, [{ start: 0, end: 10 }]);
  assert.deepEqual(elementsOf(older), [], "An old snapshot has no elements.");
  const again = redo(redo(older));
  assert.deepEqual(again.segments, [{ start: 2, end: 8 }]);
  assert.equal(elementsOf(again)[0].text, "Hello");
  const trimmed = trim(again, 0, 2);
  assert.equal(elementsOf(trimmed).length, 1, "A trim keeps the element data.");
  assert.equal(elementsOf(undo(trimmed)).length, 1);
  const plain = createTimeline(10);
  assert.equal(isEdited(plain, 10), false);
  assert.equal(isEdited(addElement(plain, 10, "b", text()), 10), true);
});

const times = (timeline) =>
  describeElements(timeline).map(
    ({ id, sourceStart, sourceEnd, start, end, visibility }) => ({
      id,
      sourceStart,
      sourceEnd,
      start,
      end,
      visibility,
    }),
  );

test("elements stay on the same source content through cut, speed, and trim", () => {
  let t = addElement(createTimeline(20), 20, "a", text({ start: 5, end: 9 }));
  assert.deepEqual(times(t), [
    {
      id: "a",
      sourceStart: 5,
      sourceEnd: 9,
      start: 5,
      end: 9,
      visibility: "full",
    },
  ]);
  // Remove source 6 to 8. The element keeps source 5 to 6 and 8 to 9.
  t = cut(t, 6, 8);
  assert.deepEqual(times(t)[0], {
    id: "a",
    sourceStart: 5,
    sourceEnd: 9,
    start: 5,
    end: 7,
    visibility: "partial",
  });
  t = configure(t, { speed: 2 });
  assert.deepEqual([times(t)[0].start, times(t)[0].end], [2.5, 3.5]);
  // Keep only edited 0 to 2.5 (source 0 to 5). Nothing of the element stays.
  const removed = trim(t, 0, 2.5);
  assert.deepEqual(times(removed)[0], {
    id: "a",
    sourceStart: 5,
    sourceEnd: 9,
    start: null,
    end: null,
    visibility: "none",
  });
  assert.deepEqual(times(undo(removed)), times(t));
});

test("edited times on a cut boundary map to the correct side", () => {
  // Segments are source 0 to 4 and 8 to 20. Edited time 4 is the boundary.
  const c = cut(createTimeline(20), 4, 8);
  let t = addElement(c, 20, "before", text({ start: 2, end: 4 }));
  t = addElement(t, 20, "after", text({ start: 4, end: 6 }));
  t = addElement(t, 20, "end", text({ start: 15, end: 16 }));
  t = addElement(
    t,
    20,
    "source",
    text({ start: 3, end: 9, timeBase: "source" }),
  );
  assert.deepEqual(times(t), [
    {
      id: "before",
      sourceStart: 2,
      sourceEnd: 4,
      start: 2,
      end: 4,
      visibility: "full",
    },
    {
      id: "after",
      sourceStart: 8,
      sourceEnd: 10,
      start: 4,
      end: 6,
      visibility: "full",
    },
    {
      id: "end",
      sourceStart: 19,
      sourceEnd: 20,
      start: 15,
      end: 16,
      visibility: "full",
    },
    {
      id: "source",
      sourceStart: 3,
      sourceEnd: 9,
      start: 3,
      end: 5,
      visibility: "partial",
    },
  ]);
  assert.throws(
    () =>
      addElement(c, 20, "x", text({ start: 5, end: 7, timeBase: "source" })),
    /not in the edited video/,
  );
  assert.throws(
    () =>
      addElement(c, 20, "x", text({ start: 19, end: 21, timeBase: "source" })),
    /source video/,
  );
  assert.throws(
    () => addElement(c, 20, "x", text({ start: 15, end: 16.5 })),
    /edited video/,
  );
});

test("fractional cut boundaries keep starts after the cut and ends before it", () => {
  // Review reproduction: cut source 0.11 to 2.11, then speed 1.25. The cut
  // is at edited 0.088, but 0.088 * 1.25 is 0.10999999999999999.
  const c = configure(cut(createTimeline(10), 0.11, 2.11), { speed: 1.25 });
  const pick = (t) =>
    times(t).map(({ sourceStart, sourceEnd, visibility }) => [
      sourceStart,
      sourceEnd,
      visibility,
    ]);
  const after = addElement(c, 10, "a", text({ start: 0.088, end: 1.088 }));
  assert.deepEqual(pick(after), [[2.11, 3.36, "full"]]);
  // With the cut removed, the element still starts on the same content.
  assert.equal(describeElements(reset(after, 10, "timeline"))[0].start, 2.11);
  // An end on the boundary stays before the cut.
  const before = addElement(c, 10, "b", text({ start: 0, end: 0.088 }));
  assert.deepEqual(pick(before), [[0, 0.11, "full"]]);
  // One millisecond on each side of the boundary is real content there.
  const left = addElement(c, 10, "c", text({ start: 0.087, end: 0.5 }));
  assert.equal(elementsOf(left)[0].sourceStart, 0.10875);
  const right = addElement(c, 10, "d", text({ start: 0, end: 0.089 }));
  assert.equal(elementsOf(right)[0].sourceEnd, 2.11125);
  // element.list gives edited times in microseconds. Such a value on a
  // boundary maps to the same side as the exact boundary.
  const slow = configure(cut(createTimeline(10), 0.11, 2.11), { speed: 1.3 });
  const listed = Math.round((0.11 / 1.3) * 1e6) / 1e6;
  assert.deepEqual(
    pick(addElement(slow, 10, "e", text({ start: listed, end: 1 }))).map(
      (e) => e[0],
    ),
    [2.11],
  );
  assert.deepEqual(
    pick(addElement(slow, 10, "f", text({ start: 0, end: listed }))).map(
      (e) => e[1],
    ),
    [0.11],
  );
  // Partial updates use the same rules and keep the other stored time.
  let u = addElement(c, 10, "g", text({ start: 0.5, end: 1 }));
  u = updateElement(u, 10, "g", { start: 0.088 });
  assert.deepEqual(pick(u)[0].slice(0, 1), [2.11]);
  u = addElement(c, 10, "h", text({ start: 0, end: 0.05 }));
  u = updateElement(u, 10, "h", { end: 0.088 });
  assert.deepEqual(pick(u)[0], [0, 0.11, "full"]);
});

test("text elements reject values outside documented bounds", () => {
  const base = createTimeline(10);
  const add = (extra) => addElement(base, 10, "a", text(extra));
  const cases = [
    [{ type: "shape" }, /type/],
    [{ text: undefined }, /Text/],
    [{ text: " \n\t " }, /Text must contain/],
    [{ text: "x".repeat(501) }, /500 characters/],
    [{ text: Array(11).fill("line").join("\n") }, /10 lines/],
    [{ text: "bell\u0007" }, /control characters/],
    [{ text: "half \ud800" }, /Unicode/],
    [{ start: 1, end: 1.04 }, /0\.05 seconds/],
    [{ x: -0.1 }, /x must be/],
    [{ y: 1.2 }, /y must be/],
    [{ x: Number.NaN }, /x must be/],
    [{ width: 0 }, /width must be/],
    [{ height: 0.001 }, /height must be/],
    [{ x: 0.5, width: 0.6 }, /inside the frame/],
    [{ y: 0.9, height: 0.2 }, /inside the frame/],
    [{ size: 0.005 }, /size must be/],
    [{ size: 0.6 }, /size must be/],
    [{ font: "comic" }, /font/],
    [{ bold: "yes" }, /bold/],
    [{ color: "red" }, /color/],
    [{ color: "#FFF" }, /color/],
    [{ opacity: 0 }, /opacity must be/],
    [{ opacity: 1.5 }, /opacity must be/],
    [{ align: "justify" }, /align/],
    [{ verticalAlign: "center" }, /verticalAlign/],
    [{ background: "black" }, /background/],
    [{ backgroundOpacity: 2 }, /backgroundOpacity must be/],
    [{ outline: "#12345G" }, /outline/],
  ];
  for (const [extra, message] of cases)
    assert.throws(() => add(extra), message, JSON.stringify(extra));
  const [element] = elementsOf(
    add({
      text: "a\r\nb\rc",
      color: "#ff00aa",
      background: "#00FF00",
      outline: "none",
    }),
  );
  assert.equal(element.text, "a\nb\nc");
  assert.equal(element.color, "#FF00AA");
  assert.equal(element.background, "#00FF00");
  assert.equal(element.outline, "none");
  // The limit counts characters, not UTF-16 units.
  assert.equal(elementsOf(add({ text: "é".repeat(500) }))[0].text.length, 500);
  assert.equal(
    elementsOf(add({ text: "😀".repeat(500) }))[0].text.length,
    1000,
  );
  let full = base;
  for (let i = 0; i < 100; i++) full = addElement(full, 10, `e${i}`, text());
  assert.throws(() => addElement(full, 10, "extra", text()), /100 elements/);
  assert.throws(
    () => addElement(full, 10, "e1", text()),
    /100 elements|exists/,
  );
  assert.throws(
    () => addElement(addElement(base, 10, "a", text()), 10, "a", text()),
    /exists/,
  );
  assert.throws(
    () => add({ text: "a" + String.fromCharCode(0x2028) + "b" }),
    /control characters/,
  );
});

test("update, duplicate, order, remove, and reset make one history entry each", () => {
  let t = addElement(createTimeline(10), 10, "a", text({ text: "First" }));
  t = addElement(t, 10, "b", text({ text: "Second", start: 2, end: 4 }));
  const steps = t.past.length;
  t = updateElement(t, 10, "a", { text: "Changed", x: 0.2, width: 0.5 });
  assert.equal(t.past.length, steps + 1);
  let [a] = describeElements(t);
  assert.deepEqual(
    [a.text, a.x, a.width, a.start, a.end],
    ["Changed", 0.2, 0.5, 1, 3],
  );
  t = updateElement(t, 10, "a", { end: 5 });
  [a] = describeElements(t);
  assert.deepEqual([a.start, a.end], [1, 5]);
  assert.equal(
    updateElement(t, 10, "a", { text: "Changed" }),
    t,
    "An update with no change makes no history entry.",
  );
  assert.throws(() => updateElement(t, 10, "a", {}), /at least one/);
  assert.throws(() => updateElement(t, 10, "zz", { x: 0 }), /not found/);
  assert.throws(
    () => updateElement(t, 10, "a", { x: 0.6 }),
    /inside the frame/,
  );
  assert.throws(() => updateElement(t, 10, "a", { start: 6 }), /range/);
  assert.throws(() => updateElement(t, 10, "a", { type: "text" }), /type/);
  t = duplicateElement(t, "a", "c");
  assert.deepEqual(
    describeElements(t).map((e) => [e.id, e.layer, e.text]),
    [
      ["a", 0, "Changed"],
      ["c", 1, "Changed"],
      ["b", 2, "Second"],
    ],
  );
  assert.throws(() => duplicateElement(t, "a", "b"), /exists/);
  t = orderElement(t, "a", 2);
  assert.deepEqual(
    elementsOf(t).map((e) => e.id),
    ["c", "b", "a"],
  );
  assert.throws(() => orderElement(t, "a", 3), /index/);
  assert.throws(() => orderElement(t, "a", 0.5), /index/);
  assert.equal(orderElement(t, "a", 2), t);
  t = removeElement(t, "b");
  assert.deepEqual(
    elementsOf(t).map((e) => e.id),
    ["c", "a"],
  );
  assert.throws(() => removeElement(t, "b"), /not found/);
  // Reset scopes.
  t = cut(t, 0, 1);
  const onlyTimeline = reset(t, 10, "timeline");
  assert.deepEqual(onlyTimeline.segments, [{ start: 0, end: 10 }]);
  assert.equal(elementsOf(onlyTimeline).length, 2);
  const onlyElements = reset(t, 10, "elements");
  assert.deepEqual(onlyElements.segments, t.segments);
  assert.deepEqual(elementsOf(onlyElements), []);
  const all = reset(t, 10);
  assert.deepEqual(all.segments, [{ start: 0, end: 10 }]);
  assert.deepEqual(elementsOf(all), []);
  assert.equal(isEdited(all, 10), false);
  assert.deepEqual(undo(all).segments, t.segments);
  assert.equal(elementsOf(undo(all)).length, 2);
  assert.throws(() => reset(t, 10, "audio"), /scope/);
});

test("an update to one time keeps the other stored source time", () => {
  // Source 5 to 9. A trim removes source 5 to 6, so the element is partial.
  let t = addElement(createTimeline(20), 20, "a", text({ start: 5, end: 9 }));
  t = trim(t, 6, 20);
  t = updateElement(t, 20, "a", { end: 4 });
  assert.deepEqual(times(t), [
    {
      id: "a",
      sourceStart: 5,
      sourceEnd: 10,
      start: 0,
      end: 4,
      visibility: "partial",
    },
  ]);
  t = updateElement(t, 20, "a", { start: 1 });
  assert.deepEqual(
    [elementsOf(t)[0].sourceStart, elementsOf(t)[0].sourceEnd],
    [7, 10],
  );
  assert.throws(
    () => updateElement(t, 20, "a", { end: 1.02 }),
    /0\.05 seconds/,
  );
  assert.throws(() => updateElement(t, 20, "a", { start: 4 }), /range|after/);
});

test("the edit revision includes elements and the timing revision does not", () => {
  const video = (timeline) => ({ id: "v", timeline });
  const plain = createTimeline(10);
  const withText = addElement(plain, 10, "a", text());
  const moved = updateElement(withText, 10, "a", { x: 0.05 });
  const revisions = [plain, withText, moved].map((t) => editRevision(video(t)));
  assert.equal(new Set(revisions).size, 3);
  assert.ok(revisions.every((r) => typeof r === "string" && r.length <= 40));
  assert.equal(editRevision(video(undo(moved))), revisions[1]);
  // A stored copy gives the same revision.
  assert.equal(
    editRevision(video(JSON.parse(JSON.stringify(moved)))),
    revisions[2],
  );
  // Transcripts map time only. Text does not change that mapping.
  assert.equal(
    timingRevision(video(moved)),
    JSON.stringify({ segments: plain.segments, speed: 1, muted: false }),
  );
  assert.equal(timingRevision(video(moved)), timingRevision(video(plain)));
});

test("a transcript revision still selects frames when only elements changed", () => {
  const before = { id: "v", timeline: createTimeline(10) };
  const transcript = timingRevision(before);
  const after = {
    ...before,
    timeline: addElement(before.timeline, 10, "a", text()),
  };
  // The transcript to inspection procedure passes the transcript revision.
  assert.equal(
    inspectionPlan(after, { timestamps: [1], revision: transcript }).revision,
    editRevision(after),
  );
  assert.throws(
    () =>
      inspectionPlan(after, {
        timestamps: [1],
        revision: editRevision(before),
      }),
    /edits changed/,
  );
  const cutVideo = { ...after, timeline: cut(after.timeline, 0, 1) };
  assert.throws(
    () => inspectionPlan(cutVideo, { timestamps: [1], revision: transcript }),
    /edits changed/,
  );
});

test("the render plan maps boxes to pixels and times to edited seconds in layer order", () => {
  let t = addElement(
    createTimeline(20),
    20,
    "low",
    text({
      text: "Low",
      start: 2,
      end: 6,
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.25,
      size: 0.1,
      background: "#102030",
      backgroundOpacity: 0.5,
    }),
  );
  t = addElement(t, 20, "gone", text({ start: 12, end: 14 }));
  t = addElement(
    t,
    20,
    "top",
    text({
      text: "Top",
      start: 0,
      end: 20,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      outline: "none",
      align: "left",
      verticalAlign: "bottom",
    }),
  );
  t = configure(cut(t, 10, 15), { speed: 2 });
  const plan = renderPlan(t, { width: 960, height: 540 });
  assert.deepEqual(
    plan.map((op) => op.id),
    ["low", "top"],
    "A removed element is not drawn.",
  );
  const [low, top] = plan;
  assert.deepEqual(
    [low.start, low.end, low.x, low.y, low.width, low.height, low.fontSize],
    [1, 3, 240, 270, 480, 135, 54],
  );
  assert.deepEqual(
    [low.text, low.background, low.backgroundOpacity, low.outline],
    ["Low", "#102030", 0.5, "#000000"],
  );
  assert.ok(low.outlineWidth >= 1);
  assert.ok(low.padding > 0 && low.padding < 135 / 2);
  assert.deepEqual(
    [top.start, top.end, top.x, top.y, top.width, top.height],
    [0, 7.5, 0, 0, 960, 540],
  );
  assert.deepEqual(
    [top.align, top.verticalAlign, top.outlineWidth],
    ["left", "bottom", 0],
  );
});
