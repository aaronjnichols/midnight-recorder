import { test } from "node:test";
import assert from "node:assert/strict";
import { TEXT_CONFLICT } from "../src/domain/elements.js";
import {
  openDraft,
  typeDraft,
  followSaved,
  applyPlan,
  startSave,
  saveFailed,
  rebaseDraft,
  draftFromIntent,
  liveProblem,
  cleanPaste,
  draftLayout,
  editTime,
  draftAlpha,
  shownColor,
} from "../src/ui/text-draft.js";

const element = { id: "e1", text: "Hello" };

test("a new draft is one session for one video and one element", () => {
  const draft = openDraft("v1", element);
  assert.equal(draft.videoId, "v1");
  assert.equal(draft.elementId, "e1");
  assert.equal(draft.text, "Hello");
  assert.equal(draft.base, "Hello");
  assert.equal(draft.state, "editing");
  assert.equal(draft.touched, false);
  assert.notEqual(draft.token, openDraft("v1", element).token);
});

test("apply sends nothing when the text did not change", () => {
  const draft = openDraft("v1", element);
  assert.deepEqual(applyPlan(draft), { kind: "none" });
  // Type, then return to the same text.
  const back = typeDraft(typeDraft(draft, "Hello!"), "Hello");
  assert.deepEqual(applyPlan(back), { kind: "none" });
});

test("apply captures one frozen intent with the text that the draft started from", () => {
  const draft = typeDraft(openDraft("v1", element), "Hello\nworld");
  const plan = applyPlan(draft);
  assert.equal(plan.kind, "save");
  assert.deepEqual(plan.intent, {
    token: draft.token,
    videoId: "v1",
    elementId: "e1",
    baseText: "Hello",
    text: "Hello\nworld",
  });
  assert.ok(Object.isFrozen(plan.intent));
  // Later typing does not change what apply captured.
  typeDraft(draft, "Later");
  assert.equal(plan.intent.text, "Hello\nworld");
});

test("a failed save from an old intent can come back as a draft", () => {
  const draft = typeDraft(openDraft("v1", element), "Mine");
  const { intent } = applyPlan(draft);
  const parked = draftFromIntent(intent, "Disk is full.");
  assert.equal(parked.state, "failed");
  assert.equal(parked.videoId, "v1");
  assert.equal(parked.elementId, "e1");
  assert.equal(parked.text, "Mine");
  assert.equal(parked.base, "Hello");
  assert.equal(parked.touched, true);
  assert.equal(parked.message, "Disk is full.");
});

test("an empty draft is valid while typing, and apply refuses it", () => {
  const draft = typeDraft(openDraft("v1", element), "   ");
  assert.equal(liveProblem(draft.text), null);
  const plan = applyPlan(draft);
  assert.equal(plan.kind, "refuse");
  assert.match(plan.message, /visible character/);
});

test("a draft over a limit shows the reason at once, and apply refuses it", () => {
  const long = "x".repeat(501);
  assert.match(liveProblem(long), /at most 500 characters/);
  assert.equal(
    applyPlan(typeDraft(openDraft("v1", element), long)).kind,
    "refuse",
  );
  const lines = Array(11).fill("a").join("\n");
  assert.match(liveProblem(lines), /at most 10 lines/);
  // Limits count characters, the same as the shared command.
  assert.equal(liveProblem("😀".repeat(500)), null);
  assert.equal(liveProblem("x".repeat(500)), null);
  assert.equal(liveProblem(Array(10).fill("a").join("\n")), null);
});

test("an untouched draft follows a saved change, and a touched draft keeps its text", () => {
  const draft = openDraft("v1", element);
  const followed = followSaved(draft, { text: "From the CLI" });
  assert.equal(followed.text, "From the CLI");
  assert.equal(followed.base, "From the CLI");
  const typed = typeDraft(draft, "Mine");
  const kept = followSaved(typed, { text: "From the CLI" });
  assert.equal(kept.text, "Mine");
  // The base stays, so the save reports the conflict and does not overwrite.
  assert.equal(applyPlan(kept).intent.baseText, "Hello");
});

test("a failed save keeps the text and reports a conflict separately", () => {
  const draft = startSave(typeDraft(openDraft("v1", element), "Mine"));
  assert.equal(draft.state, "saving");
  const failed = saveFailed(draft, "Disk is full.");
  assert.equal(failed.state, "failed");
  assert.equal(failed.text, "Mine");
  assert.equal(failed.message, "Disk is full.");
  assert.equal(failed.conflict, false);
  const conflict = saveFailed(draft, `Error: ${TEXT_CONFLICT}`);
  assert.equal(conflict.conflict, true);
  // Typing after a failure returns to editing and clears the failure.
  const again = typeDraft(failed, "Mine 2");
  assert.equal(again.state, "editing");
  assert.equal(again.message, null);
  assert.equal(again.conflict, false);
});

