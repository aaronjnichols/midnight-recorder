// Pure rules of the Transcript tool and the Parts list.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseJob,
  clockMillis,
  cutNotice,
  moveWord,
  partRows,
  rangeText,
  selectionText,
  timedWords,
  transcriptKey,
  transcriptPanel,
  wordAt,
  wordSummary,
} from "../src/ui/transcript-view.js";
import { canonicalWords, mapWords, selectWords } from "../src/domain/words.js";
import {
  addSplit,
  configure,
  createTimeline,
  cut,
} from "../src/domain/timeline.js";

const video = (extra = {}) => ({
  metadata: { duration: 60, hasAudio: true },
  timeline: createTimeline(60),
  ...extra,
});
const available = { available: true, maxSourceSeconds: 3600 };
const panel = (args) =>
  transcriptPanel({ video: video(), capability: available, ...args });

test("the panel tells each state before words are ready", () => {
  assert.equal(panel({ capability: null }).kind, "checking");

  const missing = panel({ capability: { available: false } });
  assert.equal(missing.kind, "unavailable");
  assert.equal(missing.canStart, false);
  assert.match(missing.text, /npm run setup:transcription/);

  const silent = transcriptPanel({
    video: video({ metadata: { duration: 60, hasAudio: false } }),
    capability: available,
  });
  assert.equal(silent.kind, "no_audio");
  assert.equal(silent.canStart, false);
  assert.match(silent.text, /no sound/);

  const long = transcriptPanel({
    video: video({ metadata: { duration: 3601, hasAudio: true } }),
    capability: available,
  });
  assert.equal(long.kind, "too_long");
  assert.equal(long.canStart, false);
  assert.match(long.text, /60 minutes/);

  const idle = panel({});
  assert.equal(idle.kind, "idle");
  assert.equal(idle.canStart, true);
  assert.equal(idle.startLabel, "Make transcript");
  assert.match(idle.text, /on this computer/);
});

test("a running job has progress and Cancel, and an end has Retry", () => {
  const starting = panel({ job: { state: "running", progress: {} } });
  assert.equal(starting.kind, "running");
  assert.equal(starting.canCancel, true);
  assert.equal(starting.canStart, false);
  assert.equal(starting.progress, null);

  const audio = panel({
    job: { state: "running", progress: { phase: "audio" } },
  });
  assert.match(audio.text, /audio/i);

  const speech = panel({
    job: {
      state: "running",
      progress: { phase: "speech", completedRegions: 2, totalRegions: 8 },
    },
  });
  assert.equal(speech.progress, 0.25);
  assert.match(speech.text, /part 2 of 8/);

  const cancelling = panel({ job: { state: "cancelling" } });
  assert.equal(cancelling.kind, "running");
  assert.equal(cancelling.canCancel, false);
  assert.match(cancelling.text, /Cancelling/);

  const cancelled = panel({ job: { state: "cancelled" } });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.canStart, true);
  assert.equal(cancelled.startLabel, "Make transcript");

  const failed = panel({ job: { state: "failed", error: "Engine stopped." } });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.tone, "error");
  assert.equal(failed.startLabel, "Try again");
  assert.match(failed.text, /Engine stopped/);
});

test("a complete job gives no speech, loading, or ready", () => {
  const done = (outcome) => ({ state: "complete", result: { outcome } });
  const none = panel({ job: done("no_speech") });
  assert.equal(none.kind, "no_speech");
  assert.match(none.text, /No speech/);
  assert.equal(none.canStart, false);
  assert.equal(panel({ job: done("no_audio") }).kind, "no_audio");

  const loading = panel({
    job: done("ready"),
    load: { loaded: 1000, total: 4000 },
  });
  assert.equal(loading.kind, "loading");
  assert.equal(loading.progress, 0.25);
  assert.match(loading.text, /1000 of 4000/);

  assert.equal(
    panel({ job: done("ready"), load: { loaded: 40, total: 40 } }).kind,
    "ready",
  );
});

test("a changed source file stops cuts and asks for a new transcript", () => {
  const view = panel({
    job: { state: "complete", result: { outcome: "ready" } },
    load: { loaded: 5, total: 5 },
    sourceCurrent: false,
  });
  assert.equal(view.kind, "ready");
  assert.match(view.warning, /source file changed/);
  assert.equal(view.canStart, true);
  assert.equal(view.startLabel, "Make a new transcript");
});

