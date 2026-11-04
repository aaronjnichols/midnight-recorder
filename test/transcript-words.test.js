// Canonical words: one identity for each human word of a source result, before
// any window, page, or edit. The current view maps them through the timeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWords,
  completeWords,
  mapWords,
  selectWords,
} from "../src/domain/words.js";
import { readTranscript, readWords } from "../src/domain/transcript.js";
import { buildCues } from "../src/domain/captions.js";
import {
  addSplit,
  configure,
  createTimeline,
  cut,
  undo,
} from "../src/domain/timeline.js";

const token = (word, start, end, extra = {}) => ({
  word,
  start,
  end,
  probability: 0.9,
  segmentId: 0,
  ...extra,
});
// Word n is at n to n + 0.8 seconds.
const spoken = (count) =>
  Array.from({ length: count }, (_, n) => token(` word${n}`, n, n + 0.8));
const canonical = (tokens) => canonicalWords(tokens);
const near = (actual, expected, message) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${message ?? "time"}: ${actual} is not ${expected}`,
  );

test("attached tokens join the word before them, as in captions", () => {
  const tokens = [
    token(" real", 0, 0.3),
    token("-time", 0.3, 0.7),
    token(" it", 1, 1.2),
    token("'s", 1.2, 1.3),
    token(",", 1.3, 1.31),
    token(" ok", 1.5, 2),
  ];
  const words = canonical(tokens);
  assert.deepEqual(
    words.map((w) => w.text),
    ["real-time", "it's,", "ok"],
  );
  assert.deepEqual(
    words.map((w) => w.id),
    ["w0", "w1", "w2"],
  );
  assert.equal(words[0].sourceStart, 0);
  assert.equal(words[0].sourceEnd, 0.7);
  assert.equal(words[1].sourceEnd, 1.31);
  // One policy: captions read the same complete words.
  assert.deepEqual(
    completeWords(tokens).map((w) => w.text.trim()),
    words.map((w) => w.text),
  );
});

test("identity comes from the source order, and blank tokens have none", () => {
  const words = canonical([
    token(" second", 2, 3),
    token(" ", 1, 1.5),
    token(" first\u0007", 0, 1),
  ]);
  assert.deepEqual(
    words.map(({ id, text }) => [id, text]),
    [
      ["w0", "first"],
      ["w1", "second"],
    ],
  );
  assert.deepEqual(canonical([]), []);
});

test("a token with spaces is one word for each part, as in captions", () => {
  const tokens = [token(" hello world", 0, 2)];
  const words = canonical(tokens);
  assert.deepEqual(
    words.map(({ id, text, sourceStart, sourceEnd }) => [
      id,
      text,
      sourceStart,
      sourceEnd,
    ]),
    [
      ["w0", "hello", 0, 1],
      ["w1", "world", 1, 2],
    ],
    "Each part has a time in proportion to its length.",
  );
  assert.ok(words.every((word) => word.estimated));
  // Each part can be selected alone.
  const timeline = createTimeline(5);
  const world = selectWords(mapWords(words, timeline), timeline, "w1", "w1");
  assert.equal(world.text, "world");
  assert.equal(world.sourceStart, 1);
  // An attached token joins before the split, the same as in a caption.
  const punctuated = [...tokens, token(",", 2, 2.1)];
  const parts = canonical(punctuated);
  assert.deepEqual(
    parts.map((w) => w.text),
    ["hello", "world,"],
  );
  assert.equal(parts[1].sourceEnd, 2.1);
  assert.equal(
    buildCues(punctuated, timeline).cues[0].text,
    parts.map((w) => w.text).join(" "),
  );
  assert.equal(canonical([token(" one", 0, 1)])[0].estimated, false);
});

test("canonical words have source order, also after a token with spaces", () => {
  // Valid overlapping tokens. The second part of the first token starts after
  // the next token.
  const words = canonical([token(" a b", 0, 4), token(" c", 1, 2)]);
  assert.deepEqual(
    words.map(({ id, text, sourceStart }) => [id, text, sourceStart]),
    [
      ["w0", "a", 0],
      ["w1", "c", 1],
      ["w2", "b", 2],
    ],
  );
  // Source 1 to 1.5 of c is kept. The order of the segments must not hide it.
  const timeline = cut(createTimeline(5), 1.5, 2.5);
  const view = mapWords(words, timeline);
  assert.deepEqual(
    view.map(({ text, state }) => [text, state]),
    [
      ["a", "partial"],
      ["c", "partial"],
      ["b", "partial"],
    ],
  );
  assert.deepEqual(view[1].fragments, [{ sourceStart: 1, sourceEnd: 1.5 }]);
  // An earlier word that ends later stays in the range of a selection.
  const whole = createTimeline(5);
  const nested = selectWords(
    mapWords(canonical([token(" x", 0, 4), token(" y", 1, 2)]), whole),
    whole,
    "w0",
    "w1",
  );
  assert.equal(nested.sourceStart, 0);
  assert.equal(nested.sourceEnd, 4);
});

test("the lowest token probability is the probability of the word", () => {
  const [word] = canonical([
    token(" real", 0, 0.3, { probability: 0.9 }),
    token("-time", 0.3, 0.7, { probability: 0.2 }),
  ]);
  assert.equal(word.probability, 0.2);
});

test("paragraphs break at long pauses and sentences, and have a limit", () => {
  const words = canonical([
    token(" One.", 0, 1),
    token(" Two", 1.1, 1.5),
    token(" three.", 1.6, 2),
    // A sentence end with a pause starts a new paragraph.
    token(" Four", 3, 3.5),
    // A long pause starts a new paragraph, also inside a sentence.
    token(" five", 6, 6.5),
  ]);
  assert.deepEqual(
    words.map((w) => w.paragraph),
    [0, 0, 0, 1, 2],
  );
  // No sentences at all: a paragraph still has an end.
  const long = canonical(spoken(1000));
  const sizes = new Map();
  for (const w of long)
    sizes.set(w.paragraph, (sizes.get(w.paragraph) ?? 0) + 1);
  assert.ok(Math.max(...sizes.values()) <= 90);
});

test("the current view marks kept, partial, and removed words", () => {
  const words = canonical([
    token(" kept", 0, 1),
    token(" clipped", 2, 3),
    token(" gone", 3.5, 3.9),
    token(" both", 5, 6),
    token(" after", 7, 8),
  ]);
  // Kept source: 0 to 2.5, 4 to 5.25, 5.75 to 10.
  const timeline = cut(cut(createTimeline(10), 2.5, 4), 3.75, 4.25);
  assert.deepEqual(timeline.segments, [
    { start: 0, end: 2.5 },
    { start: 4, end: 5.25 },
    { start: 5.75, end: 10 },
  ]);
  const view = mapWords(words, timeline);
  assert.deepEqual(
    view.map((w) => w.state),
    ["kept", "partial", "removed", "partial", "kept"],
  );
  assert.deepEqual(view[1].fragments, [{ sourceStart: 2, sourceEnd: 2.5 }]);
  near(view[1].start, 2);
  near(view[1].end, 2.5);
  assert.equal(view[2].start, null);
  assert.equal(view[2].end, null);
  assert.deepEqual(view[2].fragments, []);
  // One word with kept source on both sides of a cut. It does not repeat.
  assert.deepEqual(view[3].fragments, [
    { sourceStart: 5, sourceEnd: 5.25 },
    { sourceStart: 5.75, sourceEnd: 6 },
  ]);
  near(view[3].start, 3.5);
  near(view[3].end, 4);
  // The frozen read gives the same word twice. This is its old contract.
  const raw = [token(" both", 5, 6)];
  const read = readTranscript({ words: raw, duration: 10 }, timeline, {
    detail: "words",
  });
  assert.equal(read.words.length, 2);
});

test("speed scales the view, and a split does not change any word", () => {
  const words = canonical([token(" across", 4, 6)]);
  const timeline = addSplit(createTimeline(10), 5);
  const [view] = mapWords(words, timeline);
  assert.equal(view.state, "kept", "A mark is not a cut.");
  assert.deepEqual(view.fragments, [{ sourceStart: 4, sourceEnd: 6 }]);
  const [fast] = mapWords(words, configure(timeline, { speed: 2 }));
  near(fast.start, 2);
  near(fast.end, 3);
});

test("pages keep the same identities across cuts, undo, and speed", () => {
  const words = canonical(spoken(50));
  const base = createTimeline(60);
  const before = readWords(words, base, { offset: 10, limit: 5 });
  assert.deepEqual(
    before.words.map((w) => w.id),
    ["w10", "w11", "w12", "w13", "w14"],
  );
  assert.equal(before.nextOffset, 15);
  assert.equal(before.total, 50);
  const edited = configure(cut(base, 9.5, 12.5), { speed: 1.5 });
  const after = readWords(words, edited, { offset: 10, limit: 5 });
  assert.deepEqual(
    after.words.map((w) => w.id),
    before.words.map((w) => w.id),
    "The same word has the same ID.",
  );
  assert.deepEqual(
    after.words.map((w) => w.state),
    ["removed", "removed", "partial", "kept", "kept"],
  );
  // Words 10 and 11 are in the cut. The cut clips the end of word 9 and the
  // start of word 12.
  assert.equal(after.removed, 2);
  assert.equal(after.partial, 2);
  assert.equal(after.kept, 46);
  assert.deepEqual(
    readWords(words, undo(cut(base, 9.5, 12.5))).words,
    readWords(words, base).words,
  );
});

test("a long source reads completely in bounded pages", () => {
  const count = 20000;
  const words = canonical(spoken(count));
  const timeline = createTimeline(count + 5);
  const seen = [];
  let offset = 0;
  while (offset !== null) {
    const page = readWords(words, timeline, { offset, limit: 1000 });
    assert.ok(page.words.length <= 1000);
    seen.push(...page.words.map((w) => w.id));
    offset = page.nextOffset;
  }
  assert.equal(seen.length, count);
  assert.equal(new Set(seen).size, count);
  assert.equal(seen.at(-1), `w${count - 1}`);
});

test("a window gives the kept words in current edited seconds", () => {
  const words = canonical(spoken(30));
  const timeline = cut(createTimeline(40), 5, 10);
  const page = readWords(words, timeline, { start: 4, end: 7 });
  assert.deepEqual(
    page.words.map((w) => w.id),
    ["w4", "w10", "w11"],
  );
  assert.equal(page.matches, 3);
  assert.equal(page.total, 30);
});

test("reads reject bad bounds", () => {
  const words = canonical(spoken(5));
  const timeline = createTimeline(10);
  for (const args of [
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { offset: -1 },
    { start: 5, end: 4 },
    { start: 5, end: 5 },
    { start: -1 },
    { end: 99 },
  ])
    assert.throws(() => readWords(words, timeline, args), /must be|Select/);
});

test("a selection derives one range from canonical words, in either order", () => {
  const words = canonical(spoken(10));
  const timeline = createTimeline(12);
  const view = mapWords(words, timeline);
  const forward = selectWords(view, timeline, "w2", "w4");
  assert.deepEqual(
    selectWords(view, timeline, "w4", "w2"),
    forward,
    "Reverse is equal.",
  );
  assert.equal(forward.from, "w2");
  assert.equal(forward.to, "w4");
  assert.equal(forward.words, 3);
  assert.equal(forward.keptWords, 3);
  // The pauses between the words are in the range.
  assert.equal(forward.sourceStart, 2);
  assert.equal(forward.sourceEnd, 4.8);
  near(forward.start, 2);
  near(forward.end, 4.8);
  near(forward.length, 2.8);
  assert.equal(forward.text, "word2 word3 word4");
  assert.equal(forward.canCut, true);
  assert.equal(forward.reason, null);
  assert.equal(selectWords(view, timeline, "w5", "w5").keptWords, 1);
});

test("a selection uses clipped ends and excludes removed speech", () => {
  const words = canonical(spoken(10));
  // Removes word 2, word 3, and the start of word 4 (4 to 4.8).
  const timeline = cut(createTimeline(12), 1.9, 4.5);
  const view = mapWords(words, timeline);
  assert.equal(view[4].state, "partial");

  const edges = selectWords(view, timeline, "w2", "w5");
  assert.equal(edges.words, 4);
  assert.equal(edges.keptWords, 2);
  assert.equal(edges.removedWords, 2);
  assert.equal(edges.partialWords, 1);
  assert.equal(edges.sourceStart, 4.5, "The first clipped start.");
  assert.equal(edges.sourceEnd, 5.8);
  assert.equal(edges.text, "word4 word5");

  // Across the old cut, the range has both sides. The cut time is not in it.
  const across = selectWords(view, timeline, "w1", "w5");
  assert.equal(across.sourceStart, 1);
  assert.equal(across.sourceEnd, 5.8);
  near(across.length, 0.9 + 1.3);

  const gone = selectWords(view, timeline, "w2", "w3");
  assert.equal(gone.canCut, false);
  assert.match(gone.reason, /already cut/);
  assert.equal(gone.start, null);
  assert.equal(gone.end, null);
  assert.equal(gone.length, 0);
});

test("a selection of all speech can leave no video, and the check says so", () => {
  const words = canonical([token(" all", 0, 10)]);
  const select = (timeline) =>
    selectWords(mapWords(words, timeline), timeline, "w0", "w0");
  const whole = select(createTimeline(10));
  assert.equal(whole.canCut, false);
  assert.match(whole.reason, /leave some video/);
  assert.equal(select(createTimeline(11)).canCut, true);
});

test("an unknown word is an error, and the text of a selection has a limit", () => {
  const words = canonical(spoken(2000));
  const timeline = createTimeline(3000);
  const view = mapWords(words, timeline);
  for (const id of ["w5000", "x1", "w-1", "w1.5", ""])
    assert.throws(() => selectWords(view, timeline, id, "w1"), /was not found/);
  const all = selectWords(view, timeline, "w0", "w1999");
  assert.equal(all.words, 2000);
  assert.ok(all.text.length <= 2000);
  assert.equal(all.truncated, true);
  assert.equal(selectWords(view, timeline, "w0", "w5").truncated, false);
});

test("the truncated flag counts words, not spaces in the text", () => {
  // 100 tokens with 10 parts each. Text of one part has no space.
  const tokens = Array.from({ length: 100 }, (_, n) =>
    token(` ${Array(10).fill("aaaaa").join(" ")}`, n, n + 0.9),
  );
  const words = canonical(tokens);
  assert.equal(words.length, 1000);
  const timeline = createTimeline(200);
  const view = mapWords(words, timeline);
  const all = selectWords(view, timeline, "w0", "w999");
  assert.ok(all.text.length <= 2000);
  assert.equal(all.truncated, true);
  const exact = selectWords(view, timeline, "w0", "w9");
  assert.equal(exact.truncated, false);
});
