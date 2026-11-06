import {
  duration,
  isEdited,
  sourceTime,
  splitCheck,
  timelineParts,
  videoFades,
} from "../domain/timeline.js";
import {
  editRevision,
  structureRevision,
  timingRevision,
} from "../domain/inspection.js";
import { recordedSeconds } from "../domain/recording.js";
import { createElementEditor } from "./element-editor.js";
import { createCaptionEditor } from "./caption-editor.js";
import { createPartsPanel } from "./parts-panel.js";
import { createRangePlayer } from "./range-player.js";
import { createShortcutSettings } from "./shortcut-settings.js";
import { createTools } from "./tools.js";
import { createTimeline } from "./timeline.js";
import { createTranscriptEditor } from "./transcript-editor.js";
import { cutNotice } from "./transcript-view.js";
import {
  clock,
  clockTenths,
  libraryView,
  exportRows,
  finishedExports,
  recordingView,
  readableError,
  playbackBlock,
  playheadValue,
  rangeCheck,
  saveState,
  shortcut,
} from "./view-model.js";
const $ = (selector) => document.querySelector(selector);
// Commands that change saved edits. The top bar shows their true state.
const SAVED_EDIT =
  /^(edit\.|element\.(add|update|remove|duplicate|order)$|captions\.(add|update|delete|configure|remove|apply)$|library\.rename$|transcript\.cut$)/;
// Each state belongs to one video, so a late reply cannot change the state of
// another open video.
const pendingEdits = new Map(),
  failedEdits = new Set();
const PREVIEW_WAIT_MS = 300;
function call(name, args = {}, id = args.id) {
  const result = window.midnight.execute(name, args);
  if (!SAVED_EDIT.test(name)) return result;
  pendingEdits.set(id, (pendingEdits.get(id) ?? 0) + 1);
  renderSaveState();
  const done = (failed) => {
    const left = pendingEdits.get(id) - 1;
    if (left) pendingEdits.set(id, left);
    else pendingEdits.delete(id);
    if (failed) failedEdits.add(id);
    else failedEdits.delete(id);
    renderSaveState();
  };
  return result.then(
    (value) => {
      done(false);
      return value;
    },
    (error) => {
      done(true);
      throw error;
    },
  );
}
let selectedVideo,
  sources = [],
  currentRecording = "idle",
  busy = false,
  lastLibrary = "",
  librarySequence = 0,
  statusTimer,
  previewKey = "",
  previewReady = false,
  viewGeneration = 0,
  previewError = null,
  rangeKey = "",
  lastJobs = [],
  recordingDisplay = recordingView(),
  // The playhead time to use again after an edit loads a new preview.
  resumeAt = 0,
  // The join after a cut of a part or of words. The playhead goes there, so the
  // user can check the join at once.
  pendingResume = null,
  previewVideoId = "",
  // What owns the draft selection: a part or selected words. Null for a manual
  // draft. Dock Keep and Remove then use the guarded command of the owner.
  rangeOwner = null,
  rangeEpoch = 0,
  writingRange = false,
  // The state of the exact preview. A draft view can show over it.
  exactState = ["Preview ready", "ready", "Preview ready."],
  previewTimer;
let lastRecordingError;
const loadedAt = Date.now();
// The service keeps the timing fields. A reloaded page reads the same values.
let lastRecording = { state: "idle" };
const knownExports = new Map();
const seconds = (video) => duration(video.timeline);
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function notice(message, error = false) {
  // Command errors arrive with an Electron transport prefix. Show only the
  // message from the service.
  $("#message-text").textContent = readableError(message);
  $("#message").classList.toggle("error", error);
  $("#message").hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(
    () => {
      $("#message").hidden = true;
    },
    error ? 12000 : 7000,
  );
}
$("#message-close").addEventListener("click", () => {
  clearTimeout(statusTimer);
  $("#message").hidden = true;
});
window.midnight.onNotice((message) => notice(message));
window.midnight.onRecording((recording) => renderRecording(recording));
let activeRun = Promise.resolve(),
  shortcutQueue = Promise.resolve();
// Runs one page action at a time. A second click during an action is ignored.
function run(action) {
  if (busy) return Promise.resolve();
  busy = true;
  document.body.classList.add("is-busy");
  activeRun = (async () => {
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
      document.body.classList.remove("is-busy");
    }
  })();
  return activeRun;
}
// Keys and timeline selections wait for the current action. They are not lost.
function enqueue(action) {
  shortcutQueue = shortcutQueue.then(async () => {
    while (busy) await activeRun;
    await run(action);
  });
}
function handle(selector, event, action) {
  $(selector).addEventListener(event, () => run(action));
}
// Like enqueue, but the caller gets the result or the error.
function queued(action) {
  return new Promise((resolve, reject) =>
    enqueue(async () => {
      try {
        resolve(await action());
      } catch (error) {
        reject(error);
      }
    }),
  );
}
const playhead = () => (previewReady ? $("#player").currentTime : resumeAt);
// The size of the frame on screen: the rendered preview, the source frame
// while the preview is prepared, or the library size.
function frameSize() {
  for (const media of [$("#player"), $("#source-frame")])
    if (media.videoWidth && media.videoHeight && media.getAttribute("src"))
      return { width: media.videoWidth, height: media.videoHeight };
  const { width, height } = selectedVideo?.metadata || {};
  return width && height ? { width, height } : null;
}
// The picture on the screen is a rendered frame, with its elements in it.
function hasRenderedPicture() {
  const player = $("#player");
  return (
    Boolean(player.getAttribute("src")) &&
    player.readyState >= 2 &&
    $("#source-frame").hidden
  );
}
// A command result can arrive after the user opened another video. Show it
// only if its video is still open. Element and caption results use this
// check.
function showVideo(video, id) {
  if (selectedVideo?.id === id) renderVideo(video);
}
const seek = (seconds) =>
  call("playback.seek", { seconds }).catch((error) =>
    notice(error.message, true),
  );
// Moves the playhead for a text session. This is local to the page, because
// the shared seek waits for the session to end. Without a loaded preview, the
// time is the time that the next preview resumes at.
function moveTo(seconds) {
  if (previewReady) $("#player").currentTime = seconds;
  else {
    resumeAt = seconds;
    if (!$("#source-frame").hidden) showSourceFrame(selectedVideo);
  }
  showTime();
}
// The editing tools. A tool change only changes the page. It also makes a
// pending add result unable to select, so a late result cannot change the
// tool that the user opened. The current selection stays.
const tools = createTools({
  onChange: (name) => {
    editor.invalidate();
    captions.invalidate();
    if (name === "transcript") transcript.opened();
  },
});
// Show the properties of a new selection in the edit panel. The panel
// scrolls only if the properties are not already in view.
function reveal(selector) {
  const node = $(selector),
    panel = $("#tool-panels");
  if (!node || node.closest("[hidden]")) return;
  const { top, bottom } = panel.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  if (box.top < top || box.top > bottom - 160)
    panel.scrollTop += box.top - top - 8;
}
// A user selection shows its tool: the selected element or caption.
// A pointer selection starts at pointerdown, before the click. A scroll of
// the panel at that time moves the row under the pointer, so the click
// would not occur, for example the first-click seek of a caption row. So
// the panel scrolls after the pointer is released.
let pointerDown = false,
  pendingReveal = null;
