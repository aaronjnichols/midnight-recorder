import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  cut,
  configure,
  duration,
} from "../src/domain/timeline.js";
import {
  buildCues,
  CAPTION_LIMITS,
  lineCharsFor,
  captionsOf,
  applyCaptions,
  updateCue,
  addCue,
  deleteCue,
  configureCaptions,
  removeCaptions,
  describeCaptions,
  captionPlan,
} from "../src/domain/captions.js";
import { undo, redo, reset, trim, isEdited } from "../src/domain/timeline.js";
import { addElement, elementsOf } from "../src/domain/elements.js";
import { editRevision } from "../src/domain/inspection.js";

let next = 0;
const ids = () => `c${++next}`;
const sentences = (count, gap = 2) =>
  Array.from({ length: count }, (_, i) => ({
    word: ` Line${i}.`,
    start: i * gap,
    end: i * gap + 0.5,
    probability: 0.9,
    segmentId: i,
  }));

// Source-time words like the speech engine gives: a leading space, attached
// punctuation, a probability, and a speech segment number.
function words(list, segmentId = 0) {
  return list.map(([word, start, end, probability = 0.9]) => ({
    word,
    start,
    end,
    probability,
    segmentId,
  }));
}

test("words become readable cues at sentence ends, pauses, and line limits", () => {
  const timeline = createTimeline(30);
  const input = [
    ...words([
      [" Hello", 0.2, 0.5],
      [" world.", 0.5, 0.9],
      [" It", 1.0, 1.1],
      ["'s", 1.1, 1.2],
      [" a", 1.2, 1.3],
      [" very", 1.3, 1.5],
      [" long", 1.5, 1.7],
      [" sentence", 1.7, 2.1],
      [" that", 2.1, 2.3],
      [" keeps", 2.3, 2.6],
      [" going", 2.6, 2.9],
      [" past", 2.9, 3.1],
      [" the", 3.1, 3.2],
      [" limit", 3.2, 3.5],
      [" for", 3.5, 3.6],
      [" one", 3.6, 3.8],
      [" caption", 3.8, 4.2],
      [" line", 4.2, 4.4],
      [" and", 4.4, 4.5],
      [" more", 4.5, 4.7],
      [" words", 4.7, 5.0],
      [" here", 5.0, 5.2],
    ]),
    // A pause of more than 1 second.
    ...words(
      [
        [" Next", 7.0, 7.3],
        [" part", 7.3, 7.7],
      ],
      1,
    ),
  ];
  const { cues } = buildCues(input, timeline, { lineChars: 32 });
  assert.equal(cues[0].text, "Hello world.");
  assert.ok(cues[1].text.startsWith("It's a very long"), cues[1].text);
  for (const cue of cues) {
    const lines = cue.text.split("\n");
    assert.ok(lines.length <= 2, cue.text);
    assert.ok(
      lines.every((line) => line.length <= 32),
      cue.text,
    );
    assert.ok(cue.end - cue.start <= CAPTION_LIMITS.maxSeconds + 1e-9);
    assert.ok(cue.end > cue.start);
  }
  // Every word shows once, in order.
  assert.equal(
    cues.map((c) => c.text.replace(/\n/g, " ")).join(" "),
    "Hello world. It's a very long sentence that keeps going past the limit for one caption line and more words here Next part",
  );
  // The pause starts a new cue. A short hold does not reach the next cue.
  const next = cues.at(-1);
  assert.equal(next.text, "Next part");
  assert.ok(Math.abs(next.start - 7) < 1e-9);
  assert.ok(cues.at(-2).end <= 7);
  // Cues do not overlap, and a short cue shows for a readable time.
  for (let i = 1; i < cues.length; i++)
    assert.ok(cues[i].start >= cues[i - 1].end - 1e-9);
  assert.ok(cues[0].end - cues[0].start >= CAPTION_LIMITS.minSeconds - 1e-9);
});