test("the user can keep their text after a conflict", () => {
  const conflict = saveFailed(
    startSave(typeDraft(openDraft("v1", element), "Mine")),
    TEXT_CONFLICT,
  );
  const rebased = rebaseDraft(conflict, "From the CLI");
  assert.equal(rebased.text, "Mine");
  const { intent } = applyPlan(rebased);
  assert.equal(intent.text, "Mine");
  // The guard stays, with the fresh saved text.
  assert.equal(intent.baseText, "From the CLI");
});

test("pasted text becomes plain text that the shared command accepts", () => {
  assert.equal(cleanPaste("a\r\nb\rc"), "a\nb\nc");
  const separators = ["a", "b", "c", "d", "e", "f"].join("#");
  const breaks = [0x2028, 0x2029, 0x0b, 0x0c, 0x85];
  let index = 0;
  const mixed = separators.replace(/#/g, () =>
    String.fromCodePoint(breaks[index++]),
  );
  assert.equal(cleanPaste(mixed), "a\nb\nc\nd\ne\nf");
  assert.equal(cleanPaste("a\u0007b\u0000c\u001bd"), "abcd");
  assert.equal(cleanPaste("tab\tstays"), "tab\tstays");
  assert.equal(cleanPaste("é 日本語 😀"), "é 日本語 😀");
  // An unpaired surrogate cannot be saved.
  const lone = "a" + String.fromCharCode(0xd83d) + "b";
  assert.equal(cleanPaste(lone), "a" + String.fromCodePoint(0xfffd) + "b");
  // Paste does not cut text at the limit. The inline message tells the user.
  assert.equal(cleanPaste("x".repeat(900)).length, 900);
});

// Segoe UI at 64 px, measured in Chromium. Line height is line-height: normal.
const font = { ascent: 68, descent: 17, lineHeight: 85 };
const box = {
  width: 800,
  height: 400,
  padding: 16,
  align: "center",
  verticalAlign: "middle",
};
const line = (width, ascent, descent) => ({ width, ascent, descent });

test("draft layout uses the ink height of the text block, the same as drawtext", () => {
  // Measured: "aaaa" has ink from y 333 to 366 in a box at y 150.
  const one = draftLayout(box, [line(130, 34, 0)], font);
  const inkTop = 16 + (368 - 34) / 2;
  assert.equal(one.lineHeight, 85);
  assert.equal(one.height, 85);
  assert.equal(one.top, inkTop + 34 - 68);
  assert.ok(Math.abs(150 + inkTop - 333) <= 1);
  // Two lines: first line ascent, line height, last line descent.
  const two = draftLayout(box, [line(83, 46, 14), line(83, 46, 14)], font);
  const block = 85 + 46 + 14;
  assert.equal(two.height, 170);
  assert.equal(two.top, 16 + (368 - block) / 2 + 46 - 68);
  assert.equal(
    draftLayout({ ...box, verticalAlign: "top" }, [line(83, 46, 14)], font).top,
    16 + 46 - 68,
  );
  assert.equal(
    draftLayout({ ...box, verticalAlign: "bottom" }, [line(83, 46, 14)], font)
      .top,
    16 + 368 - 60 + 46 - 68,
  );
});

test("draft layout splits a line gap evenly around the font", () => {
  const roomy = { ascent: 60, descent: 15, lineHeight: 85 };
  // CSS centers the font in the line box, 5 px above and below.
  const top = draftLayout(
    { ...box, verticalAlign: "top" },
    [line(83, 46, 14)],
    roomy,
  ).top;
  assert.equal(top, 16 + 46 - 60 - 5);
});

test("draft layout centers a wide line on the box, and text is cut at the box", () => {
  const inner = 768;
  const narrow = draftLayout(box, [line(130, 34, 0)], font);
  assert.equal(narrow.left, 16);
  assert.equal(narrow.width, inner);
  for (const [align, left] of [
    ["left", 16],
    ["center", 16 + (inner - 1650) / 2],
    ["right", 16 + inner - 1650],
  ]) {
    const wide = draftLayout({ ...box, align }, [line(1650, 34, 0)], font);
    assert.equal(wide.left, left, align);
    assert.equal(wide.width, 1650);
  }
});

