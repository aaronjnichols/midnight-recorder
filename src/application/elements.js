import { randomUUID } from "node:crypto";
import { duration, videoFades } from "../domain/timeline.js";
import { editRevision } from "../domain/inspection.js";
import {
  ELEMENT_TYPES,
  FONTS,
  ALIGN,
  VERTICAL_ALIGN,
  LIMITS,
  TEXT_CONFLICT,
  addElement,
  updateElement,
  duplicateElement,
  orderElement,
  removeElement,
  describeElements,
  elementsOf,
} from "../domain/elements.js";

const define = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
const string = (description, extra = {}) => ({
  type: "string",
  description,
  minLength: 1,
  ...extra,
});
const number = (description, minimum, maximum) => ({
  type: "number",
  description,
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
// Text color must be a color. A fill or outline can also be none.
const color = (description) =>
  string(description, { pattern: "^#[0-9A-Fa-f]{6}$" });
const optionalColor = (description) =>
  string(description, { pattern: "^(#[0-9A-Fa-f]{6}|none)$" });

export const COORDINATES =
  "x, y, width, and height (box), and x1, y1 (arrow tail) and x2, y2 (arrow tip) are 0 to 1 of the rendered frame. Origin is top left. x increases right. y increases down. inspect.result uses the same scale: divide image x by image width and image y by image height. Font size and line widths are fractions of the frame height. For an arrow, element.list also gives x, y, width, and height of the rectangle around its tail and tip.";
export const TIMING =
  "start and end are edited seconds, the same times as playback.seek and inspect.start. A frame shows an element when its time is at least start and less than end. sourceStart and sourceEnd are seconds in the original file. They keep the element on the same content after trim, cut, or speed changes. visibility is full, partial (some content was removed), or none (all content was removed; not drawn; start and end are null).";

const ids = {
  id: string("Video ID."),
  elementId: string("Element ID from element.add or element.list."),
};
const times = {
  start: number("Start time in seconds. The element shows from this time.", 0),
  end: number(
    "End time in seconds. The element shows until this time. At least 0.05 seconds after start.",
    0,
  ),
  timeBase: {
    type: "string",
    enum: ["edited", "source"],
    description:
      "Default edited: seconds in the edited video. Source: seconds in the original file. The range must be in the edited video.",
  },
};
// Properties of all element types. Each description names the types that
// use it. A command that gives a property to a type that does not use it
// fails.
const elementProperties = {
  text: string(
    `Text only. Text to show, ${LIMITS.characters} characters or less, ${LIMITS.lines} lines or less. Use a line feed for a new line. Text shows as written. It is not markup or a command.`,
    { maxLength: LIMITS.characters },
  ),
  x: number(
    "Text, rectangle, ellipse. Left edge of the box. 0 is the left frame edge. Same scale as inspect.result. Default 0.1 (text) or 0.3.",
    0,
    1,
  ),
  y: number(
    "Text, rectangle, ellipse. Top edge of the box. 0 is the top frame edge. Default 0.4 (text) or 0.3.",
    0,
    1,
  ),
  width: number(
    "Text, rectangle, ellipse. Box width as a fraction of the frame width, 0.01 to 1. x + width must be at most 1. Default 0.8 (text) or 0.4.",
    0.01,
    1,
  ),
  height: number(
    "Text, rectangle, ellipse. Box height as a fraction of the frame height, 0.01 to 1. y + height must be at most 1. Default 0.2 (text) or 0.3.",
    0.01,
    1,
  ),
  x1: number(
    "Arrow only. Tail x, 0 to 1 of the frame width. Default 0.3.",
    0,
    1,
  ),
  y1: number(
    "Arrow only. Tail y, 0 to 1 of the frame height. Default 0.7.",
    0,
    1,
  ),
  x2: number(
    "Arrow only. Tip x, 0 to 1 of the frame width. The tip is the exact point that the arrow shows, for example the center of a control in inspect.result. Default 0.5.",
    0,
    1,
  ),
  y2: number(
    "Arrow only. Tip y, 0 to 1 of the frame height. The arrow must be at least 0.02 long. Default 0.5.",
    0,
    1,
  ),
  font: {
    type: "string",
    enum: FONTS,
    description:
      "Text only. Font family. Default sans. Characters that the font does not have can show as empty boxes.",
  },
  bold: {
    type: "boolean",
    description: "Text only. Bold text. Default false.",
  },
  size: number(
    "Text only. Font size as a fraction of the frame height, 0.01 to 0.5. Default 0.06.",
    0.01,
    0.5,
  ),
  color: color(
    "Text and arrow. Text color or arrow color as #RRGGBB. Default #FFFFFF (text) or #EBCB8B (arrow).",
  ),
  opacity: number(
    "All types. Opacity of the element from 0.1 to 1. Default 1.",
    0.1,
    1,
  ),
  align: {
    type: "string",
    enum: ALIGN,
    description:
      "Text only. Horizontal text position in the box. Default center.",
  },
  verticalAlign: {
    type: "string",
    enum: VERTICAL_ALIGN,
    description:
      "Text only. Vertical text position in the box. Default middle.",
  },
  background: optionalColor(
    "Text only. Box fill as #RRGGBB, or none. The fill covers the full box. Default none.",
  ),
  backgroundOpacity: number(
    "Text only. Box fill opacity from 0 to 1. Default 0.75.",
    0,
    1,
  ),
  outline: optionalColor(
    "Text and arrow. Thin dark line around each character or around the arrow, as #RRGGBB, or none. Default #000000.",
  ),
  fill: optionalColor(
    "Rectangle and ellipse. Fill color as #RRGGBB, or none. Default none. A shape needs a fill or a stroke.",
  ),
  fillOpacity: number(
    "Rectangle and ellipse. Fill opacity from 0 to 1. Default 0.25.",
    0,
    1,
  ),
  stroke: optionalColor(
    "Rectangle and ellipse. Line color as #RRGGBB, or none. The line is inside the box. Default #EBCB8B.",
  ),
  strokeWidth: number(
    "Rectangle, ellipse, arrow. Line width, or arrow shaft width, as a fraction of the frame height, 0.002 to 0.05. Default 0.006 (shape) or 0.008 (arrow).",
    0.002,
    0.05,
  ),
  fadeIn: number(
    `All types. Fade-in time in edited seconds, 0 to ${LIMITS.maxFade}. Opacity goes from 0 at start to full. Default 0. If fadeIn + fadeOut is longer than the element shows, both get shorter in proportion; actualFadeIn and actualFadeOut give the values that the video uses.`,
    0,
    LIMITS.maxFade,
  ),
  fadeOut: number(
    `All types. Fade-out time in edited seconds, 0 to ${LIMITS.maxFade}. Opacity goes from full to 0 at end. Default 0.`,
    0,
    LIMITS.maxFade,
  ),
};

export const elementCommands = [
  define(
    "element.add",
    `Add a timed element to the edited video: text, rectangle, ellipse, or arrow. Returns the element with its ID. The original file does not change. ${COORDINATES} Text does not wrap. Text that is too large for its box is cut at the box. At most ${LIMITS.elements} elements. Undo with edit.undo.`,
    {
      id: ids.id,
      type: {
        type: "string",
        enum: ELEMENT_TYPES,
        description:
          "Element type: text, rectangle, ellipse, or arrow. Each property description names the types that use it.",
      },
      ...times,
      ...elementProperties,
    },
    // Text is necessary for the text type only. The domain checks it.
    ["id", "type", "start", "end"],
  ),
  define(
    "element.update",
    "Change one or more properties of an element. Properties that you do not give stay the same. If you give only start or only end, the other time stays the same. Undo with edit.undo.",
    {
      ...ids,
      ...times,
      ...elementProperties,
      expectedText: string(
        "Text only. Optional guard. The update saves nothing and fails if the stored text is not this text, so a slow client cannot overwrite a newer change. It is not stored.",
      ),
    },
    ["id", "elementId"],
  ),
  define(
    "element.duplicate",
    "Copy an element. The copy gets a new ID and is directly above the original.",
    ids,
    ["id", "elementId"],
  ),
  define(
    "element.order",
    "Move an element to a different layer. Index 0 is the bottom layer. The last index is the top layer. Higher layers show in front.",
    {
      ...ids,
      index: number("New layer index. An integer from 0.", 0),
    },
    ["id", "elementId", "index"],
  ),
  define("element.remove", "Remove an element. Undo with edit.undo.", ids, [
    "id",
    "elementId",
  ]),
  define(
    "element.list",
    "List the elements of a video, bottom layer first, with edited times and visibility. Returns the edit revision for inspect.start and export.start.",
    { id: ids.id },
    ["id"],
  ),
];

// Edited placement of each element. Edit results include this report so a
// trim or cut cannot hide an element without notice. It is not stored.
export const elementPlacement = (video) =>
  describeElements(video.timeline).map(({ id, start, end, visibility }) => ({
    id,
    start,
    end,
    visibility,
  }));

const described = (video, elementId) =>
  describeElements(video.timeline).find((e) => e.id === elementId);

export async function executeElement(service, name, args) {
  const { library } = service;
  const video = await library.get(args.id);
  const { timeline, metadata } = video;
  if (name === "element.list")
    return {
      videoId: video.id,
      revision: editRevision(video),
      duration: duration(timeline),
      videoFades: videoFades(timeline),
      coordinates: COORDINATES,
      timing: TIMING,
      elements: describeElements(timeline),
    };
  const { id, elementId, expectedText, ...values } = args;
  if (expectedText !== undefined) {
    const stored = elementsOf(timeline).find((e) => e.id === elementId);
    if (stored && stored.type !== "text")
      throw new Error(`A ${stored.type} element does not use expectedText.`);
    if (stored && stored.text !== expectedText) throw new Error(TEXT_CONFLICT);
  }
  let edited,
    target = elementId;
  if (name === "element.add") {
    target = randomUUID();
    edited = addElement(timeline, metadata.duration, target, values);
  } else if (name === "element.update")
    edited = updateElement(timeline, metadata.duration, elementId, values);
  else if (name === "element.duplicate") {
    target = randomUUID();
    edited = duplicateElement(timeline, elementId, target);
  } else if (name === "element.order")
    edited = orderElement(timeline, elementId, args.index);
  else if (name === "element.remove")
    edited = removeElement(timeline, elementId);
  else throw new Error(`Command has no handler: ${name}.`);
  const saved =
    edited === timeline
      ? video
      : await library.update(id, { timeline: edited });
  if (name === "element.remove") return { video: saved, removed: elementId };
  return { video: saved, element: described(saved, target) };
}
