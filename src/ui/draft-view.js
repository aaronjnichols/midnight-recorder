// The draft picture of one text element, on the displayed frame. Bottom first:
// an image of the layers below the element, the element as browser text, an
// image of the layers above it, and the video fade. FFmpeg draws the two
// images with the operations of the export, so only the one text box here is
// a browser approximation. The exact preview and the export stay the true
// picture.
//
// The images do not have the element, so they stay valid while its text,
// style, or box changes. A key press only changes this page.
import { draftFrameIndex } from "../domain/draft-frame.js";
import { textBoxPixels } from "../domain/elements.js";
import { draftBaseRevision, editRevision } from "../domain/inspection.js";
import { FONT_NAMES } from "./element-view.js";
import {
  draftAlpha,
  draftLayout,
  FRAME_RATE,
  frameTime,
  shownColor,
} from "./text-draft.js";

const POLL_MS = 40;
const BAR_GAP = 6;

const pixels = (value) => `${value}px`;
const rgba = (hex, alpha) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
};

export function createDraftView({ $, call, frameSize, onChange }) {
  const view = $("#draft-view");
  const under = $("#draft-under");
  const over = $("#draft-over");
  const shade = $("#draft-fade");
  const plate = $("#draft-plate");
  const box = $("#draft-box");
  const text = $("#draft-text");
  const editor = $("#draft-editor");
  const input = $("#draft-input");
  const actions = $("#draft-actions");
  const ruler = document.createElement("canvas").getContext("2d");
  let rect = null,
    // The loaded images and the request that they answer.
    pair = null,
    // One request runs at a time, and only the latest waits. A late reply
    // cannot replace newer images, because each paint checks the request.
    active = null,
    waiting = null,
    // The last request without images. A paint does not ask for it again, so
    // a failure costs one request and not one for each key press.
    failed = null,
    target = null;

  const request = (video, elementId, seconds) => ({
    video,
    elementId,
    seconds,
    frame: frameTime(seconds),
    revision: draftBaseRevision(video, elementId),
  });
  const same = (a, b) =>
    Boolean(a) &&
    a.video.id === b.video.id &&
    a.elementId === b.elementId &&
    a.frame === b.frame &&
    a.revision === b.revision;

  async function readPair({ video, elementId, seconds, revision }) {
    const job = await call("preview.frame", {
      id: video.id,
      seconds,
      elementId,
      // The service refuses a stale request, so it cannot read a later state.
      revision: editRevision(video),
    });
    let state = job;
    while (state.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      state = await call("export.status", { jobId: job.id });
    }
    if (state.state !== "complete") throw new Error(state.error);
    // A reply can come after other edits. It shows only if it is this picture.
    const { result } = state;
    if (
      result.baseRevision !== revision ||
      result.elementId !== elementId ||
      result.frameIndex !== draftFrameIndex(video.timeline, seconds, FRAME_RATE)
    )
      throw new Error("The frame is for another edit state.");
    return result;
  }
  // The browser has the pixels before the page shows the image.
  function load(url) {
    const image = new Image();
    image.src = url;
    return image.decode();
  }
  async function run() {
    while (waiting) {
      active = waiting;
      waiting = null;
      try {
        const result = await readPair(active);
        await Promise.all(
          [result.under, result.over]
            .filter(Boolean)
            .map((file) => load(file.url)),
        );
        pair = { request: active, result };
      } catch {
        // The plate stays, and typing goes on. A new state or session tries
        // again.
        failed = active;
      }
      active = null;
      paint(target);
      onChange();
    }
  }
  function prepare(video, elementId, seconds) {
    const next = request(video, elementId, seconds);
    if (same(pair?.request, next)) return;
    if (same(active, next)) {
      waiting = null;
      return;
    }
    failed = null;
    waiting = next;
    if (!active) run();
  }

  // Line widths and ink heights in frame pixels, at the font size of the video.
  function measure(element, value, frame) {
    const op = textBoxPixels(element, frame);
    ruler.font = `${op.bold ? "bold " : ""}${op.fontSize}px ${FONT_NAMES[op.font]}`;
    ruler.fontKerning = "normal";
    ruler.textRendering = "geometricPrecision";
    const sample = ruler.measureText("Hg");
    const font = {
      ascent: sample.fontBoundingBoxAscent,
      descent: sample.fontBoundingBoxDescent,
      lineHeight: sample.fontBoundingBoxAscent + sample.fontBoundingBoxDescent,
    };
    const lines = value.split("\n").map((line) => {
      const size = ruler.measureText(line);
      return {
        width: size.width,
        ascent: size.actualBoundingBoxAscent,
        descent: size.actualBoundingBoxDescent,
      };
    });
    return { op, block: draftLayout(op, lines, font) };
  }

  const fontStyle = (op, block, scale) => ({
    fontFamily: FONT_NAMES[op.font],
    fontWeight: op.bold ? "700" : "400",
    fontSize: pixels(op.fontSize * scale),
    lineHeight: pixels(block.lineHeight * scale),
    textAlign: op.align,
    width: pixels(block.width * scale),
    height: pixels(block.height * scale),
  });

  function drawPicture(next, op, block, scale, images) {
    const color = (hex) =>
      images?.displayColor ? shownColor(hex, images.displayColor) : hex;
    const padding = op.padding + op.outlineWidth;
    Object.assign(plate.style, {
      left: pixels((op.x - padding) * scale),
      top: pixels((op.y - padding) * scale),
      width: pixels((op.width + 2 * padding) * scale),
      height: pixels((op.height + 2 * padding) * scale),
    });
    plate.hidden = view.dataset.mode !== "plate";
    Object.assign(box.style, {
      left: pixels(op.x * scale),
      top: pixels(op.y * scale),
      width: pixels(op.width * scale),
      height: pixels(op.height * scale),
      opacity: String(draftAlpha(next.element, frameTime(next.seconds))),
      background:
        op.background === "none"
          ? "none"
          : rgba(color(op.background), op.backgroundOpacity),
    });
    text.textContent = next.text;
    Object.assign(text.style, fontStyle(op, block, scale), {
      left: pixels(block.left * scale),
      top: pixels(block.top * scale),
      color: color(op.color),
      webkitTextStroke: op.outlineWidth
        ? `${2 * op.outlineWidth * scale}px ${color(op.outline)}`
        : "0",
    });
    for (const [image, file] of [
      [under, images?.under],
      [over, images?.over],
    ]) {
      if (file && image.getAttribute("src") !== file.url) image.src = file.url;
      image.hidden = !file;
    }
    shade.hidden = !images?.fadeOpacity;
    shade.style.opacity = String(images?.fadeOpacity ?? 0);
  }

  function placeEditor(op, block, scale) {
    Object.assign(input.style, fontStyle(op, block, scale), {
      left: pixels((op.x + block.left) * scale),
      top: pixels((op.y + block.top) * scale),
    });
    input.scrollLeft = 0;
    input.scrollTop = 0;
    if (actions.hidden) return;
    // Under the box, or over it if there is no room.
    const height = actions.offsetHeight;
    const below = (op.y + op.height) * scale + BAR_GAP;
    const above = op.y * scale - height - BAR_GAP;
    actions.style.top = pixels(
      below + height <= rect.height ? below : Math.max(0, above),
    );
    actions.style.left = pixels(
      Math.max(0, Math.min(op.x * scale, rect.width - actions.offsetWidth)),
    );
  }

  // A paint is a plain change of this page, with no command, so it runs on
  // each key press. Without a target, nothing shows.
  function paint(next) {
    target = next;
    const wanted = next && request(next.video, next.element.id, next.seconds);
    const clean = Boolean(next) && same(pair?.request, wanted);
    const images = clean ? pair.result : null;
    if (next?.show && !clean && !same(failed, wanted))
      prepare(next.video, next.element.id, next.seconds);
    const mode =
      !next?.show || !rect
        ? ""
        : clean
          ? "clean"
          : next.cleanOnly
            ? ""
            : next.baked
              ? "plate"
              : "plain";
    view.dataset.mode = mode;
    view.hidden = !mode;
    const frame = images?.frame ?? frameSize();
    if (!next || !frame || !rect) return;
    const scale = rect.width / frame.width;
    const { op, block } = measure(next.element, next.text, frame);
    if (mode) drawPicture(next, op, block, scale, images);
    if (!editor.hidden) placeEditor(op, block, scale);
  }

  function layout(next) {
    rect = next;
    for (const node of [view, editor])
      if (rect)
        Object.assign(node.style, {
          left: pixels(rect.left),
          top: pixels(rect.top),
          width: pixels(rect.width),
          height: pixels(rect.height),
        });
    paint(target);
  }

  return {
    prepare,
    paint,
    layout,
    mode: () => view.dataset.mode || null,
  };
}
