import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clock,
  clockTenths,
  libraryView,
  exportRows,
  finishedExports,
  recordingView,
  readableError,
  playheadValue,
  rangeCheck,
  saveState,
  shortcut,
  playbackBlock,
} from "../src/ui/view-model.js";

test("the playhead time shows tenths and does not run ahead", () => {
  assert.equal(clockTenths(0), "0:00.0");
  assert.equal(clockTenths(3.5), "0:03.5");
  assert.equal(clockTenths(1.99), "0:01.9");
  assert.equal(clockTenths(3661.25), "1:01:01.2");
  assert.equal(clockTenths(Number.NaN), "0:00.0");
});

test("the save state tells only what is true", () => {
  const state = (values) =>
    saveState({ saving: false, failed: false, dirty: false, ...values });
  assert.equal(state({}).text, "Saved");
  assert.equal(state({ saving: true }).text, "Saving…");
  assert.equal(state({ dirty: true }).text, "Not saved yet");
  assert.equal(state({ failed: true }).text, "Not saved");
  // A running save comes first. A field with a change comes before an old
  // failure, because it tells the user what to do.
  assert.equal(state({ saving: true, dirty: true }).state, "saving");
  assert.equal(state({ dirty: true, failed: true }).state, "dirty");
  for (const values of [
    {},
    { saving: true },
    { dirty: true },
    { failed: true },
  ])
    assert.ok(state(values).detail.length > 10);
});

test("zoom keys work in the editor and not in a text field or the library", () => {
  const editor = {
    view: "editor",
    ready: false,
    paused: true,
    seconds: 0,
    duration: 10,
    canUndo: false,
    canRedo: false,
  };
  const press = (key, values = {}) => ({ key, target: {}, ...values });
  assert.deepEqual(shortcut(press("+", { shiftKey: true }), editor), {
    local: "zoom-in",
  });
  assert.deepEqual(shortcut(press("="), editor), { local: "zoom-in" });
  assert.deepEqual(shortcut(press("-"), editor), { local: "zoom-out" });
  assert.deepEqual(shortcut(press("0"), editor), { local: "zoom-fit" });
  const text = { tagName: "INPUT", type: "number" };
  assert.equal(shortcut(press("-", { target: text }), editor), null);
  assert.equal(shortcut(press("0", { target: text }), editor), null);
  assert.equal(shortcut(press("0"), { ...editor, view: "library" }), null);
  assert.equal(shortcut(press("-", { ctrlKey: true }), editor), null);
});

test("clock shows minutes, seconds, and hours", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(9.9), "0:09");
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(clock(-3), "0:00");
  assert.equal(clock(NaN), "0:00");
});

test("library view separates an empty library from a search with no result", () => {
  const empty = libraryView({ total: 0, shown: 0, query: "" });
  assert.equal(empty.caption, "No videos");
  assert.equal(empty.empty.kind, "library");
  assert.match(empty.empty.title, /library is empty/);

  const all = libraryView({ total: 3, shown: 3, query: "  " });
  assert.equal(all.caption, "3 videos");
  assert.equal(all.empty, null);

  const one = libraryView({ total: 1, shown: 1, query: "" });
  assert.equal(one.caption, "1 video");

  const filtered = libraryView({ total: 3, shown: 1, query: "demo" });
  assert.equal(filtered.caption, "1 of 3 videos");
  assert.equal(filtered.empty, null);

  const missing = libraryView({ total: 3, shown: 0, query: " zzz " });
  assert.equal(missing.caption, "0 of 3 videos");
  assert.equal(missing.empty.kind, "search");
  assert.match(missing.empty.title, /zzz/);
  assert.doesNotMatch(missing.empty.title, / zzz /);
  assert.doesNotMatch(missing.empty.title, /library is empty/);
});

