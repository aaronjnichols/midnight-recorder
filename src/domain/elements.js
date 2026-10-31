// Timed visual elements on the edited video. Pure functions. No file,
// process, or Electron access, so the UI and Node can use this module.
//
// Coordinates: 0 to 1 of the rendered frame. Origin is top left. x increases
// to the right. y increases down. These are the same coordinates as
// inspect.result. Font size is a fraction of the frame height.
//
// Times: an element stores source seconds (sourceStart, sourceEnd), so it
// stays on the same video content after trim, cut, and speed changes.
// Commands accept edited seconds by default and convert them.
import {
  duration,
  editedTime,
  keptSourceSeconds,
  sourceRange,
  sourceTime,
  sourceEndTime,
  withElements,
} from "./timeline.js";

export const elementsOf = (timeline) => timeline.elements ?? [];

// Microsecond precision keeps stored JSON readable.
const round = (value) => Math.round(value * 1e6) / 1e6;

// Convert command times to a source range. Edited times are the default.
function sourceTimes(timeline, sourceDuration, { start, end, timeBase }) {
  if (timeBase === "source") {
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > sourceDuration + 1e-6
    )
      throw new Error(
        `Select a time range within the source video, from 0 to ${sourceDuration} seconds.`,
      );
    return { start: round(start), end: round(Math.min(end, sourceDuration)) };
  }
  if (timeBase !== undefined && timeBase !== "edited")
    throw new Error("Invalid timeBase. Use edited or source.");
  const range = sourceRange(timeline, start, end);
  return { start: round(range.start), end: round(range.end) };
}

// The edited interval [start, end) where the element shows, or null times
// when trim or cut removed all of its source content.
function placement(timeline, element) {
  const length = element.sourceEnd - element.sourceStart;
  const kept = keptSourceSeconds(
    timeline,
    element.sourceStart,
    element.sourceEnd,
  );
  if (kept <= 1e-6) return { start: null, end: null, visibility: "none" };
  return {
    start: round(editedTime(timeline, element.sourceStart)),
    end: round(editedTime(timeline, element.sourceEnd)),
    visibility: kept >= length - 1e-6 ? "full" : "partial",
  };
}

export const LIMITS = {
  elements: 100,
  characters: 500,
  lines: 10,
  minSeconds: 0.05,
};
export const ELEMENT_TYPES = ["text"];
export const FONTS = ["sans", "serif", "mono"];
export const ALIGN = ["left", "center", "right"];
export const VERTICAL_ALIGN = ["top", "middle", "bottom"];

const between = (name, value, min, max) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return value;
};
const choice = (name, value, options) => {
  if (!options.includes(value))
    throw new Error(`Invalid ${name}. Use ${options.join(", ")}.`);
  return value;
};
const color = (name, value, allowNone = false) => {
  if (allowNone && value === "none") return value;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(
      `${name} must be a color like #FFFFFF${allowNone ? ", or none" : ""}.`,
    );
  return value.toUpperCase();
};
// Text goes to the renderer as data, never as filter syntax. These checks
// keep it readable and bounded.
function checkText(value) {
  if (typeof value !== "string")
    throw new Error(
      `Text is necessary. Give 1 to ${LIMITS.characters} characters.`,
    );
  const text = value.replace(/\r\n?/g, "\n");
  if (!text.isWellFormed()) throw new Error("Text must be valid Unicode.");
  // Control characters other than tab and line feed, and Unicode line and
  // paragraph separators.
  if (/(?![\n\t])[\p{Cc}\p{Zl}\p{Zp}]/u.test(text))
    throw new Error(
      "Text must not contain control characters. Use a line feed (\\n) for a new line.",
    );
  if (!/\S/u.test(text))
    throw new Error("Text must contain a visible character.");
  if ([...text].length > LIMITS.characters)
    throw new Error(`Text must be at most ${LIMITS.characters} characters.`);
  if (text.split("\n").length > LIMITS.lines)
    throw new Error(`Text must be at most ${LIMITS.lines} lines.`);
  return text;
}
function checkBox(v) {
  between("x", v.x, 0, 1);
  between("y", v.y, 0, 1);
  between("width", v.width, 0.01, 1);
  between("height", v.height, 0.01, 1);
  if (v.x + v.width > 1 + 1e-9 || v.y + v.height > 1 + 1e-9)
    throw new Error(
      "The element box must be inside the frame. x + width and y + height must be at most 1.",
    );
}
function checkTextStyle(v) {
  checkBox(v);
  choice("font", v.font, FONTS);
  if (typeof v.bold !== "boolean")
    throw new Error("bold must be true or false.");
  between("size", v.size, 0.01, 0.5);
  between("opacity", v.opacity, 0.1, 1);
  choice("align", v.align, ALIGN);
  choice("verticalAlign", v.verticalAlign, VERTICAL_ALIGN);
  between("backgroundOpacity", v.backgroundOpacity, 0, 1);
}

