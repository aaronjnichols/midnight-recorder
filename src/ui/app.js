import { duration, sourceTime, editedTime } from "../domain/timeline.js";
const $ = (selector) => document.querySelector(selector);
const call = (name, args = {}) => window.midnight.execute(name, args);
let selectedVideo,
  sources = [],
  currentRecording = "idle",
  busy = false,
  lastLibrary = "",
  statusTimer;
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
  if (source) {
    const image = document.createElement("img");
    image.src = source.thumbnail;
    image.alt = source.name;
    $("#source-preview").replaceChildren(image);
  }
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
  $("#player").pause();
  $("#editor").hidden = true;
  $("#library-view").hidden = false;
  $("#crumb").textContent = "Video library";
  selectedVideo = null;
}
async function openVideo(id) {
  renderVideo(await call("library.get", { id }));
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
  if (player.dataset.videoId !== id) {
    player.src = selectedVideo.url;
    player.dataset.videoId = id;
  }
  player.playbackRate = selectedVideo.timeline.speed;
  player.muted = selectedVideo.timeline.muted;
  player.currentTime = selectedVideo.timeline.segments[0].start;
  $("#range-start").value = 0;
  $("#range-end").value = seconds(selectedVideo).toFixed(3);
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
window.midnight.onPlayback(async ({ id, action, args }) => {
  try {
    const player = $("#player");
    if (action === "open") renderVideo(args.video);
    else if (action === "view") {
      showLibrary();
      if (args.view === "recorder") $("#record-title").focus();
    } else {
      if (!selectedVideo)
        throw new Error("Open a video before you control playback.");
      if (action === "seek")
        player.currentTime = sourceTime(selectedVideo.timeline, args.seconds);
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
        seconds: selectedVideo
          ? editedTime(selectedVideo.timeline, player.currentTime)
          : 0,
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
  $("#preview-seek").value = editedTime(
    selectedVideo.timeline,
    player.currentTime,
  );
  $("#preview-time").textContent =
    `${time(editedTime(selectedVideo.timeline, player.currentTime))} / ${time(seconds(selectedVideo))}`;
  $("#preview-volume").value = player.volume;
}
for (const event of ["play", "pause", "volumechange"])
  $("#player").addEventListener(event, syncPreview);
$("#player").addEventListener("timeupdate", () => {
  if (!selectedVideo) return;
  const player = $("#player"),
    segments = selectedVideo.timeline.segments;
  if (
    !segments.some(
      (s) => player.currentTime >= s.start && player.currentTime < s.end,
    )
  ) {
    const next = segments.find((s) => s.start > player.currentTime);
    if (next) player.currentTime = next.start;
    else if (!player.paused) {
      player.pause();
      player.currentTime = segments[0].start;
    }
  }
  syncPreview();
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
  await call(`edit.${action}`, { id: selectedVideo.id, ...args });
  await openVideo(selectedVideo.id);
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
    currentRecording === "paused"
      ? "Paused"
      : currentRecording === "stopped"
        ? "Stopped. Select Stop and save to retry."
        : "Recording";
  $("#pause").disabled = currentRecording === "stopped";
  $("#pause").textContent = currentRecording === "paused" ? "Resume" : "Pause";
  $("#export-jobs").replaceChildren(
    ...status.jobs.map((job) => {
      const row = document.createElement("div");
      row.textContent =
        job.state === "failed"
          ? `Export failed: ${job.error}`
          : `Export ${job.state}: ${job.path}`;
      return row;
    }),
  );
  if (selectedVideo) {
    const latest = await call("library.get", { id: selectedVideo.id }).catch(
      () => null,
    );
    if (!latest) showLibrary();
    else if (JSON.stringify(latest) !== JSON.stringify(selectedVideo))
      await openVideo(latest.id);
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
