// Element editing on the desktop page: toolbar, layer list, properties, and
// direct editing on the displayed video. Every saved change uses a shared
// command. The rendered preview stays the exact picture. The stage shows
// outlines and handles. A text draft shows in the draft view, in place of the
// rendered text and never over it, until the exact preview is ready.
import { duration } from "../domain/timeline.js";
import { describeElements } from "../domain/elements.js";
import { draftBaseRevision } from "../domain/inspection.js";
import { createDraftView } from "./draft-view.js";
import {
  applyPlan,
  cleanPaste,
  draftFromIntent,
  editTime,
  followSaved,
  liveProblem,
  openDraft,
  saveFailed,
  startSave,
  typeDraft,
} from "./text-draft.js";
import { readableError } from "./view-model.js";
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
// A press that moves less than this is a click, so a double-click on a box
// does not save a small move.
const DRAG_PIXELS = 3;
// The wait after a selection before the page asks for the draft images, so a
// fast pass over the layers does not start FFmpeg for each row.
const PREPARE_MS = 120;

const quoted = (text) =>
  `“${text.length > 40 ? `${text.slice(0, 39)}…` : text}”`;

export function createElementEditor({
  $,
  call,
  queue,
  notice,
  showVideo,
  playhead,
  seek,
  moveTo,
  isReady,
  hasRenderedPicture,
  paused,
  frameSize,
  onSelect,
  onChange,
  onDraft,
}) {
  let video = null,
    elements = [],
    selectedId = null,
    // Increases on each user selection, so a late result cannot select an
    // element after the user selected another one.
    selection = 0,
    gesture = null,
    stageKey = "",
    layerKey = "",
    // The text session, from text-draft.js, with the time that it shows.
    draft = null,
    // True while the field on the video is open.
    boxOpen = false,
    // A saved change of a text element waits for its exact preview. The draft
    // view keeps it on the picture until then.
    hold = null,
    // The apply in progress. Its change holds also if the user selects another
    // element before the reply.
    applied = null,
    prepareTimer;
  // Failed drafts of sessions that the page left, by video and element. They
  // come back when the element is selected. They stay in memory only.
  const parked = new Map();
  const cancelled = new Set();
  const form = $("#element-form");
  const stage = $("#stage");
  const field = $("#el-text");
  const input = $("#draft-input");
  const editor = $("#draft-editor");
  const actions = $("#draft-actions");
  const problem = $("#draft-problem");
  const editButton = $("#edit-text");
  const total = () => (video ? duration(video.timeline) : 0);
  const selected = () => elements.find((e) => e.id === selectedId) || null;
  const nameOf = (id) =>
    layerRows(elements, null, total()).find((r) => r.id === id)?.name || "";
  const parkKey = (videoId, elementId) => `${videoId}/${elementId}`;
  const view = createDraftView({
    $,
    call,
    frameSize,
    onChange: () => onDraft?.(),
  });

  function render(next) {
    if (!next) return clear();
    if (video?.id !== next.id) {
      leaveDraft();
      hold = null;
      selectedId = null;
      selection++;
    }
    video = next;
    elements = describeElements(video.timeline);
    if (selectedId && !selected()) selectedId = null;
    followDraft();
    resumeDraft();
    renderLayers();
    renderForm();
    renderStage();
    renderToolbar();
    paintDraft();
    prepareFrame();
  }

  function clear() {
    leaveDraft();
    hold = null;
    clearTimeout(prepareTimer);
    video = null;
    elements = [];
    selectedId = null;
    gesture = null;
    stageKey = layerKey = "";
    $("#layer-list").replaceChildren();
    stage.replaceChildren();
    stage.hidden = true;
    form.hidden = true;
    paintDraft();
  }

  function select(id, { reveal = false } = {}) {
    if (id !== selectedId) leaveDraft();
    selectedId = id;
    selection++;
    if (id) onSelect?.();
    resumeDraft();
    renderLayers();
    renderForm();
    renderStage();
    renderToolbar();
    paintDraft();
    prepareFrame();
    onChange?.();
    const element = selected();
    // Show the selected element: move the playhead into its time. An open
    // draft has its own time.
    if (
      reveal &&
      !draft &&
      element &&
      element.visibility !== "none" &&
      isReady()
    ) {
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

  // Text draft. The field on the video and the field in the panel are two
  // views of one draft. Only an apply sends a command, so one session is one
  // update and one undo step. The rules are in text-draft.js.

  function beginDraft(element, base = element) {
    const seconds = editTime(element, playhead());
    draft = { ...openDraft(video.id, base), seconds };
    if (!paused()) call("playback.pause").catch(() => {});
    if (seconds !== playhead()) moveTo(seconds);
    view.prepare(video, element.id, seconds);
  }

  // Continues from a save in progress: the new base is the text that it
  // saves. The reply of that save cannot end this session, and if it fails,
  // the guard of the next save reports it.
  function continueDraft(element) {
    if (!draft) return beginDraft(element);
    if (draft.state !== "saving") return;
    const text = draft.text;
    draft = null;
    beginDraft(element, { ...element, text });
  }

  function typed(value, source) {
    const element = selected();
    if (element?.type !== "text") return;
    continueDraft(element);
    draft = typeDraft(draft, value);
    for (const surface of [input, field])
      if (surface !== source && surface.value !== value) surface.value = value;
    checkFit({ ...element, text: value });
    paintDraft();
  }

  function openBox(element, point) {
    if (selectedId !== element.id) select(element.id);
    continueDraft(element);
    boxOpen = true;
    input.value = draft.text;
    paintDraft();
    renderStage({ force: true });
    input.focus({ preventScroll: true });
    const caret = point
      ? document.caretPositionFromPoint(point.x, point.y)
      : null;
    const offset =
      caret?.offsetNode === input ? caret.offset : input.value.length;
    input.setSelectionRange(offset, offset);
  }

  function closeBox() {
    if (!boxOpen) return;
    boxOpen = false;
    renderStage({ force: true });
  }

  function endDraft() {
    draft = null;
    closeBox();
    renderForm({ force: true });
    paintDraft();
  }

  // Sends the frozen intent of an apply. It runs in the page queue, so it
  // stays in order with other commands. Other pages can change the text, so
  // fresh reads the saved text in the same queued step and keeps the guard.
  function saveIntent(intent, fresh, seconds) {
    applied = { ...intent, seconds };
    const ended = () => {
      if (applied?.token === intent.token) applied = null;
      cancelled.delete(intent.token);
    };
    queue(async () => {
      if (cancelled.has(intent.token)) return;
      const { videoId: id, elementId, text } = intent;
      const list = fresh ? (await call("element.list", { id })).elements : [];
      const stored = list.find((e) => e.id === elementId);
      const result = await call("element.update", {
        id,
        elementId,
        text,
        expectedText: stored?.text ?? intent.baseText,
      });
      showVideo(result.video, id);
    }).then(
      () => {
        ended();
        if (draft?.token === intent.token) endDraft();
      },
      (error) => {
        ended();
        saveError(intent, readableError(error.message));
      },
    );
  }

  function saveError(intent, message) {
    if (draft?.token === intent.token) {
      draft = saveFailed(draft, message);
      notice(message, true);
      return paintDraft();
    }
    // The page left this session. A newer draft of the element stays as it
    // is, and its own save reports the conflict.
    const here = video?.id === intent.videoId;
    const exists =
      !here || elements.some((element) => element.id === intent.elementId);
    const newer =
      (draft?.videoId === intent.videoId &&
        draft.elementId === intent.elementId) ||
      parked.has(parkKey(intent.videoId, intent.elementId));
    if (exists && !newer)
      parked.set(
        parkKey(intent.videoId, intent.elementId),
        draftFromIntent(intent, message),
      );
    notice(
      exists
        ? `The text ${quoted(intent.text)} was not saved: ${message} Select its element to try again.`
        : `The text ${quoted(intent.text)} was not saved. Its element is gone.`,
      true,
    );
    resumeDraft();
    paintDraft();
  }

  function applyDraft({ fresh = false } = {}) {
    if (!draft || draft.state === "saving") return;
    const plan = applyPlan(draft);
    if (plan.kind === "none") return endDraft();
    if (plan.kind === "refuse") {
      draft = saveFailed(draft, plan.message);
      return paintDraft();
    }
    draft = startSave(draft);
    closeBox();
    paintDraft();
    saveIntent(plan.intent, fresh, draft.seconds);
  }

  // Cancel keeps the saved text. A save that did not start yet stays unsent.
  function cancelDraft() {
    if (!draft) return;
    if (draft.state === "saving") cancelled.add(draft.token);
    endDraft();
  }

  // The user goes to another element, tool, or video. An edit applies. A
  // failed draft waits for its element. A save in progress goes on.
  function leaveDraft() {
    if (draft?.state === "editing") applyDraft();
    if (!draft) return;
    if (draft.state === "failed") {
      const key = parkKey(draft.videoId, draft.elementId);
      if (!parked.has(key)) parked.set(key, draft);
      notice(
        `The text ${quoted(draft.text)} was not saved: ${draft.message} Select its element to try again.`,
        true,
      );
    }
    draft = null;
    closeBox();
  }

  function resumeDraft() {
    const key = parkKey(video?.id, selectedId);
    const element = selected();
    if (draft || !element || !parked.has(key)) return;
    const waiting = parked.get(key);
    parked.delete(key);
    beginDraft(element);
    draft = { ...waiting, seconds: draft.seconds };
    paintDraft();
  }

  // A saved change: an untouched session shows it, and a touched session
  // keeps its text. If the element is gone, the text must not vanish.
  function followDraft() {
    if (!draft || draft.videoId !== video.id) return;
    const element = elements.find((e) => e.id === draft.elementId);
    if (element) {
      draft = followSaved(draft, element);
      if (input.value !== draft.text) input.value = draft.text;
      return;
    }
    if (draft.state !== "saving" && draft.touched)
      notice(
        `The text ${quoted(draft.text)} was not saved. Its element is gone.`,
        true,
      );
    draft = null;
    closeBox();
  }

  // After a saved change of the selected text element, the images around it
  // are still valid. The draft view shows the change, from any client, until
  // the exact preview is ready. Any other change makes the images old. The
  // page calls this first, so it can keep the picture that is on the screen.
  function observe(next) {
    if (video?.id !== next.id) return;
    const id = applied?.videoId === next.id ? applied.elementId : selectedId;
    const before = elements.find((e) => e.id === id);
    const after = describeElements(next.timeline).find((e) => e.id === id);
    const same = (elementId) =>
      draftBaseRevision(video, elementId) ===
      draftBaseRevision(next, elementId);
    if (hold && !same(hold.id)) hold = null;
    if (
      before?.type !== "text" ||
      !after ||
      JSON.stringify(before) === JSON.stringify(after) ||
      !same(id)
    )
      return;
    hold = { id, seconds: draft?.seconds ?? applied?.seconds ?? playhead() };
  }

  function paintDraft() {
    const id = draft?.elementId ?? hold?.id;
    const element = elements.find((e) => e.id === id);
    if (hold && !elements.some((e) => e.id === hold.id)) hold = null;
    const moved =
      gesture?.moved && gesture.id === id ? gesture.current : hold?.moved;
    const bar = Boolean(draft) && draft.state !== "saving";
    editor.hidden = !bar && !boxOpen;
    input.hidden = !boxOpen;
    actions.hidden = !bar;
    if (bar) {
      const failed = draft.state === "failed";
      $("#draft-done").textContent = draft.conflict
        ? "Save my text"
        : failed
          ? "Try again"
          : "Done";
      $("#draft-cancel").textContent = failed ? "Discard" : "Cancel";
      problem.textContent = draft.message ?? liveProblem(draft.text) ?? "";
      problem.hidden = !problem.textContent;
    }
    const text = draft?.text ?? element?.text;
    view.paint(
      element
        ? {
            video,
            element: { ...element, ...moved },
            text,
            seconds: draft?.seconds ?? hold?.seconds ?? playhead(),
            baked: hasRenderedPicture(),
            show:
              Boolean(hold) ||
              Boolean(moved) ||
              text !== element.text ||
              draft?.state === "failed",
            // A drag does not need a plate. The outline shows the box.
            cleanOnly: Boolean(moved) && !draft,
          }
        : null,
    );
    onDraft?.();
  }

  // Asks for the images early, so a double-click normally finds them ready.
  function prepareFrame() {
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(() => {
      const element = selected();
      // A hold needs its own images, so it keeps them until it ends.
      if (element?.type === "text" && video && paused() && !draft && !hold)
        view.prepare(video, element.id, editTime(element, playhead()));
    }, PREPARE_MS);
  }

  function leaveSurface(event) {
    const next = event.relatedTarget;
    if (draft?.state !== "editing") return;
    // These controls are part of the session.
    if ([input, field, editButton].includes(next) || actions.contains(next))
      return;
    // Another window: the user can come back and type on.
    if (!document.hasFocus()) return;
    applyDraft();
  }

  function surfaceKey(event) {
    if (!draft || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelDraft();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      applyDraft();
    }
  }

  // A text field pastes plain text. This only cleans characters that the
  // shared command refuses. execCommand keeps the native undo of the paste.
  function surfacePaste(event) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text || cleanPaste(text) === text.replace(/\r\n?/g, "\n")) return;
    event.preventDefault();
    document.execCommand("insertText", false, cleanPaste(text));
  }

  for (const surface of [field, input]) {
    surface.addEventListener("input", () => typed(surface.value, surface));
    surface.addEventListener("keydown", surfaceKey);
    surface.addEventListener("blur", leaveSurface);
    surface.addEventListener("paste", surfacePaste);
  }
  // A press on the controls does not take focus from the text, so Cancel
  // runs without a blur that saves first. From the keyboard, Tab reaches them
  // as part of the session, and app shortcuts do not run on them.
  for (const control of [actions, editButton]) {
    control.addEventListener("mousedown", (event) => event.preventDefault());
    control.addEventListener("focusout", leaveSurface);
  }
  actions.addEventListener("keydown", (event) => {
    surfaceKey(event);
    event.stopPropagation();
  });
  editButton.addEventListener("keydown", surfaceKey);
  $("#draft-done").addEventListener("click", () =>
    applyDraft({ fresh: draft?.conflict }),
  );
  $("#draft-cancel").addEventListener("click", cancelDraft);
  editButton.addEventListener("click", () => {
    const element = selected();
    if (element?.type === "text") openBox(element);
  });
  stage.addEventListener("dblclick", (event) => {
    const { clientX: x, clientY: y } = event;
    const id = document.elementFromPoint(x, y)?.closest?.(".stage-item")
      ?.dataset.id;
    const element = elements.find((e) => e.id === id);
    if (element?.type === "text") openBox(element, { x, y });
  });
  // A gesture does not change the focus or select page text, and a press in
  // the open box keeps the focus in its field. This is on mousedown and not on
  // pointerdown, because a cancelled pointerdown also ends dblclick.
  stage.addEventListener("mousedown", (event) => {
    const id = event.target.closest?.(".stage-item")?.dataset.id;
    const inBox = boxOpen && id === draft?.elementId;
    if (gesture || inBox) event.preventDefault();
    if (inBox) input.focus({ preventScroll: true });
  });

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
    // Writing the same value would move the caret.
    const text = draft?.elementId === element.id ? draft.text : element.text;
    if (element.type === "text" && field.value !== text) field.value = text;
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
    checkFit({ ...element, text });
  }

  // The box cuts text that is larger than it, in the video and in the draft.
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
        `The text is larger than its box (${Math.round(Math.max(fit.widthRatio, fit.heightRatio) * 100)}% of the box). In the video, the box cuts it. Make the text smaller, add line breaks, or make the box larger.`;
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
    view.layout(rect);
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
    const key = JSON.stringify([selectedId, boxOpen, shown]);
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
    if (element.type === "text") item.title = "Double-click to edit the text";
    const editing = boxOpen && draft?.elementId === element.id;
    item.classList.toggle("editing", editing);
    item.addEventListener("pointerdown", (event) =>
      begin(event, element, "move"),
    );
    if (active && !editing)
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
    event.stopPropagation();
    // In the open box, the pointer belongs to the text.
    if (boxOpen && draft?.elementId === element.id) return;
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
      moved: false,
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
    const { width, height } = stage.getBoundingClientRect();
    if (
      mode === "move" &&
      !gesture.moved &&
      Math.hypot(dx * width, dy * height) < DRAG_PIXELS
    )
      return;
    gesture.moved = true;
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

  // Show the gesture on the outline, and on a text draft if its images are
  // ready. The video does not render until the gesture ends.
  function draw(value) {
    if (gesture.type === "text") paintDraft();
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
    // A click changes nothing. The item under the pointer must stay, or
    // Chromium does not send click and dblclick.
    if (!done.moved) return;
    const changes = changedKeys(done.origin, done.current);
    if (!Object.keys(changes).length || video?.id !== done.videoId) {
      paintDraft();
      return renderStage({ force: true });
    }
    // The text stays at its new place until the reply of the save. Then the
    // saved values take over.
    if (done.type === "text")
      hold = { id: done.id, seconds: playhead(), moved: done.current };
    paintDraft();
    command("element.update", { elementId: done.id, ...changes }).finally(
      () => {
        if (!hold?.moved) return;
        hold = null;
        paintDraft();
      },
    );
  }

  // Escape or a lost pointer cancels the gesture. Nothing is saved.
  function cancelGesture() {
    if (!gesture) return false;
    release();
    gesture = null;
    renderStage({ force: true });
    paintDraft();
    return true;
  }

  return {
    render,
    clear,
    layout: () => {
      layout();
      renderStage();
      prepareFrame();
    },
    timeChanged: () => {
      if (!gesture) renderStage();
    },
    selected: () => selectedId,
    // The picture of the draft view, for the status: clean, plate, plain, or
    // null when the exact preview shows.
    draftMode: () => view.mode(),
    // A session is open: an exact render waits, and playback must not move
    // under its still picture.
    typing: () => Boolean(draft),
    // A change is on the picture, and its exact preview is not ready.
    holding: () => Boolean(hold),
    observe,
    // The page has a text that is not saved in this video.
    unsaved: () =>
      (Boolean(draft) && draft.text !== draft.base) ||
      [...parked.keys()].some((key) => key.startsWith(`${video?.id}/`)),
    // The exact preview of the current edits is on the screen.
    exactShown: () => {
      hold = null;
      paintDraft();
    },
    editSelected: () => {
      const element = selected();
      if (element?.type === "text") openBox(element);
    },
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