test("export rows show only file exports for the open video, newest first", () => {
  const jobs = [
    { id: "p", kind: "preview", state: "complete", videoId: "a" },
    { id: "i", kind: "inspection", state: "running", videoId: "a" },
    {
      id: "old",
      kind: "export",
      state: "complete",
      videoId: "a",
      path: "C:\\Videos\\demo.mp4",
      startedAt: "2026-10-31T10:00:00.000Z",
    },
    {
      id: "new",
      kind: "export",
      state: "failed",
      videoId: "a",
      path: "D:/out/second.mp4",
      error: "Disk full",
      startedAt: "2026-10-31T10:05:00.000Z",
    },
    {
      id: "running",
      kind: "export",
      state: "running",
      videoId: "b",
      path: "/tmp/other.mp4",
      startedAt: "2026-10-31T10:06:00.000Z",
    },
  ];
  const rows = exportRows(jobs, "a");
  assert.deepEqual(
    rows.map((row) => row.id),
    ["new", "old"],
  );
  assert.equal(rows[0].label, "Export failed");
  assert.equal(rows[0].error, "Disk full");
  assert.equal(rows[0].file, "second.mp4");
  assert.equal(rows[1].label, "Exported");
  assert.equal(rows[1].file, "demo.mp4");
  assert.equal(rows[1].folder, "C:\\Videos");
  assert.equal(exportRows(jobs, "b")[0].label, "Exporting");
  assert.ok(
    rows.every((row) => !Object.values(row).includes(undefined)),
    "A row must not show undefined values.",
  );
});

test("finished exports report each completed export once", () => {
  const known = new Map();
  const job = (state) => ({
    id: "e",
    kind: "export",
    state,
    videoId: "a",
    path: "C:/out/demo.mp4",
  });
  const old = {
    id: "before",
    kind: "export",
    state: "complete",
    path: "C:/out/old.mp4",
  };
  assert.deepEqual(finishedExports(known, [old, job("running")]), []);
  const inspection = { id: "i", kind: "inspection", state: "running" };
  finishedExports(known, [inspection]);
  const done = finishedExports(known, [
    old,
    job("complete"),
    { ...inspection, state: "complete" },
  ]);
  assert.deepEqual(
    done.map((row) => [row.id, row.state, row.file]),
    [["e", "complete", "demo.mp4"]],
  );
  assert.deepEqual(finishedExports(known, [old, job("complete")]), []);

  // A fast export can finish between two status reads.
  const since = Date.parse("2026-10-31T10:00:00.000Z");
  const fast = {
    id: "fast",
    kind: "export",
    state: "failed",
    path: "C:/out/fast.mp4",
    error: "Disk full",
    startedAt: "2026-10-31T10:00:02.000Z",
  };
  const fresh = new Map();
  assert.deepEqual(
    finishedExports(fresh, [old, fast], since).map((row) => row.id),
    ["fast"],
  );
  assert.deepEqual(finishedExports(fresh, [old, fast], since), []);
});

test("recording view gives one state label and the allowed controls", () => {
  const idle = recordingView({ state: "idle" });
  assert.equal(idle.active, false);

  const countdown = recordingView({ state: "countdown", remaining: 2 });
  assert.equal(countdown.active, true);
  assert.equal(countdown.label, "Starts in 2");
  assert.equal(countdown.canPause, false);
  assert.equal(countdown.canStop, false);
  assert.equal(countdown.canCancel, true);
  assert.equal(countdown.cancelLabel, "Cancel countdown");
  assert.equal(countdown.showTime, false);

  const starting = recordingView({ state: "starting" });
  assert.equal(starting.canCancel, false);
  assert.equal(starting.canStop, false);

  const recording = recordingView({ state: "recording" });
  assert.equal(recording.label, "Recording");
  assert.equal(recording.tone, "recording");
  assert.equal(recording.canPause, true);
  assert.equal(recording.pauseLabel, "Pause");
  assert.equal(recording.canStop, true);
  assert.equal(recording.cancelLabel, "Cancel recording");
  assert.equal(recording.showTime, true);

  const paused = recordingView({ state: "paused" });
  assert.equal(paused.label, "Paused");
  assert.equal(paused.pauseLabel, "Resume");
  assert.equal(paused.canPause, true);

  const failed = recordingView({ state: "failed", error: "Disk full" });
  assert.match(failed.label, /Recording failed/);
  assert.match(failed.label, /Disk full/);
  assert.equal(failed.canPause, false);
  assert.equal(failed.canStop, true);
  assert.equal(failed.canCancel, true);

  // Electron adds a transport prefix to errors from the main process.
  const wrapped = recordingView({
    state: "failed",
    error: "Error invoking remote method 'capture:chunk': Error: Disk full",
  });
  assert.equal(wrapped.label, "Recording failed: Disk full");
  assert.equal(wrapped.short, "Recording failed");
  assert.equal(wrapped.error, "Disk full");
  assert.equal(
    readableError("Error invoking remote method 'capture:start': Camera busy"),
    "Camera busy",
  );
  assert.equal(readableError("Disk full"), "Disk full");

  const stopped = recordingView({ state: "stopped" });
  assert.equal(stopped.canPause, false);
  for (const view of [countdown, starting, recording, paused, failed, stopped])
    assert.ok(view.detail.length > 0);
});