document.addEventListener("pointerdown", () => (pointerDown = true), true);
for (const type of ["pointerup", "pointercancel"])
  document.addEventListener(
    type,
    () => {
      pointerDown = false;
      const selector = pendingReveal;
      pendingReveal = null;
      // After the click that this release makes.
      if (selector) setTimeout(() => reveal(selector));
    },
    true,
  );
function showSelection(tool, selector) {
  tools.show(tool);
  if (pointerDown) pendingReveal = selector;
  // After the editor shows the properties of the new selection.
  else queueMicrotask(() => reveal(selector));
}
const editor = createElementEditor({
  $,
  call,
  queue: queued,
  notice,
  showVideo,
  playhead,
  seek,
  moveTo,
  isReady: () => previewReady,
  hasRenderedPicture,
  paused: () => $("#player").paused,
  frameSize,
  // One selection at a time: an element or a caption.
  onSelect: () => {
    captions.deselect();
    showSelection("elements", "#element-heading");
  },
  onChange: () => timeline.renderLanes(),
  onDraft: () => {
    renderPreviewState();
    renderSaveState();
  },
});
const captions = createCaptionEditor({
  $,
  call,
  queue: queued,
  notice,
  showVideo,
  playhead,
  seek,
  isReady: () => previewReady,
  range: () => checkRange(),
  selectRange: (start, end) =>
    writeRange({ start: String(start), end: String(end) }),
  onSelect: () => {
    editor.deselect();
    showSelection("captions", "#caption-form");
  },
  onChange: () => timeline.renderLanes(),
});
const rangePlayer = createRangePlayer({
  player: $("#player"),
  call,
  onChange: () => transcript.renderFooter(),
});
const transcript = createTranscriptEditor({
  $,
  call,
  notice,
  playhead,
  seek,
  isReady: () => previewReady,
  isOpen: () => tools.active() === "transcript",
  range: rangePlayer,
  draft: {
    // A word selection is the draft selection, with all digits. A manual
    // change ends it. See setOwner.
    show: (selection, { jobId, timing }) =>
      writeRange(
        { start: String(selection.start), end: String(selection.end) },
        {
          kind: "words",
          videoId: selectedVideo.id,
          jobId,
          timing,
          from: selection.from,
          to: selection.to,
          label: `${selection.keptWords} word${selection.keptWords === 1 ? "" : "s"}`,
        },
      ),
    clear: () => {
      if (rangeOwner?.kind === "words") clearRange();
    },
  },
  onCut: (video, selection, id) => {
    if (selectedVideo?.id !== id) return;
    pendingResume = selection.start;
    renderVideo(video);
    notice(cutNotice(selection, video.captionPlacement));
    return refreshLibrary();
  },
});
const parts = createPartsPanel({
  $,
  select: (row) => selectPart(row, { seekTo: true }),
  keep: (row) => run(() => partEdit("keepPart", row)),
  remove: (row) => run(() => partEdit("removePart", row)),
  join: (row) =>
    run(() =>
      edit("unsplit", {
        splitId: row.splitAfter,
        revision: structureRevision(selectedVideo),
      }),
    ),
});
// Moves the playhead for a click on the timeline. It waits for the current
// action, so the click is not lost.
function seekFromTimeline(time) {
  if (!selectedVideo) return;
  if (!previewReady) {
    notice("Wait for the preview. Then select a point on the timeline.");
    return;
  }
  const id = selectedVideo.id;
  enqueue(async () => {
    if (selectedVideo?.id !== id || !previewReady) return;
    await call("playback.seek", { seconds: time });
  });
}
// A drag on the ruler sends many times. One seek runs at a time, and only the
// latest time waits. A waiting time belongs to its view and its time mapping,
// so it cannot move another video, or a video that a trim or cut changed.
let scrubTarget = null,
  scrubbing = false;
