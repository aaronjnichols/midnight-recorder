// The layers of one output frame around one element. Pure functions. No file,
// process, or Electron access.
//
// A draft picture has an image of the layers below an element and an image of
// the layers above it. The element itself is not in either image, so its text
// can change without a new image. The same operations as the export draw both
// images, and a frame shows them by the same [start, end) rule.
import { duration, sourceTime, videoFadeLevel } from "./timeline.js";
import { elementsOf, renderPlan, FRAME_EDGE } from "./elements.js";
import { captionPlan } from "./captions.js";

// The same frames as the export: frame n is at n / rate seconds, and the last
// frame starts before the edited end.
export function draftFrameIndex(timeline, seconds, rate) {
  const last = Math.max(0, Math.ceil(duration(timeline) * rate - 1e-6) - 1);
  return Math.min(last, Math.floor(seconds * rate + 1e-6));
}

export function draftFramePlan(timeline, frame, elementId, seconds, rate) {
  const list = elementsOf(timeline);
  const layer = list.findIndex((e) => e.id === elementId);
  if (layer < 0) throw new Error("Element was not found.");
  const total = duration(timeline);
  const frameIndex = draftFrameIndex(timeline, seconds, rate);
  const time = frameIndex / rate;
  const shown = (op) =>
    time >= op.start - FRAME_EDGE && time < op.end - FRAME_EDGE;
  const layers = new Map(list.map((e, index) => [e.id, index]));
  const ops = renderPlan(timeline, frame).filter(shown);
  const above = ops.filter((op) => layers.get(op.id) > layer);
  // Captions are over all elements.
  const captions = captionPlan(timeline, frame);
  const cue = captions?.cues.find(shown);
  if (cue) {
    const { cues, ...style } = captions;
    above.push({
      ...style,
      ...cue,
      id: "caption",
      type: "text",
      opacity: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
  }
  return {
    frameIndex,
    seconds: time,
    sourceSeconds: sourceTime(timeline, Math.min(time, total)),
    below: ops.filter((op) => layers.get(op.id) < layer),
    element: ops.find((op) => op.id === elementId) ?? null,
    above,
    // The video fades come after all layers, so they are not in the images.
    fadeOpacity: 1 - videoFadeLevel(timeline, frameIndex, rate),
  };
}