const words = canonicalWords(
  Array.from({ length: 6 }, (_, n) => ({
    word: ` w${n}`,
    start: n,
    end: n + 0.5,
    probability: 0.9,
    segmentId: 0,
  })),
);

test("the summary shows the words, the range, and the length", () => {
  const timeline = createTimeline(10);
  const view = mapWords(words, timeline);
  assert.equal(
    wordSummary(selectWords(view, timeline, "w1", "w3")),
    "3 words · 0:01.00 to 0:03.50 · 2.50 s",
  );
  assert.equal(
    wordSummary(selectWords(view, timeline, "w2", "w2")),
    "1 word · 0:02.00 to 0:02.50 · 0.50 s",
  );
  assert.equal(wordSummary(null), "");
});

test("the summary tells what the cut excludes, and why a cut cannot run", () => {
  const timeline = cut(createTimeline(10), 1.75, 3.25);
  const view = mapWords(words, timeline);
  assert.match(
    wordSummary(selectWords(view, timeline, "w1", "w4")),
    /^3 words .* 1 already cut, 1 part cut$/,
  );
  const gone = selectWords(view, timeline, "w2", "w2");
  assert.equal(
    wordSummary(gone),
    "These words are already cut from the video.",
  );
});

test("the text of a selection has the kept words, and the copy has them all", () => {
  const timeline = cut(createTimeline(10), 1.75, 3.25);
  const view = mapWords(words, timeline);
  assert.equal(selectionText(view, 1, 4), "w1 w3 w4");
  assert.equal(selectionText(view, 2, 2), "");
});

test("the current word uses edited times with a binary search", () => {
  const timeline = cut(createTimeline(10), 1.75, 3.25);
  const timed = timedWords(mapWords(words, timeline));
  assert.deepEqual(
    timed.map((w) => w.index),
    [0, 1, 3, 4, 5],
  );
  assert.equal(wordAt(timed, 0.2), 0);
  assert.equal(wordAt(timed, 0.75), -1, "In the pause.");
  assert.equal(wordAt(timed, 1.1), 1);
  assert.equal(wordAt(timed, 1.8), 3, "After the join.");
  assert.equal(wordAt(timed, 9), -1);
  assert.equal(wordAt([], 1), -1);
});

test("the current word stays correct when word times overlap or nest", () => {
  const nested = canonicalWords(
    [
      [" long", 0, 4],
      [" short", 1, 2],
      [" last", 2, 3],
    ].map(([word, start, end]) => ({ word, start, end })),
  );
  const timed = timedWords(mapWords(nested, createTimeline(10)));
  assert.equal(wordAt(timed, 3.5), 0, "Inside the long word only.");
  assert.equal(wordAt(timed, 2.5), 2, "The latest word that started.");
  assert.equal(wordAt(timed, 1.5), 1);
  assert.equal(wordAt(timed, 0.5), 0);
  assert.equal(wordAt(timed, 4), -1, "The end is not in the word.");
  assert.equal(wordAt(timed, 9), -1);

  // A long word early in a long list stays found, with a bounded search.
  const many = canonicalWords([
    { word: " long", start: 0, end: 500 },
    ...Array.from({ length: 400 }, (_, n) => ({
      word: ` w${n}`,
      start: n + 1,
      end: n + 1.5,
    })),
  ]);
  const list = timedWords(mapWords(many, createTimeline(600)));
  assert.equal(wordAt(list, 450), 0);
  assert.equal(wordAt(list, 10.25), 10);
});

