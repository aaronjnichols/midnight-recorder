import { duration } from "../domain/timeline.js";
const $ = (selector) => document.querySelector(selector);
const call = (name, args = {}) => window.midnight.execute(name, args);
let selectedVideo,
  sources = [],
  currentRecording = "idle",
  busy = false,
  lastLibrary = "",
  statusTimer,
  previewKey = "",
  previewReady = false,
  viewGeneration = 0,
  previewError = null;
const seconds = (video) => duration(video.timeline);
const time = (value) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
function notice(message, error = false) {
  $("#message").textContent = message;
  $("#message").classList.toggle("error", error);
  $("#message").hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $("#message").hidden = true;
  }, 9000);
}
window.midnight.onNotice((message) => notice(message));
function handle(selector, event, action) {
  $(selector).addEventListener(event, async () => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    } finally {
      busy = false;
    }
  });
}
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
  const source = sources.find((s) => s.id === $("#source").value);
  const fallback = () => {
    const icon = document.createElement("span");
    icon.textContent = "▣";
    const label = document.createElement("p");
    label.textContent = source
      ? "Preview unavailable"
      : "Select a screen or window";
    $("#source-preview").replaceChildren(icon, label);
  };
  if (source?.thumbnail) {
    const image = document.createElement("img");
    image.onerror = fallback;
    image.src = source.thumbnail;
    image.alt = source.name;
    $("#source-preview").replaceChildren(image);
  } else fallback();
}
async function refreshLibrary() {
  const videos = await call(
    "library.list",
    $("#search").value ? { query: $("#search").value } : {},
  );
  const key = JSON.stringify(videos);
  if (key === lastLibrary) return;
  lastLibrary = key;
  $("#videos").replaceChildren();
  $("#empty").hidden = videos.length > 0;
  $("#video-total").textContent =
    `${videos.length} video${videos.length === 1 ? "" : "s"}`;
  $("#library-count").textContent = videos.length;
  for (const video of videos) {
    const card = document.createElement("button");
    card.className = "video-card";
    const cover = document.createElement("div");
    cover.className = "video-cover";
    const preview = document.createElement("video");
    preview.src = video.url;
    preview.muted = true;
    preview.preload = "metadata";
    const length = document.createElement("span");
    length.textContent = time(seconds(video));
    cover.append(preview, length);
    const body = document.createElement("div");
    body.className = "card-body";
    const title = document.createElement("strong");
    title.className = "card-title";
    title.textContent = video.title;
    const meta = document.createElement("span");
    meta.className = "card-meta";
    meta.textContent = `${new Date(video.createdAt).toLocaleDateString()} · ${video.metadata.width || ""} × ${video.metadata.height || ""}`;
    body.append(title, meta);
    card.append(cover, body);
    card.addEventListener("click", () =>
      openVideo(video.id).catch((error) => notice(error.message, true)),
    );
    $("#videos").append(card);
  }
}
function showLibrary() {
  viewGeneration++;
  $("#player").pause();
  $("#editor").hidden = true;
  $("#library-view").hidden = false;
  $("#crumb").textContent = "Video library";
  selectedVideo = null;
  previewKey = "";
  previewReady = false;
  $(".player-shell").classList.remove("fullscreen");
}
async function openVideo(id) {
  const generation = ++viewGeneration;
  const video = await call("library.get", { id });
  if (generation === viewGeneration) renderVideo(video);
}
function renderVideo(video) {
  selectedVideo = video;
  const id = video.id;
  $("#library-view").hidden = true;
  $("#editor").hidden = false;
  $("#crumb").textContent = "Video editor";
  $("#video-title").textContent = selectedVideo.title;
  $("#rename-title").value = selectedVideo.title;
  $("#video-info").textContent =
    `${time(seconds(selectedVideo))} · ${selectedVideo.metadata.width} × ${selectedVideo.metadata.height} · Local video`;
  const player = $("#player");
  const { segments, speed, muted } = video.timeline;
  const key = id + JSON.stringify({ segments, speed, muted });
  if (previewKey !== key) {
    previewKey = key;
    previewReady = false;
    previewError = null;
    player.dataset.original = "false";
    player.pause();
    player.removeAttribute("src");
    player.load();
    const original =
      segments.length === 1 &&
      segments[0].start === 0 &&
      segments[0].end === video.metadata.duration &&
      speed === 1 &&
      !muted;
    if (original) setPreview(video.url, true);
    else {
      $("#preview-state").textContent =
        "Preparing edited preview. You can continue to edit.";
      Promise.resolve().then(() => preparePreview(video, key));
    }
  }
  $("#range-start").value = 0;
  $("#range-end").value = seconds(selectedVideo);
  $("#speed").value = selectedVideo.timeline.speed;
  $("#mute").checked = selectedVideo.timeline.muted;
  $("#undo").disabled = !selectedVideo.timeline.past.length;
  $("#redo").disabled = !selectedVideo.timeline.future.length;
  $("#duration").textContent = time(seconds(selectedVideo));
  $("#preview-seek").max = seconds(selectedVideo);
  syncPreview();
  $("#timeline-bars").replaceChildren(
    ...selectedVideo.timeline.segments.map((s) => {
      const bar = document.createElement("i");
      bar.style.flex = s.end - s.start;
      return bar;
    }),
  );
}
function setPreview(url, original = false) {
  const player = $("#player");
  player.dataset.original = String(original);
  player.src = url;
  player.playbackRate = 1;
  player.muted = selectedVideo.timeline.muted;
  player.currentTime = 0;
  previewReady = false;
  $("#preview-state").textContent = "Loading preview.";
  syncPreview();
}
async function preparePreview(video, key) {
  try {
    const { segments, speed, muted } = video.timeline;
    const started = await call("preview.start", {
      id: video.id,
      revision: JSON.stringify({ segments, speed, muted }),
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
      $("#preview-state").textContent = `Preview failed: ${error.message}`;
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
      showLibrary();
      if (args.view === "recorder") $("#record-title").focus();
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
  $("#preview-play").textContent = player.paused ? "Play" : "Pause";
  $("#preview-play").disabled = !previewReady;
  $("#preview-seek").disabled = !previewReady;
  $("#preview-seek").value = player.currentTime;
  $("#preview-time").textContent =
    `${time(player.currentTime)} / ${time(seconds(selectedVideo))}`;
  $("#preview-volume").value = player.volume;
}
for (const event of ["play", "pause", "volumechange"])
  $("#player").addEventListener(event, syncPreview);
$("#player").addEventListener("loadeddata", () => {
  if (!selectedVideo || $("#player").readyState < 2) return;
  previewReady = true;
  previewError = null;
  $("#preview-state").textContent =
    "Preview ready. Your edits match the exported video.";
  syncPreview();
});
$("#player").addEventListener("error", () => {
  const player = $("#player");
  if (!selectedVideo || !player.getAttribute("src")) return;
  previewReady = false;
  if (player.dataset.original === "true") {
    player.dataset.original = "false";
    $("#preview-state").textContent = "Preparing a compatible preview.";
    preparePreview(selectedVideo, previewKey);
  } else {
    previewError =
      "Cannot play this preview. Check the source file and FFmpeg.";
    $("#preview-state").textContent = previewError;
  }
  syncPreview();
});
$("#player").addEventListener("timeupdate", syncPreview);
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
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    $(".player-shell").classList.contains("fullscreen")
  )
    call("playback.fullscreen", { enabled: false }).catch((error) =>
      notice(error.message, true),
    );
});
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
  await call("recording.start", options);
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
  await openVideo(video.id);
});
handle("#cancel-recording", "click", async () => {
  await call("recording.cancel");
  await refreshStatus();
});
handle("#refresh-sources", "click", refreshSources);
$("#source").addEventListener("change", updateSource);
$("#search").addEventListener("input", () =>
  refreshLibrary().catch((error) => notice(error.message, true)),
);
handle("#import", "click", async () => {
  const path = await window.midnight.pickImport();
  if (path) {
    const video = await call("library.import", { path });
    await refreshLibrary();
    await openVideo(video.id);
  }
});
handle("#trim", "click", () =>
  edit("trim", {
    start: Number($("#range-start").value),
    end: Number($("#range-end").value),
  }),
);
handle("#cut", "click", () =>
  edit("cut", {
    start: Number($("#range-start").value),
    end: Number($("#range-end").value),
  }),
);
handle("#speed", "change", () =>
  edit("configure", { speed: Number($("#speed").value) }),
);
handle("#mute", "change", () =>
  edit("configure", { muted: $("#mute").checked }),
);
for (const action of ["undo", "redo", "reset"])
  handle("#" + action, "click", () => edit(action));
