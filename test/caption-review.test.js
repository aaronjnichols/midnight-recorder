// Regressions for the confirmed stage 3 domain review cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeline, cut, configure } from "../src/domain/timeline.js";
import {
  buildCues,
  applyCaptions,
  addCue,
  updateCue,
  deleteCue,
  captionsOf,
  captionPlan,
  describeCaptions,
  CAPTION_LIMITS,
} from "../src/domain/captions.js";

let next = 0;
const ids = () => `r${++next}`;
const words = (list) =>
  list.map(([word, start, end, segmentId = 0]) => ({
    word,
    start,
    end,
    probability: 0.9,
    segmentId,
  }));
const flat = (cues) => cues.map((c) => c.text.replace(/\n/g, " "));
// Stored cues in source order do not overlap and each has a length.
function assertTrack(timeline) {
  const cues = [...captionsOf(timeline).cues].sort(
    (a, b) => a.sourceStart - b.sourceStart,
  );
  for (const [i, cue] of cues.entries()) {
    assert.ok(cue.sourceEnd > cue.sourceStart, JSON.stringify(cue));
    if (i)
      assert.ok(
        cue.sourceStart >= cues[i - 1].sourceEnd - 1e-9,
        `Overlap: ${JSON.stringify([cues[i - 1], cue])}`,
      );
  }
  assert.equal(new Set(cues.map((c) => c.id)).size, cues.length, "Unique IDs.");
}

test("review 1: a range replacement cannot overlap a caption that stays", () => {
  const base = applyCaptions(
    createTimeline(10),
    [{ sourceStart: 0, sourceEnd: 1, text: "Old." }],
    { ids: () => "old" },
  ).timeline;
  const range = { start: 1, end: 2 };
  // The word midpoint 1.1 is in the range, but the word starts at 0.9.
  const draft = buildCues(words([[" New.", 0.9, 1.3]]), base, range).cues;
  assert.equal(draft.length, 1);
  // The cue starts at the range start, and the clipped word needs a check.
  assert.ok(Math.abs(draft[0].start - 1) < 1e-9, JSON.stringify(draft[0]));
  assert.ok(draft[0].sourceStart >= 1 - 1e-9);
  assert.equal(draft[0].check, true);
  const result = applyCaptions(base, draft, { ids, replace: true, range });
  assertTrack(result.timeline);
  const stored = captionsOf(result.timeline).cues;
  assert.deepEqual(
    stored[0],
    captionsOf(base).cues[0],
    "The old cue is unchanged.",
  );
  assert.equal(result.removed, 0);
  // A cue that ends after the range end ends at the range end.
  const late = buildCues(words([[" Late.", 1.6, 2.3]]), base, range).cues;
  assert.ok(late[0].end <= 2 + 1e-9 && late[0].check, JSON.stringify(late[0]));
});

test("review 2: an attached suffix stays with its word at the grouping limit", () => {
  const input = words([
    [" This", 0, 0.2],
    [" is", 0.2, 0.3],
    [" great", 0.3, 0.6],
    [" because", 0.6, 0.9],
    [" it", 0.9, 1.0],
    ["'s", 1.0, 1.1],
    [" useful.", 1.1, 1.5],
  ]);
  const { cues } = buildCues(input, createTimeline(5), { lineChars: 12 });
  assert.ok(!cues.some((c) => c.text.startsWith("'")), JSON.stringify(cues));
  assert.deepEqual(flat(cues), ["This is great because", "it's useful."]);
  // Punctuation tokens without a space stay attached too.
  const comma = buildCues(
    words([
      [" Yes", 0, 0.3],
      [",", 0.3, 0.32],
      [" so", 0.4, 0.6],
    ]),
    createTimeline(5),
    { lineChars: 12 },
  ).cues;
  assert.deepEqual(flat(comma), ["Yes, so"]);
});

test("review 3: generated cues are valid intervals within the line limits", () => {
  const timeline = createTimeline(10);
  // Two words with the same times. No cue has zero length, and no word is lost.
  const same = buildCues(
    words([
      [" One.", 0, 0.5],
      [" Two.", 0, 0.5],
    ]),
    timeline,
  );
  assert.deepEqual(flat(same.cues), ["One. Two."]);
  for (const cue of same.cues) assert.ok(cue.end - cue.start >= 0.05);
  const saved = applyCaptions(timeline, same.cues, { ids }).timeline;
  assert.equal(
    captionPlan(saved, { width: 640, height: 360 }).cues.length,
    same.cues.length,
    "Each stored cue renders.",
  );
  // A 180-character token with spaces becomes several cues of 3 lines or less.
  const text = Array.from(
    { length: 36 },
    (_, i) => `w${String(i).padStart(2, "0")}`,
  ).join(" ");
  assert.equal(text.length, 143);
  const long = ` ${text} ${"z".repeat(180 - text.length - 2)}`;
  assert.equal(long.trim().length, 179);
  const split = buildCues(words([[long, 1, 7]]), timeline, { lineChars: 12 });
  assert.ok(split.cues.length > 1);
  for (const cue of split.cues) {
    assert.ok(cue.text.split("\n").length <= CAPTION_LIMITS.lines, cue.text);
    assert.ok([...cue.text].length <= CAPTION_LIMITS.characters);
    assert.ok(cue.end - cue.start >= 0.05);
    assert.equal(cue.check, true, "Split speech times are estimates.");
  }
  assert.equal(flat(split.cues).join(" "), long.trim(), "All words, in order.");
  const stored = applyCaptions(timeline, split.cues, { ids }).timeline;
  assertTrack(stored);
  // Invalid cues are rejected before any change.
  for (const [cue, message] of [
    [{ sourceStart: 1, sourceEnd: 1, text: "Zero." }, /at least 0\.05 seconds/],
    [{ sourceStart: 1, sourceEnd: 2, text: "a\nb\nc\nd" }, /3 lines/],
    [{ sourceStart: 1, sourceEnd: 2, text: "x".repeat(201) }, /200 characters/],
    [{ sourceStart: 1, sourceEnd: Number.NaN, text: "NaN." }, /time/],
  ])
    assert.throws(() => applyCaptions(timeline, [cue], { ids }), message);
  assert.throws(
    () =>
      applyCaptions(
        timeline,
        [
          { sourceStart: 1, sourceEnd: 3, text: "A." },
          { sourceStart: 2, sourceEnd: 4, text: "B." },
        ],
        { ids },
      ),
    /overlap/,
  );
});

