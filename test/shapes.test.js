import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  cut,
  configure,
  undo,
} from "../src/domain/timeline.js";
import {
  addElement,
  updateElement,
  duplicateElement,
  describeElements,
  elementsOf,
  renderPlan,
  ELEMENT_TYPES,
} from "../src/domain/elements.js";

const base = () => createTimeline(10);
const one = (timeline) => describeElements(timeline)[0];

test("rectangles, ellipses, and arrows store checked type properties", () => {
  assert.deepEqual(ELEMENT_TYPES, ["text", "rectangle", "ellipse", "arrow"]);
  const box = one(
    addElement(base(), 10, "r", {
      type: "rectangle",
      start: 1,
      end: 3,
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.2,
      fill: "#ff0000",
      fillOpacity: 0.5,
      stroke: "#00ff00",
      strokeWidth: 0.01,
    }),
  );
  assert.deepEqual(
    [box.type, box.fill, box.fillOpacity, box.stroke, box.strokeWidth],
    ["rectangle", "#FF0000", 0.5, "#00FF00", 0.01],
  );
  assert.deepEqual([box.opacity, box.fadeIn, box.fadeOut], [1, 0, 0]);
  assert.equal(box.text, undefined, "A shape has no text.");
  const ellipse = one(
    addElement(base(), 10, "e", { type: "ellipse", start: 0, end: 1 }),
  );
  assert.equal(ellipse.type, "ellipse");
  assert.ok(ellipse.stroke !== "none" || ellipse.fill !== "none");
  const arrow = one(
    addElement(base(), 10, "a", {
      type: "arrow",
      start: 0,
      end: 2,
      x1: 0.1,
      y1: 0.8,
      x2: 0.45,
      y2: 0.5,
      color: "#ebcb8b",
    }),
  );
  assert.deepEqual(
    [arrow.x1, arrow.y1, arrow.x2, arrow.y2, arrow.color],
    [0.1, 0.8, 0.45, 0.5, "#EBCB8B"],
  );
  // The selection box of an arrow is its bounds.
  assert.deepEqual(
    [arrow.x, arrow.y, arrow.width, arrow.height],
    [0.1, 0.5, 0.35, 0.3],
  );
});

test("shape and arrow values outside the documented bounds are rejected", () => {
  const add = (args) =>
    addElement(base(), 10, "s", { start: 0, end: 1, ...args });
  for (const [args, message] of [
    [{ type: "rectangle", fill: "none", stroke: "none" }, /fill or a line/],
    [{ type: "rectangle", fill: "red" }, /fill must be a color/],
    [{ type: "rectangle", fillOpacity: 1.5 }, /fillOpacity must be/],
    [{ type: "rectangle", strokeWidth: 0.2 }, /strokeWidth must be/],
    [{ type: "ellipse", x: 0.8, width: 0.3 }, /inside the frame/],
    [{ type: "rectangle", text: "Hello" }, /does not use text/],
    [{ type: "text", text: "Hi", fill: "#FFFFFF" }, /does not use fill/],
    [{ type: "arrow", x1: 0.5, y1: 0.5, x2: 0.505, y2: 0.5 }, /at least 0\.02/],
    [{ type: "arrow", x2: 1.2 }, /x2 must be/],
    [{ type: "arrow", color: "none" }, /color must be a color/],
    [{ type: "arrow", stroke: "#FFFFFF" }, /does not use stroke/],
    [{ type: "rectangle", strokeWidth: 0.001 }, /strokeWidth must be/],
    [{ type: "arrow", width: 0.2 }, /does not use width/],
    [{ type: "rectangle", fadeIn: -1 }, /fadeIn must be/],
    [{ type: "text", text: "Hi", fadeOut: 11 }, /fadeOut must be/],
  ])
    assert.throws(() => add(args), message, JSON.stringify(args));
});

test("review: a shape must have a visible part, and the minimum arrow length is accepted", () => {
  const add = (args) =>
    addElement(base(), 10, "s", { start: 0, end: 1, ...args });
  // Finding 1: a fill with 0 opacity and no line draws nothing.
  for (const type of ["rectangle", "ellipse"])
    assert.throws(
      () => add({ type, fill: "#FF0000", fillOpacity: 0, stroke: "none" }),
      /visible fill or a line/,
    );
  let t = add({
    type: "rectangle",
    fill: "#FF0000",
    fillOpacity: 1,
    stroke: "none",
  });
  assert.throws(
    () => updateElement(t, 10, "s", { fillOpacity: 0 }),
    /visible fill/,
  );
  assert.equal(
    one(add({ type: "rectangle", fill: "#FF0000", fillOpacity: 0 })).stroke,
    "#EBCB8B",
  );
  // Finding 2: exactly the minimum length, in any direction.
  for (const [x1, x2] of [
    [0.1, 0.12],
    [0.3, 0.32],
    [0.7, 0.68],
  ])
    assert.equal(one(add({ type: "arrow", x1, y1: 0.5, x2, y2: 0.5 })).x2, x2);
  assert.throws(
    () => add({ type: "arrow", x1: 0.1, y1: 0.5, x2: 0.1199, y2: 0.5 }),
    /at least 0\.02/,
  );
});