handle("#rename", "click", async () => {
  await call("library.rename", {
    id: selectedVideo.id,
    title: $("#rename-title").value,
  });
  await openVideo(selectedVideo.id);
  await refreshLibrary();
});
handle("#export", "click", async () => {
  const path = await window.midnight.pickExport(selectedVideo.title);
  if (path) {
    await call("export.start", { id: selectedVideo.id, path });
    notice("Export started. You can continue to edit.");
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
  $("#confirm-delete").close();
  showLibrary();
  await refreshLibrary();
});
$("#back").addEventListener("click", showLibrary);
$("#library-nav").addEventListener("click", showLibrary);
$("#new-nav").addEventListener("click", () => {
  showLibrary();
  $("#record-title").focus();
});
async function refreshStatus() {
  const status = await call("app.status");
  currentRecording = status.recording.state;
  $("#start").hidden = currentRecording !== "idle";
  $("#record-controls").hidden = currentRecording === "idle";
  $("#record-status").textContent =
    currentRecording === "failed"
      ? `Recording failed. Select Stop and save to retry, or Cancel. ${status.recording.error}`
      : currentRecording === "paused"
        ? "Paused"
        : currentRecording === "stopped"
          ? "Stopped. Select Stop and save to retry."
          : "Recording";
  $("#pause").disabled = ["stopped", "failed"].includes(currentRecording);
  $("#pause").textContent = currentRecording === "paused" ? "Resume" : "Pause";
  $("#export-jobs").replaceChildren(
    ...status.jobs
      .filter((job) => job.kind !== "preview")
      .map((job) => {
        const row = document.createElement("div");
        row.textContent =
          job.state === "failed"
            ? `Export failed: ${job.error}`
            : `Export ${job.state}: ${job.path}`;
        return row;
      }),
  );
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
