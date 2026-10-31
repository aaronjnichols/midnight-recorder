import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RecordingFeedback } from "../src/desktop/recording-feedback.js";

test("feedback selects the capture monitor and does not intercept input", async () => {
  const displays = [
    { id: 10, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 20, bounds: { x: 0, y: 0, width: 1536, height: 864 } },
  ];
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [...displays];
  const created = [];
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_, state) => {
        this.state = state;
      };
      created.push(this);
    }
    setBounds(bounds) {
      this.bounds = bounds;
    }
    setContentProtection(value) {
      this.protected = value;
    }
    setIgnoreMouseEvents(value) {
      this.ignoreMouse = value;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    async loadFile() {}
    hide() {
      this.visible = false;
    }
    showInactive() {
      this.visible = true;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return !!this.destroyed;
    }
  }
  const feedback = new RecordingFeedback({
    BrowserWindow: Window,
    screen,
    sources: async () => [
      { id: "screen:other", displayId: "20" },
      { id: "screen:unknown", displayId: "" },
    ],
  });
  await feedback.prepare({ sourceId: "screen:other" });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].bounds, displays[1].bounds);
  assert.equal(created[0].protected, true);
  assert.equal(created[0].ignoreMouse, true);
  assert.equal(created[0].options.focusable, false);
  feedback.update({ state: "countdown", remaining: 3 });
  assert.equal(created[0].visible, true);
  feedback.update({ state: "starting" });
  assert.equal(created[0].visible, false);
  feedback.update({ state: "recording" });
  assert.equal(created[0].visible, true);
  displays[1].bounds = { x: 0, y: 0, width: 1280, height: 720 };
  screen.emit("display-metrics-changed");
  assert.deepEqual(created[0].bounds, displays[1].bounds);
  feedback.update({ state: "idle" });
  assert.equal(created[0].destroyed, true);
  let releaseFirst;
  let loads = 0;
  Window.prototype.loadFile = () =>
    ++loads === 1
      ? new Promise((resolve) => {
          releaseFirst = resolve;
        })
      : Promise.resolve();
  const preparing = feedback.prepare({ cameraOnly: true });
  const earlyDisplay = {
    id: 40,
    bounds: { x: 1280, y: 0, width: 1280, height: 720 },
  };
  displays.push(earlyDisplay);
  screen.emit("display-added", {}, earlyDisplay);
  releaseFirst();
  await preparing;
  feedback.update({ state: "recording" });
  assert.equal(
    feedback.windows.size,
    3,
    "A monitor connected during window load needs an indicator.",
  );
  assert.equal(feedback.windows.get("40").visible, true);
  displays.pop();
  Window.prototype.loadFile = async () => {};
  await feedback.prepare({ sourceId: "screen:unknown" });
  assert.equal(feedback.windows.size, 2);
  await feedback.prepare({ sourceId: "window:1" });
  assert.equal(feedback.windows.size, 2);
  feedback.update({ state: "recording" });
  const added = {
    id: 30,
    bounds: { x: 1280, y: 0, width: 1920, height: 1080 },
  };
  displays.push(added);
  screen.emit("display-added", {}, added);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feedback.windows.size, 3);
  assert.equal(created.at(-1).state.state, "recording");
  assert.equal(created.at(-1).visible, true);
  screen.emit("display-removed", {}, added);
  assert.equal(feedback.windows.size, 2);
  assert.equal(created.at(-1).destroyed, true);
  displays.pop();

  // A display that finishes loading after Cancel must stay closed.
  let finishLoad;
  Window.prototype.loadFile = () =>
    new Promise((resolve) => {
      finishLoad = resolve;
    });
  screen.emit("display-added", {}, added);
  feedback.update({ state: "idle" });
  finishLoad();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(feedback.windows.size, 0);
  assert.equal(created.at(-1).destroyed, true);
  assert.notEqual(created.at(-1).visible, true);
  Window.prototype.loadFile = async () => {};
  await feedback.prepare({ cameraOnly: true });
  assert.equal(feedback.windows.size, 2);
  await assert.rejects(
    feedback.prepare({ sourceId: "screen:gone" }),
    /no longer available/,
  );
  assert.equal(feedback.windows.size, 0);
  feedback.dispose();
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(screen.listenerCount("display-added"), 0);
});