test("a stopped recording shows save progress, an import error, or cleanup after save", () => {
  // The service sets stopped before the import starts.
  const saving = recordingView({ state: "stopped", file: "pending.webm" });
  assert.equal(saving.label, "Saving");
  assert.equal(saving.short, "Saving");
  assert.equal(saving.canPause, false);
  assert.equal(saving.canStop, false);
  assert.equal(saving.canCancel, false);
  assert.doesNotMatch(saving.label + saving.detail, /not|fail/i);

  const importFailed = recordingView({
    state: "stopped",
    file: "pending.webm",
    error: "Import failed",
  });
  assert.equal(importFailed.label, "Not saved: Import failed");
  assert.equal(importFailed.short, "Not saved");
  assert.equal(importFailed.error, "Import failed");
  assert.equal(importFailed.canStop, true);
  assert.equal(importFailed.canCancel, true);

  // The import is complete. Only the recorder cleanup failed.
  const cleanup = recordingView({
    state: "stopped",
    file: "pending.webm",
    saved: { id: "video", title: "Demo" },
    error: "Cleanup failed",
  });
  assert.doesNotMatch(cleanup.label + cleanup.detail, /not saved|did not/i);
  assert.match(cleanup.label, /^Saved/);
  assert.equal(cleanup.error, "Cleanup failed");
  assert.equal(cleanup.label, `${cleanup.short}: ${cleanup.error}`);
  assert.match(cleanup.detail, /Demo/);
  assert.match(cleanup.detail, /library/);
  assert.match(cleanup.detail, /keeps the saved video/);
  assert.equal(cleanup.canStop, true);
  assert.equal(cleanup.canCancel, true);

  const finishing = recordingView({
    state: "stopped",
    file: "pending.webm",
    saved: { id: "video", title: "Demo" },
  });
  assert.equal(finishing.label, "Saving");
  assert.equal(finishing.canStop, false);
  assert.notEqual(saving.tone, importFailed.tone);
  assert.notEqual(cleanup.tone, importFailed.tone);
});

test("range values stay inside the edited duration at fractional speeds", () => {
  for (const total of [10 / 1.5, 10 / 0.75]) {
    // A playhead at or after the end gives the exact end.
    assert.equal(Number(playheadValue(total, total)), total);
    assert.equal(Number(playheadValue(total + 0.04, total)), total);
    assert.equal(Number(playheadValue(total - 0.001, total)), total);
    assert.equal(playheadValue(1.234, total), "1.23");
    assert.equal(playheadValue(-1, total), "0");
    assert.ok(Number(playheadValue(total - 0.02, total)) <= total);

    // The message maximum and the exact end are accepted values.
    const exact = rangeCheck("1", String(total), total);
    assert.equal(exact.valid, true);
    assert.equal(exact.end, total);
    const shown = rangeCheck("1", exact.maximum, total);
    assert.equal(shown.valid, true, `Maximum ${exact.maximum}.`);
    assert.ok(shown.end <= total);
    assert.equal(rangeCheck("1", String(total + 0.02), total).valid, false);
    assert.equal(rangeCheck("0", String(total), total).full, true);
    assert.equal(rangeCheck("2", "1", total).valid, false);
    assert.equal(rangeCheck("", "1", total).valid, false);
  }
  assert.equal(rangeCheck("1", "6.67", 10 / 1.5).end, 10 / 1.5);
});