const timed = (extra) => ({
  start: 2,
  end: 5,
  visibility: "full",
  opacity: 1,
  actualFadeIn: 0,
  actualFadeOut: 0,
  ...extra,
});
const frameCenter = (n) => (n + 0.5) / 30;

test("the edit time stays at a playhead that shows the element", () => {
  assert.equal(editTime(timed(), 3), 3);
  assert.equal(editTime(timed({ actualFadeIn: 1 }), 2.6), 2.6);
});

test("the edit time moves into the element when the playhead is outside it", () => {
  assert.equal(editTime(timed(), 1), frameCenter(60));
  assert.equal(editTime(timed(), 5), frameCenter(60));
  // The first frame at or after a start that is not on a frame.
  assert.equal(editTime(timed({ start: 2.01 }), 1), frameCenter(61));
  // The frame at the playhead decides, not the exact time.
  assert.equal(editTime(timed({ start: 2.01 }), 2.02), frameCenter(61));
});

test("the edit time moves to the first full frame in a low fade", () => {
  const faded = timed({ actualFadeIn: 1, actualFadeOut: 1 });
  assert.equal(editTime(faded, 2.1), frameCenter(90));
  assert.equal(editTime(faded, 4.9), frameCenter(90));
  // Fades that fill the element meet at one full frame.
  const peak = timed({ actualFadeIn: 1.5, actualFadeOut: 1.5 });
  assert.equal(editTime(peak, 2.05), frameCenter(105));
});

test("permanently translucent text does not count as a low fade", () => {
  // Element opacity never reaches 1, so the fade factor decides.
  const glass = timed({ opacity: 0.3 });
  assert.equal(editTime(glass, 3), 3);
  const faded = timed({ opacity: 0.3, actualFadeIn: 1 });
  assert.equal(editTime(faded, 2.1), frameCenter(90));
  assert.equal(editTime(faded, 2.8), 2.8);
});

test("a short element with opposing fades uses its best frame", () => {
  // A 0.05 s element: the peak is at 2.025 s, between frames 60 and 61.
  const short = timed({
    start: 2,
    end: 2.05,
    actualFadeIn: 0.025,
    actualFadeOut: 0.025,
  });
  const time = editTime(short, 1);
  // Frame 61 at 2.0333 s has the higher factor. Frame 60 has factor 0.
  assert.equal(time, frameCenter(61));
  // The result is always a frame in the element.
  assert.ok(time >= 2 && time < 2.05 + 1 / 30);
});

test("the edit time stays at the playhead when no frame shows the element", () => {
  // The remaining part is shorter than a frame, between two frames.
  const sliver = timed({ start: 2.01, end: 2.02 });
  assert.equal(editTime(sliver, 4), 4);
  assert.equal(editTime({ visibility: "none", start: null, end: null }, 4), 4);
});

test("draft alpha counts whole frames, the same as the element fade in the export", () => {
  // Measured: a fade in of 0.05 s from 2 s is half at the next frame.
  const element = timed({ actualFadeIn: 0.05 });
  assert.equal(draftAlpha(element, 2), 0);
  assert.equal(draftAlpha(element, 61 / 30), 0.5);
  assert.equal(draftAlpha(element, 62 / 30), 1);
});

test("a shown color follows the player for an untagged HD video", () => {
  // The measured player color of #E02020.
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (const [display, measured] of [
    ["bt709", [240, 51, 28]],
    ["smpte170m", [218, 47, 30]],
  ]) {
    const shown = rgb(shownColor("#E02020", display));
    measured.forEach((value, i) =>
      assert.ok(Math.abs(shown[i] - value) <= 2, `${display}: ${shown}`),
    );
    // Gray has no shift, and a color stays in range.
    assert.equal(shownColor("#FFFFFF", display), "#FFFFFF");
    assert.equal(shownColor("#000000", display), "#000000");
    assert.equal(shownColor("#808080", display), "#808080");
    assert.match(shownColor("#FF0000", display), /^#[0-9A-F]{6}$/);
  }
});

test("draft alpha has the element opacity and its fades at a frame", () => {
  const element = timed({ opacity: 0.8, actualFadeIn: 1, actualFadeOut: 2 });
  assert.equal(draftAlpha(element, 1.9), 0);
  assert.equal(draftAlpha(element, 5), 0);
  assert.ok(Math.abs(draftAlpha(element, 2.5) - 0.4) < 1e-9);
  assert.ok(Math.abs(draftAlpha(element, 3) - 0.8) < 1e-9);
  assert.ok(Math.abs(draftAlpha(element, 4) - 0.4) < 1e-9);
});
