import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  dialog,
  session,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Service } from "../application/service.js";
import { Library } from "../adapters/library.js";
import { Media } from "../adapters/media.js";
import { serve } from "../agent/server.js";
import { dataRoot } from "../agent/client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = dataRoot();
app.setPath("userData", path.join(root, "electron"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (process.platform === "win32") {
  // The D3D11 camera path can crash during screen and camera capture.
  const disabled = app.commandLine.getSwitchValue("disable-features");
  app.commandLine.appendSwitch(
    "disable-features",
    [disabled, "MediaFoundationD3D11VideoCapture"].filter(Boolean).join(","),
  );
}
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      let ui;
      const worker = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(here, "capture-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      const pending = new Map();
      const rpc = (action, args = {}) =>
        new Promise((resolve, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Recorder did not respond to ${action}.`));
          }, 60000);
          pending.set(id, { resolve, reject, timer });
          worker.webContents.send("capture:request", { id, action, args });
        });
      ipcMain.on("capture:reply", (event, { id, result, error }) => {
        if (event.sender !== worker.webContents || !pending.has(id)) return;
        const request = pending.get(id);
        pending.delete(id);
        clearTimeout(request.timer);
        if (error) request.reject(new Error(error));
        else request.resolve(result);
      });
      let selected,
        file,
        stream,
        stopped = false,
        writeError;
      ipcMain.handle("capture:chunk", async (event, bytes) => {
        if (event.sender !== worker.webContents || !stream)
          throw new Error("Recorder stream is unavailable.");
        if (writeError) throw writeError;
        await new Promise((resolve, reject) =>
          stream.write(Buffer.from(bytes), (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      });
      const sources = async () =>
        (
          await desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 180 },
          })
        ).map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        }));
      session.defaultSession.setPermissionRequestHandler(
        (contents, permission, callback) =>
          callback(
            contents === worker.webContents &&
              ["media", "display-capture"].includes(permission),
          ),
      );
      session.defaultSession.setPermissionCheckHandler(
        (contents, permission) =>
          contents === worker.webContents &&
          ["media", "display-capture"].includes(permission),
      );
      session.defaultSession.setDisplayMediaRequestHandler(
        async (request, callback) => {
          try {
            if (request.frame !== worker.webContents.mainFrame)
              return callback({});
            const source = (
              await desktopCapturer.getSources({ types: ["screen", "window"] })
            ).find((s) => s.id === selected?.sourceId);
            if (!source) return callback({});
            callback({
              video: source,
              ...(selected.systemAudio ? { audio: "loopback" } : {}),
            });
          } catch {
            callback({});
          }
        },
      );
      const closeStream = async () => {
        if (!stream) return;
        const current = stream;
        stream = null;
        if (writeError) {
          current.destroy();
          throw writeError;
        }
        await new Promise((resolve, reject) =>
          current.end((error) => (error ? reject(error) : resolve())),
        );
      };
      const capture = {
        sources,
        devices: () => rpc("devices"),
        start: async (options) => {
          selected = options;
          stopped = false;
          writeError = null;
          await mkdir(path.join(root, "pending"), { recursive: true });
          file = path.join(root, "pending", randomUUID() + ".webm");
          stream = createWriteStream(file, { flags: "wx" });
          stream.on("error", (error) => {
            writeError = error;
          });
          try {
            return await rpc("start", options);
          } catch (error) {
            await capture.cancel();
            throw error;
          }
        },
        pause: () => rpc("pause"),
        resume: () => rpc("resume"),
        stop: async () => {
          if (!stopped) {
            await rpc("stop");
            stopped = true;
            await closeStream();
          }
          if (writeError) throw writeError;
          return file;
        },
        cancel: async () => {
          try {
            await rpc("cancel");
          } finally {
            await closeStream().catch(() => {});
            if (file) await rm(file, { force: true });
            file = null;
            stopped = false;
          }
        },
      };
      await worker.loadFile(path.join(here, "capture.html"));
      const playbackPending = new Map();
      const playback = {
        request: async (action, args) => {
          if (action === "fullscreen") ui.setFullScreen(args.enabled);
          return new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(() => {
              playbackPending.delete(id);
              reject(new Error("The video preview did not respond."));
            }, 20000);
            playbackPending.set(id, { resolve, reject, timer });
            ui.webContents.send("playback:request", { id, action, args });
          });
        },
      };
      const service = new Service({
        library: new Library(root),
        media: new Media({
          ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
          ffprobe: process.env.FFPROBE_PATH || "ffprobe",
        }),
        capture,
        playback,
      });
      ipcMain.on("capture:ended", (event) => {
        if (
          event.sender !== worker.webContents ||
          !["recording", "paused"].includes(service.recording.state)
        )
          return;
        service.execute("recording.stop").then(
          () =>
            ui.webContents.send(
              "notice",
              "The recording input ended. The app saved your video.",
            ),
          (error) =>
            ui.webContents.send(
              "notice",
              `The recording input ended. Select Stop and save to retry. ${error.message}`,
            ),
        );
      });
      const server = await serve(service, root);
      ui = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 1000,
        minHeight: 720,
        backgroundColor: "#1e2127",
        title: "Midnight Recorder",
        webPreferences: {
          preload: path.join(here, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      ui.setMenuBarVisibility(false);
      const trusted = (event) => {
        if (event.sender !== ui.webContents)
          throw new Error("Unknown app window.");
      };
      ipcMain.on("playback:reply", (event, { id, result, error }) => {
        trusted(event);
        const pending = playbackPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        playbackPending.delete(id);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
      });
      ipcMain.handle("command", (event, name, args) => {
        trusted(event);
        return service.execute(name, args);
      });
      ipcMain.handle("pick-import", async (event) => {
        trusted(event);
        return (
          (
            await dialog.showOpenDialog(ui, {
              properties: ["openFile"],
              filters: [
                { name: "Video", extensions: ["mp4", "webm", "mov", "mkv"] },
              ],
            })
          ).filePaths[0] || null
        );
      });
      ipcMain.handle("pick-export", async (event, title) => {
        trusted(event);
        return (
          (
            await dialog.showSaveDialog(ui, {
              defaultPath: path.join(
                root,
                "exports",
                title.replace(/[<>:"/\\|?*]/g, "_") + ".mp4",
              ),
              filters: [{ name: "MP4 video", extensions: ["mp4"] }],
            })
          ).filePath || null
        );
      });
      ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      ui.webContents.on("will-navigate", (event) => event.preventDefault());
      ui.on("close", (event) => {
        if (
          service.recording.state !== "idle" ||
          [...service.jobs.values()].some((j) => j.state === "running")
        ) {
          event.preventDefault();
          ui.webContents.send(
            "notice",
            "Stop or cancel the recording and wait for exports before closing.",
          );
        }
      });
      ui.on("closed", () => {
        server.close();
        worker.destroy();
        app.quit();
      });
      app.on("second-instance", () => {
        ui.show();
        ui.focus();
      });
      await ui.loadFile(path.join(here, "../ui/index.html"));
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
