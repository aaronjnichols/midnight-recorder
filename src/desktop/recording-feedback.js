import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// This adapter owns only the native indicator. The service owns recording state.
export class RecordingFeedback {
  constructor({ BrowserWindow, screen, sources, onError = console.error }) {
    Object.assign(this, { BrowserWindow, screen, sources, onError });
    this.windows = new Map();
    this.ready = new Set();
    this.recording = { state: "idle" };
    this.onMetrics = () => {
      for (const display of screen.getAllDisplays()) {
        this.windows.get(String(display.id))?.setBounds(display.bounds);
      }
    };
    this.onRemoved = (_, display) => {
      const win = this.windows.get(String(display.id));
      win?.destroy();
      this.ready.delete(win);
      this.windows.delete(String(display.id));
    };
    this.onAdded = (_, display) => {
      if (
        this.allDisplays &&
        (this.preparing || this.recording.state !== "idle")
      )
        this.addDisplay(display).catch(this.onError);
    };
    screen.on("display-metrics-changed", this.onMetrics);
    screen.on("display-removed", this.onRemoved);
    screen.on("display-added", this.onAdded);
  }

  async prepare(options) {
    this.clear();
    this.allDisplays = true;
    let displays = this.screen.getAllDisplays();
    if (!options.cameraOnly && options.sourceId?.startsWith("screen:")) {
      const source = (await this.sources()).find(
        (s) => s.id === options.sourceId,
      );
      if (!source)
        throw new Error("The capture screen is no longer available.");
      // Some capture backends do not return a display ID. In that case, mark all displays.
      if (source.displayId) {
        this.allDisplays = false;
        displays = displays.filter((d) => String(d.id) === source.displayId);
        if (!displays.length)
          throw new Error("The capture display is no longer available.");
      }
    }
    // Refresh after source lookup. Display events can arrive while windows load.
    if (this.allDisplays) displays = this.screen.getAllDisplays();
    this.preparing = true;
    try {
      for (const display of displays) await this.addDisplay(display);
    } catch (error) {
      this.clear();
      throw error;
    } finally {
      this.preparing = false;
    }
  }

  async addDisplay(display) {
    const id = String(display.id);
    if (this.windows.has(id)) return;
    const win = new this.BrowserWindow({
      ...display.bounds,
      title: "Midnight recording indicator",
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      thickFrame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: path.join(here, "recording-feedback-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.windows.set(id, win);
    win.setContentProtection(true);
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    try {
      await win.loadFile(path.join(here, "recording-feedback.html"));
    } catch (error) {
      if (win.isDestroyed()) return;
      this.windows.delete(id);
      win.destroy();
      throw error;
    }
    // Cancel or display removal can close this window while it loads.
    if (win.isDestroyed()) return;
    this.ready.add(win);
    // Apply full display bounds after load. Do not use the work area, which excludes the taskbar.
    win.setBounds(
      this.screen.getAllDisplays().find((d) => String(d.id) === id)?.bounds ||
        display.bounds,
    );
    this.showState(win);
  }

  update(recording) {
    if (
      !["countdown", "starting", "recording", "paused"].includes(
        recording.state,
      )
    ) {
      this.clear();
      return;
    }
    this.recording = { ...recording };
    for (const win of this.ready) this.showState(win);
  }

  showState(win) {
    const recording = this.recording;
    if (["idle", "starting"].includes(recording.state)) win.hide();
    else {
      win.webContents.send("recording-feedback", {
        state: recording.state,
        remaining: recording.remaining,
      });
      win.showInactive();
    }
  }

  clear() {
    this.preparing = false;
    this.recording = { state: "idle" };
    this.allDisplays = false;
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    this.ready.clear();
  }

  dispose() {
    this.clear();
    this.screen.removeListener("display-metrics-changed", this.onMetrics);
    this.screen.removeListener("display-removed", this.onRemoved);
    this.screen.removeListener("display-added", this.onAdded);
  }
}
