import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp, access } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Media } from "../src/adapters/media.js";

test(
  "desktop screen recorder lifecycle saves media, edits, and exports",
  { timeout: 90000 },
  async (t) => {
    await access("src/desktop/main.js");
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "desktop-"));
    const app = await _electron.launch({
      args: ["."],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    app.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    page.on("pageerror", (error) => process.stderr.write(error.message + "\n"));
    t.after(async () => {
      if (!page.isClosed())
        process.stderr.write(
          "App message: " +
            (await page.locator("#message").textContent()) +
            "\n",
        );
    });
    await page.waitForSelector("h1");
    assert.match(
      await page.locator("#library-view h1").innerText(),
      /Your video workspace/,
    );
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    const sources = await call("capture.sources");
    await assert.rejects(
      () => call("playback.fullscreen", { enabled: true }),
      /Open a video/,
    );
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
          .isFullScreen(),
      ),
      false,
    );
    assert.ok(sources.length > 0);
    await page
      .locator("#source")
      .selectOption(sources.find((s) => s.id.startsWith("screen:")).id);
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector("#record-status")
        .textContent.includes("Recording"),
    );
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector("#record-status").textContent.includes("Paused"),
    );
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await page
      .getByRole("button", { name: "Stop and save", exact: true })
      .click();
    await page.waitForSelector("#editor:not([hidden])");
    const videos = await call("library.list");
    assert.equal(videos.length, 1);
    assert.ok(videos[0].metadata.duration > 1);
    await call("edit.trim", { id: videos[0].id, start: 0.25, end: 1.25 });
    const job = await call("export.start", {
      id: videos[0].id,
      path: path.join(root, "result.mp4"),
    });
    let result;
    for (let i = 0; i < 100; i++) {
      result = await call("export.status", { jobId: job.id });
      if (result.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(result.state, "complete", JSON.stringify(result));
    assert.ok(Math.abs(result.result.metadata.duration - 1) < 0.2);
    const opened = await call("playback.open", { id: videos[0].id });
    assert.equal(typeof opened.ready, "boolean");
    for (let i = 0; i < 150; i++) {
      if ((await call("playback.status")).ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await call("playback.status")).ready, true);
    assert.match(await page.locator("#player").getAttribute("src"), /previews/);
    await call("playback.seek", { seconds: 0.5 });
    assert.ok(Math.abs((await call("playback.status")).seconds - 0.5) < 0.05);
    await call("playback.play");
    await call("playback.pause");
    await page.locator("#preview-seek").fill("0.6");
    await page.locator("#preview-seek").dispatchEvent("change");
    assert.ok(Math.abs((await call("playback.status")).seconds - 0.6) < 0.05);
    await call("playback.configure", { volume: 0.25 });
    assert.equal((await call("playback.status")).volume, 0.25);
    await call("playback.fullscreen", { enabled: true });
    assert.equal(
      await page
        .locator(".player-shell")
        .evaluate((element) => element.classList.contains("fullscreen")),
      true,
    );
    await call("app.view", { view: "library" });
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
          .isFullScreen(),
      ),
      false,
    );
    await call("playback.fullscreen", { enabled: false });
    assert.equal(await page.locator("#library-view").isVisible(), true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
        .setSize(1000, 760),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/desktop.png" });
  },
);

test(
  "camera and microphone test devices record visible frames and audio",
  { timeout: 60000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "devices-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    const devices = await call("capture.devices");
    assert.ok(devices.some((d) => d.kind === "videoinput"));
    await call("recording.start", {
      cameraOnly: true,
      microphoneId: "default",
      title: "Camera test",
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const video = await call("recording.stop");
    assert.equal(video.metadata.hasAudio, true);
    assert.ok(video.metadata.duration > 1);
    const frame = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "0.5",
      "-i",
      video.path,
      "-vf",
      "scale=1:1,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(frame[0] > 15, `Frame is too dark: ${frame[0]}`);
    const job = await call("export.start", {
      id: video.id,
      path: path.join(root, "camera.mp4"),
    });
    let result;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await call("export.status", { jobId: job.id });
    } while (result.state === "running");
    assert.equal(result.state, "complete", result.error);
    assert.equal((await new Media().probe(result.result.path)).hasAudio, true);
    await call("playback.open", { id: video.id });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
        .setSize(1000, 760),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/editor-min.png" });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("command");
      ipcMain.handle("command", () => {
        throw new Error("Cannot delete during export");
      });
    });
    await page.locator("#delete").click();
    await page.locator("#confirm-delete-button").click();
    await page.waitForFunction(() =>
      document.querySelector("#message").textContent.includes("Cannot delete"),
    );
    assert.ok(await page.locator("#player").getAttribute("src"));
  },
);

test(
  "cancel releases the recorder after a disk write fails",
  { timeout: 60000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "disk-error-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("capture:chunk");
      ipcMain.handle("capture:chunk", () => {
        throw new Error("Disk full");
      });
    });
    await call("recording.start", { cameraOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await assert.rejects(() => call("recording.stop"), /Disk full/);
    await call("recording.cancel");
    assert.equal((await call("app.status")).recording.state, "idle");
  },
);

test(
  "an ended input saves the recording and releases its devices",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "ended-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    await call("recording.start", { cameraOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const worker = app
      .windows()
      .find((page) => page.url().endsWith("/capture.html"));
    await worker.evaluate(() =>
      streams[0].getVideoTracks()[0].dispatchEvent(new Event("ended")),
    );
    let status;
    for (let i = 0; i < 40; i++) {
      status = await call("app.status");
      if (status.recording.state === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.recording.state, "idle");
    assert.equal((await call("library.list")).length, 1);
  },
);

test(
  "screen recordings include visible camera overlay frames",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "overlay-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    const sources = await call("capture.sources");
    await call("recording.start", {
      sourceId: sources.find((s) => s.id.startsWith("screen:")).id,
      cameraId: "default",
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const worker = app
      .windows()
      .find((page) => page.url().endsWith("/capture.html"));
    const video = await call("recording.stop");
    const frames = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      video.path,
      "-vf",
      "crop=iw*0.12:ih*0.12:iw*0.86:ih*0.82,scale=1:1,format=gray",
      "-an",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(
      [...frames].some((value) => value > 15),
      "The camera overlay has no visible content.",
    );
  },
);

test(
  "an input that ends during startup fails without leaving an active recorder",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "early-end-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
      env: { ...process.env, MIDNIGHT_DATA: root },
    });
    t.after(async () => {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    });
    const page =
      app.windows().find((page) => page.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (page) => {
          await page.waitForLoadState();
          return page.url().endsWith("/ui/index.html");
        },
      }));
    const worker = app
      .windows()
      .find((page) => page.url().endsWith("/capture.html"));
    await worker.evaluate(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (options) => {
        const stream = await original(options);
        stream.getTracks().forEach((track) => track.stop());
        return stream;
      };
    });
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    await assert.rejects(
      () => call("recording.start", { cameraOnly: true }),
      /input.*ended/i,
    );
    assert.equal((await call("app.status")).recording.state, "idle");
  },
);
