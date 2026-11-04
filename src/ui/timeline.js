// The timeline dock: ruler, track, selection with handles, playhead, zoom, and
// the pointer gestures. A drag changes the draft selection on the page only.
// Keep and Remove are the edits. The rules are in timeline-view.js.
import { duration } from "../domain/timeline.js";
import { editedLevels, frameAtEdited } from "../domain/overview.js";
import { createOverview } from "./timeline-overview.js";
import {
  DRAG_THRESHOLD,
  LANE_MIN,
  MIN_RANGE,
  SNAP_PIXELS,
  ZOOM_STEP,
  draftValues,
  dragRange,
  handleKey,
  keepInView,
  maxZoom,
  overviewNote,
  packLanes,
  rulerStep,
  rulerTicks,
  snapTime,
  timeAt,
  timingChanges,
  zoomAbout,
} from "./timeline-view.js";

// The space beside the track, so a handle at a track end stays on screen.
const EDGE_PAN = 28;
const EDGE_SPEED = 14;
// Rows for elements. More elements share the last row, and the list in the
// inspector has all of them. So many elements do not make the dock taller.
const LANE_ROWS = 2;
const percent = (value, total) => `${total > 0 ? (value / total) * 100 : 0}%`;
const two = (value) => Number(value.toFixed(2));
// What a drag depends on: the video and how edited times map to the source.
const timingOf = ({ id, timeline: { segments, speed } }) =>
  JSON.stringify([id, segments, speed]);