async function scrub(time) {
  if (!selectedVideo) return;
  scrubTarget = { time, timing: rangeKey, view: viewGeneration };
  if (scrubbing) return;
  scrubbing = true;
  while (scrubTarget) {
    const target = scrubTarget;
    scrubTarget = null;
    if (target.timing !== rangeKey || target.view !== viewGeneration) continue;
    await call("playback.seek", { seconds: target.time }).catch(() => {});
  }
  scrubbing = false;
}
const timeline = createTimeline({
  $,
  call,
  seek: seekFromTimeline,
  scrub,
  isReady: () => previewReady,
  playhead,
  range: {
    read: () => checkRange(),
    fields: () => ({
      start: $("#range-start").value,
      end: $("#range-end").value,
      owner: rangeOwner,
    }),
    write: (values) => writeRange(values),
    // A cancelled drag returns the selection from before it. Selected words
    // return with their owner, or the owner does not return.
    restore: ({ owner, ...values }) => {
      writeRange(values, owner);
      if (owner?.kind === "words" && !transcript.restoreSelection(owner))
        rangeOwner = null;
    },
  },
  parts: {
    selectable: () => partSelectable(),
    click: (time) => selectPartAt(time),
  },
  items: {
    elements: () => editor.timelineItems(),
    captions: () => captions.timelineItems(),
    limits: (id) => captions.limits(id),
    select: (kind, id, options) =>
      (kind === "caption" ? captions : editor).selectItem(id, options),
    commit: (kind, id, changes) =>
      (kind === "caption" ? captions : editor).setTimes(id, changes),
  },
});
$("#selection-chip").addEventListener("click", () => tools.show("trim"));
$("#selection-clear").addEventListener("click", () => clearRange());
$("#export-progress").addEventListener("click", () => tools.show("details"));
async function refreshSources() {
  sources = await call("capture.sources");
  const before = $("#source").value;
  $("#source").replaceChildren(
    ...sources.map((source) => new Option(source.name, source.id)),
  );
  if (sources.some((s) => s.id === before)) $("#source").value = before;
  updateSource();
  const devices = await call("capture.devices");
  for (const [id, kind] of [
    ["microphone", "audioinput"],
    ["camera", "videoinput"],
  ]) {
    const value = $("#" + id).value;
    $("#" + id).replaceChildren(
      new Option("Off", ""),
      ...devices
        .filter((d) => d.kind === kind)
        .map((d) => new Option(d.name, d.id || "default")),
    );
    if ([...$("#" + id).options].some((o) => o.value === value))
      $("#" + id).value = value;
  }
}
function updateSource() {
  const preview = $("#source-preview");
  const source = sources.find((s) => s.id === $("#source").value);
  const placeholder = (symbol, text) => {
    preview.replaceChildren(
      element("span", "", symbol),
      element("p", "", text),
    );
  };
  preview.dataset.kind = $("#camera-only").checked ? "camera" : "source";
  if ($("#camera-only").checked)
    return placeholder(
      "◉",
      "Camera only. The app records the camera and not the screen.",
    );
  const fallback = () =>
    placeholder(
      "▣",
      source ? "Preview unavailable" : "Select a screen or window",
    );
  if (source?.thumbnail) {
    const image = document.createElement("img");
    image.onerror = fallback;
    image.src = source.thumbnail;
    image.alt = source.name;
    preview.replaceChildren(image);
  } else fallback();
}
function videoCard(video) {
  const card = element("button", "video-card");
  card.dataset.id = video.id;
  card.title = video.title;
  const cover = element("div", "video-cover");
  const icon = element("span", "cover-icon", "▶");
  icon.setAttribute("aria-hidden", "true");
  const preview = document.createElement("video");
  // Show a frame after the start. Many recordings start with a black frame.
  const frame = Math.min(1, video.metadata.duration / 2);
  preview.src = `${video.url}#t=${frame.toFixed(2)}`;
  preview.muted = true;
  preview.preload = "metadata";
  preview.tabIndex = -1;
  preview.setAttribute("aria-hidden", "true");
  cover.append(
    icon,
    preview,
    element("span", "duration", clock(seconds(video))),
  );
  if (isEdited(video.timeline, video.metadata.duration))
    cover.append(element("span", "edited-badge", "Edited"));
  const body = element("div", "card-body");
  const date = new Date(video.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const size =
    video.metadata.width && video.metadata.height
      ? ` · ${video.metadata.width} × ${video.metadata.height}`
      : "";
  body.append(
    element("strong", "card-title", video.title),
    element("span", "card-meta", date + size),
  );
  card.append(cover, body);
  card.addEventListener("click", () =>
    openVideo(video.id, { focus: true }).catch((error) =>
      notice(error.message, true),
    ),
  );
  return card;
}
async function refreshLibrary() {
  const request = ++librarySequence;
  const query = $("#search").value.trim();
  const all = await call("library.list");
  const videos = query ? await call("library.list", { query }) : all;
  if (request !== librarySequence) return;
  const key = JSON.stringify([query, all.length, videos]);
  if (key === lastLibrary) return;
  lastLibrary = key;
  const view = libraryView({
    total: all.length,
    shown: videos.length,
    query,
  });
  $("#video-total").textContent = view.caption;
  $("#library-count").textContent = all.length;
  $("#empty").hidden = !view.empty;
  if (view.empty) {
    $("#empty").dataset.kind = view.empty.kind;
    $("#empty-icon").textContent = view.empty.kind === "search" ? "⌕" : "▷";
    $("#empty-title").textContent = view.empty.title;
    $("#empty-text").textContent = view.empty.text;
    $("#clear-search").hidden = view.empty.kind !== "search";
  }
  $("#videos").replaceChildren(...videos.map(videoCard));
}
function clearSearch() {
  $("#search").value = "";
  return refreshLibrary();
}
function showLibrary({ restoreFocus = false } = {}) {
  const previous = selectedVideo?.id;
  viewGeneration++;
  $("#player").pause();
  showEditorFrame(false);
  $("#crumb").textContent = "Video library";
  selectedVideo = null;
  previewKey = "";
  previewReady = false;
  rangeKey = "";
  rangeOwner = null;
  pendingResume = null;
  resumeAt = 0;
  previewVideoId = "";
  rangePlayer.stop();
  editor.clear();
  captions.clear();
  transcript.clear();
  timeline.clear();
  failedEdits.delete(previous);
  hideSourceFrame();
  $(".player-shell").classList.remove("fullscreen");
  if (restoreFocus) {
    const card = [...document.querySelectorAll(".video-card")].find(
      (item) => item.dataset.id === previous,
    );
    (card || $("#search")).focus();
  }
}
// The editor is a focused workspace: the library sidebar and the page heading
// do not show. The top bar has the title and the editor actions.
function showEditorFrame(open) {
  document.body.classList.toggle("editing", open);
  $("#editor").hidden = !open;
  $("#library-view").hidden = open;
  $("#breadcrumb").hidden = open;
  $("#local-badge").hidden = open;
  for (const id of ["#editor-heading", "#editor-status", "#editor-actions"])
    $(id).hidden = !open;
}
function focusRecorder() {
  const recorder = $("#recorder");
  recorder.classList.remove("attention");
  void recorder.offsetWidth;
  recorder.classList.add("attention");
  const target = ["#stop", "#pause", "#cancel-recording", "#record-title"]
    .map($)
    .find((item) => !item.disabled && item.offsetParent !== null);
  (target || recorder).focus();
}
function showView(view, options) {
  showLibrary(options);
  if (view === "recorder") focusRecorder();
}
async function openVideo(id, { focus = false } = {}) {
  const generation = ++viewGeneration;
  const video = await call("library.get", { id });
  if (generation !== viewGeneration) return;
  renderVideo(video);
  if (focus) $("#video-title").focus();
}
function previewStatus(text, state, detail = text) {
  exactState = [text, state, detail];
  renderPreviewState();
}
// The state of the picture on the screen. A text draft is an approximation of
// a change that the exact preview does not have yet, so the page never calls
// it ready.
function renderPreviewState() {
  const mode = editor.draftMode();
  const [text, state, detail] =
    mode && editor.typing()
      ? [
          "Draft view",
          "draft",
          "This text is a draft. It is close to the video, but it is not exact. The exact preview renders after you apply it.",
        ]
      : mode && exactState[1] === "ready"
        ? [
            "Draft view",
            "draft",
            "This text is a draft until the exact preview is ready.",
          ]
        : exactState;
  const node = $("#preview-state");
  if (node.textContent !== text) node.textContent = text;
  node.dataset.state = state;
  node.title =
    mode && state === "preparing"
      ? `${detail} Until then, the text on the picture is a draft.`
      : detail;
  renderStageNote(mode);
}
function renderStageNote(mode) {
  const note = $("#stage-note");
  const text =
    mode === "plate"
      ? "The clean frame is not ready. A plate covers the old text."
      : mode === "clean" || $("#source-frame").hidden
        ? ""
        : "Preparing the preview. This picture is the original video without elements. Outlines show the elements.";
  if (note.textContent !== text) note.textContent = text;
  note.hidden = !text;
}
// The true state of the edits: a command in progress, a field that is not
// saved yet, or a rejected change. A draft selection is not an edit.
function renderSaveState() {
  const title = $("#rename-title").value.trim();
  const view = saveState({
    saving: pendingEdits.has(selectedVideo?.id),
    failed: failedEdits.has(selectedVideo?.id),
    dirty:
      Boolean($("#editor [data-dirty='1']")) ||
      editor.unsaved() ||
      (Boolean(selectedVideo) &&
        Boolean(title) &&
        title !== selectedVideo.title),
  });
  const node = $("#save-state");
  if (node.textContent !== view.text) node.textContent = view.text;
  node.dataset.state = view.state;
  node.title = view.detail;
}
$("#editor").addEventListener("input", renderSaveState);
$("#editor").addEventListener("change", renderSaveState);
function renderVideoInfo(video) {
  const parts = [
    element("span", "", `${video.metadata.width} × ${video.metadata.height}`),
  ];
  if (video.metadata.hasAudio === false)
    parts.push(element("span", "", "No sound"));
  parts.push(
    isEdited(video.timeline, video.metadata.duration)
      ? element(
          "span",
          "chip edited",
          `Edited from ${clock(video.metadata.duration)}`,
        )
      : element("span", "chip", "Original"),
  );
  $("#video-info").replaceChildren(...parts);
}
function renderVideo(video) {
  // A video opens with Trim & cut. A new state of the open video, for
  // example after an edit or a status update, keeps the user's tool.
  if (selectedVideo?.id !== video.id) {
    tools.show("trim");
    failedEdits.delete(video.id);
    rangePlayer.stop();
  }
  selectedVideo = video;
  const id = video.id;
  showEditorFrame(true);
  $("#crumb").textContent = "Video editor";
  $("#video-title").textContent = video.title;
  $("#video-title").title = video.title;
  const title = $("#rename-title");
  if (title.dataset.videoId !== id || title.value === title.dataset.rendered)
    title.value = video.title;
  title.dataset.videoId = id;
  title.dataset.rendered = video.title;
  updateRenameState();
  $("#delete-name").textContent = video.title;
  renderVideoInfo(video);
  const player = $("#player");
  editor.observe(video);
  // The revision includes elements, so an element change loads a new preview.
  const key = id + editRevision(video);
  if (previewKey !== key) {
    // An edit keeps the playhead time. Another video starts at 0. A cut of a
    // part or of words goes to its join.
    rangePlayer.stop();
    if (previewVideoId !== id) resumeAt = 0;
    else if (pendingResume !== null) resumeAt = pendingResume;
    else if (previewReady) resumeAt = player.currentTime;
    pendingResume = null;
    previewVideoId = id;
    previewKey = key;
    previewReady = false;
    previewError = null;
    player.dataset.original = "false";
    player.pause();
    // A saved text change stays on the picture. The old frame has all other
    // layers, so it stays under the draft until the next preview replaces it.
    const keepFrame = editor.holding() && player.getAttribute("src");
    if (!keepFrame) {
      player.removeAttribute("src");
      player.load();
    }
    if (!isEdited(video.timeline, video.metadata.duration)) {
      hideSourceFrame();
      setPreview(video.url, true);
    } else {
      previewStatus(
        "Preparing preview",
        "preparing",
        "Preparing the edited preview. You can continue to edit.",
      );
      if (!keepFrame) showSourceFrame(video);
      startPreview(video, key);
    }
  }
  const total = seconds(video);
  // The selection times are edited times. They stay after an element,
  // caption, style, or title change. A trim, cut, or speed change moves the
  // edited times, and another video has other times: then the selection is
  // the full video again.
  const { segments, speed } = video.timeline;
  const timing = id + JSON.stringify([segments, speed]);
  if (rangeKey !== timing) {
    rangeKey = timing;
    rangeOwner = null;
    $("#range-start").value = 0;
    $("#range-end").value = total;
  }
  updatePartOwner(video);
  $("#range-start").max = total;
  $("#range-end").max = total;
  $("#speed").value = video.timeline.speed;
  $("#mute").checked = video.timeline.muted;
  const silent = video.metadata.hasAudio === false;
  $("#mute").disabled = silent && !video.timeline.muted;
  $("#no-audio").hidden = !silent;
  $("#undo").disabled = !video.timeline.past.length;
  $("#redo").disabled = !video.timeline.future.length;
  $("#duration").textContent = clock(total);
  timeline.render(video);
  renderRange();
  renderExports();
  renderVideoFades(video);
  editor.render(video);
  captions.render(video);
  transcript.render(video);
  parts.render(video, selectedPartId());
  timeline.renderLanes();
  syncPreview();
  renderSaveState();
}
function renderVideoFades(video) {
  const fades = videoFades(video.timeline);
  for (const [id, key] of [
    ["#video-fade-in", "fadeIn"],
    ["#video-fade-out", "fadeOut"],
  ]) {
    const input = $(id);
    if (input !== document.activeElement || !input.dataset.dirty)
      input.value = String(fades[key]);
  }
  const shortened =
    fades.actualFadeIn !== fades.fadeIn ||
    fades.actualFadeOut !== fades.fadeOut;
  $("#video-fade-note").classList.toggle("warn", shortened);
  $("#video-fade-note").textContent = shortened
    ? `The video is shorter than both fades together. The video uses ${fades.actualFadeIn} s and ${fades.actualFadeOut} s.`
    : "The picture and the sound fade together. These are the only video effects. There are no crossfades between clips.";
}
for (const [id, key] of [
  ["#video-fade-in", "fadeIn"],
  ["#video-fade-out", "fadeOut"],
]) {
  const input = $(id);
  input.addEventListener("input", () => (input.dataset.dirty = "1"));
  const commit = () => {
    input.dataset.dirty = "";
    const value = Number(input.value);
    if (!selectedVideo) return;
    if (input.value.trim() === "" || !Number.isFinite(value)) {
      notice("Enter a number of seconds.", true);
      return renderVideoFades(selectedVideo);
    }
    if (value === (selectedVideo.timeline[key] ?? 0)) return;
    run(async () => {
      try {
        await edit("configure", { [key]: value });
      } catch (error) {
        renderVideoFades(selectedVideo);
        throw error;
      }
    });
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commit();
  });
}
// While the edited preview renders, the player shows the source frame at
// the playhead without elements. The stage shows element outlines. The
// rendered preview replaces this picture when it is ready. A draft view can
// cover this picture with a true picture of the frame.
function showSourceFrame(video) {
  const frame = $("#source-frame");
  const total = seconds(video);
  if (frame.getAttribute("src") !== video.url) frame.src = video.url;
  frame.currentTime = sourceTime(video.timeline, Math.min(resumeAt, total));
  frame.hidden = false;
  renderStageNote(editor.draftMode());
}
function hideSourceFrame() {
  $("#source-frame").hidden = true;
  renderStageNote(editor.draftMode());
}
$("#source-frame").addEventListener("error", () => {
  $("#source-frame").hidden = true;
});
$("#source-frame").addEventListener("loadedmetadata", () => editor.layout());
function setPreview(url, original = false) {
  const player = $("#player");
  player.dataset.original = String(original);
  player.src = url;
  player.playbackRate = 1;
  player.muted = selectedVideo.timeline.muted;
  player.currentTime = Math.min(resumeAt, seconds(selectedVideo));
  previewReady = false;
  previewStatus("Loading preview", "preparing");
  syncPreview();
}
// A render is long, so text edits start as few as possible. A draft view keeps
// the picture true, so a short wait costs nothing, and quick changes start one
// render. Nothing renders during a text session. A render that already runs
// goes on, and its result stays in the cache for Undo.
function startPreview(video, key) {
  clearTimeout(previewTimer);
  const start = () => {
    if (previewKey !== key) return;
    if (editor.typing()) previewTimer = setTimeout(start, PREVIEW_WAIT_MS);
    else preparePreview(video, key);
  };
  if (editor.holding() || editor.typing())
    previewTimer = setTimeout(start, PREVIEW_WAIT_MS);
  else Promise.resolve().then(start);
}
async function preparePreview(video, key) {
  try {
    const started = await call("preview.start", {
      id: video.id,
      revision: editRevision(video),
    });
    let job = started;
    while (job.state === "running") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      job = await call("export.status", { jobId: started.id });
      if (!selectedVideo || previewKey !== key) return;
    }
    if (job.state === "failed") throw new Error(job.error);
    if (selectedVideo && previewKey === key) setPreview(job.result.url);
  } catch (error) {
    if (selectedVideo && previewKey === key) {
      previewError = error.message;
      previewStatus("Preview failed", "failed", error.message);
      notice(error.message, true);
    }
  }
}
const playbackState = () => ({
  ready: previewReady,
  typing: editor.typing(),
  holding: editor.holding(),
});
window.midnight.onPlayback(async ({ id, action, args }) => {
  try {
    const player = $("#player");
    if (action === "open") {
      viewGeneration++;
      renderVideo(args.video);
    } else if (action === "view") {
      showView(args.view);
    } else if (action === "fullscreen" && !args.enabled) {
      $(".player-shell").classList.remove("fullscreen");
    } else {
      if (!selectedVideo)
        throw new Error("Open a video before you control playback.");
      const blocked = playbackBlock(action, playbackState());
      if (blocked) throw new Error(blocked);
      if (action === "seek") {
        if (args.seconds > seconds(selectedVideo))
          throw new Error("Seek time is outside the edited range.");
        player.currentTime = args.seconds;
      }
      if (action === "play") await player.play();
      if (action === "pause") player.pause();
      if (action === "configure") player.volume = args.volume;
      if (action === "fullscreen")
        $(".player-shell").classList.toggle("fullscreen", args.enabled);
    }
    window.midnight.playbackReply({
      id,
      result: {
        videoId: selectedVideo?.id || null,
        paused: player.paused,
        volume: player.volume,
        muted: player.muted,
        // Ready means that a client can play the picture on the screen, by
        // the same rule as a play command.
        ready: !playbackBlock("play", playbackState()),
        error: previewError,
        seconds: selectedVideo ? player.currentTime : 0,
        duration: selectedVideo ? seconds(selectedVideo) : 0,
      },
    });
  } catch (error) {
    window.midnight.playbackReply({ id, error: error.message });
  }
});
function syncPreview() {
  if (!selectedVideo) return;
  const player = $("#player");
  const playing = !player.paused;
  $("#preview-play use").setAttribute("href", playing ? "#i-pause" : "#i-play");
  $("#preview-play").setAttribute(
    "aria-label",
    playing ? "Pause preview" : "Play preview",
  );
  $("#preview-play").disabled = !previewReady;
  showTime();
  $("#preview-volume").value = player.volume;
  $("#range-start-now").disabled = !previewReady;
  $("#range-end-now").disabled = !previewReady;
  renderSplit();
  const fullscreen = $(".player-shell").classList.contains("fullscreen");
  const label = fullscreen ? "Exit fullscreen" : "Fullscreen";
  $("#preview-fullscreen").setAttribute("aria-label", label);
  $("#preview-fullscreen").title = shortcutSettings.label("fullscreen", label);
  $("#preview-fullscreen use").setAttribute(
    "href",
    fullscreen ? "#i-fullscreen-exit" : "#i-fullscreen",
  );
  editor.layout();
  captions.timeChanged();
  transcript.timeChanged();
}
// The Split button uses the same check as the command. The tip tells why it is
// not available.
function renderSplit() {
  const button = $("#split");
  const time = $("#player").currentTime;
  const check = previewReady
    ? splitCheck(selectedVideo.timeline, time)
    : {
        ok: false,
        reason: "Wait for the preview. Then split at the playhead.",
      };
  button.disabled = !check.ok;
  button.title = check.ok
    ? shortcutSettings.label(
        "split",
        `Split at ${clockTenths(time)}. This makes two parts and removes no time.`,
      )
    : check.reason;
}
function splitAtPlayhead() {
  if (!selectedVideo || !previewReady) return;
  const seconds = $("#player").currentTime;
  const check = splitCheck(selectedVideo.timeline, seconds);
  if (!check.ok) return notice(check.reason);
  return edit("split", {
    seconds,
    revision: structureRevision(selectedVideo),
  });
}
// The time and the playhead. A new preview starts at 0, so until it is ready
// the page shows the time that the preview resumes at.
function showTime() {
  const time = playhead();
  $("#preview-time").textContent = clockTenths(time);
  timeline.setPlayhead(time);
}
// timeupdate is too slow for a smooth playhead during playback.
function followPlayback() {
  if ($("#player").paused || !selectedVideo) return;
  showTime();
  requestAnimationFrame(followPlayback);
}
$("#player").addEventListener("play", followPlayback);
new ResizeObserver(() => editor.layout()).observe($(".player-wrap"));
for (const event of ["play", "pause", "volumechange", "timeupdate", "seeked"])
  $("#player").addEventListener(event, syncPreview);
