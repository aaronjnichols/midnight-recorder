// Caption editing on the desktop page: speech-to-caption jobs, the cue list,
// the selected cue, and the shared caption style. Every change uses a shared
// command. Caption commands return a summary, so the page reads the video
// again after a change. showVideo shows it only if the same video is open.
import { duration } from "../domain/timeline.js";
import {
  cueRows,
  captionState,
  jobView,
  positionOf,
  POSITIONS,
  captionGap,
} from "./caption-view.js";

const POLL_MS = 400;
const round = (value) => Math.round(value * 1000) / 1000;

export function createCaptionEditor({
  $,
  call,
  queue,
  notice,
  showVideo,
  playhead,
  seek,
  isReady,
  range,
  onSelect,
}) {
  let video = null,
    rows = [],
    selectedId = null,
    // Increases on each user selection, so a late result cannot select a
    // caption after the user selected something else.
    selection = 0,
    capability = null,
    checking = null,
    listKey = "",
    restoring = false,
    currentId = null,
    // The last caption job: { jobId, videoId, status }. It continues when
    // another video is open, and shows only with its own video.
    job = null;
  const form = $("#caption-form");
  const total = () => (video ? duration(video.timeline) : 0);
  const selected = () => rows.find((r) => r.id === selectedId) || null;
  const cueOf = (id) => video?.timeline.captions?.cues.find((c) => c.id === id);

  function checkCapability() {
    if (capability?.available || checking) return;
    checking = call("transcript.capabilities")
      .then(
        (result) => (capability = result),
        (error) => (capability = { available: false, reason: error.message }),
      )
      .finally(() => {
        checking = null;
        if (video) renderPanel();
      });
  }

  function render(next) {
    if (!next) return clear();
    if (video?.id !== next.id) {
      selectedId = null;
      selection++;
    }
    // The confirmation text is for the open video and its caption count.
    if (
      confirmation &&
      (confirmation.videoId !== next.id ||
        confirmation.count !== (next.timeline.captions?.cues.length ?? 0))
    )
      closeConfirmation();
    video = next;
    rows = cueRows(video.timeline, selectedId, playhead());
    if (selectedId && !selected()) selectedId = null;
    checkCapability();
    renderList();
    renderPanel();
    renderJob();
    renderForm();
  }

  function clear() {
    video = null;
    rows = [];
    selectedId = null;
    listKey = "";
    currentId = null;
    $("#caption-list").replaceChildren();
    closeConfirmation();
    $("#caption-job").hidden = true;
    form.hidden = true;
  }

  function select(id, { reveal = false } = {}) {
    selectedId = id;
    selection++;
    if (id) onSelect?.();
    // The rows show the selection, so they change with it.
    if (video) rows = cueRows(video.timeline, selectedId, playhead());
    renderList();
    renderForm();
    const row = selected();
    // Show the selected caption: move the playhead to its start.
    if (reveal && row && row.visibility !== "none" && isReady()) {
      const now = playhead();
      if (now < row.start || now >= row.end) seek(row.start);
    }
  }

  // Runs one shared caption command for the open video, then reads the
  // video again. selectCue gives the cue ID to select from the result.
  function command(name, args, { selectCue } = {}) {
    if (!video) return Promise.resolve();
    const id = video.id,
      before = selection;
    return queue(async () => {
      const result = await call(name, { id, ...args });
      const latest = await call("library.get", { id });
      showVideo(latest, id);
      const cueId = selectCue?.(result);
      if (cueId !== undefined && video?.id === id && selection === before)
        select(cueId);
      return result;
    }).catch((error) => {
      notice(error.message, true);
      renderForm({ force: true });
      renderPanel({ force: true });
    });
  }

  // Cue list: one row for each caption, in time order. The rows are made
  // again only when caption data changes. The selection changes in place,
  // so a click that selects a row by focus ends on the same row.
  function renderList() {
    $("#captions-empty").hidden = rows.length > 0;
    const key = JSON.stringify(
      rows.map((r) => [r.id, r.text, r.check, r.visibility, r.timeText]),
    );
    if (key !== listKey) buildList(key);
    for (const item of $("#caption-list").children)
      item
        .querySelector(".caption-select")
        .setAttribute("aria-pressed", String(item.dataset.id === selectedId));
    markCurrent();
  }
  function buildList(key) {
    listKey = key;
    const focused =
      document.activeElement?.closest?.(".caption-row")?.dataset.id;
    $("#caption-list").replaceChildren(
      ...rows.map((row, index) => {
        const item = document.createElement("li");
        item.className = "layer-row caption-row";
        item.dataset.id = row.id;
        item.dataset.visibility = row.visibility;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "layer-select caption-select";
        button.setAttribute("aria-pressed", String(row.selected));
        const number = document.createElement("span");
        number.className = "caption-number";
        number.textContent = String(index + 1);
        const time = document.createElement("span");
        time.className = "layer-time";
        time.textContent = row.timeText;
        const text = document.createElement("span");
        text.className = "layer-name caption-text";
        text.textContent = row.text;
        button.append(number, time, text);
        for (const [show, label, kind] of [
          [row.check, "Check", "check"],
          [row.visibility === "partial", "Part cut", "partial"],
          [row.visibility === "none", "Cut", "none"],
        ])
          if (show) {
            const badge = document.createElement("span");
            badge.className = `caption-badge ${kind}`;
            badge.textContent = label;
            button.append(badge);
          }
        button.addEventListener("focus", () => {
          if (!restoring && selectedId !== row.id) select(row.id);
        });
        button.addEventListener("click", () =>
          select(row.id, { reveal: true }),
        );
        item.append(button);
        return item;
      }),
    );
    currentId = null;
    markCurrent();
    // The focus moves to the new row of the same caption. This is not a
    // selection, so Escape can clear the selection of a focused row.
    if (focused) {
      restoring = true;
      $(
        `.caption-row[data-id="${CSS.escape(focused)}"] .caption-select`,
      )?.focus();
      restoring = false;
    }
  }

  // The cue at the playhead gets a mark. This runs on each time update, so
  // it changes only two rows.
  function markCurrent() {
    const now = playhead();
    const row = rows.find(
      (r) => r.visibility !== "none" && now >= r.start && now < r.end,
    );
    const id = row?.id ?? null;
    if (id === currentId) return;
    for (const node of $("#caption-list").querySelectorAll(".current"))
      node.classList.remove("current");
    currentId = id;
    if (id)
      $(`.caption-row[data-id="${CSS.escape(id)}"]`)?.classList.add("current");
  }

  const editing = (node, force) =>
    !force && node === document.activeElement && node.dataset.dirty === "1";

  function renderPanel({ force = false } = {}) {
    if (!video) return;
    const state = captionState(video, capability);
    $("#caption-count").textContent = state.countText;
    $("#caption-audio").hidden = !state.audio;
    $("#caption-audio").textContent = state.audio;
    $("#caption-setup").hidden = !state.setup;
    $("#caption-setup").textContent = state.setup;
    const running = job?.videoId === video.id && jobView(job.status).running;
    const generate = $("#caption-generate");
    generate.disabled = !state.canGenerate || running;
    generate.textContent = capability
      ? state.generateLabel
      : "Checking speech recognition…";
    $("#caption-enabled").disabled = !state.exists;
    $("#caption-enabled").checked = state.enabled;
    $("#caption-remove").hidden = !state.exists;
    $("#caption-style").hidden = !state.exists;
    if (!state.style) return;
    const style = state.style;
    const size = $("#cap-size");
    if (!editing(size, force)) {
      size.value = String(round(style.size * 100));
      size.dataset.dirty = "";
    }
    $("#cap-position").value = positionOf(style);
    $("#cap-color").value = style.color.toLowerCase();
    $("#cap-bold").checked = style.bold;
    if (style.background !== "none")
      $("#cap-background").value = style.background.toLowerCase();
    $("#cap-background-none").checked = style.background === "none";
    const opacity = $("#cap-background-opacity");
    if (!editing(opacity, force)) {
      opacity.value = String(Math.round(style.backgroundOpacity * 100));
      opacity.dataset.dirty = "";
    }
    opacity.disabled = style.background === "none";
  }

  function renderJob() {
    const mine = job && video && job.videoId === video.id;
    $("#caption-job").hidden = !mine;
    if (!mine) return;
    const view = jobView(job.status);
    $("#caption-job").dataset.tone = view.tone;
    if ($("#caption-job-text").textContent !== view.text)
      $("#caption-job-text").textContent = view.text;
    const bar = $("#caption-progress");
    bar.hidden = !view.running;
    if (view.progress === null) bar.removeAttribute("value");
    else bar.value = view.progress;
    $("#caption-cancel").hidden = !view.canCancel;
    $("#caption-apply").hidden = !view.canApply;
  }

  function renderForm({ force = false } = {}) {
    const row = selected();
    form.hidden = !row;
    if (!row) return;
    const cue = cueOf(row.id);
    const index = rows.indexOf(row);
    $("#caption-cue-heading").textContent =
      `Caption ${index + 1} of ${rows.length}`;
    const text = $("#cap-text");
    if (!editing(text, force)) {
      text.value = cue.text;
      text.dataset.dirty = "";
    }
    for (const key of ["start", "end"]) {
      const input = $(`#cap-${key}`);
      if (editing(input, force)) continue;
      input.value = row.visibility === "none" ? "" : String(round(row[key]));
      input.dataset.dirty = "";
    }
    $("#cap-check").hidden = !row.check;
    $("#cap-check").textContent =
      "Check this caption. Speech recognition was not sure of a word, or a cut removed part of a word.";
    $("#cap-visibility").textContent =
      row.visibility === "none"
        ? "A cut or trim removed the speech of this caption, so it does not show. Set new times, delete it, or undo the cut."
        : row.visibility === "partial"
          ? "A cut removed part of the speech of this caption. The text is all of the recognized text. Check that it agrees with the speech that stays."
          : "";
  }

  // Generation. Existing captions are replaced only after a confirmation.
  // The confirmation keeps the exact scope that it shows. A change to the
  // selection or to "Only the selection" closes it, so Replace cannot send
  // a different scope.
  let confirmation = null;
  function scope() {
    if (!$("#caption-range-only").checked) return {};
    const { start, end, valid } = range();
    if (!valid) throw new Error("Set a valid range in Range first.");
    return { start, end };
  }
  function closeConfirmation() {
    confirmation = null;
    $("#caption-replace").hidden = true;
  }
  function generate(selected, replace) {
    if (!video) return;
    const id = video.id;
    const args = {
      id,
      apply: true,
      ...selected,
      ...(replace ? { replace: true } : {}),
    };
    closeConfirmation();
    queue(async () => {
      const status = await call("captions.generate", args);
      job = { jobId: status.jobId, videoId: id, status };
      renderJob();
      renderPanel();
      poll(status.jobId);
    }).catch((error) => notice(error.message, true));
  }
  $("#caption-generate").addEventListener("click", () => {
    if (!video) return;
    let selected;
    try {
      selected = scope();
    } catch (error) {
      return notice(error.message, true);
    }
    const { count } = captionState(video, capability);
    if (!count) return generate(selected, false);
    confirmation = { videoId: video.id, count, scope: selected };
    $("#caption-replace-text").textContent =
      selected.start !== undefined
        ? `New captions replace the captions in the selected range, ${round(selected.start)} to ${round(selected.end)} seconds. Other captions, labels, and shapes do not change. You can undo this.`
        : `New captions replace all ${count} captions. Labels and shapes do not change. You can undo this.`;
    $("#caption-replace").hidden = false;
    $("#caption-replace-yes").focus();
  });
  $("#caption-replace-yes").addEventListener("click", () => {
    if (confirmation && confirmation.videoId === video?.id)
      generate(confirmation.scope, true);
    else closeConfirmation();
  });
  $("#caption-replace-no").addEventListener("click", () => {
    closeConfirmation();
    $("#caption-generate").focus();
  });
  $("#caption-range-only").addEventListener("change", closeConfirmation);
  for (const id of ["#range-start", "#range-end"])
    $(id).addEventListener("input", closeConfirmation);

  // Polls one job until it ends. A newer job stops this loop.
  async function poll(jobId) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (job?.jobId !== jobId) return;
      let status;
      try {
        status = await call("captions.status", { jobId });
      } catch (error) {
        status = { state: "failed", message: error.message };
      }
      if (job?.jobId !== jobId) return;
      job.status = status;
      if (!jobView(status).running) return finish(jobId, status);
      renderJob();
    }
  }
  async function finish(jobId, status) {
    const { videoId } = job;
    if (status.state === "applied") {
      const latest = await call("library.get", { id: videoId }).catch(
        () => null,
      );
      if (job?.jobId !== jobId) return;
      // The user can have opened another video during recognition.
      if (latest) showVideo(latest, videoId);
    }
    if (video?.id === videoId) {
      renderJob();
      renderPanel();
      if (status.state === "applied") notice(status.message);
      if (status.state === "failed") notice(status.message, true);
    }
  }
  $("#caption-cancel").addEventListener("click", () => {
    const current = job;
    if (!current) return;
    call("captions.cancel", { jobId: current.jobId })
      .then((status) => {
        if (job === current) {
          job.status = status;
          renderJob();
        }
      })
      .catch((error) => notice(error.message, true));
  });
  // A draft: the video changed during recognition. Adding it is a new,
  // deliberate step that uses the current edits.
  $("#caption-apply").addEventListener("click", () => {
    const current = job;
    if (!current || video?.id !== current.videoId) return;
    queue(async () => {
      await call("captions.apply", { jobId: current.jobId });
      const status = await call("captions.status", { jobId: current.jobId });
      if (job !== current) return;
      job.status = status;
      await finish(current.jobId, status);
    }).catch((error) => notice(error.message, true));
  });

  // Track and style.
  $("#caption-enabled").addEventListener("change", () =>
    command("captions.configure", { enabled: $("#caption-enabled").checked }),
  );
  $("#caption-remove").addEventListener("click", () =>
    command("captions.remove", {}, { selectCue: () => null }).then(
      (result) =>
        result &&
        notice(
          `Removed ${result.removed} captions. Labels and shapes did not change. Undo with Ctrl+Z.`,
        ),
    ),
  );
  const style = (values) => command("captions.configure", values);
  const numberField = (input, convert) => {
    input.addEventListener("input", () => (input.dataset.dirty = "1"));
    const commit = () => {
      if (input.dataset.dirty !== "1") return;
      input.dataset.dirty = "";
      const value = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(value)) {
        notice("Enter a number.", true);
        return renderPanel({ force: true });
      }
      style(convert(value));
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
  };
  numberField($("#cap-size"), (value) => ({ size: round(value / 100) }));
  numberField($("#cap-background-opacity"), (value) => ({
    backgroundOpacity: round(value / 100),
  }));
  $("#cap-position").addEventListener("change", () => {
    const value = POSITIONS[$("#cap-position").value];
    if (value) style(value);
  });
  $("#cap-color").addEventListener("change", () =>
    style({ color: $("#cap-color").value.toUpperCase() }),
  );
  $("#cap-bold").addEventListener("change", () =>
    style({ bold: $("#cap-bold").checked }),
  );
  $("#cap-background").addEventListener("change", () =>
    style({ background: $("#cap-background").value.toUpperCase() }),
  );
  $("#cap-background-none").addEventListener("change", () =>
    style({
      background: $("#cap-background-none").checked
        ? "none"
        : $("#cap-background").value.toUpperCase(),
    }),
  );

  // Add a caption in the gap at the playhead.
  $("#caption-add").addEventListener("click", () => {
    if (!video) return;
    if (!isReady())
      return notice(
        "Wait for the preview. Then add a caption at the playhead.",
      );
    const gap = captionGap(rows, playhead(), total());
    if (gap.error === "inside")
      return notice(
        "A caption shows at the playhead. Move the playhead to a time without a caption, or change that caption.",
      );
    if (gap.error)
      return notice(
        "There is not sufficient time at the playhead for a caption. Move the playhead, or change the next caption.",
      );
    const { start, end } = gap;
    command(
      "captions.add",
      { text: "New caption", start, end },
      { selectCue: (result) => result?.cue?.id ?? null },
    ).then((result) => {
      // Only for the new caption. If the user selected another caption
      // during the add, its draft text and caret stay.
      const id = result?.cue?.id;
      if (id && selectedId === id) $("#cap-text").select();
    });
  });

  // Selected cue.
  function update(changes) {
    const row = selected();
    if (!row) return Promise.resolve();
    return command("captions.update", { cueId: row.id, ...changes });
  }
  const text = $("#cap-text");
  text.addEventListener("input", () => (text.dataset.dirty = "1"));
  text.addEventListener("change", () => {
    const cue = cueOf(selectedId);
    text.dataset.dirty = "";
    if (cue && text.value !== cue.text) update({ text: text.value });
  });
  // Ctrl+Enter saves the text. Enter makes a new line.
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      text.dispatchEvent(new Event("change"));
    }
  });
  for (const key of ["start", "end"]) {
    const input = $(`#cap-${key}`);
    input.addEventListener("input", () => (input.dataset.dirty = "1"));
    const commit = () => {
      const row = selected();
      if (!row || input.dataset.dirty !== "1") return;
      input.dataset.dirty = "";
      const value = Number(input.value);
      if (input.value.trim() === "" || !Number.isFinite(value)) {
        notice("Enter a number of seconds.", true);
        return renderForm({ force: true });
      }
      // A time within half of the shown step of the edited end is the end.
      update({ [key]: Math.abs(value - total()) < 0.0005 ? total() : value });
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commit();
    });
    $(`#cap-${key}-now`).addEventListener("click", () => {
      if (!isReady())
        return notice("Wait for the preview. Then use the playhead.");
      update({ [key]: Math.min(total(), round(playhead())) });
    });
  }
  function deleteSelected() {
    const row = selected();
    if (!row) return Promise.resolve();
    const index = rows.indexOf(row);
    return command(
      "captions.delete",
      { cueId: row.id },
      // Select the next caption, so Delete can continue through the list.
      { selectCue: () => rows[index]?.id ?? rows[index - 1]?.id ?? null },
    );
  }
  $("#cap-delete").addEventListener("click", () => deleteSelected());
  form.addEventListener("submit", (event) => event.preventDefault());

  return {
    render,
    clear,
    timeChanged: () => {
      if (video) markCurrent();
    },
    selected: () => selectedId,
    // Also without a selection, this makes a pending result unable to
    // select, for example when the user selects an element during an add.
    // Returns true if a caption was selected.
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
  };
}