test("a cut never joins words, and a word across a cut shows once", () => {
  // Remove source 2.0 to 3.0.
  const timeline = cut(createTimeline(10), 2, 3);
  const input = words([
    [" alpha", 1.0, 1.4],
    // Midpoint 2.05 is in the removed part: dropped.
    [" beta.", 1.8, 2.3],
    // Midpoint 3.15 is kept: clipped to start at 3.0, marked to check.
    [" gamma", 2.9, 3.4],
    [" delta", 3.5, 3.9],
  ]);
  const result = buildCues(input, timeline);
  assert.deepEqual(
    result.cues.map((c) => c.text),
    ["alpha", "gamma delta"],
  );
  assert.equal(result.dropped, 1);
  assert.equal(result.partial, 1);
  const [first, second] = result.cues;
  // The first cue stays before the cut. The second starts at the cut.
  assert.ok(first.sourceEnd <= 2 + 1e-9);
  assert.ok(first.end <= 2 + 1e-9);
  assert.equal(second.sourceStart, 3);
  assert.ok(Math.abs(second.start - 2) < 1e-9);
  assert.equal(second.check, true, "A cut word needs a check.");
  assert.equal(first.check, false);
  // A word with its midpoint before the cut stays in the first part only.
  const early = buildCues(
    words([
      [" one", 1.0, 1.5],
      [" two", 1.7, 2.2],
      [" three", 3.1, 3.5],
    ]),
    timeline,
  );
  assert.deepEqual(
    early.cues.map((c) => c.text),
    ["one two", "three"],
  );
  assert.equal(early.cues[0].sourceEnd, 2);
});

test("cue times use the edited clock at a fractional speed", () => {
  const timeline = configure(createTimeline(4), { speed: 1.5 });
  const total = duration(timeline);
  const { cues } = buildCues(
    words([
      [" Fast", 3.0, 3.4],
      [" talk.", 3.4, 3.98],
    ]),
    timeline,
  );
  assert.equal(cues.length, 1);
  assert.ok(Math.abs(cues[0].start - 2) < 1e-9);
  // The hold stops at the edited end.
  assert.ok(cues[0].end <= total + 1e-9, String(cues[0].end));
  assert.ok(cues[0].sourceEnd <= 4 + 1e-9);
});

test("low-probability words mark a cue to check, and a range keeps its words", () => {
  const timeline = createTimeline(20);
  const input = words([
    [" Click", 1.0, 1.3],
    [" sav", 1.3, 1.6, 0.2],
    [" now.", 1.6, 2.0],
    [" Later", 10.0, 10.4],
    [" words.", 10.4, 10.9],
  ]);
  const all = buildCues(input, timeline);
  assert.equal(all.cues[0].check, true);
  assert.equal(all.cues[1].check, false);
  const ranged = buildCues(input, timeline, { start: 5, end: 20 });
  assert.deepEqual(
    ranged.cues.map((c) => c.text),
    ["Later words."],
  );
  // The range end bounds the cue.
  const short = buildCues(input, timeline, { start: 0, end: 1.8 });
  assert.ok(short.cues.every((c) => c.end <= 1.8 + 1e-9));
});

test("recognized text is cleaned and bounded like typed caption text", () => {
  const timeline = createTimeline(20);
  const long = "x".repeat(260);
  const input = words([
    [" Bad\u0000\u0007word here.", 1.0, 1.5],
    [` ${long}`, 3.0, 3.5],
    [" \u0001", 5.0, 5.2],
  ]);
  const { cues } = buildCues(input, timeline);
  assert.equal(cues[0].text, "Bad word here.");
  // An overlong token is shortened and marked to check.
  assert.equal([...cues[1].text].length, CAPTION_LIMITS.characters);
  assert.ok(cues[1].text.endsWith("…"));
  assert.equal(cues[1].check, true);
  // A word with no visible character makes no cue.
  assert.equal(cues.length, 2);
  for (const cue of cues) assert.ok(cue.text.split("\n").length <= 3);
});

test("line length follows the frame shape and the font size", () => {
  const style = { width: 0.84, size: 0.045 };
  const wide = lineCharsFor({ width: 1920, height: 1080 }, style);
  const tall = lineCharsFor({ width: 1080, height: 1920 }, style);
  assert.ok(wide >= 36 && wide <= 48, String(wide));
  assert.ok(tall < wide && tall >= 12, String(tall));
});

