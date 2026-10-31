import {
  duration,
  isEdited,
  sourceTime,
  videoFades,
} from "../domain/timeline.js";
import { editRevision } from "../domain/inspection.js";
import { recordedSeconds } from "../domain/recording.js";
import { createElementEditor } from "./element-editor.js";
import {
  clock,
  libraryView,
  exportRows,
  finishedExports,
  recordingView,
  readableError,
  playheadValue,
  rangeCheck,
  shortcut,
} from "./view-model.js";
const $ = (selector) => document.querySelector(selector);
const call = (name, args = {}) => window.midnight.execute(name, args);
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
  previewVideoId = "";
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
const editor = createElementEditor({
  $,
  call,
  queue: queued,
  notice,
  showVideo: (video, id) => {
    if (selectedVideo?.id === id) renderVideo(video);
  },
  playhead,
  seek: (seconds) =>
    call("playback.seek", { seconds }).catch((error) =>
      notice(error.message, true),
    ),
  isReady: () => previewReady,
  frameSize,
});
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
  $("#editor").hidden = true;
  $("#library-view").hidden = false;
  $("#crumb").textContent = "Video library";
  selectedVideo = null;
  previewKey = "";
  previewReady = false;
  rangeKey = "";
  resumeAt = 0;
  previewVideoId = "";
  editor.clear();
  hideSourceFrame();
  $(".player-shell").classList.remove("fullscreen");
  if (restoreFocus) {
    const card = [...document.querySelectorAll(".video-card")].find(
      (item) => item.dataset.id === previous,
    );
    (card || $("#search")).focus();
  }
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
function previewStatus(text, state) {
  $("#preview-state").textContent = text;
  $("#preview-state").dataset.state = state;
}
function renderVideoInfo(video) {
  const parts = [
    element("span", "", clock(seconds(video))),
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
  selectedVideo = video;
  const id = video.id;
  $("#library-view").hidden = true;
  $("#editor").hidden = false;
  $("#crumb").textContent = "Video editor";
  $("#video-title").textContent = video.title;
  const title = $("#rename-title");
  if (title.dataset.videoId !== id || title.value === title.dataset.rendered)
    title.value = video.title;
  title.dataset.videoId = id;
  title.dataset.rendered = video.title;
  updateRenameState();
  $("#delete-name").textContent = video.title;
  renderVideoInfo(video);
  const player = $("#player");
  // The revision includes elements, so an element change loads a new preview.
  const key = id + editRevision(video);
  if (previewKey !== key) {
    // An edit keeps the playhead time. Another video starts at 0.
    if (previewVideoId !== id) resumeAt = 0;
    else if (previewReady) resumeAt = player.currentTime;
    previewVideoId = id;
    previewKey = key;
    previewReady = false;
    previewError = null;
    player.dataset.original = "false";
    player.pause();
    player.removeAttribute("src");
    player.load();
    if (!isEdited(video.timeline, video.metadata.duration)) {
      hideSourceFrame();
      setPreview(video.url, true);
    } else {
      previewStatus(
        "Preparing edited preview. You can continue to edit.",
        "preparing",
      );
      showSourceFrame(video);
      Promise.resolve().then(() => preparePreview(video, key));
    }
  }
  const total = seconds(video);
  if (rangeKey !== key) {
    rangeKey = key;
    $("#range-start").value = 0;
    $("#range-end").value = total;
  }
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
  $("#preview-seek").max = total;
  $("#timeline-bars").replaceChildren(
    ...video.timeline.segments.map((s) => {
      const bar = document.createElement("i");
      bar.style.flex = s.end - s.start;
      return bar;
    }),
  );
  renderRange();
  renderExports();
  renderVideoFades(video);
  editor.render(video);
  syncPreview();
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
// rendered preview replaces this picture when it is ready.
function showSourceFrame(video) {
  const frame = $("#source-frame");
  const total = seconds(video);
  if (frame.getAttribute("src") !== video.url) frame.src = video.url;
  frame.currentTime = sourceTime(video.timeline, Math.min(resumeAt, total));
  frame.hidden = false;
  $("#stage-note").textContent =
    "Preparing the preview. This picture is the original video without elements. Outlines show the elements.";
  $("#stage-note").hidden = false;
}
function hideSourceFrame() {
  $("#source-frame").hidden = true;
  $("#stage-note").hidden = true;
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
  previewStatus("Loading preview.", "preparing");
  syncPreview();
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
      previewStatus(`Preview failed: ${error.message}`, "failed");
      notice(error.message, true);
    }
  }
}
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
      if (["seek", "play"].includes(action) && !previewReady)
        throw new Error(
          "The edited preview is still being prepared. Poll playback.status until ready is true.",
        );
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
        ready: previewReady,
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
  const total = seconds(selectedVideo);
  const playing = !player.paused;
  $("#preview-play .icon").textContent = playing ? "❚❚" : "▶";
  $("#preview-play .label").textContent = playing ? "Pause" : "Play";
  $("#preview-play").setAttribute(
    "aria-label",
    playing ? "Pause preview" : "Play preview",
  );
  $("#preview-play").disabled = !previewReady;
  $("#preview-seek").disabled = !previewReady;
  $("#preview-seek").value = player.currentTime;
  $("#preview-time").textContent =
    `${clock(player.currentTime)} / ${clock(total)}`;
  $("#preview-volume").value = player.volume;
  $("#timeline-playhead").style.left =
    `${Math.min(100, (player.currentTime / total) * 100)}%`;
  $("#timeline-track").classList.toggle("ready", previewReady);
  $("#range-start-now").disabled = !previewReady;
  $("#range-end-now").disabled = !previewReady;
  const fullscreen = $(".player-shell").classList.contains("fullscreen");
  const label = fullscreen ? "Exit fullscreen" : "Fullscreen";
  $("#preview-fullscreen .label").textContent = label;
  $("#preview-fullscreen").setAttribute("aria-label", label);
  editor.layout();
}
new ResizeObserver(() => editor.layout()).observe($(".player-wrap"));
for (const event of ["play", "pause", "volumechange", "timeupdate", "seeked"])
  $("#player").addEventListener(event, syncPreview);
