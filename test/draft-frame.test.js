import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  cut,
  configure,
  fadeShare,
} from "../src/domain/timeline.js";
import {
  addElement,
  updateElement,
  orderElement,
} from "../src/domain/elements.js";
import { draftFramePlan, draftFrameIndex } from "../src/domain/draft-frame.js";
import { draftBaseRevision, editRevision } from "../src/domain/inspection.js";
import { applyCaptions, configureCaptions } from "../src/domain/captions.js";

const frame = { width: 640, height: 360 };
const rate = 30;
const text = (id, extra = {}) => [
  id,
  { type: "text", text: id, start: 1, end: 5, ...extra },
];
function timeline(...elements) {
  let result = createTimeline(10);
  for (const [id, args] of elements) result = addElement(result, 10, id, args);
  return result;
}
const plan = (value, id, seconds) =>
  draftFramePlan(value, frame, id, seconds, rate);
const ids = (ops) => ops.map((op) => op.id);

test("a draft frame splits the shown elements around the edited element", () => {
  const value = timeline(text("a"), text("b"), text("c"), text("d"));
  const result = plan(value, "b", 2);
  assert.deepEqual(ids(result.below), ["a"]);
  assert.deepEqual(ids(result.above), ["c", "d"]);
  assert.equal(result.frameIndex, 60);
  assert.equal(result.seconds, 2);
});

test("a draft frame draws only the elements that the frame shows", () => {
  const value = timeline(
    text("early", { start: 0, end: 1 }),
    text("edited"),
    text("late", { start: 6, end: 8 }),
    text("here", { start: 1.9, end: 2.1 }),
  );
  const result = plan(value, "edited", 2);
  assert.deepEqual(ids(result.below), []);
  assert.deepEqual(ids(result.above), ["here"]);
});

test("a frame uses the same [start, end) rule on the output clock", () => {
  const value = timeline(
    text("edited"),
    text("ends", { start: 0, end: 2 }),
    text("starts", { start: 2, end: 3 }),
  );
  // Frame 60 is at 2 s. An end at 2 s does not show there.
  assert.deepEqual(ids(plan(value, "edited", 2).above), ["starts"]);
  // Frame 59 shows until 2 s, so 1.99 s selects frame 59.
  const earlier = plan(value, "edited", 1.99);
  assert.equal(earlier.frameIndex, 59);
  assert.deepEqual(ids(earlier.above), ["ends"]);
});

test("a time at the end of the video selects the last frame", () => {
  const value = timeline(text("edited"));
  assert.equal(plan(value, "edited", 10).frameIndex, 299);
});

test("the source time follows cuts and speed", () => {
  const value = configure(cut(timeline(text("edited")), 2, 4), { speed: 2 });
  // Edited 1.5 s at speed 2 is 3 s of kept video, so source 5 s.
  assert.equal(plan(value, "edited", 1.5).sourceSeconds, 5);
});

test("the edited element is in the plan with its layer, or absent when it is not drawn", () => {
  const value = timeline(text("a"), text("edited"));
  assert.equal(plan(value, "edited", 2).element.id, "edited");
  // Outside its time the element has no drawing, and the rest still splits.
  const outside = plan(value, "edited", 8);
  assert.equal(outside.element, null);
  assert.deepEqual(ids(outside.below), []);
  // Trim or cut can remove all of its content.
  const removed = cut(timeline(text("a"), text("edited")), 1, 5);
  const none = plan(removed, "edited", 1);
  assert.equal(none.element, null);
});

test("a missing element is an error", () => {
  assert.throws(() => plan(timeline(text("a")), "gone", 2), /was not found/);
});