test("updates keep the type and only the given keys, and duplicates copy shapes", () => {
  let t = addElement(base(), 10, "a", {
    type: "arrow",
    start: 1,
    end: 4,
    x1: 0.1,
    y1: 0.1,
    x2: 0.5,
    y2: 0.5,
  });
  t = updateElement(t, 10, "a", { x2: 0.7, y2: 0.6 });
  assert.deepEqual([one(t).x1, one(t).x2, one(t).y2], [0.1, 0.7, 0.6]);
  assert.throws(
    () => updateElement(t, 10, "a", { fill: "#FFFFFF" }),
    /does not use fill/,
  );
  assert.throws(
    () => updateElement(t, 10, "a", { x2: 0.11, y2: 0.1 }),
    /at least 0\.02/,
  );
  t = duplicateElement(t, "a", "b");
  assert.deepEqual(
    elementsOf(t).map((e) => [e.id, e.type, e.x2]),
    [
      ["a", "arrow", 0.7],
      ["b", "arrow", 0.7],
    ],
  );
  // An old text element without fade keys reads with fades 0, and an update
  // that changes nothing makes no history entry.
  const old = {
    ...base(),
    elements: [
      {
        id: "old",
        type: "text",
        sourceStart: 1,
        sourceEnd: 2,
        text: "Old",
        x: 0.1,
        y: 0.4,
        width: 0.8,
        height: 0.2,
        font: "sans",
        bold: false,
        size: 0.06,
        color: "#FFFFFF",
        opacity: 1,
        align: "center",
        verticalAlign: "middle",
        background: "none",
        backgroundOpacity: 0.75,
        outline: "#000000",
      },
    ],
  };
  assert.deepEqual([one(old).fadeIn, one(old).fadeOut], [0, 0]);
  assert.equal(updateElement(old, 10, "old", { text: "Old" }), old);
  assert.equal(updateElement(old, 10, "old", { fadeIn: 0 }), old);
  assert.equal(one(updateElement(old, 10, "old", { fadeIn: 0.5 })).fadeIn, 0.5);
});

test("element fades report actual values after cuts, speed, and short intervals", () => {
  let t = addElement(base(), 10, "a", {
    type: "rectangle",
    start: 2,
    end: 4,
    fadeIn: 0.5,
    fadeOut: 1,
  });
  let e = one(t);
  assert.deepEqual([e.actualFadeIn, e.actualFadeOut], [0.5, 1]);
  // Double speed: the element shows for 1 edited second. 0.5 + 1 is longer,
  // so both scale down in proportion. The stored request does not change.
  t = configure(t, { speed: 2 });
  e = one(t);
  assert.deepEqual([e.fadeIn, e.fadeOut], [0.5, 1]);
  assert.ok(Math.abs(e.actualFadeIn - 1 / 3) < 1e-6, String(e.actualFadeIn));
  assert.ok(Math.abs(e.actualFadeOut - 2 / 3) < 1e-6, String(e.actualFadeOut));
  // A cut that removes most of the element.
  t = cut(undo(t), 2.1, 3.95);
  e = one(t);
  assert.ok(Math.abs(e.end - e.start - 0.15) < 1e-6);
  assert.ok(Math.abs(e.actualFadeIn + e.actualFadeOut - 0.15) < 1e-6);
  const plan = renderPlan(t, { width: 640, height: 360 })[0];
  assert.ok(Math.abs(plan.fadeIn - e.actualFadeIn) < 1e-9);
  assert.ok(Math.abs(plan.fadeOut - e.actualFadeOut) < 1e-9);
});

test("the render plan gives pixel geometry for shapes and arrow tips", () => {
  let t = addElement(base(), 10, "r", {
    type: "rectangle",
    start: 0,
    end: 2,
    x: 0.25,
    y: 0.25,
    width: 0.5,
    height: 0.5,
    strokeWidth: 0.02,
  });
  t = addElement(t, 10, "a", {
    type: "arrow",
    start: 0,
    end: 2,
    x1: 0.1,
    y1: 0.9,
    x2: 0.5,
    y2: 0.5,
    strokeWidth: 0.02,
  });
  const [rect, arrow] = renderPlan(t, { width: 640, height: 360 });
  assert.deepEqual(
    [rect.x, rect.y, rect.width, rect.height, rect.strokeWidth],
    [160, 90, 320, 180, 7],
  );
  assert.deepEqual(
    [arrow.x1, arrow.y1, arrow.x2, arrow.y2],
    [64, 324, 320, 180],
  );
  assert.equal(arrow.strokeWidth, 7);
  // The arrow polygon ends exactly at the tip.
  assert.ok(arrow.points.some(([x, y]) => x === 320 && y === 180));
});