test("job choice: a new request stays, and an older result cannot replace it", () => {
  const job = (id, state, extra = {}) => ({
    id,
    state,
    startedAt: `2026-11-03T00:00:0${id}.000Z`,
    options: { language: "en", vocabulary: [] },
    ...extra,
  });
  const done = (id, extra = {}) =>
    job(id, "complete", {
      result: {
        outcome: "ready",
        wordCount: 5,
        identity: { model: "a" },
        cached: false,
        ...extra,
      },
    });
  const old = done(1);
  const running = job(2, "running");

  // The reproduction: Make a new transcript after a source change.
  assert.deepEqual(
    chooseJob({ jobs: [old, running], current: running, hasWords: false }),
    { action: "keep" },
  );
  // The new result then replaces the old words.
  const fresh = done(2);
  assert.deepEqual(
    chooseJob({ jobs: [old, fresh], current: old, hasWords: true }),
    { action: "load", job: fresh },
  );
  // An external job shows while nothing is on the panel.
  assert.deepEqual(
    chooseJob({ jobs: [running], current: null, hasWords: false }),
    { action: "watch", job: running },
  );
  // Words stay on the panel while another job runs.
  assert.deepEqual(
    chooseJob({ jobs: [old, running], current: old, hasWords: true }),
    { action: "keep" },
  );
  // A complete job loads when the panel has nothing.
  assert.deepEqual(chooseJob({ jobs: [old], current: null, hasWords: false }), {
    action: "load",
    job: old,
  });
  // An older job does not replace the current job.
  assert.deepEqual(
    chooseJob({ jobs: [old, fresh], current: fresh, hasWords: true }),
    { action: "keep" },
  );
  // A selection waits. The next update loads the new words.
  assert.deepEqual(
    chooseJob({
      jobs: [old, fresh],
      current: old,
      hasWords: true,
      hasSelection: true,
    }),
    { action: "keep" },
  );
});

test("job choice: an old job list cannot roll back a newer result", () => {
  const complete = (id, second) => ({
    id,
    state: "complete",
    startedAt: `2026-11-03T00:00:0${second}.000Z`,
    options: { language: "en", vocabulary: [] },
    result: {
      outcome: "ready",
      wordCount: 5,
      identity: { model: "a" },
      cached: false,
    },
  });
  const old = complete("old", 1);
  const fresh = complete("fresh", 2);
  // A status reply from before the new job arrives after the job ended.
  assert.deepEqual(chooseJob({ jobs: [old], current: fresh, hasWords: true }), {
    action: "keep",
  });
  assert.deepEqual(
    chooseJob({ jobs: [old], current: fresh, hasWords: false }),
    { action: "keep" },
    "Also while its words load.",
  );
  // The current job in an old list is not a reason to change.
  assert.deepEqual(chooseJob({ jobs: [], current: fresh, hasWords: true }), {
    action: "keep",
  });
  // A newer job still replaces the current job.
  assert.deepEqual(
    chooseJob({ jobs: [old, fresh], current: old, hasWords: true }),
    { action: "load", job: fresh },
  );
});

test("job choice: the same cached words keep the list and its scroll", () => {
  const base = {
    state: "complete",
    options: { language: "en", vocabulary: [] },
  };
  const result = {
    outcome: "ready",
    wordCount: 5,
    identity: { model: "a" },
  };
  const first = {
    ...base,
    id: "a",
    startedAt: "2026-11-03T00:00:01.000Z",
    result: { ...result, cached: false },
  };
  const again = {
    ...base,
    id: "b",
    startedAt: "2026-11-03T00:00:02.000Z",
    result: { ...result, cached: true },
  };
  assert.deepEqual(
    chooseJob({ jobs: [first, again], current: first, hasWords: true }),
    { action: "switch", job: again },
  );
  // Other options or another count are other words.
  for (const other of [
    { ...again, options: { language: "en", vocabulary: ["Blender"] } },
    { ...again, result: { ...again.result, wordCount: 6 } },
    { ...again, result: { ...again.result, cached: false } },
    { ...again, result: { ...again.result, identity: { model: "b" } } },
  ])
    assert.deepEqual(
      chooseJob({ jobs: [first, other], current: first, hasWords: true }),
      { action: "load", job: other },
    );
});

test("job choice: an ended job shows only when no words can show", () => {
  const failed = { id: "f", state: "failed", startedAt: "2" };
  const old = {
    id: "o",
    state: "complete",
    startedAt: "1",
    result: { outcome: "ready" },
  };
  assert.deepEqual(chooseJob({ jobs: [failed], current: null }), {
    action: "show",
    job: failed,
  });
  assert.deepEqual(
    chooseJob({ jobs: [old, failed], current: old, hasWords: true }),
    { action: "keep" },
  );
  // A failed new request returns to the older words.
  assert.deepEqual(
    chooseJob({ jobs: [old, failed], current: failed, hasWords: false }),
    { action: "load", job: old },
  );
  assert.deepEqual(chooseJob({ jobs: [], current: null }), { action: "keep" });
});

