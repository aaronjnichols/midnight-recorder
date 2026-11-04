// Element editing on the desktop page: toolbar, layer list, properties, and
// direct editing on the displayed video. Every change uses a shared command.
// The rendered preview stays the exact picture. The stage shows only
// outlines and handles, never a second copy of text or shapes.
import { duration } from "../domain/timeline.js";
import { describeElements } from "../domain/elements.js";
import {
  contentRect,
  moveBox,
  resizeBox,
  moveArrow,
  moveArrowEnd,
  changedKeys,
} from "./stage.js";
import {
  layerRows,
  newElement,
  fieldValue,
  inputValue,
  textFit,
  fadeNote,
  FONT_NAMES,
  TYPE_LABELS,
} from "./element-view.js";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_NAMES = {
  nw: "top left",
  n: "top",
  ne: "top right",
  e: "right",
  se: "bottom right",
  s: "bottom",
  sw: "bottom left",
  w: "left",
};
const COLOR_KEYS = ["background", "outline", "fill", "stroke"];
const MIN_SIZE = 0.01;
const SVG = "http://www.w3.org/2000/svg";

export function createElementEditor({
  $,
  call,
  queue,
  notice,
  showVideo,
  playhead,
  seek,
  isReady,
  frameSize,
  onSelect,
  onChange,
}) {
  let video = null,
    elements = [],
    selectedId = null,
    // Increases on each user selection, so a late result cannot select an
    // element after the user selected another one.
    selection = 0,
    gesture = null,
    stageKey = "",
    layerKey = "";
  const form = $("#element-form");
  const stage = $("#stage");
  const total = () => (video ? duration(video.timeline) : 0);
  const selected = () => elements.find((e) => e.id === selectedId) || null;
  const nameOf = (id) =>
    layerRows(elements, null, total()).find((r) => r.id === id)?.name || "";

  function render(next) {
    if (!next) return clear();
    if (video?.id !== next.id) {
      selectedId = null;
      selection++;
    }
    video = next;
    elements = describeElements(video.timeline);
    if (selectedId && !selected()) selectedId = null;
    renderLayers();
    renderForm();
    renderStage();
    renderToolbar();
  }

  function clear() {
    video = null;
    elements = [];
    selectedId = null;
    gesture = null;
    stageKey = layerKey = "";
    $("#layer-list").replaceChildren();
    stage.replaceChildren();
    stage.hidden = true;
    form.hidden = true;
  }

  function select(id, { reveal = false } = {}) {
    selectedId = id;
    selection++;
    if (id) onSelect?.();
    renderLayers();
    renderForm();
    renderStage();
    renderToolbar();
    onChange?.();
    const element = selected();
    // Show the selected element: move the playhead into its time.
    if (reveal && element && element.visibility !== "none" && isReady()) {
      const now = playhead();
      if (now < element.start || now >= element.end) seek(element.start);
    }
  }

  // Runs one shared command for this video. The result shows only if the
  // same video is still open.
  function command(name, args, { selectResult = false } = {}) {
    if (!video) return Promise.resolve();
    const id = video.id,
      before = selection;
    return queue(async () => {
      const result = await call(name, { id, ...args });
      showVideo(result.video, id);
      if (selectResult && video?.id === id && selection === before)
        select(result.element?.id ?? null);
    }).catch((error) => {
      notice(error.message, true);
      // A rejected edit does not change the saved state. Show it again.
      renderForm({ force: true });
      renderStage({ force: true });
    });
  }

  function update(changes) {
    const element = selected();
    if (!element || !Object.keys(changes).length) return Promise.resolve();
    return command("element.update", { elementId: element.id, ...changes });
  }

  // Toolbar.
  for (const kind of ["text", "label", "rectangle", "ellipse", "arrow"])
    $(`#add-${kind}`).addEventListener("click", () =>
      command("element.add", newElement(kind, playhead(), total()), {
        selectResult: true,
      }),
    );
  $("#duplicate-element").addEventListener("click", () => {
    const element = selected();
    if (element)
      command(
        "element.duplicate",
        { elementId: element.id },
        { selectResult: true },
      );
  });
  $("#delete-element").addEventListener("click", () => deleteSelected());
  for (const [button, step] of [
    ["#raise-element", 1],
    ["#lower-element", -1],
  ])
    $(button).addEventListener("click", () => {
      const element = selected();
      if (!element) return;
      const index = element.layer + step;
      if (index >= 0 && index < elements.length)
        command("element.order", { elementId: element.id, index });
    });

  function deleteSelected() {
    const element = selected();
    if (!element) return Promise.resolve();
    const before = selection;
    return command("element.remove", { elementId: element.id }).then(() => {
      if (selection === before && !selected()) select(null);
    });
  }

  function renderToolbar() {
    const element = selected();
    for (const id of ["text", "label", "rectangle", "ellipse", "arrow"])
      $(`#add-${id}`).disabled = !video;
    // The actions show with the element that they change.
    $("#element-actions").hidden = !element;
    $("#duplicate-element").disabled = !element;
    $("#delete-element").disabled = !element;
    $("#raise-element").disabled =
      !element || element.layer >= elements.length - 1;
    $("#lower-element").disabled = !element || element.layer <= 0;
  }

  // Layer list: one row per element, top layer first, with its lifetime.
  function renderLayers() {
    const rows = layerRows(elements, selectedId, total());
    $("#layer-count").textContent = rows.length
      ? `${rows.length} element${rows.length === 1 ? "" : "s"}`
      : "No elements";
    $("#layers-empty").hidden = rows.length > 0;
    const key = JSON.stringify(rows);
    if (key === layerKey) return;
    layerKey = key;
    const focused = document.activeElement?.closest?.(".layer-row")?.dataset.id;
    $("#layer-list").replaceChildren(
      ...rows.map((row) => {
        const item = document.createElement("li");
        item.className = "layer-row";
        item.dataset.id = row.id;
        item.dataset.visibility = row.visibility;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "layer-select";
        button.setAttribute("aria-pressed", String(row.selected));
        const icon = document.createElementNS(SVG, "svg");
        icon.setAttribute("class", `icon layer-icon type-${row.type}`);
        icon.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(SVG, "use");
        use.setAttribute("href", `#i-${row.type}`);
        icon.append(use);
        const name = document.createElement("span");
        name.className = "layer-name";
        name.textContent = row.name;
        const time = document.createElement("span");
        time.className = "layer-time";
        time.textContent = row.timeText;
        button.append(icon, name, time);
        // Selection follows the keyboard focus. A click also moves the
        // playhead into the element's time.
        button.addEventListener("focus", () => {
          if (selectedId !== row.id) select(row.id);
        });
        button.addEventListener("click", () =>
          select(row.id, { reveal: true }),
        );
        item.append(button);
        return item;
      }),
    );
    if (focused)
      $(`.layer-row[data-id="${CSS.escape(focused)}"] .layer-select`)?.focus();
  }

  // Properties form. A field that the user is typing in does not change.
  function renderForm({ force = false } = {}) {
    const element = selected();
    form.hidden = !element;
    $("#element-empty").hidden = Boolean(element);
    $("#element-heading").textContent = element
      ? `Element: ${nameOf(element.id)}`
      : "Element";
    if (!element) return;
    for (const node of form.querySelectorAll("[data-types]"))
      node.hidden = !node.dataset.types.split(" ").includes(element.type);
    const busy = (node) =>
      !force && node === document.activeElement && node.dataset.dirty === "1";
    for (const input of form.querySelectorAll("[data-key]")) {
      if (input.classList.contains("color-field") || busy(input)) continue;
      input.dataset.dirty = "";
      if (input.type === "checkbox")
        input.checked = Boolean(element[input.dataset.key]);
      else if (input.type === "color")
        input.value = String(
          element[input.dataset.key] || "#ffffff",
        ).toLowerCase();
      else input.value = fieldValue(input.dataset.key, element);
    }
    const text = $("#el-text");
    if (element.type === "text" && !busy(text)) {
      text.value = element.text;
      text.dataset.dirty = "";
    }
    for (const key of COLOR_KEYS) {
      const value = element[key];
      if (value === undefined) continue;
      const input = $(`#el-${key}`);
      if (value !== "none") input.value = value.toLowerCase();
      $(`#el-${key}-none`).checked = value === "none";
    }
    $("#el-visibility").textContent =
      element.visibility === "none"
        ? "This element is not in the edited video. A cut or trim removed its time. Set new times, or undo the cut."
        : element.visibility === "partial"
          ? "A cut or trim removed part of this element's time. The times show what remains."
          : "";
    $("#el-fade-in-note").textContent = fadeNote(element, "fadeIn");
    $("#el-fade-out-note").textContent = fadeNote(element, "fadeOut");
    checkFit(element);
  }

  // Text that is larger than its box extends outside the box in the video.
  // The check measures the text with the same font and pixel size.
  let measure;
  function checkFit(element) {
    const note = $("#el-fit");
    const frame = frameSize();
    if (element.type !== "text" || !frame) {
      note.hidden = true;
      return;
    }
    measure ??= document.createElement("canvas").getContext("2d");
    const pixels = Math.max(1, Math.round(element.size * frame.height));
    measure.font = `${element.bold ? "bold " : ""}${pixels}px ${FONT_NAMES[element.font]}`;
    const lines = element.text.split("\n");
    const sample = measure.measureText("Hg");
    const lineHeight =
      (sample.fontBoundingBoxAscent || pixels) +
      (sample.fontBoundingBoxDescent || 0);
    const width = Math.round(element.width * frame.width),
      height = Math.round(element.height * frame.height);
    const padding = Math.min(
      Math.round(pixels * 0.25),
      Math.floor((width - 1) / 2),
      Math.floor((height - 1) / 2),
    );
    const fit = textFit({
      textWidth: Math.max(
        ...lines.map((line) => measure.measureText(line).width),
      ),
      textHeight: lines.length * lineHeight,
      innerWidth: Math.max(1, width - 2 * padding),
      innerHeight: Math.max(1, height - 2 * padding),
    });
    note.hidden = fit.fits;
    note.dataset.scale = fit.scale;
    if (!fit.fits)
      $("#el-fit-text").textContent =
        `The text is larger than its box (${Math.round(Math.max(fit.widthRatio, fit.heightRatio) * 100)}% of the box). In the video, it extends outside the box. Make the text smaller, add line breaks, or make the box larger.`;
  }
  $("#el-fit-button").addEventListener("click", () => {
    const element = selected();
    const scale = Number($("#el-fit").dataset.scale);
    if (element && scale > 0)
      update({
        size: Math.max(0.01, Math.floor(element.size * scale * 1000) / 1000),
      });
  });

  // Each field sends only its own key, so a style or start change does not
  // send an unchanged end again.
  function commitField(input) {
    const element = selected();
    if (!element) return;
    const key = input.dataset.key;
    input.dataset.dirty = "";
    let value;
    if (input.type === "checkbox") value = input.checked;
    else if (input.tagName === "SELECT") value = input.value;
    else if (input.type === "color") value = input.value.toUpperCase();
    else {
      // The field shows a rounded value. An unchanged field sends nothing,
      // so Enter cannot send a rounded time past the edited end.
      if (input.value === fieldValue(key, element)) return;
      value = inputValue(key, input.value);
      if (!Number.isFinite(value)) {
        notice("Enter a number.", true);
        renderForm({ force: true });
        return;
      }
      // A time within half of the shown step of the edited end is the end.
      if (
        (key === "start" || key === "end") &&
        Math.abs(value - total()) < 0.0005
      )
        value = total();
    }
    const current = element[key];
    if (
      value === current ||
      (typeof value === "number" &&
        typeof current === "number" &&
        Math.abs(value - current) < 1e-7)
    )
      return;
    update({ [key]: value });
  }
  for (const input of form.querySelectorAll("[data-key]")) {
    if (input.classList.contains("color-field")) continue;
    input.addEventListener("input", () => (input.dataset.dirty = "1"));
    input.addEventListener("change", () => commitField(input));
    if (input.tagName === "INPUT")
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commitField(input);
      });
  }
  for (const key of COLOR_KEYS) {
    const color = $(`#el-${key}`),
      none = $(`#el-${key}-none`);
    color.addEventListener("change", () =>
      update({ [key]: color.value.toUpperCase() }),
    );
    none.addEventListener("change", () =>
      update({ [key]: none.checked ? "none" : color.value.toUpperCase() }),
    );
  }
  const text = $("#el-text");
  text.addEventListener("input", () => (text.dataset.dirty = "1"));
  text.addEventListener("change", () => {
    const element = selected();
    text.dataset.dirty = "";
    if (element && text.value !== element.text) update({ text: text.value });
  });
  for (const key of ["start", "end"])
    $(`#el-${key}-now`).addEventListener("click", () => {
      if (!isReady())
        return notice("Wait for the preview. Then use the playhead.");
      // Never past the edited end. The last frame can end after it.
      update({
        [key]: Math.min(total(), Math.round(playhead() * 1000) / 1000),
      });
    });
  form.addEventListener("submit", (event) => event.preventDefault());

  // Stage: outlines and handles on the displayed frame.
  function layout() {
    const wrap = stage.parentElement;
    const frame = frameSize();
    const rect =
      video && frame
        ? contentRect(
            { width: wrap.clientWidth, height: wrap.clientHeight },
            frame,
          )
        : null;
    stage.hidden = !rect;
    if (!rect) return;
    Object.assign(stage.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  function renderStage({ force = false } = {}) {
    layout();
    if (gesture) return;
    const now = playhead();
    const shown = elements.filter(
      (e) =>
        e.id === selectedId ||
        (e.visibility !== "none" && now >= e.start && now < e.end),
    );
    const key = JSON.stringify([selectedId, shown]);
    if (!force && key === stageKey) return;
    stageKey = key;
    stage.replaceChildren(...shown.map(stageItem));
  }

  function stageItem(element) {
    const item = document.createElement("div");
    item.className = `stage-item type-${element.type}`;
    item.dataset.id = element.id;
    const active = element.id === selectedId;
    item.classList.toggle("selected", active);
    const now = playhead();
    item.classList.toggle(
      "hidden-now",
      element.visibility === "none" ||
        now < element.start ||
        now >= element.end,
    );
    if (element.type === "arrow") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 1000 1000");
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      for (const [name, value] of [
        ["x1", element.x1 * 1000],
        ["y1", element.y1 * 1000],
        ["x2", element.x2 * 1000],
        ["y2", element.y2 * 1000],
      ])
        line.setAttribute(name, value);
      line.setAttribute("vector-effect", "non-scaling-stroke");
      const hit = line.cloneNode();
      hit.classList.add("arrow-hit");
      line.classList.add("arrow-line");
      hit.addEventListener("pointerdown", (event) =>
        begin(event, element, "move"),
      );
      svg.append(line, hit);
      item.append(svg);
      if (active)
        for (const end of ["tail", "tip"]) {
          const handle = document.createElement("span");
          handle.className = "handle";
          handle.dataset.handle = end;
          handle.title = end === "tip" ? "Arrow tip" : "Arrow tail";
          const [x, y] =
            end === "tip" ? [element.x2, element.y2] : [element.x1, element.y1];
          handle.style.left = `${x * 100}%`;
          handle.style.top = `${y * 100}%`;
          handle.addEventListener("pointerdown", (event) =>
            begin(event, element, "end", end),
          );
          item.append(handle);
        }
      return item;
    }
    place(item, element);
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `Select ${nameOf(element.id)}`);
    item.tabIndex = -1;
    item.addEventListener("pointerdown", (event) =>
      begin(event, element, "move"),
    );
    if (active)
      for (const name of HANDLES) {
        const handle = document.createElement("span");
        handle.className = "handle";
        handle.dataset.handle = name;
        handle.title = `Resize from the ${HANDLE_NAMES[name]}`;
        handle.addEventListener("pointerdown", (event) =>
          begin(event, element, "resize", name),
        );
        item.append(handle);
      }
    return item;
  }
  const place = (item, box) =>
    Object.assign(item.style, {
      left: `${box.x * 100}%`,
      top: `${box.y * 100}%`,
      width: `${box.width * 100}%`,
      height: `${box.height * 100}%`,
    });

  const geometry = (e) =>
    e.type === "arrow"
      ? { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }
      : { x: e.x, y: e.y, width: e.width, height: e.height };

  // A pointer point as a fraction of the displayed frame. It is not clamped,
  // so a move can continue past the frame edge.
  function point(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function begin(event, element, mode, handle) {
    if (event.button !== 0 || !video) return;
    event.preventDefault();
    event.stopPropagation();
    // Selection draws the stage again and replaces the item under the
    // pointer. The stage itself stays, so it holds the pointer capture.
    if (element.id !== selectedId) select(element.id);
    const target = stage;
    target.setPointerCapture?.(event.pointerId);
    gesture = {
      videoId: video.id,
      id: element.id,
      type: element.type,
      mode,
      handle,
      start: point(event),
      origin: geometry(element),
      current: geometry(element),
      target,
      pointerId: event.pointerId,
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onEnd);
    target.addEventListener("pointercancel", cancelGesture);
  }

  function onMove(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const p = point(event);
    const dx = p.x - gesture.start.x,
      dy = p.y - gesture.start.y;
    const { origin, mode, handle } = gesture;
    gesture.current =
      gesture.type === "arrow"
        ? mode === "end"
          ? moveArrowEnd(origin, handle, p)
          : moveArrow(origin, dx, dy)
        : mode === "resize"
          ? resizeBox(origin, handle, dx, dy, MIN_SIZE)
          : moveBox(origin, dx, dy);
    draw(gesture.current);
  }

  // Show the gesture on the outline only. The video does not render until
  // the gesture ends.
  function draw(value) {
    const item = stage.querySelector(
      `.stage-item[data-id="${CSS.escape(gesture.id)}"]`,
    );
    if (!item) return;
    if (gesture.type !== "arrow") return place(item, value);
    for (const line of item.querySelectorAll("line")) {
      line.setAttribute("x1", value.x1 * 1000);
      line.setAttribute("y1", value.y1 * 1000);
      line.setAttribute("x2", value.x2 * 1000);
      line.setAttribute("y2", value.y2 * 1000);
    }
    for (const node of item.querySelectorAll(".handle")) {
      const tip = node.dataset.handle === "tip";
      node.style.left = `${(tip ? value.x2 : value.x1) * 100}%`;
      node.style.top = `${(tip ? value.y2 : value.y1) * 100}%`;
    }
  }

  function release() {
    const { target } = gesture;
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onEnd);
    target.removeEventListener("pointercancel", cancelGesture);
    if (target.hasPointerCapture?.(gesture.pointerId))
      target.releasePointerCapture(gesture.pointerId);
  }

  // One gesture sends one update with only the changed values.
  function onEnd(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const done = gesture;
    release();
    gesture = null;
    const changes = changedKeys(done.origin, done.current);
    if (!Object.keys(changes).length || video?.id !== done.videoId)
      return renderStage({ force: true });
    command("element.update", { elementId: done.id, ...changes });
  }

  // Escape or a lost pointer cancels the gesture. Nothing is saved.
  function cancelGesture() {
    if (!gesture) return false;
    release();
    gesture = null;
    renderStage({ force: true });
    return true;
  }

  return {
    render,
    clear,
    layout: () => {
      layout();
      renderStage();
    },
    timeChanged: () => {
      if (!gesture) renderStage();
    },
    selected: () => selectedId,
    // Also without a selection, this makes a pending result unable to
    // select, for example when the user selects a caption during an add.
    // Returns true if an element was selected.
    deselect: () => {
      const had = Boolean(selectedId);
      select(null);
      return had;
    },
    // A tool change: a pending result cannot select any more. The current
    // selection stays.
    invalidate: () => {
      selection++;
    },
    deleteSelected,
    cancelGesture,
    typeLabel: (type) => TYPE_LABELS[type],
    // The timeline bars: elements in the edited video.
    timelineItems: () =>
      layerRows(elements, selectedId, total())
        .filter((row) => row.visibility !== "none")
        .map(({ id, name, start, end, selected }) => ({
          id,
          name,
          start,
          end,
          selected,
        })),
    selectItem: (id, options) => select(id, options),
    setTimes: (id, changes) =>
      command("element.update", { elementId: id, ...changes }),
  };
}