const TEXT_DEFAULTS = {
  x: 0.1,
  y: 0.4,
  width: 0.8,
  height: 0.2,
  font: "sans",
  bold: false,
  size: 0.06,
  color: "#FFFFFF",
  opacity: 1,
  align: "center",
  verticalAlign: "middle",
  background: "none",
  backgroundOpacity: 0.75,
  outline: "#000000",
};

// Build a checked text element. Unknown keys are not copied.
function textElement(id, sourceStart, sourceEnd, values) {
  const v = { ...TEXT_DEFAULTS };
  for (const [key, value] of Object.entries(values))
    if (key in TEXT_DEFAULTS && value !== undefined) v[key] = value;
  checkTextStyle(v);
  return {
    id,
    type: "text",
    sourceStart,
    sourceEnd,
    text: checkText(values.text),
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    font: v.font,
    bold: v.bold,
    size: v.size,
    color: color("color", v.color),
    opacity: v.opacity,
    align: v.align,
    verticalAlign: v.verticalAlign,
    background: color("background", v.background, true),
    backgroundOpacity: v.backgroundOpacity,
    outline: color("outline", v.outline, true),
  };
}

// The range checks in sourceTimes report an end before the start.
function checkDuration({ start, end }) {
  if (end > start && end - start < LIMITS.minSeconds - 1e-9)
    throw new Error(
      `An element must show for at least ${LIMITS.minSeconds} seconds.`,
    );
}

export function addElement(timeline, sourceDuration, id, args) {
  choice("type", args.type, ELEMENT_TYPES);
  const list = elementsOf(timeline);
  if (list.length >= LIMITS.elements)
    throw new Error(`A video can have at most ${LIMITS.elements} elements.`);
  if (list.some((e) => e.id === id))
    throw new Error("Element ID already exists.");
  checkDuration(args);
  const range = sourceTimes(timeline, sourceDuration, args);
  const element = textElement(id, range.start, range.end, args);
  if (placement(timeline, element).visibility === "none")
    throw new Error(
      "The time range is not in the edited video. That part was cut or trimmed.",
    );
  return withElements(timeline, [...elementsOf(timeline), element]);
}

function find(timeline, elementId) {
  const list = elementsOf(timeline);
  const index = list.findIndex((e) => e.id === elementId);
  if (index < 0) throw new Error("Element was not found.");
  return { list, index, element: list[index] };
}

const TIME_KEYS = ["start", "end"];

