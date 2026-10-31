// Geometry for direct editing on the displayed video. No DOM or Electron
// dependency, so node:test checks it directly. Element values are 0 to 1 of
// the frame, the same as the shared commands and inspect.result.

const r4 = (value) => Math.round(value * 10000) / 10000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The rectangle where a video shows inside its element box. A <video> keeps
// the aspect ratio (object-fit: contain), so the frame has bars at the sides
// or at the top and bottom. Returns null before the video size is known.
export function contentRect(box, media) {
  if (!media.width || !media.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / media.width, box.height / media.height);
  const width = media.width * scale,
    height = media.height * scale;
  return {
    left: r4((box.width - width) / 2),
    top: r4((box.height - height) / 2),
    width: r4(width),
    height: r4(height),
  };
}

// A pointer point in the same pixel space as the rectangle, as 0 to 1 of
// the frame. A point in a bar goes to the nearest frame edge.
export function toFrame(point, rect) {
  return {
    x: r4(clamp((point.x - rect.left) / rect.width, 0, 1)),
    y: r4(clamp((point.y - rect.top) / rect.height, 0, 1)),
  };
}

export function moveBox(box, dx, dy) {
  return {
    x: r4(clamp(box.x + dx, 0, 1 - box.width)),
    y: r4(clamp(box.y + dy, 0, 1 - box.height)),
    width: box.width,
    height: box.height,
  };
}

// Resize from a handle: n, s, e, w, ne, nw, se, or sw. The opposite edge
// stays. The box stays in the frame and at least `min` wide and high.
export function resizeBox(box, handle, dx, dy, min = 0.01) {
  let left = box.x,
    right = box.x + box.width,
    top = box.y,
    bottom = box.y + box.height;
  if (handle.includes("w")) left = clamp(left + dx, 0, right - min);
  if (handle.includes("e")) right = clamp(right + dx, left + min, 1);
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - min);
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + min, 1);
  left = r4(left);
  right = r4(right);
  top = r4(top);
  bottom = r4(bottom);
  return {
    x: left,
    y: top,
    width: r4(right - left),
    height: r4(bottom - top),
  };
}

// Move both arrow ends. The move stops at the frame edge for both ends.
export function moveArrow(arrow, dx, dy) {
  const mx = clamp(
    dx,
    -Math.min(arrow.x1, arrow.x2),
    1 - Math.max(arrow.x1, arrow.x2),
  );
  const my = clamp(
    dy,
    -Math.min(arrow.y1, arrow.y2),
    1 - Math.max(arrow.y1, arrow.y2),
  );
  return {
    x1: r4(arrow.x1 + mx),
    y1: r4(arrow.y1 + my),
    x2: r4(arrow.x2 + mx),
    y2: r4(arrow.y2 + my),
  };
}

// Put the tail or the tip at a frame point.
export function moveArrowEnd(arrow, end, point) {
  const x = r4(clamp(point.x, 0, 1)),
    y = r4(clamp(point.y, 0, 1));
  return end === "tip"
    ? { ...arrow, x2: x, y2: y }
    : { ...arrow, x1: x, y1: y };
}

// The values that a gesture changed, rounded to 4 decimals. A gesture sends
// only these keys, so it does not send times or style again.
export function changedKeys(before, after) {
  const changed = {};
  for (const [key, value] of Object.entries(after))
    if (Math.abs(r4(value) - r4(before[key])) > 1e-5) changed[key] = r4(value);
  return changed;
}