$("#player").addEventListener("loadeddata", () => {
  if (!selectedVideo || $("#player").readyState < 2) return;
  previewReady = true;
  previewError = null;
  hideSourceFrame();
  previewStatus(
    "Preview ready",
    "ready",
    "Preview ready. Your edits match the exported video.",
  );
  syncPreview();
  whenFrameShows(previewKey, () => editor.exactShown());
});
// The player can still seek to the resume time when its data loads. A draft
// view stays until the player shows that frame, so no other frame flashes.
function whenFrameShows(key, action) {
  const player = $("#player");
  const painted = () =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (previewKey === key && previewReady) action();
      }),
    );
  if (player.seeking)
    player.addEventListener("seeked", painted, { once: true });
  else painted();
}
$("#player").addEventListener("error", () => {
  const player = $("#player");
  if (!selectedVideo || !player.getAttribute("src")) return;
  previewReady = false;
  if (player.dataset.original === "true") {
    player.dataset.original = "false";
    previewStatus(
      "Preparing preview",
      "preparing",
      "Preparing a compatible preview.",
    );
    preparePreview(selectedVideo, previewKey);
  } else {
    previewError =
      "Cannot play this preview. Check the source file and FFmpeg.";
    previewStatus("Preview failed", "failed", previewError);
  }
  syncPreview();
});
new MutationObserver(syncPreview).observe($(".player-shell"), {
  attributes: true,
  attributeFilter: ["class"],
});
handle("#preview-play", "click", () =>
  call($("#player").paused ? "playback.play" : "playback.pause"),
);
handle("#preview-volume", "change", () =>
  call("playback.configure", { volume: Number($("#preview-volume").value) }),
);
handle("#preview-fullscreen", "click", () =>
  call("playback.fullscreen", {
    enabled: !$(".player-shell").classList.contains("fullscreen"),
  }),
);
function checkRange() {
  return rangeCheck(
    $("#range-start").value,
    $("#range-end").value,
    seconds(selectedVideo),
  );
}
function rangeValues() {
  const { start, end } = checkRange();
  return { start, end };
}
// The owner of the draft, if it still applies to this video and these times.
function activeOwner() {
  const owner = rangeOwner;
  if (!owner || !selectedVideo || owner.videoId !== selectedVideo.id)
    return null;
  if (owner.kind === "part")
    return owner.structure === structureRevision(selectedVideo) ? owner : null;
  return owner.jobId === transcript.jobId() &&
    owner.timing === timingRevision(selectedVideo)
    ? owner
    : null;
}
const selectedPartId = () => {
  const owner = activeOwner();
  return owner?.kind === "part" ? owner.id : null;
};
// One change of the owner. Selected words end with their draft.
function setOwner(owner) {
  const before = rangeOwner;
  rangeOwner = owner ? { ...owner, epoch: ++rangeEpoch } : null;
  if (before?.kind === "words" && owner?.kind !== "words")
    transcript.ownerEnded();
  // A drag writes many manual drafts. The list changes only with a part.
  if (selectedVideo && (before?.kind === "part" || owner?.kind === "part"))
    parts.render(selectedVideo, selectedPartId());
}
// A click on the track selects a part only if the draft is free: no selection,
// or a part. So a manual draft and selected words stay.
function partSelectable() {
  if (!selectedVideo || timelineParts(selectedVideo.timeline).length < 2)
    return false;
  return checkRange().full || Boolean(selectedPartId());
}
function selectPart(part, { seekTo = false } = {}) {
  const exact = (value) => String(Math.round(value * 1e6) / 1e6);
  writeRange(
    {
      start: exact(part.start),
      end:
        part.end >= seconds(selectedVideo) ? String(part.end) : exact(part.end),
    },
    {
      kind: "part",
      id: part.id,
      videoId: selectedVideo.id,
      structure: structureRevision(selectedVideo),
      label: `Part ${(part.index ?? part.number - 1) + 1}`,
    },
  );
  if (seekTo && previewReady) seek(part.start);
}
function selectPartAt(time) {
  if (!partSelectable()) return;
  const list = timelineParts(selectedVideo.timeline);
  selectPart(list.find((part) => time < part.end) ?? list.at(-1));
}
// A change of the marks. A part that still exists stays selected, and its
// number can change. A part that a split divided is gone, so the next click can
// select a new part.
function updatePartOwner(video) {
  const owner = rangeOwner;
  if (owner?.kind !== "part" || owner.videoId !== video.id) return;
  const structure = structureRevision(video);
  if (owner.structure === structure) return;
  const part = timelineParts(video.timeline).find(
    (item) => item.id === owner.id,
  );
  if (part)
    rangeOwner = { ...owner, structure, label: `Part ${part.index + 1}` };
  else {
    rangeOwner = null;
    $("#range-start").value = 0;
    $("#range-end").value = duration(video.timeline);
  }
}
function renderRange() {
  if (!selectedVideo) return;
  const { start, end, valid, full, maximum } = checkRange();
  const summary = $("#range-summary");
  const length = `${(end - start).toFixed(2)} s long`;
  // The summary is in Trim & cut and tells why the actions are not available.
  summary.classList.toggle("invalid", !valid || full);
  summary.textContent = !valid
    ? `Set an end time after the start time. The maximum is ${maximum}.`
    : full
      ? "The selection is the full video. Drag on the timeline, use Set start and Set end, or type the times."
      : `Selection: ${start.toFixed(2)} s to ${end.toFixed(2)} s, ${length}.`;
  // The dock buttons work in every tool, so the dock tells a screen reader.
  $("#selection-status").textContent = summary.textContent;
  const usable = valid && !full;
  $("#trim").disabled = !usable;
  $("#cut").disabled = !usable;
  $("#range-hint").hidden = usable;
  $("#range-hint").textContent = valid
    ? "Drag on the timeline, or use Set start and Set end."
    : "The end must be after the start.";
  // The dock shows the selection in every tool. Its button opens Trim & cut.
  // A small window shows only the times. The tip and the name have all of it.
  const chip = $("#selection-chip");
  chip.hidden = !usable;
  $("#selection-group").hidden = !usable;
  if (usable) {
    const times = `${start.toFixed(2)} to ${end.toFixed(2)} s`;
    const detail = `Selection ${times}, ${length}. Open Trim & cut to change the exact times.`;
    const owner = activeOwner();
    $("#selection-times").textContent = times;
    $("#selection-word").textContent = `${owner?.label ?? "Selection"} `;
    chip.title = detail;
    chip.setAttribute("aria-label", detail);
  }
  timeline.renderRange();
}
// A typed time, Set start, and Set end are manual changes, also when the text
// stays the same. Only writeRange can keep an owner.
for (const id of ["#range-start", "#range-end"])
  $(id).addEventListener("input", () => {
    if (!writingRange) setOwner(null);
    renderRange();
  });