// Change some properties. Times use the edited time base unless timeBase is
// source. A missing start or end keeps its current value.
export function updateElement(timeline, sourceDuration, elementId, args) {
  const { list, index, element } = find(timeline, elementId);
  if (args.type !== undefined)
    throw new Error(
      "The element type cannot change. Add a new element and remove this one.",
    );
  const keys = Object.keys(args).filter(
    (key) =>
      args[key] !== undefined &&
      (key === "text" || key in TEXT_DEFAULTS || TIME_KEYS.includes(key)),
  );
  if (!keys.length) throw new Error("Give at least one property to change.");
  let { sourceStart, sourceEnd } = element;
  const timed = args.start !== undefined || args.end !== undefined;
  if (timed && args.timeBase === "source") {
    const range = {
      start: args.start ?? sourceStart,
      end: args.end ?? sourceEnd,
    };
    checkDuration(range);
    ({ start: sourceStart, end: sourceEnd } = sourceTimes(
      timeline,
      sourceDuration,
      { ...range, timeBase: "source" },
    ));
  } else if (timed) {
    if (args.timeBase !== undefined && args.timeBase !== "edited")
      throw new Error("Invalid timeBase. Use edited or source.");
    // Convert only the times that you give. The other stored source time
    // stays, so content that a trim or cut removed is not lost.
    const total = duration(timeline);
    const outside = (value) =>
      !Number.isFinite(value) || value < 0 || value > total + 1e-6;
    if (outside(args.start ?? 0) || outside(args.end ?? total))
      throw new Error(
        `Select a time range within the edited video, from 0 to ${total} seconds.`,
      );
    if (args.start !== undefined)
      sourceStart = round(sourceTime(timeline, Math.min(args.start, total)));
    if (args.end !== undefined)
      sourceEnd = round(sourceEndTime(timeline, Math.min(args.end, total)));
  }
  if (timed && sourceEnd <= sourceStart)
    throw new Error("Select a time range where the end is after the start.");
  const values = { ...element };
  for (const key of keys) values[key] = args[key];
  const next = textElement(element.id, sourceStart, sourceEnd, values);
  if (JSON.stringify(next) === JSON.stringify(element)) return timeline;
  const shown = placement(timeline, next);
  if (shown.visibility === "none")
    throw new Error(
      "The time range is not in the edited video. That part was cut or trimmed.",
    );
  if (timed && args.timeBase !== "source") checkDuration(shown);
  return withElements(timeline, list.with(index, next));
}

// Copy an element with a new ID. The copy is directly above the original.
export function duplicateElement(timeline, elementId, newId) {
  const { list, index, element } = find(timeline, elementId);
  if (list.length >= LIMITS.elements)
    throw new Error(`A video can have at most ${LIMITS.elements} elements.`);
  if (list.some((e) => e.id === newId))
    throw new Error("Element ID already exists.");
  return withElements(
    timeline,
    list.toSpliced(index + 1, 0, {
      ...structuredClone(element),
      id: newId,
    }),
  );
}

// Move an element to a layer index. 0 is the bottom layer. The last index is
// the top layer.
export function orderElement(timeline, elementId, layer) {
  const { list, index, element } = find(timeline, elementId);
  if (!Number.isInteger(layer) || layer < 0 || layer >= list.length)
    throw new Error(`index must be an integer from 0 to ${list.length - 1}.`);
  if (layer === index) return timeline;
  const rest = list.toSpliced(index, 1);
  return withElements(timeline, rest.toSpliced(layer, 0, element));
}

export function removeElement(timeline, elementId) {
  const { list, index } = find(timeline, elementId);
  return withElements(timeline, list.toSpliced(index, 1));
}

// Elements with their layer (0 is the bottom) and edited placement.
export function describeElements(timeline) {
  return elementsOf(timeline).map((element, layer) => ({
    ...element,
    layer,
    ...placement(timeline, element),
  }));
}

// Pixel drawing operations for the rendered frame, bottom layer first.
// Preview, export, and inspection all render from this plan. Elements with
// no kept source content are not drawn. A box edge maps to round(value *
// frame size), so x + width = 1 is the right frame edge.
export function renderPlan(timeline, frame) {
  return describeElements(timeline)
    .filter((e) => e.visibility !== "none")
    .map((e) => {
      const left = Math.round(e.x * frame.width),
        top = Math.round(e.y * frame.height);
      const width = Math.max(
        1,
        Math.round((e.x + e.width) * frame.width) - left,
      );
      const height = Math.max(
        1,
        Math.round((e.y + e.height) * frame.height) - top,
      );
      const fontSize = Math.max(1, Math.round(e.size * frame.height));
      // Padding keeps text off the box edge. The inner text box keeps at
      // least 1 pixel.
      const padding = Math.max(
        0,
        Math.min(
          Math.round(fontSize * 0.25),
          Math.floor((width - 1) / 2),
          Math.floor((height - 1) / 2),
        ),
      );
      return {
        id: e.id,
        type: e.type,
        start: e.start,
        end: e.end,
        x: left,
        y: top,
        width,
        height,
        padding,
        text: e.text,
        font: e.font,
        bold: e.bold,
        fontSize,
        color: e.color,
        opacity: e.opacity,
        align: e.align,
        verticalAlign: e.verticalAlign,
        background: e.background,
        backgroundOpacity: e.backgroundOpacity,
        outline: e.outline,
        outlineWidth:
          e.outline === "none" ? 0 : Math.max(1, Math.round(fontSize / 16)),
      };
    });
}