test("the displayed maximum is accepted at a floating point rounding boundary", () => {
  // 5.35 seconds at 2x speed. The end is 2.675 seconds. The message shows
  // 2.68, but 2.675 + 0.005 is 2.6799999999999997 in floating point.
  const total = 5.35 / 2;
  const message = rangeCheck("0.5", "99", total);
  assert.equal(message.valid, false);
  assert.equal(message.maximum, "2.68");
  const advertised = rangeCheck("0.5", message.maximum, total);
  assert.equal(advertised.valid, true, "The shown maximum must be accepted.");
  assert.equal(advertised.end, total, "The exact end is sent to the edit.");
  assert.equal(advertised.full, false);
  assert.equal(rangeCheck("0", message.maximum, total).full, true);
  assert.equal(rangeCheck("0.5", String(total), total).end, total);
  // Values after the half step remain outside the accepted range.
  assert.equal(rangeCheck("0.5", "2.681", total).valid, false);
  assert.equal(rangeCheck("0.5", "2.69", total).valid, false);
  assert.equal(rangeCheck("0.5", String(total + 0.0051), total).valid, false);

  // The same rules apply to other durations and speeds.
  for (const seconds of [1.005, 2.675, 5.35, 10, 13.37, 59.995, 100.125])
    for (const speed of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
      const end = seconds / speed;
      const { maximum } = rangeCheck("0", "", end);
      const shown = rangeCheck("0", maximum, end);
      assert.equal(shown.valid, true, `${seconds} at ${speed}x: ${maximum}`);
      assert.ok(shown.end <= end);
      // Just after the half step is outside the accepted range.
      assert.equal(
        rangeCheck("0", String(end + 0.0051), end).valid,
        false,
        `${seconds} at ${speed}x: ${end + 0.0051}`,
      );
      assert.equal(rangeCheck("0", String(end + 0.006), end).valid, false);
    }
});

test("keyboard shortcuts use shared commands and keep native keys", () => {
  const key = (key, extra = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: "BODY" },
    ...extra,
  });
  const editor = {
    view: "editor",
    ready: true,
    paused: true,
    seconds: 3,
    duration: 10,
    fullscreen: false,
    canUndo: true,
    canRedo: false,
  };
  assert.deepEqual(shortcut(key(" "), editor), { command: "playback.play" });
  assert.deepEqual(shortcut(key("k"), { ...editor, paused: false }), {
    command: "playback.pause",
  });
  assert.deepEqual(shortcut(key("ArrowRight"), editor), {
    command: "playback.seek",
    args: { seconds: 8 },
  });
  assert.deepEqual(shortcut(key("ArrowRight"), { ...editor, seconds: 8 }), {
    command: "playback.seek",
    args: { seconds: 10 },
  });
  assert.deepEqual(shortcut(key("ArrowLeft"), editor), {
    command: "playback.seek",
    args: { seconds: 0 },
  });
  assert.deepEqual(shortcut(key("ArrowLeft", { shiftKey: true }), editor), {
    command: "playback.seek",
    args: { seconds: 2 },
  });
  assert.deepEqual(shortcut(key("z", { ctrlKey: true }), editor), {
    command: "edit.undo",
  });
  assert.equal(shortcut(key("y", { ctrlKey: true }), editor), null);
  assert.deepEqual(
    shortcut(key("Z", { ctrlKey: true, shiftKey: true }), {
      ...editor,
      canRedo: true,
    }),
    { command: "edit.redo" },
  );
  assert.deepEqual(
    shortcut(key("y", { ctrlKey: true }), { ...editor, canRedo: true }),
    { command: "edit.redo" },
  );
  assert.deepEqual(shortcut(key("i"), editor), { local: "range-start" });
  assert.deepEqual(shortcut(key("o"), editor), { local: "range-end" });
  assert.deepEqual(shortcut(key("s"), editor), { local: "split" });
  assert.equal(shortcut(key("s"), { ...editor, ready: false }), null);
  assert.equal(shortcut(key("s", { ctrlKey: true }), editor), null);
  assert.deepEqual(shortcut(key("f"), editor), {
    command: "playback.fullscreen",
    args: { enabled: true },
  });
  assert.deepEqual(shortcut(key("f"), { ...editor, fullscreen: true }), {
    command: "playback.fullscreen",
    args: { enabled: false },
  });

  const text = { tagName: "INPUT", type: "text" };
  assert.equal(shortcut(key(" ", { target: text }), editor), null);
  assert.equal(shortcut(key("i", { target: text }), editor), null);
  assert.equal(
    shortcut(key("z", { ctrlKey: true, target: text }), editor),
    null,
  );
  assert.equal(
    shortcut(
      key("ArrowRight", { target: { tagName: "INPUT", type: "range" } }),
      editor,
    ),
    null,
  );
  assert.equal(
    shortcut(key("ArrowRight", { target: { tagName: "SELECT" } }), editor),
    null,
  );
  assert.equal(
    shortcut(key(" ", { target: { tagName: "BUTTON" } }), editor),
    null,
  );
  assert.equal(
    shortcut(
      key(" ", { target: { tagName: "INPUT", type: "checkbox" } }),
      editor,
    ),
    null,
  );
  assert.equal(shortcut(key("ArrowRight"), { ...editor, ready: false }), null);
  assert.equal(shortcut(key(" "), { ...editor, ready: false }), null);
  assert.equal(shortcut(key(" "), { ...editor, dialog: true }), null);
  assert.equal(shortcut(key("f", { altKey: true }), editor), null);

  const library = { view: "library" };
  assert.deepEqual(shortcut(key("/"), library), { local: "search" });
  assert.deepEqual(shortcut(key("f", { ctrlKey: true }), library), {
    local: "search",
  });
  assert.equal(shortcut(key("/", { target: text }), library), null);
  assert.equal(shortcut(key(" "), library), null);
  assert.equal(shortcut(key("z", { ctrlKey: true }), library), null);
});