test("review 4: caption IDs are unique", () => {
  let t = addCue(createTimeline(10), 10, "same", {
    text: "A",
    start: 3,
    end: 4,
  });
  assert.throws(
    () => addCue(t, 10, "same", { text: "B", start: 1, end: 2 }),
    /already exists/,
  );
  assert.equal(captionsOf(t).cues.length, 1);
  // A generated ID that repeats, or that an existing cue has, is rejected.
  const draft = [
    { sourceStart: 5, sourceEnd: 6, text: "C." },
    { sourceStart: 7, sourceEnd: 8, text: "D." },
  ];
  assert.throws(
    () =>
      applyCaptions(t, draft, {
        ids: () => "dup",
        replace: true,
        range: { start: 5, end: 9 },
      }),
    /already exists/,
  );
  assert.throws(
    () =>
      applyCaptions(t, draft.slice(0, 1), {
        ids: () => "same",
        replace: true,
        range: { start: 5, end: 9 },
      }),
    /already exists/,
  );
  t = addCue(t, 10, "other", { text: "B", start: 1, end: 2 });
  assert.equal(describeCaptions(deleteCue(t, "same")).count, 1);
});

test("review 7: a cut applies to a complete word with its attached suffix", () => {
  const tokens = words([
    [" it", 1, 1.2],
    ["'s", 1.2, 1.3],
    [" useful.", 1.3, 1.7],
  ]);
  // The complete word it's is 1.0 to 1.3. Its midpoint 1.15 is cut.
  const removed = buildCues(tokens, cut(createTimeline(5), 0, 1.2));
  assert.deepEqual(flat(removed.cues), ["useful."]);
  assert.equal(removed.dropped, 2, "Both tokens of it's are cut.");
  // Its midpoint is kept: the complete word shows, clipped, with a check.
  const kept = buildCues(tokens, cut(createTimeline(5), 0, 1.1));
  assert.deepEqual(flat(kept.cues), ["it's useful."]);
  assert.equal(kept.cues[0].check, true);
  assert.equal(kept.partial, 1);
});

test("review 8: new or changed source times must show for the edited minimum", () => {
  // At 2x speed, source 0.011 to 0.061 is edited 0.0055 to 0.0305.
  const fast = configure(createTimeline(10), { speed: 2 });
  const source = {
    text: "Short",
    start: 0.011,
    end: 0.061,
    timeBase: "source",
  };
  assert.throws(() => addCue(fast, 10, "a", source), /0\.05 seconds/);
  const t = addCue(fast, 10, "a", { text: "Long", start: 1, end: 2 });
  assert.throws(
    () =>
      updateCue(t, 10, "a", { start: 0.011, end: 0.061, timeBase: "source" }),
    /0\.05 seconds/,
  );
  // The exact minimum is allowed: source 0.1 to 0.2 is edited 0.05 seconds.
  assert.equal(
    captionsOf(addCue(fast, 10, "b", { ...source, start: 0.1, end: 0.2 })).cues
      .length,
    1,
  );
});

test("review 11: stored-time rounding does not reject a cue of the minimum duration", () => {
  // At 2/3 speed, microsecond source times change edited times a little.
  const slow = configure(createTimeline(10), { speed: 2 / 3 });
  const manual = addCue(slow, 10, "a", {
    text: "Min",
    start: 0.001,
    end: 0.051,
  });
  assert.equal(captionsOf(manual).cues.length, 1);
  const moved = updateCue(
    addCue(slow, 10, "b", { text: "B", start: 1, end: 2 }),
    10,
    "b",
    { start: 0.001, end: 0.051 },
  );
  assert.equal(captionsOf(moved).cues[0].sourceStart, 0.000667);
  // The generated path: a 0.034-second source at 2/3 speed is 0.051 seconds.
  const short = configure(createTimeline(0.034), { speed: 2 / 3 });
  const built = buildCues(words([[" Hi.", 0.0006666667, 0.034]]), short);
  assert.equal(built.cues.length, 1);
  assert.equal(
    captionsOf(applyCaptions(short, built.cues, { ids }).timeline).cues.length,
    1,
  );
  // A cue that is really shorter than the minimum is still rejected.
  assert.throws(
    () => addCue(slow, 10, "c", { text: "Short", start: 3, end: 3.049 }),
    /0\.05 seconds/,
  );
});

test("review 9: a generated cue of exactly the minimum duration is kept", () => {
  const timeline = createTimeline(0.15);
  const built = buildCues(words([[" Hi.", 0.1, 0.15]]), timeline);
  assert.equal(built.skipped, 0);
  assert.deepEqual(flat(built.cues), ["Hi."]);
  assert.equal(
    captionsOf(applyCaptions(timeline, built.cues, { ids }).timeline).cues
      .length,
    1,
  );
});