// Changes the draft selection. The input event reaches all that depend on it,
// for example the caption replace confirmation. No edit command runs.
function writeRange({ start, end }, owner = null) {
  writingRange = true;
  setOwner(owner);
  $("#range-start").value = start;
  $("#range-end").value = end;
  $("#range-start").dispatchEvent(new Event("input", { bubbles: true }));
  writingRange = false;
}
// Returns true if a selection was cleared.
function clearRange() {
  if (!selectedVideo || checkRange().full) return false;
  writeRange({ start: "0", end: String(seconds(selectedVideo)) });
  return true;
}
function setRangeFromPlayhead(which) {
  if (!selectedVideo || !previewReady) return;
  $(`#range-${which}`).value = playheadValue(
    $("#player").currentTime,
    seconds(selectedVideo),
  );
  $(`#range-${which}`).dispatchEvent(new Event("input", { bubbles: true }));
}
$("#range-start-now").addEventListener("click", () =>
  setRangeFromPlayhead("start"),
);
$("#range-end-now").addEventListener("click", () =>
  setRangeFromPlayhead("end"),
);
const shortcutDialog = $("#shortcut-settings");
const shortcutSettings = createShortcutSettings(shortcutDialog, call, () => {
  const fullscreen = $("#preview-fullscreen");
  fullscreen.title = shortcutSettings.label(
    "fullscreen",
    fullscreen.getAttribute("aria-label"),
  );
  renderSplit();
});
shortcutSettings.sync({});
document.addEventListener("keydown", (event) => {
  if (shortcutDialog.open || event.defaultPrevented) return;
  // Escape cancels a drag first. Nothing is saved.
  if (
    event.key === "Escape" &&
    (timeline.cancelGesture() || editor.cancelGesture())
  ) {
    event.preventDefault();
    return;
  }
  if (
    event.key === "Escape" &&
    $(".player-shell").classList.contains("fullscreen")
  ) {
    call("playback.fullscreen", { enabled: false }).catch((error) =>
      notice(error.message, true),
    );
    return;
  }
  if (
    event.key === "Escape" &&
    !$("#editor").hidden &&
    !$("#confirm-delete").open &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) &&
    (editor.deselect() || captions.deselect() || clearRange())
  )
    return;
  const context = shortcutContext();
  // Accept a key that can apply after the current action completes. Check it
  // again with the state at that time.
  const possible = shortcut(event, {
    ...context,
    ready: true,
    canUndo: true,
    canRedo: true,
  });
  if (!possible) return;
  event.preventDefault();
  if (context.view === "library") return perform(possible);
  // The editors queue their own command for the selected element or caption.
  // Only the selection of the open tool: the user can see what it deletes.
  if (possible.local === "delete-element") {
    if (tools.active() === "captions") captions.deleteSelected();
    if (tools.active() === "elements") editor.deleteSelected();
    return;
  }
  const keys = {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    target: event.target,
  };
  const id = selectedVideo?.id;
  enqueue(async () => {
    if (!selectedVideo || selectedVideo.id !== id) return;
    // Keep the binding from the key press. The action can wait behind another
    // operation while the user or an agent changes the shortcut settings.
    const action = shortcut(keys, {
      ...shortcutContext(),
      shortcutOverrides: context.shortcutOverrides,
    });
    if (action) await perform(action);
  });
});
function shortcutContext() {
  const player = $("#player");
  return {
    view: $("#editor").hidden ? "library" : "editor",
    ready: previewReady,
    paused: player.paused,
    seconds: player.currentTime,
    duration: selectedVideo ? seconds(selectedVideo) : 0,
    fullscreen: $(".player-shell").classList.contains("fullscreen"),
    canUndo: Boolean(selectedVideo?.timeline.past.length),
    canRedo: Boolean(selectedVideo?.timeline.future.length),
    dialog: $("#confirm-delete").open || shortcutDialog.open,
    shortcutOverrides: shortcutSettings.overrides(),
    // Delete and Backspace use the selection of the open tool only. A
    // selection in a closed tool stays, but the keys do not change it.
    selected: activeSelection(),
  };
}
function activeSelection() {
  if (tools.active() === "elements") return editor.selected();
  if (tools.active() === "captions") return captions.selected();
  return null;
}
function perform(action) {
  if (action.local === "search") {
    $("#search").focus();
    $("#search").select();
  } else if (action.local === "range-start") setRangeFromPlayhead("start");
  else if (action.local === "range-end") setRangeFromPlayhead("end");
  else if (action.local === "split") return splitAtPlayhead();
  else if (action.local === "edit-text") editor.editSelected();
  else if (action.local === "zoom-in") timeline.zoomIn();
  else if (action.local === "zoom-out") timeline.zoomOut();
  else if (action.local === "zoom-fit") timeline.zoomFit();
  else if (action.command.startsWith("edit."))
    return edit(action.command.slice(5));
  else return call(action.command, action.args);
}
async function edit(action, args = {}) {
  const id = selectedVideo.id,
    generation = viewGeneration;
  const video = await call(`edit.${action}`, { id, ...args });
  if (generation === viewGeneration && selectedVideo?.id === id)
    renderVideo(video);
  await refreshLibrary();
}
handle("#start", "click", async () => {
  const options = {
    sourceId: $("#source").value,
    cameraOnly: $("#camera-only").checked,
    systemAudio: $("#system-audio").checked,
    frameRate: Number($("#fps").value),
  };
  if (!options.sourceId) delete options.sourceId;
  if ($("#record-title").value.trim())
    options.title = $("#record-title").value.trim();
  if ($("#microphone").value) options.microphoneId = $("#microphone").value;
  if ($("#camera").value) options.cameraId = $("#camera").value;
  await call("recording.countdown", options);
  await refreshStatus();
});
handle("#pause", "click", async () => {
  await call(
    currentRecording === "paused" ? "recording.resume" : "recording.pause",
  );
  await refreshStatus();
});
handle("#stop", "click", async () => {
  const video = await call("recording.stop");
  await refreshStatus();
  await refreshLibrary();
  await openVideo(video.id, { focus: true });
  notice(`Recording saved: ${video.title}`);
});
handle("#cancel-recording", "click", async () => {
  await call("recording.cancel");
  await refreshStatus();
});
handle("#refresh-sources", "click", refreshSources);
$("#source").addEventListener("change", updateSource);
$("#camera-only").addEventListener("change", updateSource);
$("#search").addEventListener("input", () =>
  refreshLibrary().catch((error) => notice(error.message, true)),
);
$("#search").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !$("#search").value) return;
  event.preventDefault();
  clearSearch().catch((error) => notice(error.message, true));
});
$("#clear-search").addEventListener("click", () => {
  $("#search").focus();
  clearSearch().catch((error) => notice(error.message, true));
});
handle("#import", "click", async () => {
  const path = await window.midnight.pickImport();
  if (!path) return;
  const button = $("#import");
  button.setAttribute("aria-busy", "true");
  $("#import .label").textContent = "Importing…";
  try {
    const video = await call("library.import", { path });
    await refreshLibrary();
    await openVideo(video.id, { focus: true });
    notice(`Video imported: ${video.title}`);
  } finally {
    button.removeAttribute("aria-busy");
    $("#import .label").textContent = "Import video";
  }
});
// A part or selected words use their guarded command, with their exact source
// times. A manual draft uses the times of the fields.
function partEdit(action, part) {
  if (action === "removePart") pendingResume = part.start;
  return edit(action, {
    partId: part.id,
    revision: structureRevision(selectedVideo),
  }).catch((error) => {
    pendingResume = null;
    throw /parts\.list/.test(error.message)
      ? new Error("The video changed. Select the part again.")
      : error;
  });
}
const ownedPart = (owner) =>
  timelineParts(selectedVideo.timeline).find((part) => part.id === owner.id);
