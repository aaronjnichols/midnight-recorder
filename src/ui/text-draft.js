// Rules for a text draft: one session of typing on one text element. No DOM
// or Electron dependency, so node:test checks it directly.
//
// A draft is local to the page. Only an apply sends a shared command, so one
// session is one saved change and one undo step.
import { checkText, FRAME_EDGE, TEXT_CONFLICT } from "../domain/elements.js";
import { fadeShare } from "../domain/timeline.js";

export const FRAME_RATE = 30;
// Below this share of its fades, an element is too faint to type on.
const USABLE_FADE = 0.5;

let tokens = 0;

export function openDraft(videoId, element) {
  return {
    token: ++tokens,
    videoId,
    elementId: element.id,
    base: element.text,
    text: element.text,
    touched: false,
    state: "editing",
    message: null,
    conflict: false,
  };
}

export const typeDraft = (draft, text) => ({
  ...draft,
  text,
  touched: true,
  state: "editing",
  message: null,
  conflict: false,
});

// A saved change during the session. An untouched draft shows it. A touched
// draft keeps its text and its base, so the save reports the conflict.
export const followSaved = (draft, element) =>
  draft.touched ? draft : { ...draft, base: element.text, text: element.text };

// A draft can be empty or too long while the user types. A reason shows at
// once for a limit, but an empty field is a normal step in typing.
export function liveProblem(text) {
  if (!/\S/u.test(text)) return null;
  try {
    checkText(text);
    return null;
  } catch (error) {
    return error.message;
  }
}

// What an apply does. The intent is frozen: it stays the same if the user
// types again, selects another element, or opens another video.
export function applyPlan(draft) {
  if (draft.text === draft.base) return { kind: "none" };
  try {
    checkText(draft.text);
  } catch (error) {
    return { kind: "refuse", message: error.message };
  }
  return {
    kind: "save",
    intent: Object.freeze({
      token: draft.token,
      videoId: draft.videoId,
      elementId: draft.elementId,
      baseText: draft.base,
      text: draft.text,
    }),
  };
}

export const startSave = (draft) => ({
  ...draft,
  state: "saving",
  message: null,
  conflict: false,
});

export const saveFailed = (draft, message) => ({
  ...draft,
  state: "failed",
  message,
  conflict: message.includes(TEXT_CONFLICT),
});

// The user keeps their text over a saved change. The guard stays, with the
// saved text that the user has now seen.
export const rebaseDraft = (draft, text) => ({
  ...draft,
  base: text,
  state: "editing",
  message: null,
  conflict: false,
});

// A failed save of a session that the page already left.
export const draftFromIntent = (intent, message) =>
  saveFailed(
    {
      ...openDraft(intent.videoId, {
        id: intent.elementId,
        text: intent.baseText,
      }),
      text: intent.text,
      touched: true,
    },
    message,
  );

// Pasted text as text that the shared command accepts. Paste does not cut
// text at a limit, so nothing is lost without a message.
export const cleanPaste = (text) =>
  text
    .toWellFormed()
    .replace(/\r\n?|[\v\f\x85\p{Zl}\p{Zp}]/gu, "\n")
    .replace(/(?![\n\t])\p{Cc}/gu, "");

// The text block in its box, in frame pixels from the top left of the box. It
// follows the measured drawtext rules:
// - The block height is from the ink top of the first line to the ink bottom
//   of the last line, with the font line height between lines.
// - A line wider than the box stays on the same side or center, and the box
//   cuts it.
// The result is the CSS line box of the first line, so `top` steps back from
// the first baseline by the font ascent and half of the line gap.
export function draftLayout(box, lines, font) {
  const innerWidth = box.width - 2 * box.padding;
  const innerHeight = box.height - 2 * box.padding;
  const first = lines[0];
  const inkHeight =
    (lines.length - 1) * font.lineHeight + first.ascent + lines.at(-1).descent;
  const inkTop =
    box.padding +
    { top: 0, middle: 0.5, bottom: 1 }[box.verticalAlign] *
      (innerHeight - inkHeight);
  const width = Math.max(innerWidth, ...lines.map((line) => line.width));
  const gap = (font.lineHeight - font.ascent - font.descent) / 2;
  return {
    left:
      box.padding +
      { left: 0, center: 0.5, right: 1 }[box.align] * (innerWidth - width),
    top: inkTop + first.ascent - font.ascent - gap,
    width,
    height: lines.length * font.lineHeight,
    lineHeight: font.lineHeight,
  };
}