test("applying captions is one undo step that keeps labels and shapes", () => {
  let base = addElement(createTimeline(40), 40, "label", {
    type: "text",
    text: "Manual label",
    start: 1,
    end: 3,
  });
  assert.equal(captionsOf(base), null);
  const draft = buildCues(sentences(5), base).cues;
  const first = applyCaptions(base, draft, { ids, source: { words: 5 } });
  let t = first.timeline;
  assert.equal(t.past.length, base.past.length + 1);
  assert.equal(captionsOf(t).cues.length, 5);
  assert.deepEqual(first.added.length, 5);
  assert.deepEqual(elementsOf(t), elementsOf(base));
  assert.equal(captionsOf(t).enabled, true);
  assert.equal(isEdited(t, 40), true);
  assert.equal(captionsOf(undo(t)), null);
  assert.equal(captionsOf(redo(undo(t))).cues.length, 5);
  // Replace is deliberate. A style change stays after a replace.
  assert.throws(() => applyCaptions(t, draft, { ids }), /replace/);
  t = configureCaptions(t, { size: 0.06, y: 0.05, verticalAlign: "top" });
  const again = applyCaptions(t, draft.slice(0, 2), { ids, replace: true });
  assert.equal(captionsOf(again.timeline).cues.length, 2);
  assert.equal(again.removed, 5);
  assert.equal(captionsOf(again.timeline).style.size, 0.06);
  assert.equal(elementsOf(again.timeline).length, 1);
  // A range replaces only the cues that overlap it.
  const ranged = applyCaptions(
    t,
    buildCues(sentences(5), t, { start: 3, end: 5 }).cues,
    { ids, replace: true, range: { start: 3, end: 5 } },
  );
  assert.equal(ranged.removed, 1);
  assert.equal(captionsOf(ranged.timeline).cues.length, 5);
  // Capacity: no change, and the error gives a range that fits.
  const many = buildCues(sentences(510, 1), createTimeline(520)).cues;
  assert.equal(many.length, 510);
  assert.throws(
    () => applyCaptions(createTimeline(520), many, { ids }),
    /510 captions.*at most 500.*from 0 to 500 seconds/,
  );
  assert.equal(
    applyCaptions(createTimeline(520), many.slice(0, 500), { ids }).added
      .length,
    500,
  );
});

test("caption corrections keep source anchors, stay in order, and validate text", () => {
  const timeline = createTimeline(20);
  let t = applyCaptions(timeline, buildCues(sentences(4, 3), timeline).cues, {
    ids,
  }).timeline;
  const [a, b] = captionsOf(t).cues;
  t = updateCue(t, 20, a.id, { text: "Corrected text" });
  assert.equal(captionsOf(t).cues[0].text, "Corrected text");
  assert.equal(captionsOf(t).cues[0].check, false);
  for (const [args, message] of [
    [{ text: " " }, /visible character/],
    [{ text: "x".repeat(201) }, /200 characters/],
    [{ text: "a\nb\nc\nd" }, /3 lines/],
    [{ text: "bell\u0007" }, /control characters/],
    // The next cue starts at 3 seconds.
    [{ end: 3.5 }, /overlaps the next caption/],
    [{ start: 0.5, end: 0.52 }, /0\.05 seconds/],
  ])
    assert.throws(
      () => updateCue(t, 20, a.id, args),
      message,
      JSON.stringify(args),
    );
  // After a trim removes the start of b, a start-only change keeps the end.
  const trimmed = trim(t, 3.2, 20);
  const moved = updateCue(trimmed, 20, b.id, { start: 0.1 });
  const stored = captionsOf(moved).cues.find((c) => c.id === b.id);
  assert.equal(stored.sourceEnd, b.sourceEnd);
  assert.ok(Math.abs(stored.sourceStart - 3.3) < 1e-9);
  // Add a cue in a gap, delete one, and turn captions off.
  t = addCue(t, 20, "manual", { text: "Added", start: 13, end: 14 });
  assert.equal(captionsOf(t).cues.at(-1).id, "manual");
  assert.throws(
    () => addCue(t, 20, "x", { text: "Over", start: 2.9, end: 3.4 }),
    /overlaps/,
  );
  t = deleteCue(t, b.id);
  assert.equal(
    captionsOf(t).cues.some((c) => c.id === b.id),
    false,
  );
  const off = configureCaptions(t, { enabled: false });
  assert.equal(captionPlan(off, { width: 640, height: 360 }), null);
  assert.equal(configureCaptions(off, { enabled: false }), off, "No change.");
  assert.throws(
    () => configureCaptions(t, { x: 0.5, width: 0.6 }),
    /inside the frame/,
  );
  assert.throws(
    () => configureCaptions(t, { fill: "#FFFFFF" }),
    /does not use fill/,
  );
  assert.equal(captionsOf(removeCaptions(t)), null);
  assert.equal(
    captionsOf(undo(removeCaptions(t))).cues.length,
    captionsOf(t).cues.length,
  );
  assert.throws(() => updateCue(t, 20, "missing", { text: "x" }), /not found/);
});