function keepSelection() {
  const owner = activeOwner();
  if (owner?.kind === "part") return partEdit("keepPart", ownedPart(owner));
  return edit("trim", rangeValues());
}
function removeSelection() {
  const owner = activeOwner();
  if (owner?.kind === "part") return partEdit("removePart", ownedPart(owner));
  if (owner?.kind === "words") return transcript.cutSelected();
  return edit("cut", rangeValues());
}
handle("#trim", "click", keepSelection);
handle("#cut", "click", removeSelection);
handle("#split", "click", splitAtPlayhead);
handle("#transcript-cut", "click", () => transcript.cutSelected());
handle("#transcript-play", "click", () => transcript.playSelection());
handle("#speed", "change", () =>
  edit("configure", { speed: Number($("#speed").value) }),
);
handle("#mute", "change", () =>
  edit("configure", { muted: $("#mute").checked }),
);
for (const action of ["undo", "redo", "reset"])
  handle("#" + action, "click", () => edit(action));
function updateRenameState() {
  const value = $("#rename-title").value.trim();
  $("#rename").disabled =
    !selectedVideo || !value || value === selectedVideo.title;
}
$("#rename-title").addEventListener("input", updateRenameState);
$("#rename-title").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || $("#rename").disabled) return;
  event.preventDefault();
  $("#rename").click();
});
handle("#rename", "click", async () => {
  const id = selectedVideo.id;
  await call("library.rename", {
    id,
    title: $("#rename-title").value,
  });
  await openVideo(id);
  await refreshLibrary();
  notice("Title saved.");
});
handle("#export", "click", async () => {
  const path = await window.midnight.pickExport(selectedVideo.title);
  if (path) {
    await call("export.start", { id: selectedVideo.id, path });
    notice("Export started. You can continue to edit.");
    await refreshStatus();
  }
});
$("#delete").addEventListener("click", () => $("#confirm-delete").showModal());
$("#keep-video").addEventListener("click", () => $("#confirm-delete").close());
handle("#confirm-delete-button", "click", async () => {
  $("#player").pause();
  $("#player").removeAttribute("src");
  $("#player").load();
  $("#player").dataset.videoId = "";
  try {
    await call("library.delete", { id: selectedVideo.id });
  } catch (error) {
    previewKey = "";
    renderVideo(selectedVideo);
    throw error;
  }
  const title = selectedVideo.title;
  $("#confirm-delete").close();
  showLibrary();
  await refreshLibrary();
  $("#search").focus();
  notice(`Video deleted: ${title}`);
});
$("#back").addEventListener("click", () => showLibrary({ restoreFocus: true }));
$("#library-nav").addEventListener("click", () =>
  showLibrary({ restoreFocus: true }),
);
$("#new-nav").addEventListener("click", () => showView("recorder"));
$("#recording-pill").addEventListener("click", () => showView("recorder"));
function renderExports() {
  const rows = selectedVideo ? exportRows(lastJobs, selectedVideo.id) : [];
  $("#exports").hidden = !rows.length;
  const running = rows.some((row) => row.state === "running");
  $("#export-progress").hidden = !running;
  $("#export-progress").textContent = "Exporting…";
  $("#export-jobs").replaceChildren(
    ...rows.map((row) => {
      const item = element("div", "export-row");
      item.dataset.state = row.state;
      const file = element("div", "export-file");
      file.append(
        element("strong", "", row.file),
        element("span", "", row.folder),
      );
      item.append(element("span", "export-state", row.label), file);
      if (row.error) item.append(element("p", "export-error", row.error));
      return item;
    }),
  );
}
function renderRecordingTime() {
  const text = clock(recordedSeconds(lastRecording, Date.now()));
  for (const id of ["#record-time", "#pill-time"]) {
    $(id).hidden = !recordingDisplay.showTime;
    if ($(id).textContent !== text) $(id).textContent = text;
  }
}
function renderRecording(recording) {
  currentRecording = recording.state;
  if (
    recording.state === "idle" &&
    recording.error &&
    recording.error !== lastRecordingError
  )
    notice(`Cannot start recording. ${readableError(recording.error)}`, true);
  lastRecordingError = recording.error;
  lastRecording = recording;
  const view = recordingView(recording);
  recordingDisplay = view;
  $("#recorder").dataset.state = recording.state;
  $("#start").hidden = view.active;
  $("#start-hint").hidden = view.active;
  $("#source-preview").hidden = view.active;
  $("#settings-locked").hidden = !view.active;
  $("#record-controls").hidden = !view.active;
  $("#record-controls").dataset.tone = view.tone;
  // The status text stays one sentence for screen readers. The error shows on
  // its own line. Change the live region only when its text changes.
  const status = $("#record-status");
  if (status.textContent !== view.label) {
    if (view.error)
      status.replaceChildren(
        element("span", "", view.short),
        element("span", "visually-hidden", ": "),
        element("span", "record-error", view.error),
      );
    else status.textContent = view.label;
  }
  $("#record-detail").textContent = view.detail;
  $("#pause").disabled = !view.canPause;
  $("#pause").textContent = view.pauseLabel;
  $("#stop").disabled = !view.canStop;
  $("#cancel-recording").disabled = !view.canCancel;
  $("#cancel-recording").textContent = view.cancelLabel;
  for (const selector of [
    "#source",
    "#camera",
    "#microphone",
    "#camera-only",
    "#system-audio",
    "#fps",
    "#record-title",
    "#refresh-sources",
  ])
    $(selector).disabled = view.active;
  const pill = $("#recording-pill");
  pill.hidden = !view.active;
  pill.dataset.tone = view.tone;
  pill.title = "Show recording controls";
  $("#pill-label").textContent = view.short;
  document.title = view.active
    ? `${view.short} · Midnight Recorder`
    : "Midnight Recorder";
  renderRecordingTime();
}
async function refreshStatus() {
  const status = await call("app.status");
  shortcutSettings.sync(status.shortcutOverrides);
  renderRecording(status.recording);
  lastJobs = status.jobs;
  for (const row of finishedExports(knownExports, status.jobs, loadedAt))
    notice(
      row.state === "complete"
        ? `Export complete: ${row.file}`
        : `Export failed: ${row.error}`,
      row.state !== "complete",
    );
  renderExports();
  if (selectedVideo) {
    transcript.syncJobs(status.jobs);
    const id = selectedVideo.id,
      generation = viewGeneration;
    // A small result first. The full video, with its undo history, loads
    // only when an edit, Undo, Redo, or the title changed.
    const latest = await call("library.revision", { id }).catch(() => null);
    if (generation !== viewGeneration || selectedVideo?.id !== id) return;
    if (!latest) return showLibrary();
    const { timeline, title } = selectedVideo;
    if (
      latest.revision === editRevision(selectedVideo) &&
      latest.structureRevision === structureRevision(selectedVideo) &&
      latest.title === title &&
      latest.history?.undo === timeline.past.length &&
      latest.history?.redo === timeline.future.length
    )
      return;
    const video = await call("library.get", { id }).catch(() => null);
    if (generation !== viewGeneration || selectedVideo?.id !== id) return;
    if (!video) showLibrary();
    else renderVideo(video);
  }
}
try {
  shortcutSettings.sync((await call("shortcuts.list")).overrides);
} catch (error) {
  notice(error.message, true);
}
try {
  await refreshSources();
  await refreshLibrary();
  await refreshStatus();
} catch (error) {
  notice(error.message, true);
}
setInterval(renderRecordingTime, 250);
setInterval(async () => {
  if (!busy) {
    try {
      await refreshStatus();
      await refreshLibrary();
    } catch (error) {
      notice(error.message, true);
    }
  }
}, 1500);
