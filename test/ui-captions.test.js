import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimeline, cut, configure } from "../src/domain/timeline.js";
import { applyCaptions } from "../src/domain/captions.js";
import {
  cueRows,
  cueTimeText,
  captionState,
  jobView,
  positionOf,
  POSITIONS,
  captionGap,
} from "../src/ui/caption-view.js";

let next = 0;
const ids = () => `c${++next}`;
const captioned = (cues, timeline = createTimeline(20)) =>
  applyCaptions(
    timeline,
    cues.map(([sourceStart, sourceEnd, text, check = false]) => ({
      sourceStart,
      sourceEnd,
      text,
      check,
    })),
    { ids },
  ).timeline;

test("caption rows show times, one-line text, marks, selection, and the current cue", () => {
  const timeline = cut(
    captioned([
      [1, 2.5, "First line\nsecond line"],
      [3, 4, "Low confidence", true],
      [5, 7, "Partly cut"],
      [8, 9, "Removed"],
    ]),
    6,
    9.5,
  );
  const ids = timeline.captions.cues.map((c) => c.id);
  const rows = cueRows(timeline, ids[1], 3.5);
  assert.deepEqual(
    rows.map((r) => [r.text, r.check, r.visibility, r.selected, r.current]),
    [
      ["First line / second line", false, "full", false, false],
      ["Low confidence", true, "full", true, true],
      ["Partly cut", false, "partial", false, false],
      ["Removed", false, "none", false, false],
    ],
  );
  assert.equal(rows[0].timeText, "0:01.0 to 0:02.5");
  assert.equal(rows[3].timeText, "Cut from the video");
  assert.equal(cueTimeText(65.25, 70), "1:05.3 to 1:10.0");
});

test("caption state explains sound, setup, and what generation can do", () => {
  const video = (timeline, hasAudio = true) => ({
    timeline,
    metadata: { duration: 20, width: 1280, height: 720, hasAudio },
  });
  const empty = captionState(video(createTimeline(20)), { available: true });
  assert.equal(empty.countText, "No captions");
  assert.equal(empty.canGenerate, true);
  assert.equal(empty.generateLabel, "Make captions from speech");
  const some = captionState(
    video(
      captioned([
        [1, 2, "A", true],
        [3, 4, "B"],
      ]),
    ),
    { available: true },
  );
  assert.equal(some.countText, "2 captions · 1 to check");
  assert.equal(some.generateLabel, "Make new captions from speech");
  const muted = captionState(
    video(configure(captioned([[1, 2, "A"]]), { muted: true })),
    { available: true },
  );
  assert.match(muted.audio, /muted.*Captions still show/);
  assert.equal(muted.canGenerate, true, "Speech is in the source audio.");
  const silent = captionState(video(createTimeline(20), false), {
    available: true,
  });
  assert.match(silent.audio, /no sound/);
  assert.equal(silent.canGenerate, false);
  const missing = captionState(video(createTimeline(20)), {
    available: false,
    reason: "No runtime.",
  });
  assert.equal(missing.canGenerate, false);
  assert.match(missing.setup, /not set up.*npm run setup:transcription/);
  const unknown = captionState(video(createTimeline(20)), null);
  assert.equal(unknown.canGenerate, false, "Wait for the capability check.");
});

test("job view gives plain progress, cancel, and the next action", () => {
  const running = jobView({
    state: "running",
    progress: { phase: "speech", completedRegions: 2, totalRegions: 4 },
    message: "Recognizing speech: part 2 of 4.",
  });
  assert.deepEqual(
    [running.running, running.progress, running.canCancel, running.canApply],
    [true, 0.5, true, false],
  );
  assert.equal(running.text, "Recognizing speech: part 2 of 4.");
  const starting = jobView({
    state: "running",
    progress: { phase: "audio" },
    message: "Preparing the audio.",
  });
  assert.equal(starting.progress, null, "Unknown progress has no bar value.");
  const draft = jobView({
    state: "draft",
    changed: true,
    message: "The video changed.",
  });
  assert.deepEqual(
    [draft.running, draft.canApply, draft.tone],
    [false, true, "warn"],
  );
  const failed = jobView({
    state: "failed",
    message: "Captions were not made. Decoder failed.",
  });
  assert.equal(failed.tone, "error");
  assert.equal(
    jobView({ state: "applied", message: "Added 3 captions." }).tone,
    "ok",
  );
  // Speech that is not in the captions is a warning, also after an apply.
  assert.equal(
    jobView({
      state: "applied",
      warning: "1 word ...",
      message: "Added 1 caption.",
    }).tone,
    "warn",
  );
  assert.equal(
    jobView({ state: "no_speech", message: "No speech." }).tone,
    "warn",
  );
  assert.equal(
    jobView({ state: "cancelling", message: "Cancelling." }).canCancel,
    false,
  );
});

test("review UI 2: a new caption at the playhead ends in the edited video", () => {
  // A 10-second source at 1.5x speed is 6.666... seconds long.
  const timeline = configure(
    captioned([
      [1, 2, "A"],
      [3, 4, "B"],
    ]),
    { speed: 1.5 },
  );
  const total = 10 / 1.5;
  const rows = cueRows(timeline, null, 5);
  assert.deepEqual(captionGap(rows, 5, total), { start: 5, end: total });
  assert.ok(captionGap(rows, 5, total).end <= total);
  // The next caption starts at a fractional time: the gap ends there.
  assert.deepEqual(captionGap(rows, 1.5, total), { start: 1.5, end: 2 });
  assert.equal(captionGap(rows, 1, total).error, "inside");
  assert.equal(captionGap(rows, 1.9, total).error, "short");
  assert.equal(captionGap(rows, total, total).error, "short");
});

test("caption positions map to the caption area and back", () => {
  for (const [name, value] of Object.entries(POSITIONS))
    assert.equal(positionOf({ ...value, height: 0.15 }), name);
  assert.equal(positionOf({ y: 0.3, verticalAlign: "top" }), "custom");
});