test("caption lists are bounded windows with edited times and visibility", () => {
  const timeline = createTimeline(100);
  let t = applyCaptions(timeline, buildCues(sentences(30, 3), timeline).cues, {
    ids,
  }).timeline;
  // Remove all of the second cue (source 3 to 3.8).
  t = cut(t, 2.9, 6.2);
  const page = describeCaptions(t, { limit: 10 });
  assert.equal(page.count, 30);
  assert.equal(page.cues.length, 10);
  assert.equal(page.nextOffset, 10);
  assert.equal(page.cues[1].visibility, "none", "The cut removed this cue.");
  assert.equal(page.cues[1].start, null);
  const window = describeCaptions(t, { start: 10, end: 20 });
  assert.ok(window.cues.length > 0);
  assert.ok(window.cues.every((c) => c.end > 10 && c.start < 20));
  assert.equal(window.nextOffset, null);
  assert.throws(() => describeCaptions(t, { limit: 201 }), /limit/);
});

test("old history and revisions without captions stay valid, and reset clears captions", () => {
  const old = {
    segments: [{ start: 0, end: 10 }],
    speed: 1,
    muted: false,
    past: [{ segments: [{ start: 0, end: 10 }], speed: 1, muted: false }],
    future: [],
  };
  assert.equal(captionsOf(old), null);
  assert.equal(
    editRevision({ timeline: { ...old, captions: null } }),
    editRevision({ timeline: old }),
  );
  const t = applyCaptions(old, buildCues(sentences(2), old).cues, {
    ids,
  }).timeline;
  assert.notEqual(
    editRevision({ timeline: t }),
    editRevision({ timeline: old }),
  );
  assert.equal(captionsOf(undo(undo(t))), null);
  assert.equal(captionsOf(reset(t, 10)), null);
  assert.equal(captionsOf(reset(t, 10, "timeline")).cues.length, 2);
  assert.equal(captionsOf(reset(t, 10, "captions")), null);
  assert.equal(captionsOf(reset(t, 10, "elements")).cues.length, 2);
});

test("history keeps the latest 100 steps, so stored data stays bounded", () => {
  let t = applyCaptions(
    createTimeline(400),
    buildCues(sentences(150), createTimeline(400)).cues,
    {
      ids,
    },
  ).timeline;
  const cue = captionsOf(t).cues[0].id;
  for (let i = 0; i < 130; i++)
    t = updateCue(t, 400, cue, { text: `Text ${i}` });
  assert.equal(t.past.length, 100);
  let back = t;
  for (let i = 0; i < 100; i++) back = undo(back);
  assert.equal(back.past.length, 0);
  assert.equal(captionsOf(back).cues[0].text, "Text 29");
  assert.equal(captionsOf(redo(back)).cues[0].text, "Text 30");
});

test("the caption render plan gives visible cues and the style in pixels", () => {
  const timeline = cut(createTimeline(20), 3.2, 6.2);
  let t = applyCaptions(timeline, buildCues(sentences(4, 3), timeline).cues, {
    ids,
  }).timeline;
  const plan = captionPlan(t, { width: 640, height: 360 });
  // The cue at source 3 was cut. Three cues show.
  assert.equal(plan.cues.length, 3);
  assert.deepEqual(
    [plan.x, plan.y, plan.width, plan.height, plan.fontSize],
    [51, 288, 538, 54, 16],
  );
  assert.ok(
    plan.cues.every((c, i) => i === 0 || c.start >= plan.cues[i - 1].end),
  );
  assert.equal(plan.cues[1].text, "Line2.");
});