export function createTimeline({
  $,
  call,
  range,
  items,
  seek,
  scrub,
  isReady,
  playhead,
}) {
  const scroller = $("#timeline-scroll");
  const canvas = $("#timeline-canvas");
  const overview = createOverview({ call, onChange: renderOverview });
  const content = $("#timeline-content");
  const ruler = $("#timeline-ruler");
  const track = $("#timeline-track");
  const frame = $("#timeline-range");
  const startHandle = $("#range-handle-start");
  const endHandle = $("#range-handle-end");
  const before = $("#timeline-shade-before");
  const after = $("#timeline-shade-after");
  const head = $("#timeline-playhead");
  const tip = $("#timeline-tip");
  let video = null,
    total = 0,
    zoom = 1,
    gesture = null,
    panFrame = 0,
    rulerKey = "",
    barsKey = "",
    lanesKey = "",
    lastTime = -1;

  const paddingLeft = () => parseFloat(getComputedStyle(scroller).paddingLeft);
  // The width of the track at zoom 1, in pixels.
  const fitWidth = () => scroller.clientWidth - 2 * paddingLeft();
  const box = () => track.getBoundingClientRect();
  const pixelsPerSecond = () => (total > 0 ? box().width / total : 0);

  function layout() {
    const width = fitWidth();
    if (!(width > 0)) return;
    // A smaller window can make the zoom too large for a short video.
    zoom = Math.min(zoom, maxZoom(total, width));
    content.style.width = `${width * zoom}px`;
    renderRuler();
    renderZoom();
    draw();
  }

  function renderZoom() {
    const most = maxZoom(total, fitWidth());
    $("#zoom-out").disabled = zoom <= 1;
    $("#zoom-fit").disabled = zoom <= 1;
    $("#zoom-in").disabled = !video || zoom >= most - 1e-6;
    $("#zoom-level").textContent =
      `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`;
    scroller.classList.toggle("zoomed", zoom > 1);
  }

  function setZoom(next, anchorX = fitWidth() / 2) {
    if (!video) return;
    const result = zoomAbout({
      zoom,
      next,
      anchorX,
      scrollLeft: scroller.scrollLeft,
      width: fitWidth(),
      total,
    });
    zoom = result.zoom;
    content.style.width = `${fitWidth() * zoom}px`;
    renderZoom();
    scroller.scrollLeft = result.scrollLeft;
    renderRuler();
    draw();
  }

  // Only the ticks in view are in the page.
  function renderRuler() {
    if (!(total > 0)) return ruler.replaceChildren();
    const width = fitWidth() * zoom;
    const seconds = width / total;
    const margin = 80 / seconds;
    const start = Math.max(0, (scroller.scrollLeft / width) * total - margin);
    const end = Math.min(
      total,
      ((scroller.scrollLeft + scroller.clientWidth) / width) * total + margin,
    );
    const step = rulerStep(seconds);
    const key = JSON.stringify([total, zoom, step, Math.floor(start / step)]);
    if (key === rulerKey) return;
    rulerKey = key;
    ruler.replaceChildren(
      ...rulerTicks({ start, end, pxPerSecond: seconds }).map((tick) => {
        const node = document.createElement("span");
        node.textContent = tick.label;
        node.style.left = percent(tick.time, total);
        return node;
      }),
    );
  }

  function renderBars() {
    const { segments, speed } = video.timeline;
    const key = JSON.stringify([segments, speed]);
    if (key === barsKey) return;
    barsKey = key;
    let elapsed = 0;
    $("#timeline-bars").replaceChildren(
      ...segments.map((segment) => {
        const length = (segment.end - segment.start) / speed;
        const bar = document.createElement("i");
        bar.style.left = percent(elapsed, total);
        bar.style.width = percent(length, total);
        elapsed += length;
        return bar;
      }),
    );
  }

  // One bar for each element and caption, at its edited time. The bars
  // change only after a command, so a gesture draws on its own bar.
  function renderLanes({ force = false } = {}) {
    if (!video || gesture?.kind === "lane") return;
    const elements = packLanes(items.elements(), LANE_ROWS);
    const captions = items.captions();
    const key = JSON.stringify([total, elements, captions]);
    if (!force && key === lanesKey) return;
    lanesKey = key;
    $("#lane-elements").replaceChildren(
      ...elements.map((item) => laneBar("element", item)),
    );
    $("#lane-captions").replaceChildren(
      ...captions.map((item) => laneBar("caption", item)),
    );
  }

  function laneBar(kind, item) {
    const node = document.createElement("div");
    node.className = `lane-bar ${kind}`;
    Object.assign(node.dataset, { zone: "lane", kind, id: item.id });
    node.title = `${item.name}: ${item.start.toFixed(2)} to ${item.end.toFixed(2)} s`;
    placeBar(node, item);
    if (item.row) node.style.top = `calc(var(--row-lane) * ${item.row})`;
    // A bar that shares a row with another bar shows without its name.
    node.classList.toggle("overflow", Boolean(item.overflow) && !item.selected);
    const name = document.createElement("span");
    name.className = "lane-name";
    name.textContent = item.name;
    node.append(name);
    if (item.selected) {
      node.classList.add("selected");
      for (const edge of ["start", "end"]) {
        const handle = document.createElement("span");
        handle.className = `lane-handle ${edge}`;
        handle.dataset.zone = `lane-${edge}`;
        handle.dataset.edge = edge;
        handle.title = `Drag to change the ${edge} time`;
        node.append(handle);
      }
    }
    return node;
  }
  const placeBar = (node, { start, end }) => {
    node.style.left = percent(start, total);
    node.style.width = percent(end - start, total);
  };

  // The state of the sound and frames, for the user and for tests.
  function renderOverview() {
    const { videoId, audio, frames } = overview.view();
    track.dataset.overview = videoId;
    track.dataset.audio = audio.state;
    track.dataset.frames = frames.state;
    const muted = Boolean(video?.timeline.muted);
    const note = videoId ? overviewNote({ audio, frames, muted }) : null;
    $("#timeline-note").hidden = !note;
    $("#timeline-note-text").textContent = note?.text ?? "";
    $("#overview-retry").hidden = !note?.retry;
    draw();
  }

  // The canvas covers only the part of the track in view, so a large zoom
  // needs no large canvas. Frames are on top, and the sound is below them.
  function draw() {
    if (!video || !(total > 0)) return;
    const { audio, frames } = overview.view();
    const rect = box();
    const height = track.clientHeight;
    const left = Math.max(0, scroller.scrollLeft - paddingLeft());
    const width = Math.min(rect.width - left, scroller.clientWidth);
    if (!(width > 0) || !(height > 0)) return;
    const ratio = devicePixelRatio || 1;
    canvas.style.left = `${left}px`;
    canvas.style.width = `${width}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, -left * ratio, 0);
    const pixels = rect.width / total;
    const sound = !["none", "failed"].includes(audio.state);
    const stripHeight = Math.round(height * (sound ? 0.58 : 1));

    // One clip for each kept part, so the joins stay visible.
    context.save();
    context.beginPath();
    let elapsed = 0;
    const { segments, speed } = video.timeline;
    for (const [index, segment] of segments.entries()) {
      const length = (segment.end - segment.start) / speed;
      const gap = index < segments.length - 1 ? 2 : 0;
      context.roundRect(
        elapsed * pixels,
        0,
        Math.max(1, length * pixels - gap),
        height,
        6,
      );
      elapsed += length;
    }
    context.clip();
    drawFrames(context, frames, stripHeight, left, width, pixels);
    if (audio.state === "ready")
      drawSound(context, audio, stripHeight, height, left, width, pixels);
    context.restore();
  }

  function drawFrames(context, frames, height, left, width, pixels) {
    if (!frames.items.length) return;
    const tile = Math.max(8, (height * frames.width) / frames.height);
    const first = Math.floor(left / tile);
    const last = Math.ceil((left + width) / tile);
    for (let index = first; index < last; index++) {
      const x = index * tile;
      const time = Math.min(total, (x + tile / 2) / pixels);
      const frame = frameAtEdited(video.timeline, frames.items, time);
      // A kept part with no sample stays empty. A frame of a removed part
      // does not show.
      if (frame) context.drawImage(frame.image, x, 0, tile + 0.5, height);
    }
  }

  function drawSound(context, audio, top, bottom, left, width, pixels) {
    const columns = Math.max(1, Math.round(width / 2));
    const levels = editedLevels(video.timeline, audio, {
      start: left / pixels,
      end: (left + width) / pixels,
      columns,
    });
    // The loudest sound of the video fills the zone. Quiet noise stays small.
    const scale = 1 / Math.max(audio.loudest / 255, 0.25);
    const middle = (top + bottom) / 2;
    const reach = (bottom - top) / 2 - 2;
    const step = width / columns;
    context.fillStyle = video.timeline.muted ? "#5c6578" : "#88c0d0";
    context.beginPath();
    context.moveTo(left, middle);
    for (let column = 0; column < columns; column++)
      context.lineTo(
        left + (column + 0.5) * step,
        middle - Math.max(0.5, Math.min(1, levels[column] * scale) * reach),
      );
    context.lineTo(left + width, middle);
    for (let column = columns - 1; column >= 0; column--)
      context.lineTo(
        left + (column + 0.5) * step,
        middle + Math.max(0.5, Math.min(1, levels[column] * scale) * reach),
      );
    context.closePath();
    context.fill();
  }

  // The edited time of each join between two kept parts.
  function seams() {
    const { segments, speed } = video.timeline;
    const times = [];
    let elapsed = 0;
    for (const segment of segments.slice(0, -1)) {
      elapsed += (segment.end - segment.start) / speed;
      times.push(elapsed);
    }
    return times;
  }

  function render(next) {
    const opened = video?.id !== next.id;
    // A new video or a new time mapping ends a drag. A trim, cut, or speed
    // change from another client can come during a drag.
    if (gesture && timingOf(next) !== gesture.timing) abandon();
    video = next;
    total = duration(next.timeline);
    if (opened) {
      zoom = 1;
      scroller.scrollLeft = 0;
      rulerKey = barsKey = lanesKey = "";
      lastTime = -1;
      overview.load(next.id);
      $("#lane-elements").replaceChildren();
      $("#lane-captions").replaceChildren();
    }
    head.setAttribute("aria-valuemax", String(two(total)));
    endHandle.setAttribute("aria-valuemax", String(two(total)));
    startHandle.setAttribute("aria-valuemax", String(two(total)));
    renderBars();
    layout();
    renderRange();
    renderOverview();
  }

  function clear() {
    if (gesture) abandon();
    video = null;
    total = 0;
    zoom = 1;
    rulerKey = barsKey = lanesKey = "";
    overview.clear();
    ruler.replaceChildren();
    $("#timeline-bars").replaceChildren();
    $("#lane-elements").replaceChildren();
    $("#lane-captions").replaceChildren();
    canvas.width = canvas.height = 0;
  }

  function renderRange() {
    if (!video) return;
    const { start, end, valid, full } = range.read();
    const shown = valid ? { start, end } : { start: 0, end: total };
    const whole = !valid || full;
    frame.classList.toggle("full", whole);
    frame.style.left = percent(shown.start, total);
    frame.style.width = percent(shown.end - shown.start, total);
    before.hidden = after.hidden = whole;
    before.style.width = percent(shown.start, total);
    after.style.left = percent(shown.end, total);
    after.style.width = percent(total - shown.end, total);
    for (const [node, value] of [
      [startHandle, shown.start],
      [endHandle, shown.end],
    ]) {
      node.setAttribute("aria-valuenow", String(two(value)));
      node.setAttribute("aria-valuetext", `${value.toFixed(2)} seconds`);
    }
  }

  // The playhead on the page. During a scrub it follows the pointer.
  function setPlayhead(seconds) {
    if (!video || gesture?.kind === "seek") return;
    placePlayhead(seconds);
    // The view follows a new time, not a manual scroll of a paused video.
    if (zoom > 1 && !gesture && Math.abs(seconds - lastTime) > 0.01) {
      const width = fitWidth();
      const left = keepInView({
        x: (seconds / total) * width * zoom,
        scrollLeft: scroller.scrollLeft,
        width,
      });
      if (left !== scroller.scrollLeft) scroller.scrollLeft = left;
    }
    lastTime = seconds;
  }
  function placePlayhead(seconds) {
    head.style.left = percent(Math.min(seconds, total), total);
    head.setAttribute("aria-valuenow", String(two(seconds)));
    head.setAttribute("aria-valuetext", `${seconds.toFixed(1)} seconds`);
  }

  const showTip = (seconds) => {
    tip.hidden = false;
    tip.textContent = `${seconds.toFixed(2)} s`;
    tip.style.left = percent(seconds, total);
  };

  // Points that a dragged edge goes to: the video ends, the joins, and the
  // playhead.
  function snapPoints() {
    const points = [0, total, ...seams()];
    if (isReady()) points.push(playhead());
    return points;
  }

  // A pointer position in the time of the track, not limited to the track,
  // so a drag from a handle keeps its distance from the pointer.
  const pointerTime = (x) => {
    const rect = box();
    return rect.width > 0 ? ((x - rect.left) / rect.width) * total : 0;
  };

  function begin(event) {
    if (event.button !== 0 || !video || gesture) return;
    const target = event.target.closest?.("[data-zone]");
    const zone = target?.dataset.zone;
    if (!zone) return;
    // A field saves when it loses focus. A press on the timeline does not
    // move the focus by itself.
    const field = document.activeElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(field?.tagName)) field.blur();
    const seekZone = zone === "ruler";
    const lane = zone.startsWith("lane") ? laneGesture(target, zone) : null;
    if (zone.startsWith("lane") && !lane) return;
    const handled = zone === "start" || zone === "end";
    const current = range.read();
    const origin = current.valid
      ? { start: current.start, end: current.end }
      : { start: 0, end: total };
    gesture = {
      kind: seekZone ? "seek" : "range",
      mode: { track: "create", range: "move", start: "start", end: "end" }[
        zone
      ],
      ...lane,
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      moved: false,
      anchor: pointerTime(event.clientX),
      origin: lane?.origin ?? origin,
      fields: range.fields(),
      from: playhead(),
      handled,
      timing: timingOf(video),
      sent: false,
    };
    if (!handled) event.preventDefault();
    scroller.setPointerCapture?.(event.pointerId);
    scroller.addEventListener("pointermove", onMove);
    scroller.addEventListener("pointerup", onUp);
    scroller.addEventListener("pointercancel", cancel);
    scroller.addEventListener("lostpointercapture", cancel);
    if (seekZone) update();
  }

  // What a press on a bar needs. The item and its limits come from the press,
  // so a later change of the list does not change this gesture.
  function laneGesture(target, zone) {
    const node = target.closest(".lane-bar");
    const { kind, id } = node.dataset;
    const list = kind === "caption" ? items.captions() : items.elements();
    const item = list.find((entry) => entry.id === id);
    if (!item) return null;
    const limits = kind === "caption" ? items.limits(id) : {};
    return {
      kind: "lane",
      mode: zone === "lane" ? "move" : zone.slice(5),
      node,
      item: { kind, id },
      origin: { start: item.start, end: item.end },
      next: { start: item.start, end: item.end },
      // A stored time can already be at a limit. A drag does not move it in.
      limits:
        kind === "caption"
          ? {
              lower: Math.min(limits.lower, item.start),
              upper: Math.max(limits.upper, item.end),
            }
          : {},
      selected: item.selected,
    };
  }

  function updateLane(g, time) {
    const snap = (value) =>
      snapTime(value, snapPoints(), SNAP_PIXELS / pixelsPerSecond());
    g.next = dragRange({
      mode: g.mode,
      origin: g.origin,
      anchor: g.anchor,
      time: g.mode === "move" ? time : snap(g.origin[g.mode] + time - g.anchor),
      total,
      min: LANE_MIN,
      ...g.limits,
    });
    placeBar(g.node, g.next);
    showTip(g.mode === "end" ? g.next.end : g.next.start);
    // The first drag of an item also selects it.
    if (!g.selected) {
      g.selected = true;
      g.node.classList.add("selected");
      items.select(g.item.kind, g.item.id);
    }
  }

  function update() {
    const g = gesture;
    if (!g) return;
    const time = pointerTime(g.lastX);
    if (g.kind === "lane") return updateLane(g, time);
    if (g.kind === "seek") {
      const seconds = timeAt(g.lastX, box(), total);
      placePlayhead(seconds);
      if (isReady()) {
        g.sent = true;
        scrub(seconds);
      }
      return;
    }
    const snap = (value) =>
      snapTime(value, snapPoints(), SNAP_PIXELS / pixelsPerSecond());
    let next;
    if (g.mode === "start" || g.mode === "end") {
      const value = snap(g.origin[g.mode] + time - g.anchor);
      next = dragRange({ mode: g.mode, origin: g.origin, time: value, total });
      showTip(next[g.mode]);
    } else if (g.mode === "move")
      next = dragRange({
        mode: "move",
        origin: g.origin,
        anchor: g.anchor,
        time,
        total,
      });
    else
      next = dragRange({
        mode: "create",
        anchor: g.anchor,
        time: snap(Math.min(total, Math.max(0, time))),
        total,
      });
    writeDraft(next, g.handled ? g.mode : "both", g.fields);
  }

  // A handle changes one end. The other end keeps its exact text, which can
  // have more digits than a drag gives.
  function writeDraft(next, which, fields) {
    const text = draftValues(next, total);
    range.write({
      start: which === "end" ? fields.start : text.start,
      end: which === "start" ? fields.end : text.end,
    });
  }

  function onMove(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    g.lastX = event.clientX;
    if (!g.moved && Math.abs(g.lastX - g.startX) < DRAG_THRESHOLD) return;
    g.moved = true;
    update();
    pan();
  }

  // A drag at the edge of the view scrolls the timeline, also while the
  // pointer does not move.
  function pan() {
    if (panFrame || !gesture || zoom <= 1) return;
    const view = scroller.getBoundingClientRect();
    const speed =
      gesture.lastX > view.right - EDGE_PAN
        ? EDGE_SPEED
        : gesture.lastX < view.left + EDGE_PAN
          ? -EDGE_SPEED
          : 0;
    if (!speed) return;
    panFrame = requestAnimationFrame(() => {
      panFrame = 0;
      if (!gesture) return;
      scroller.scrollLeft += speed;
      update();
      pan();
    });
  }

  function release() {
    const { pointerId } = gesture;
    gesture = null;
    tip.hidden = true;
    cancelAnimationFrame(panFrame);
    panFrame = 0;
    scroller.removeEventListener("pointermove", onMove);
    scroller.removeEventListener("pointerup", onUp);
    scroller.removeEventListener("pointercancel", cancel);
    scroller.removeEventListener("lostpointercapture", cancel);
    if (scroller.hasPointerCapture?.(pointerId))
      scroller.releasePointerCapture(pointerId);
  }

  function onUp(event) {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    release();
    if (g.kind === "lane") return finishLane(g);
    // A scrub already sent its times. Without a preview, seek tells the user
    // to wait.
    if (g.kind === "seek") {
      if (!isReady()) seek(0);
      return;
    }
    if (g.moved) return;
    // A press on a handle moves the playhead to that end. The handle is
    // beside the time, so the pointer time is not exact there.
    seek(g.handled ? g.origin[g.mode] : timeAt(event.clientX, box(), total));
  }

  // A press selects. A drag sends one command with only the changed times. A
  // result or an error draws the bars again.
  function finishLane(g) {
    const { kind, id } = g.item;
    if (!g.moved) return items.select(kind, id, { reveal: true });
    const changes = timingChanges(g.origin, g.next, total);
    if (!Object.keys(changes).length) return renderLanes({ force: true });
    Promise.resolve(items.commit(kind, id, changes)).finally(() =>
      renderLanes({ force: true }),
    );
  }

  // Escape or a lost pointer ends the gesture. The draft from before the
  // drag returns.
  function cancel() {
    const g = gesture;
    if (!g) return false;
    release();
    if (g.kind === "lane") renderLanes({ force: true });
    if (g.kind === "range" && g.moved) range.restore(g.fields);
    if (g.kind === "seek") {
      placePlayhead(g.from);
      // A press moves the video at once, also without a drag.
      if (g.sent && isReady()) scrub(g.from);
    }
    return true;
  }
  // The video or its timing changed, so the old draft and the old time do not
  // apply any more.
  function abandon() {
    if (!gesture) return;
    release();
    lanesKey = "";
  }

  scroller.addEventListener("pointerdown", begin);
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (!video) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const view = scroller.getBoundingClientRect();
        const step = Math.sqrt(ZOOM_STEP);
        setZoom(
          event.deltaY < 0 ? zoom * step : zoom / step,
          event.clientX - view.left - paddingLeft(),
        );
      } else if (zoom > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        scroller.scrollLeft += event.deltaY;
      }
    },
    { passive: false },
  );
  scroller.addEventListener("scroll", () => {
    renderRuler();
    draw();
  });
  $("#overview-retry").addEventListener("click", () => {
    if (video) overview.load(video.id);
  });
  $("#zoom-in").addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  $("#zoom-out").addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  $("#zoom-fit").addEventListener("click", () => setZoom(1));
  new ResizeObserver(() => {
    if (video) layout();
  }).observe(scroller);

  // Keys on a handle change the draft selection. They do not reach the page
  // shortcuts, so the arrow keys do not also move the playhead.
  for (const [node, which] of [
    [startHandle, "start"],
    [endHandle, "end"],
  ])
    node.addEventListener("keydown", (event) => {
      if (!video || event.altKey || event.ctrlKey || event.metaKey) return;
      const current = range.read();
      const shown = current.valid
        ? { start: current.start, end: current.end }
        : { start: 0, end: total };
      const limits =
        which === "start"
          ? { min: 0, max: shown.end - MIN_RANGE }
          : { min: shown.start + MIN_RANGE, max: total };
      const value = handleKey(event, shown[which], limits);
      if (value === null) return;
      event.preventDefault();
      event.stopPropagation();
      writeDraft({ ...shown, [which]: value }, which, range.fields());
    });

  return {
    render,
    clear,
    renderRange,
    renderLanes,
    setPlayhead,
    cancelGesture: cancel,
    zoomIn: () => setZoom(zoom * ZOOM_STEP),
    zoomOut: () => setZoom(zoom / ZOOM_STEP),
    zoomFit: () => setZoom(1),
  };
}
