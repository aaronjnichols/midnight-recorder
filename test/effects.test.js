import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTimeline,
  configure,
  trim,
  undo,
  redo,
  reset,
  isEdited,
  videoFades,
} from "../src/domain/timeline.js";
import { editRevision } from "../src/domain/inspection.js";

test("video fades use the edit history and report actual values", () => {
  const plain = createTimeline(10);
  assert.deepEqual(videoFades(plain), {
    fadeIn: 0,
    fadeOut: 0,
    actualFadeIn: 0,
    actualFadeOut: 0,
  });
  let t = configure(plain, { fadeIn: 1, fadeOut: 2 });
  assert.equal(isEdited(t, 10), true);
  assert.deepEqual(videoFades(t), {
    fadeIn: 1,
    fadeOut: 2,
    actualFadeIn: 1,
    actualFadeOut: 2,
  });
  // A configure call without fades keeps them.
  t = configure(t, { speed: 1.25 });
  assert.equal(videoFades(t).fadeOut, 2);
  t = configure(t, { speed: 1 });
  // A 2-second video is shorter than 1 + 2 seconds of fades. Both get
  // shorter in proportion. The stored request stays.
  const short = trim(t, 0, 2);
  const fades = videoFades(short);
  assert.deepEqual([fades.fadeIn, fades.fadeOut], [1, 2]);
  assert.ok(Math.abs(fades.actualFadeIn - 2 / 3) < 1e-6);
  assert.ok(Math.abs(fades.actualFadeOut - 4 / 3) < 1e-6);
  assert.deepEqual(videoFades(undo(short)).actualFadeOut, 2);
  // Undo back to before the fades.
  assert.equal(videoFades(undo(undo(undo(t)))).fadeIn, 0);
  assert.equal(videoFades(redo(undo(t))).fadeIn, 1);
  for (const [value, message] of [
    [{ fadeIn: -1 }, /fadeIn must be/],
    [{ fadeOut: 10.5 }, /fadeOut must be/],
    [{ fadeIn: Number.NaN }, /fadeIn must be/],
  ])
    assert.throws(() => configure(plain, value), message);
  // Reset scopes: timeline resets fades, elements keeps them.
  assert.equal(videoFades(reset(t, 10, "timeline")).fadeIn, 0);
  assert.equal(videoFades(reset(t, 10, "elements")).fadeIn, 1);
  assert.equal(videoFades(reset(t, 10)).fadeOut, 0);
});

test("old history and old revisions stay valid without fade keys", () => {
  // A stored state from before fades: no fade keys anywhere.
  const old = {
    segments: [{ start: 0, end: 8 }],
    speed: 1,
    muted: false,
    past: [{ segments: [{ start: 0, end: 10 }], speed: 1, muted: false }],
    future: [],
  };
  assert.deepEqual(videoFades(old).fadeIn, 0);
  const faded = configure(old, { fadeOut: 1 });
  assert.equal(videoFades(undo(faded)).fadeOut, 0);
  assert.equal(videoFades(undo(undo(faded))).fadeOut, 0);
  // A state without fades has the same revision as before fades existed.
  assert.equal(
    editRevision({ timeline: { ...old, fadeIn: 0, fadeOut: 0 } }),
    editRevision({ timeline: old }),
  );
  assert.notEqual(
    editRevision({ timeline: faded }),
    editRevision({ timeline: old }),
  );
});
