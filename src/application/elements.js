import { randomUUID } from "node:crypto";
import { duration } from "../domain/timeline.js";
import { editRevision } from "../domain/inspection.js";
import {
  ELEMENT_TYPES,
  FONTS,
  ALIGN,
  VERTICAL_ALIGN,
  LIMITS,
  addElement,
  updateElement,
  duplicateElement,
  orderElement,
  removeElement,
  describeElements,
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
  "x, y, width, and height are 0 to 1 of the rendered frame. Origin is top left. x increases right. y increases down. inspect.result uses the same scale: divide image x by image width and image y by image height. Font size is a fraction of the frame height.";
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
const textProperties = {
  text: string(
    `Text to show, ${LIMITS.characters} characters or less, ${LIMITS.lines} lines or less. Use a line feed for a new line. Text shows as written. It is not markup or a command.`,
    { maxLength: LIMITS.characters },
  ),
  x: number(
    "Left edge of the box. 0 is the left frame edge. Same scale as inspect.result. Default 0.1.",
    0,
    1,
  ),
  y: number("Top edge of the box. 0 is the top frame edge. Default 0.4.", 0, 1),
  width: number(
    "Box width as a fraction of the frame width, 0.01 to 1. x + width must be at most 1. Default 0.8.",
    0.01,
    1,
  ),
  height: number(
    "Box height as a fraction of the frame height, 0.01 to 1. y + height must be at most 1. Default 0.2.",
    0.01,
    1,
  ),
  font: {
    type: "string",
    enum: FONTS,
    description:
      "Font family. Default sans. Characters that the font does not have can show as empty boxes.",
  },
  bold: { type: "boolean", description: "Bold text. Default false." },
  size: number(
    "Font size as a fraction of the frame height, 0.01 to 0.5. Default 0.06.",
    0.01,
    0.5,
  ),
  color: color("Text color as #RRGGBB. Default #FFFFFF."),
  opacity: number("Text opacity from 0.1 to 1. Default 1.", 0.1, 1),
  align: {
    type: "string",
    enum: ALIGN,
    description: "Horizontal text position in the box. Default center.",
  },
  verticalAlign: {
    type: "string",
    enum: VERTICAL_ALIGN,
    description: "Vertical text position in the box. Default middle.",
  },
  background: optionalColor(
    "Box fill as #RRGGBB, or none. The fill covers the full box. Default none.",
  ),
  backgroundOpacity: number(
    "Box fill opacity from 0 to 1. Default 0.75.",
    0,
    1,
  ),
  outline: optionalColor(
    "Thin line around each character as #RRGGBB, or none. Default #000000.",
  ),
};

export const elementCommands = [
  define(
    "element.add",
    `Add a timed text element to the edited video. Returns the element with its ID. The original file does not change. ${COORDINATES} Text can extend outside its box if it is too large. At most ${LIMITS.elements} elements. Undo with edit.undo.`,
    {
      id: ids.id,
      type: {
        type: "string",
        enum: ELEMENT_TYPES,
        description: "Element type. This version has text only.",
      },
      ...times,
      ...textProperties,
    },
    ["id", "type", "text", "start", "end"],
  ),
  define(
    "element.update",
    "Change one or more properties of an element. Properties that you do not give stay the same. If you give only start or only end, the other time stays the same. Undo with edit.undo.",
    { ...ids, ...times, ...textProperties },
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
      coordinates: COORDINATES,
      timing: TIMING,
      elements: describeElements(timeline),
    };
  const { id, elementId, ...values } = args;
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