test("a caret moves over removed words", () => {
  const timeline = cut(createTimeline(10), 1.75, 3.25);
  const view = mapWords(words, timeline);
  assert.equal(moveWord(view, 1, 1), 3);
  assert.equal(moveWord(view, 3, -1), 1);
  assert.equal(moveWord(view, 5, 1), 5, "The end stays.");
  assert.equal(moveWord(view, 0, -1), 0);
  assert.equal(moveWord(view, -1, 1), 0);
});

test("the transcript keys have one meaning each", () => {
  const press = (key, extra = {}) => transcriptKey({ key, ...extra });
  assert.deepEqual(press("ArrowRight"), { move: 1 });
  assert.deepEqual(press("ArrowLeft"), { move: -1 });
  assert.deepEqual(press("ArrowRight", { shiftKey: true }), { extend: 1 });
  assert.deepEqual(press("ArrowLeft", { shiftKey: true }), { extend: -1 });
  assert.deepEqual(press("ArrowDown"), { paragraph: 1 });
  assert.deepEqual(press("ArrowUp"), { paragraph: -1 });
  assert.deepEqual(press("ArrowDown", { shiftKey: true }), {
    extendParagraph: 1,
  });
  assert.deepEqual(press("Enter"), { seek: true });
  assert.deepEqual(press("Escape"), { clear: true });
  assert.deepEqual(press("a", { ctrlKey: true }), { all: true });
  // Delete must not cut. Other keys stay with the page.
  for (const key of ["Delete", "Backspace", " ", "i", "o", "s", "z"])
    assert.equal(press(key), null, key);
  assert.equal(press("c", { ctrlKey: true }), null, "Copy stays native.");
  assert.equal(
    press("z", { ctrlKey: true }),
    null,
    "Undo stays with the page.",
  );
  assert.equal(press("ArrowRight", { altKey: true }), null);
});

test("a time range and a precise clock show short parts", () => {
  assert.equal(clockMillis(0), "0:00.000");
  assert.equal(clockMillis(3.217), "0:03.217");
  assert.equal(clockMillis(75.0004), "1:15.000");
  assert.equal(clockMillis(3599.9996), "1:00:00.000");
  assert.equal(rangeText(1, 2.5), "0:01.00 to 0:02.50");
});

test("the Parts rows show exact times and length, for a part of any size", () => {
  const timeline = addSplit(
    addSplit(configure(createTimeline(10), { speed: 1.25 }), 2.5),
    2.56,
  );
  const rows = partRows(timeline, "p3125000-3200000");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.number),
    [1, 2, 3],
  );
  assert.equal(rows[1].startText, "0:02.500");
  assert.equal(rows[1].endText, "0:02.560");
  assert.equal(rows[1].lengthText, "0.060 s");
  assert.equal(rows[1].selected, true);
  assert.equal(rows[0].selected, false);
  assert.equal(rows[1].splitAfter, "s3200000");
  assert.match(rows[1].label, /^Part 2, 0:02\.500 to 0:02\.560, 0\.060 s/);
});

test("the Parts rows name the join of a cut", () => {
  const rows = partRows(cut(createTimeline(10), 2, 3), null);
  assert.equal(rows[1].seam, "cut");
  assert.equal(rows[1].splitBefore, null);
});

test("a cut message tells the time and the captions to check", () => {
  const selection = { keptWords: 3, length: 2.5 };
  assert.equal(
    cutNotice(selection, { partial: 0, removed: 0 }),
    "Cut 3 words, 2.50 s. Undo with Ctrl+Z.",
  );
  assert.equal(
    cutNotice({ keptWords: 1, length: 0.4 }, { partial: 1, removed: 2 }),
    "Cut 1 word, 0.40 s. Undo with Ctrl+Z. Check 3 captions in Captions: the cut changed their speech, not their text.",
  );
  assert.match(
    cutNotice(selection, { partial: 1, removed: 0 }),
    /Check 1 caption in Captions/,
  );
});
