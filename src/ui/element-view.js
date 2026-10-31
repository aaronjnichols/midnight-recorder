// View rules for element editing. No DOM or Electron dependency, so
// node:test checks it directly.

export const TYPE_LABELS = {
  text: "Text",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  arrow: "Arrow",
};

// Browser font names for the renderer font families on Windows. The UI uses
// them to measure text.
export const FONT_NAMES = {
  sans: '"Segoe UI", Arial, sans-serif',
  serif: "Georgia, serif",
  mono: "Consolas, monospace",
};

const trimNumber = (value, digits) => String(Number(value.toFixed(digits)));

// Rows for the layer list. The top layer is first, as it shows in front.
export function layerRows(elements, selectedId, total) {
  const counts = {};
  const named = elements.map((e) => {
    counts[e.type] = (counts[e.type] || 0) + 1;
    const first = e.type === "text" ? e.text.split("\n")[0].trim() : "";
    return {
      element: e,
      name:
        e.type === "text"
          ? `Text: ${first.length > 40 ? `${first.slice(0, 39)}…` : first}`
          : `${TYPE_LABELS[e.type]} ${counts[e.type]}`,
    };
  });
  return named.reverse().map(({ element: e, name }) => {
    const shown = e.visibility !== "none" && total > 0;
    return {
      id: e.id,
      type: e.type,
      name,
      start: e.start,
      end: e.end,
      visibility: e.visibility,
      selected: e.id === selectedId,
      left: shown ? Number(((e.start / total) * 100).toFixed(3)) : 0,
      width: shown ? Number((((e.end - e.start) / total) * 100).toFixed(3)) : 0,
      timeText: shown
        ? `${e.start.toFixed(2)} to ${e.end.toFixed(2)} s${e.visibility === "partial" ? " (part was removed)" : ""}`
        : "Not in the edited video. A cut or trim removed it.",
    };
  });
}

const DURATION = 3;
const PRESETS = {
  text: {
    type: "text",
    text: "New text",
    x: 0.1,
    y: 0.4,
    width: 0.8,
    height: 0.2,
  },
  // A lower-third label with a dark background, readable on most video.
  label: {
    type: "text",
    text: "Label",
    x: 0.05,
    y: 0.78,
    width: 0.45,
    height: 0.13,
    size: 0.05,
    bold: true,
    color: "#ECEFF4",
    background: "#1E2127",
    backgroundOpacity: 0.85,
    outline: "none",
    align: "left",
  },
  rectangle: { type: "rectangle", x: 0.3, y: 0.3, width: 0.4, height: 0.3 },
  ellipse: { type: "ellipse", x: 0.35, y: 0.3, width: 0.3, height: 0.35 },
  arrow: { type: "arrow", x1: 0.3, y1: 0.7, x2: 0.5, y2: 0.5 },
};

// Arguments for element.add at the playhead. The element shows for 3
// seconds, or less if the video is shorter. Near the end it starts earlier
// so that it can show for its full length.
export function newElement(kind, playhead, total) {
  let start = Math.max(0, Math.min(playhead, total));
  if (total - start < DURATION) start = Math.max(0, total - DURATION);
  // Times are rounded to milliseconds, but never past the edited end. At a
  // fractional speed the edited end, for example 6.666..., has more digits.
  const round = (value) => Math.min(total, Math.round(value * 1000) / 1000);
  return {
    ...PRESETS[kind],
    start: round(start),
    end: round(Math.min(total, start + DURATION)),
  };
}

// Form units. Positions, sizes, and opacities show as percent. Font size
// and line width show as percent of the video height. Times are seconds.
const PERCENT = new Set([
  "x",
  "y",
  "width",
  "height",
  "x1",
  "y1",
  "x2",
  "y2",
  "opacity",
  "fillOpacity",
  "backgroundOpacity",
  "size",
  "strokeWidth",
]);
export function fieldValue(key, element) {
  const value = element[key];
  if (value === null || value === undefined) return "";
  if (PERCENT.has(key)) return trimNumber(value * 100, 2);
  if (typeof value === "number") return trimNumber(value, 3);
  return String(value);
}
export function inputValue(key, text) {
  if (String(text).trim() === "") return Number.NaN;
  const number = Number(text);
  return PERCENT.has(key) ? Math.round(number * 10000) / 1000000 : number;
}

// Compares measured text with the inner text box, in the same pixels.
// scale is the font size factor that makes the text fit, with a small
// margin.
export function textFit({ textWidth, textHeight, innerWidth, innerHeight }) {
  const widthRatio = Math.round((textWidth / innerWidth) * 10000) / 10000;
  const heightRatio = Math.round((textHeight / innerHeight) * 10000) / 10000;
  return {
    fits: widthRatio <= 1 && heightRatio <= 1,
    widthRatio,
    heightRatio,
    scale:
      Math.round(Math.min(1 / widthRatio, 1 / heightRatio) * 0.98 * 10000) /
      10000,
  };
}

// A note when a fade is shorter than its request.
export function fadeNote(element, key) {
  const actual = element[`actual${key[0].toUpperCase()}${key.slice(1)}`];
  if (actual === undefined || Math.abs(actual - element[key]) < 1e-6) return "";
  const length = element.end - element.start;
  return Number.isFinite(length)
    ? `The video uses ${trimNumber(actual, 3)} s. The element shows for ${trimNumber(length, 3)} s, so fade in and fade out together are shortened.`
    : "The element is not in the edited video, so it has no fade.";
}