$("#player").addEventListener("loadeddata", () => {
  if (!selectedVideo || $("#player").readyState < 2) return;
  previewReady = true;
  previewError = null;
  hideSourceFrame();
  previewStatus("Preview ready. Your edits match the exported video.", "ready");
  syncPreview();
});
$("#player").addEventListener("error", () => {
  const player = $("#player");
  if (!selectedVideo || !player.getAttribute("src")) return;
  previewReady = false;
  if (player.dataset.original === "true") {
    player.dataset.original = "false";
    previewStatus("Preparing a compatible preview.", "preparing");
    preparePreview(selectedVideo, previewKey);
  } else {
    previewError =
      "Cannot play this preview. Check the source file and FFmpeg.";
    previewStatus(previewError, "failed");
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
handle("#preview-seek", "change", () =>
  call("playback.seek", { seconds: Number($("#preview-seek").value) }),
);
handle("#preview-volume", "change", () =>
  call("playback.configure", { volume: Number($("#preview-volume").value) }),
);
handle("#preview-fullscreen", "click", () =>
  call("playback.fullscreen", {
    enabled: !$(".player-shell").classList.contains("fullscreen"),
  }),
);
$("#timeline-track").addEventListener("click", (event) => {
  if (!selectedVideo) return;
  if (!previewReady) {
    notice("Wait for the preview. Then select a point on the timeline.");
    return;
  }
  const box = event.currentTarget.getBoundingClientRect();
  const fraction = Math.min(
    1,
    Math.max(0, (event.clientX - box.left) / box.width),
  );
  const id = selectedVideo.id;
  enqueue(async () => {
    if (selectedVideo?.id !== id || !previewReady) return;
    await call("playback.seek", { seconds: fraction * seconds(selectedVideo) });
  });
});
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
function renderRange() {
  if (!selectedVideo) return;
  const total = seconds(selectedVideo);
  const { start, end, valid, full, maximum } = checkRange();
  const summary = $("#range-summary");
  summary.classList.toggle("invalid", !valid);
  summary.textContent = !valid
    ? `Set an end time after the start time. The maximum is ${maximum}.`
    : full
      ? "The range is the full video. Change the start or end time."
      : `Selected range: ${(end - start).toFixed(2)} seconds.`;
  $("#trim").disabled = !valid || full;
  $("#cut").disabled = !valid || full;
  $("#timeline-range").hidden = !valid || full;
  if (valid && !full) {
    $("#timeline-range").style.left = `${(start / total) * 100}%`;
    $("#timeline-range").style.width = `${((end - start) / total) * 100}%`;
  }
}
for (const id of ["#range-start", "#range-end"])
  $(id).addEventListener("input", renderRange);
function setRangeFromPlayhead(which) {
  if (!selectedVideo || !previewReady) return;
  $(`#range-${which}`).value = playheadValue(
    $("#player").currentTime,
    seconds(selectedVideo),
  );
  renderRange();
}
$("#range-start-now").addEventListener("click", () =>
  setRangeFromPlayhead("start"),
);
$("#range-end-now").addEventListener("click", () =>
  setRangeFromPlayhead("end"),
);
document.addEventListener("keydown", (event) => {
  // Escape cancels a drag first. Nothing is saved.
  if (event.key === "Escape" && editor.cancelGesture()) {
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
    editor.deselect()
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
  // The editor queues its own command for the selected element.
  if (possible.local === "delete-element") {
    editor.deleteSelected();
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
    const action = shortcut(keys, shortcutContext());
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
    dialog: $("#confirm-delete").open,
    selected: editor.selected(),
  };
}
function perform(action) {
  if (action.local === "search") {
    $("#search").focus();
    $("#search").select();
  } else if (action.local === "range-start") setRangeFromPlayhead("start");
  else if (action.local === "range-end") setRangeFromPlayhead("end");
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
handle("#trim", "click", () => edit("trim", rangeValues()));
handle("#cut", "click", () => edit("cut", rangeValues()));
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
    const id = selectedVideo.id,
      generation = viewGeneration;
    const latest = await call("library.get", { id }).catch(() => null);
    if (generation !== viewGeneration || selectedVideo?.id !== id) return;
    if (!latest) showLibrary();
    else if (JSON.stringify(latest) !== JSON.stringify(selectedVideo))
      renderVideo(latest);
  }
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
