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
export function sourceTimes(
  timeline,
  sourceDuration,
  { start, end, timeBase },
) {
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
export function placement(timeline, element) {
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
  maxFade: 10,
  minArrow: 0.02,
};
export const ELEMENT_TYPES = ["text", "rectangle", "ellipse", "arrow"];
export const FONTS = ["sans", "serif", "mono"];
export const ALIGN = ["left", "center", "right"];
export const VERTICAL_ALIGN = ["top", "middle", "bottom"];

export const between = (name, value, min, max) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return value;
};
export const choice = (name, value, options) => {
  if (!options.includes(value))
    throw new Error(`Invalid ${name}. Use ${options.join(", ")}.`);
  return value;
};
export const color = (name, value, allowNone = false) => {
  if (allowNone && value === "none") return value;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(
      `${name} must be a color like #FFFFFF${allowNone ? ", or none" : ""}.`,
    );
  return value.toUpperCase();
};
// Text goes to the renderer as data, never as filter syntax. These checks
// keep it readable and bounded.
export function checkText(value, limits = LIMITS) {
  if (typeof value !== "string")
    throw new Error(
      `Text is necessary. Give 1 to ${limits.characters} characters.`,
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
  if ([...text].length > limits.characters)
    throw new Error(`Text must be at most ${limits.characters} characters.`);
  if (text.split("\n").length > limits.lines)
    throw new Error(`Text must be at most ${limits.lines} lines.`);
  return text;
}
export function checkBox(v) {
  between("x", v.x, 0, 1);
  between("y", v.y, 0, 1);
  between("width", v.width, 0.01, 1);
  between("height", v.height, 0.01, 1);
  if (v.x + v.width > 1 + 1e-9 || v.y + v.height > 1 + 1e-9)
    throw new Error(
      "The element box must be inside the frame. x + width and y + height must be at most 1.",
    );
}
// Opacity and fades are common to all types. Fades are edited seconds.
function checkCommon(v) {
  between("opacity", v.opacity, 0.1, 1);
  between("fadeIn", v.fadeIn, 0, LIMITS.maxFade);
  between("fadeOut", v.fadeOut, 0, LIMITS.maxFade);
}
const COMMON = { opacity: 1, fadeIn: 0, fadeOut: 0 };

// Each type has its stored keys in a fixed order, defaults, and checks.
// Stroke width is a fraction of the frame height, like the font size.
const TYPES = {
  text: {
    defaults: {
      text: undefined,
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
      fadeIn: 0,
      fadeOut: 0,
    },
    check(v) {
      v.text = checkText(v.text);
      checkBox(v);
      choice("font", v.font, FONTS);
      if (typeof v.bold !== "boolean")
        throw new Error("bold must be true or false.");
      between("size", v.size, 0.01, 0.5);
      checkCommon(v);
      choice("align", v.align, ALIGN);
      choice("verticalAlign", v.verticalAlign, VERTICAL_ALIGN);
      between("backgroundOpacity", v.backgroundOpacity, 0, 1);
      v.color = color("color", v.color);
      v.background = color("background", v.background, true);
      v.outline = color("outline", v.outline, true);
    },
  },
  rectangle: { defaults: shapeDefaults(), check: checkShape },
  ellipse: { defaults: shapeDefaults(), check: checkShape },
  arrow: {
    defaults: {
      x1: 0.3,
      y1: 0.7,
      x2: 0.5,
      y2: 0.5,
      color: "#EBCB8B",
      strokeWidth: 0.008,
      outline: "#000000",
      ...COMMON,
    },
    check(v) {
      for (const key of ["x1", "y1", "x2", "y2"]) between(key, v[key], 0, 1);
      // A small tolerance accepts exactly the minimum, for example 0.1 to
      // 0.12, where floating-point subtraction gives 0.019999999999999997.
      if (Math.hypot(v.x2 - v.x1, v.y2 - v.y1) < LIMITS.minArrow - 1e-9)
        throw new Error(
          `An arrow must be at least ${LIMITS.minArrow} long from tail (x1, y1) to tip (x2, y2).`,
        );
      v.color = color("color", v.color);
      between("strokeWidth", v.strokeWidth, 0.002, 0.05);
      v.outline = color("outline", v.outline, true);
      checkCommon(v);
    },
  },
};
function shapeDefaults() {
  return {
    x: 0.3,
    y: 0.3,
    width: 0.4,
    height: 0.3,
    fill: "none",
    fillOpacity: 0.25,
    stroke: "#EBCB8B",
    strokeWidth: 0.006,
    ...COMMON,
  };
}
function checkShape(v) {
  checkBox(v);
  v.fill = color("fill", v.fill, true);
  between("fillOpacity", v.fillOpacity, 0, 1);
  v.stroke = color("stroke", v.stroke, true);
  between("strokeWidth", v.strokeWidth, 0.002, 0.05);
  // A fill with 0 opacity draws nothing, so it does not count as visible.
  if ((v.fill === "none" || v.fillOpacity === 0) && v.stroke === "none")
    throw new Error(
      "A shape needs a visible fill or a line color. Set fillOpacity above 0 or set a stroke.",
    );
  checkCommon(v);
}
const PROPERTY_KEYS = new Set(
  Object.values(TYPES).flatMap((spec) => Object.keys(spec.defaults)),
);

// Reject a known property that this type does not use.
function checkKeys(type, values) {
  for (const key of Object.keys(values))
    if (
      PROPERTY_KEYS.has(key) &&
      values[key] !== undefined &&
      !(key in TYPES[type].defaults)
    )
      throw new Error(`A ${type} element does not use ${key}.`);
}

// Stored elements from before fades existed have no fade keys. Read them as
// 0. The stored file does not change until the element changes.
function normalize(element) {
  return {
    ...element,
    fadeIn: element.fadeIn ?? 0,
    fadeOut: element.fadeOut ?? 0,
  };
}

// Build a checked element. Unknown keys are not copied.
function buildElement(type, id, sourceStart, sourceEnd, values) {
  const spec = TYPES[type];
  const v = { ...spec.defaults };
  for (const key of Object.keys(spec.defaults))
    if (values[key] !== undefined) v[key] = values[key];
  spec.check(v);
  return { id, type, sourceStart, sourceEnd, ...v };
}

// The range checks in sourceTimes report an end before the start.
export function checkDuration({ start, end }) {
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
  checkKeys(args.type, args);
  checkDuration(args);
  const range = sourceTimes(timeline, sourceDuration, args);
  const element = buildElement(args.type, id, range.start, range.end, args);
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
  const found = find(timeline, elementId);
  const { list, index } = found;
  const element = normalize(found.element);
  if (args.type !== undefined)
    throw new Error(
      "The element type cannot change. Add a new element and remove this one.",
    );
  checkKeys(element.type, args);
  const keys = Object.keys(args).filter(
    (key) =>
      args[key] !== undefined &&
      (key in TYPES[element.type].defaults || TIME_KEYS.includes(key)),
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
  const next = buildElement(
    element.type,
    element.id,
    sourceStart,
    sourceEnd,
    values,
  );
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

// Fades that fit in the visible interval. When fadeIn + fadeOut is longer
// than the interval, both get shorter in proportion. The stored values do
// not change, so undo of a cut gives the full fades again.
function actualFades(element, shown) {
  if (shown.visibility === "none") return { actualFadeIn: 0, actualFadeOut: 0 };
  const length = shown.end - shown.start;
  const total = element.fadeIn + element.fadeOut;
  const scale = total > length ? length / total : 1;
  return {
    actualFadeIn: round(element.fadeIn * scale),
    actualFadeOut: round(element.fadeOut * scale),
  };
}

// The selection box of an arrow is the rectangle around its tail and tip.
const bounds = (e) =>
  e.type === "arrow"
    ? {
        x: round(Math.min(e.x1, e.x2)),
        y: round(Math.min(e.y1, e.y2)),
        width: round(Math.abs(e.x2 - e.x1)),
        height: round(Math.abs(e.y2 - e.y1)),
      }
    : {};

// Elements with their layer (0 is the bottom), edited placement, and actual
// fades.
export function describeElements(timeline) {
  return elementsOf(timeline).map((stored, layer) => {
    const element = normalize(stored);
    const shown = placement(timeline, element);
    return {
      ...element,
      ...bounds(element),
      layer,
      ...shown,
      ...actualFades(element, shown),
    };
  });
}

// Arrow outline points in pixels: a shaft and a head. The last point of the
// head is exactly the tip.
function arrowPoints(x1, y1, x2, y2, shaft) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length,
    uy = (y2 - y1) / length;
  const nx = -uy,
    ny = ux;
  const head = Math.min(Math.max(4 * shaft, 12), length * 0.6);
  const half = Math.min(Math.max(2 * shaft, 7), head * 0.75);
  const bx = x2 - ux * head,
    by = y2 - uy * head;
  const p = (x, y) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  const s = Math.min(shaft / 2, half * 0.8);
  return [
    p(x1 + nx * s, y1 + ny * s),
    p(bx + nx * s, by + ny * s),
    p(bx + nx * half, by + ny * half),
    [x2, y2],
    p(bx - nx * half, by - ny * half),
    p(bx - nx * s, by - ny * s),
    p(x1 - nx * s, y1 - ny * s),
  ];
}

// Pixel drawing operations for the rendered frame, bottom layer first.
// Preview, export, and inspection all render from this plan. Elements with
// no kept source content are not drawn. A box edge maps to round(value *
// frame size), so x + width = 1 is the right frame edge.
export function renderPlan(timeline, frame) {
  return describeElements(timeline)
    .filter((e) => e.visibility !== "none")
    .map((e) => {
      const timing = {
        id: e.id,
        type: e.type,
        start: e.start,
        end: e.end,
        opacity: e.opacity,
        fadeIn: e.actualFadeIn,
        fadeOut: e.actualFadeOut,
      };
      const line = (value) => Math.max(1, Math.round(value * frame.height));
      if (e.type === "arrow") {
        const x1 = Math.round(e.x1 * frame.width),
          y1 = Math.round(e.y1 * frame.height),
          x2 = Math.round(e.x2 * frame.width),
          y2 = Math.round(e.y2 * frame.height);
        const strokeWidth = line(e.strokeWidth);
        return {
          ...timing,
          x1,
          y1,
          x2,
          y2,
          strokeWidth,
          color: e.color,
          outline: e.outline,
          outlineWidth:
            e.outline === "none" ? 0 : Math.max(1, Math.round(strokeWidth / 4)),
          points:
            x1 === x2 && y1 === y2
              ? []
              : arrowPoints(x1, y1, x2, y2, strokeWidth),
        };
      }
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
      if (e.type !== "text")
        return {
          ...timing,
          x: left,
          y: top,
          width,
          height,
          fill: e.fill,
          fillOpacity: e.fillOpacity,
          stroke: e.stroke,
          // The line is inside the box, so it cannot be wider than half of
          // the box.
          strokeWidth:
            e.stroke === "none"
              ? 0
              : Math.min(
                  line(e.strokeWidth),
                  Math.max(1, Math.floor(Math.min(width, height) / 2)),
                ),
        };
      return { ...timing, ...textBoxPixels(e, frame), text: e.text };
    });
}

// Pixel box and text style of a text element or the caption style. Text
// elements and captions use the same rules, so they draw in the same way.
export function textBoxPixels(e, frame) {
  const left = Math.round(e.x * frame.width),
    top = Math.round(e.y * frame.height);
  const width = Math.max(1, Math.round((e.x + e.width) * frame.width) - left);
  const height = Math.max(1, Math.round((e.y + e.height) * frame.height) - top);
  const fontSize = Math.max(1, Math.round(e.size * frame.height));
  // Padding keeps text off the box edge. The inner text box keeps at least
  // 1 pixel.
  const padding = Math.max(
    0,
    Math.min(
      Math.round(fontSize * 0.25),
      Math.floor((width - 1) / 2),
      Math.floor((height - 1) / 2),
    ),
  );
  return {
    x: left,
    y: top,
    width,
    height,
    padding,
    font: e.font,
    bold: e.bold,
    fontSize,
    color: e.color,
    align: e.align,
    verticalAlign: e.verticalAlign,
    background: e.background,
    backgroundOpacity: e.backgroundOpacity,
    outline: e.outline,
    outlineWidth:
      e.outline === "none" ? 0 : Math.max(1, Math.round(fontSize / 16)),
  };
}
