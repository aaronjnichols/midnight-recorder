import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWords, readWindow, findPhrase } from "./context.mjs";

test("map words through cuts and speed without keeping deleted speech", () => {
  const words = [
    { word: "Do", start: 0, end: 0.3 },
    { word: "not", start: 0.3, end: 0.6 },
    { word: "select", start: 0.6, end: 1 },
    { word: "Cancel", start: 1, end: 1.4 },
  ];
  const result = mapWords(words, {
    segments: [
      { start: 0, end: 0.3 },
      { start: 0.6, end: 1.4 },
    ],
    speed: 2,
  });
  assert.deepEqual(
    result.map((w) => w.word),
    ["Do", "select", "Cancel"],
  );
  assert.equal(result[1].start, 0.15);
  assert.equal(result[1].sourceStart, 0.6);
  assert.equal(result[1].cutBefore, true);
});

test("a word cut in half carries an explicit partial flag", () => {
  const result = mapWords([{ word: "Save", start: 1, end: 2 }], {
    segments: [{ start: 1.5, end: 3 }],
    speed: 1,
  });
  assert.equal(result[0].partial, true);
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 0.5);
});

test("a time query keeps words that overlap the window and excludes its end boundary", () => {
  const words = [
    { word: "Select", start: 1, end: 2 },
    { word: "Save", start: 2, end: 3 },
    { word: "next", start: 3, end: 4 },
  ];
  assert.deepEqual(
    readWindow(words, 1.5, 3).map((w) => w.word),
    ["Select", "Save"],
  );
});

test("phrase search finds repeated words with a bounded context and cannot bridge a cut", () => {
  const words = [
    { word: "Do", start: 0, end: 0.2 },
    { word: "not", start: 0.2, end: 0.4 },
    { word: "select", start: 0.4, end: 0.6 },
    { word: "Save.", start: 0.6, end: 1 },
    { word: "Select", start: 8, end: 8.4 },
    { word: "Save", start: 8.4, end: 9, cutBefore: true },
  ];
  const hits = findPhrase(words, "select save", 1);
  assert.equal(hits.length, 1);
  assert.deepEqual(
    hits[0].context.map((w) => w.word),
    ["Do", "not", "select", "Save."],
  );
  assert.equal(hits[0].start, 0.4);
});