test("keys on an editing tool tab move between tabs and do not seek", () => {
  const editor = {
    view: "editor",
    ready: true,
    paused: true,
    seconds: 3,
    duration: 10,
    fullscreen: false,
    canUndo: true,
    canRedo: true,
  };
  const tab = {
    tagName: "BUTTON",
    getAttribute: (name) => (name === "role" ? "tab" : null),
  };
  const key = (name, target = tab) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target,
  });
  for (const name of ["ArrowLeft", "ArrowRight", "Home", "End"])
    assert.equal(shortcut(key(name), editor), null, name);
  // Shift+arrow and Space on a tab are not playback keys either.
  assert.equal(
    shortcut({ ...key("ArrowRight"), shiftKey: true }, editor),
    null,
  );
  assert.equal(shortcut(key(" "), editor), null);
  // Other editor keys still work on a tab.
  assert.deepEqual(shortcut(key("i"), editor), { local: "range-start" });
  assert.deepEqual(shortcut({ ...key("z"), ctrlKey: true }, editor), {
    command: "edit.undo",
  });
  // The same arrow key on another button seeks.
  assert.deepEqual(shortcut(key("ArrowRight", { tagName: "BUTTON" }), editor), {
    command: "playback.seek",
    args: { seconds: 8 },
  });
});

test("Delete removes the selected element only outside text fields and dialogs", () => {
  const key = (name, target = { tagName: "BODY" }) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target,
  });
  const editor = {
    view: "editor",
    ready: false,
    paused: true,
    seconds: 0,
    duration: 10,
    selected: "a",
  };
  // The preview does not need to be ready to delete an element.
  for (const name of ["Delete", "Backspace"])
    assert.deepEqual(shortcut(key(name), editor), { local: "delete-element" });
  assert.deepEqual(shortcut(key("Delete", { tagName: "BUTTON" }), editor), {
    local: "delete-element",
  });
  for (const target of [
    { tagName: "INPUT", type: "text" },
    { tagName: "INPUT", type: "number" },
    { tagName: "TEXTAREA" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
  ])
    assert.equal(shortcut(key("Delete", target), editor), null);
  assert.equal(shortcut(key("Delete"), { ...editor, selected: null }), null);
  assert.equal(shortcut(key("Delete"), { ...editor, dialog: true }), null);
  assert.equal(shortcut(key("Delete"), { ...editor, view: "library" }), null);
  // F2 opens the text box of the selection, with the preview ready or not.
  assert.deepEqual(shortcut(key("F2"), editor), { local: "edit-text" });
  assert.equal(shortcut(key("F2"), { ...editor, selected: null }), null);
  assert.equal(shortcut(key("F2", { tagName: "TEXTAREA" }), editor), null);
  assert.equal(shortcut(key("F2"), { ...editor, view: "library" }), null);
});

// Review U1: the picture of a text session or of a saved draft is a still
// frame. Play and seek wait until the exact preview is on the screen, also in
// the time after its data loads and before the draft view goes.
test("playback waits for the picture that is on the screen", () => {
  const ready = { ready: true, typing: false, holding: false };
  for (const action of ["play", "seek"]) {
    assert.equal(playbackBlock(action, ready), null);
    assert.match(
      playbackBlock(action, { ...ready, typing: true }),
      /text edit is open/,
    );
    assert.match(
      playbackBlock(action, { ...ready, holding: true }),
      /being prepared/,
    );
    assert.match(
      playbackBlock(action, { ...ready, ready: false }),
      /being prepared/,
    );
    // An open session tells what to do, also while a render runs.
    assert.match(
      playbackBlock(action, { ready: false, typing: true, holding: true }),
      /text edit is open/,
    );
  }
  for (const action of ["pause", "configure", "fullscreen", "open"])
    assert.equal(
      playbackBlock(action, { ready: false, typing: true, holding: true }),
      null,
    );
});
