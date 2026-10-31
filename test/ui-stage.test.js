import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentRect,
  toFrame,
  moveBox,
  resizeBox,
  moveArrow,
  moveArrowEnd,
  changedKeys,
} from "../src/ui/stage.js";
import {
  layerRows,
  newElement,
  fieldValue,
  inputValue,
  textFit,
  fadeNote,
} from "../src/ui/element-view.js";

test("the displayed video rectangle handles letterbox, pillarbox, and portrait video", () => {
  // A 16:9 video in a wider 1000 x 400 box: bars at the left and right.
  assert.deepEqual(
    contentRect({ width: 1000, height: 400 }, { width: 1920, height: 1080 }),
    {
      left: 144.4444,
      top: 0,
      width: 711.1111,
      height: 400,
    },
  );
  // The same video in a tall box: bars at the top and bottom.
  assert.deepEqual(
    contentRect({ width: 640, height: 640 }, { width: 1920, height: 1080 }),
    {
      left: 0,
      top: 140,
      width: 640,
      height: 360,
    },
  );
  // A portrait video in a 16:9 box.
  assert.deepEqual(
    contentRect({ width: 800, height: 450 }, { width: 720, height: 1280 }),
    {
      left: 273.4375,
      top: 0,
      width: 253.125,
      height: 450,
    },
  );
  assert.equal(
    contentRect({ width: 800, height: 450 }, { width: 0, height: 0 }),
    null,
  );
  const rect = { left: 273.4375, top: 0, width: 253.125, height: 450 };
  assert.deepEqual(toFrame({ x: 273.4375 + 253.125 / 2, y: 45 }, rect), {
    x: 0.5,
    y: 0.1,
  });
  // A point in the bar is clamped to the frame edge.
  assert.deepEqual(toFrame({ x: 10, y: 500 }, rect), { x: 0, y: 1 });
});

test("move and resize keep a box inside the frame and at least the minimum size", () => {
  const box = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 };
  assert.deepEqual(moveBox(box, 0.1, -0.05), {
    x: 0.3,
    y: 0.15,
    width: 0.3,
    height: 0.2,
  });
  assert.deepEqual(moveBox(box, 0.9, 0.9), {
    x: 0.7,
    y: 0.8,
    width: 0.3,
    height: 0.2,
  });
  assert.deepEqual(resizeBox(box, "se", 0.1, 0.1), {
    x: 0.2,
    y: 0.2,
    width: 0.4,
    height: 0.3,
  });
  assert.deepEqual(resizeBox(box, "nw", 0.1, 0.05), {
    x: 0.3,
    y: 0.25,
    width: 0.2,
    height: 0.15,
  });
  // The left edge cannot pass the right edge.
  assert.deepEqual(resizeBox(box, "w", 0.5, 0), {
    x: 0.49,
    y: 0.2,
    width: 0.01,
    height: 0.2,
  });
  assert.deepEqual(resizeBox(box, "e", 0.9, 0), {
    x: 0.2,
    y: 0.2,
    width: 0.8,
    height: 0.2,
  });
  assert.deepEqual(resizeBox(box, "n", 0, -0.5), {
    x: 0.2,
    y: 0,
    width: 0.3,
    height: 0.4,
  });
  const arrow = { x1: 0.1, y1: 0.8, x2: 0.4, y2: 0.5 };
  assert.deepEqual(moveArrow(arrow, -0.2, 0.1), {
    x1: 0,
    y1: 0.9,
    x2: 0.3,
    y2: 0.6,
  });
  assert.deepEqual(moveArrowEnd(arrow, "tip", { x: 0.7, y: 0.2 }), {
    x1: 0.1,
    y1: 0.8,
    x2: 0.7,
    y2: 0.2,
  });
  // Only changed keys are sent, so times and style are not sent again.
  assert.deepEqual(changedKeys(box, { ...box, x: 0.25 }), { x: 0.25 });
  assert.deepEqual(changedKeys(box, { ...box }), {});
  assert.deepEqual(changedKeys(box, { ...box, y: 0.200001 }), {});
});

test("layer rows, new elements, field units, text fit, and fade notes", () => {
  const elements = [
    {
      id: "a",
      type: "text",
      text: "First line\nSecond",
      start: 1,
      end: 3,
      visibility: "full",
      layer: 0,
    },
    {
      id: "b",
      type: "arrow",
      start: null,
      end: null,
      visibility: "none",
      layer: 1,
    },
  ];
  const rows = layerRows(elements, "a", 10);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "a"],
    "Top layer first.",
  );
  assert.equal(rows[1].name, "Text: First line");
  assert.equal(rows[1].selected, true);
  assert.deepEqual([rows[1].left, rows[1].width], [10, 20]);
  assert.match(rows[0].timeText, /Not in the edited video/);
  assert.equal(rows[0].width, 0);

  const label = newElement("label", 4, 10);
  assert.equal(label.type, "text");
  assert.deepEqual([label.start, label.end], [4, 7]);
  assert.notEqual(label.background, "none");
  assert.ok(
    label.backgroundOpacity >= 0.7,
    "A label has a readable background.",
  );
  // Near the end the element still shows for its full length if it can.
  assert.deepEqual(
    (({ start, end }) => [start, end])(newElement("rectangle", 9.9, 10)),
    [7, 10],
  );
  assert.deepEqual(
    (({ start, end }) => [start, end])(newElement("arrow", 0.5, 1)),
    [0, 1],
  );
  assert.equal(newElement("arrow", 0, 10).type, "arrow");
  // Review finding 7: at 1.5x speed a 10-second source is 6.666... edited
  // seconds. The end must not be rounded past the edited end.
  const total = 10 / 1.5;
  const late = newElement("label", 5, total);
  assert.equal(late.end, total);
  assert.ok(
    late.start >= 0 && late.end - late.start > 2.99,
    JSON.stringify(late),
  );
  assert.ok(newElement("text", 1.0004, total).end <= total);

  assert.equal(fieldValue("x", { x: 0.125 }), "12.5");
  assert.equal(fieldValue("size", { size: 0.06 }), "6");
  assert.equal(fieldValue("start", { start: 1.23456 }), "1.235");
  assert.equal(inputValue("x", "12.5"), 0.125);
  assert.equal(inputValue("size", "6"), 0.06);
  assert.equal(inputValue("start", "1.5"), 1.5);
  assert.equal(inputValue("opacity", "80"), 0.8);
  assert.ok(Number.isNaN(inputValue("x", "")));

  assert.deepEqual(
    textFit({
      textWidth: 300,
      textHeight: 40,
      innerWidth: 200,
      innerHeight: 100,
    }),
    { fits: false, widthRatio: 1.5, heightRatio: 0.4, scale: 0.6533 },
  );
  assert.equal(
    textFit({
      textWidth: 100,
      textHeight: 40,
      innerWidth: 200,
      innerHeight: 100,
    }).fits,
    true,
  );
  assert.equal(fadeNote({ fadeIn: 0.5, actualFadeIn: 0.5 }, "fadeIn"), "");
  assert.match(
    fadeNote({ fadeIn: 2, actualFadeIn: 0.4, start: 1, end: 1.8 }, "fadeIn"),
    /0\.4 s/,
  );
});