test("the active caption is the top layer of the frame", () => {
  const base = timeline(text("edited"), text("above"));
  const { timeline: value } = applyCaptions(
    base,
    [{ sourceStart: 1, sourceEnd: 3, text: "Spoken words" }],
    { ids: () => "c1" },
  );
  const shown = plan(value, "edited", 2);
  assert.deepEqual(ids(shown.above), ["above", "caption"]);
  const caption = shown.above.at(-1);
  assert.equal(caption.text, "Spoken words");
  assert.equal(caption.type, "text");
  assert.equal(caption.opacity, 1);
  assert.deepEqual(ids(plan(value, "edited", 4).above), ["above"]);
  const off = configureCaptions(value, { enabled: false });
  assert.deepEqual(ids(plan(off, "edited", 2).above), ["above"]);
});

test("the plan gives the black level of the video fades at the frame", () => {
  const value = configure(timeline(text("edited")), { fadeIn: 2, fadeOut: 1 });
  assert.equal(plan(value, "edited", 1).fadeOpacity, 0.5);
  assert.equal(plan(value, "edited", 5).fadeOpacity, 0);
  assert.ok(Math.abs(plan(value, "edited", 9.5).fadeOpacity - 0.5) < 1e-9);
  assert.equal(plan(timeline(text("edited")), "edited", 5).fadeOpacity, 0);
});

test("a fade counts whole frames, the same as the export", () => {
  // Measured in real exports. Start and length round to whole frames.
  assert.equal(fadeShare(1, 30, 0, 0.05), 0.5);
  assert.equal(fadeShare(2, 30, 0, 0.05), 1);
  assert.equal(fadeShare(0, 30, 0, 0.05), 0);
  // 0.51 s is 15 frames, and 0.517 s is 16 frames.
  assert.equal(fadeShare(3, 30, 0, 0.51), 0.2);
  assert.equal(fadeShare(4, 30, 0, 0.517), 0.25);
  // A start between frames rounds: 1.483 s is frame 44.
  assert.equal(fadeShare(44, 30, 1.483, 0.517), 0);
  assert.equal(fadeShare(52, 30, 1.483, 0.517), 0.5);
  // A fade under half a frame takes one frame.
  assert.equal(fadeShare(0, 30, 0, 0.01), 0);
  assert.equal(fadeShare(1, 30, 0, 0.01), 1);
});

test("the frame index of a time needs no frame size", () => {
  const value = timeline(text("a"));
  assert.equal(draftFrameIndex(value, 2, rate), 60);
  assert.equal(draftFrameIndex(value, 1.99, rate), 59);
  assert.equal(draftFrameIndex(value, 10, rate), 299);
});

const video = (value) => ({ timeline: value });

test("the base revision ignores all changes to the edited element", () => {
  const value = timeline(text("a"), text("edited"));
  const before = draftBaseRevision(video(value), "edited");
  for (const changes of [
    { text: "Other words" },
    { x: 0.2 },
    { color: "#FF0000" },
    { size: 0.1, bold: true },
    { start: 2 },
  ]) {
    const next = updateElement(value, 10, "edited", changes);
    assert.notEqual(editRevision(video(next)), editRevision(video(value)));
    assert.equal(draftBaseRevision(video(next), "edited"), before);
  }
});

test("the base revision changes with anything around the edited element", () => {
  const value = timeline(text("a"), text("edited"), text("b"));
  const before = draftBaseRevision(video(value), "edited");
  const { timeline: captioned } = applyCaptions(
    value,
    [{ sourceStart: 1, sourceEnd: 3, text: "Words" }],
    { ids: () => "c1" },
  );
  for (const [name, next] of [
    ["other element", updateElement(value, 10, "a", { text: "New" })],
    ["layer order", orderElement(value, "edited", 2)],
    ["cut", cut(value, 6, 7)],
    ["speed", configure(value, { speed: 2 })],
    ["fade", configure(value, { fadeIn: 1 })],
    ["captions", captioned],
  ])
    assert.notEqual(draftBaseRevision(video(next), "edited"), before, name);
  assert.notEqual(draftBaseRevision(video(value), "a"), before);
});

test("mute is not part of the base revision", () => {
  const value = timeline(text("edited"));
  assert.equal(
    draftBaseRevision(video(configure(value, { muted: true })), "edited"),
    draftBaseRevision(video(value), "edited"),
  );
});