// The share of an element that its own fades show at a frame time, 0 to 1.
function shownShare(element, seconds) {
  if (
    seconds < element.start - FRAME_EDGE ||
    seconds >= element.end - FRAME_EDGE
  )
    return 0;
  const frame = Math.round(seconds * FRAME_RATE);
  const { start, end, actualFadeIn, actualFadeOut } = element;
  return (
    (actualFadeIn ? fadeShare(frame, FRAME_RATE, start, actualFadeIn) : 1) *
    (actualFadeOut
      ? 1 - fadeShare(frame, FRAME_RATE, end - actualFadeOut, actualFadeOut)
      : 1)
  );
}

// The frame time of the frame that shows at a playhead time.
export const frameTime = (seconds) =>
  Math.floor(seconds * FRAME_RATE + 1e-6) / FRAME_RATE;

export const draftAlpha = (element, seconds) =>
  element.opacity * shownShare(element, seconds);

// SMPTE 170M primaries to sRGB primaries, on linear light.
const SMPTE_TO_SRGB = [
  [0.93954, 0.05018, 0.01028],
  [0.01777, 0.96579, 0.01643],
  [-0.00162, -0.00437, 1.00599],
];
const toLinear = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const toSrgb = (value) =>
  value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

// FFmpeg writes a color as BT.601 and Chromium reads it as BT.709. Limited range.
function matrixShift([r, g, b]) {
  const luma = 1.16438 * (65.481 * r + 128.553 * g + 24.966 * b);
  const cb = -37.797 * r - 74.203 * g + 112 * b;
  const cr = 112 * r - 93.786 * g - 18.214 * b;
  return [
    luma + 1.79274 * cr,
    luma - 0.21325 * cb - 0.53291 * cr,
    luma + 2.1124 * cb,
  ].map((value) => value / 255);
}

// The color that the player shows for a color of the video. The frame result
// names the case: see renderInfo in src/adapters/media.js.
export function shownColor(hex, displayColor) {
  const color = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = color.map(toLinear);
  const shown =
    displayColor === "bt709"
      ? matrixShift(color)
      : SMPTE_TO_SRGB.map((row) =>
          toSrgb(
            Math.max(
              0,
              row.reduce((sum, v, i) => sum + v * linear[i], 0),
            ),
          ),
        );
  return `#${shown
    .map((value) =>
      Math.min(255, Math.max(0, Math.round(value * 255)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

// The time to edit an element. A playhead that shows the element stays, so the
// picture does not jump. Otherwise the time moves to the frame nearest the
// fade peak. Element opacity does not count, so permanently translucent text
// stays usable. The time is the middle of the frame. An element that shows on
// no frame has no better time.
export function editTime(element, playhead) {
  if (element.visibility === "none") return playhead;
  const first = Math.ceil((element.start - FRAME_EDGE) * FRAME_RATE);
  const last = Math.ceil((element.end - FRAME_EDGE) * FRAME_RATE) - 1;
  if (last < first) return playhead;
  if (shownShare(element, frameTime(playhead)) >= USABLE_FADE) return playhead;
  const peak = (element.start + element.actualFadeIn) * FRAME_RATE;
  const [early, late] = [Math.floor(peak), Math.ceil(peak)].map((frame) =>
    Math.min(last, Math.max(first, frame)),
  );
  const share = (frame) => shownShare(element, frame / FRAME_RATE);
  return ((share(late) > share(early) ? late : early) + 0.5) / FRAME_RATE;
}
