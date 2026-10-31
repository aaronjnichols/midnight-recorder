import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

test(
  "missing capture thumbnails show a clear fallback",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "thumbnail-"));
    const app = await _electron.launch({
      args: ["."],
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
    await page.waitForSelector("#source option", { state: "attached" });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("command");
      ipcMain.handle("command", (_, name) => {
        if (name === "capture.sources")
          return [{ id: "screen:test", name: "Test screen", thumbnail: null }];
        if (name === "app.status")
          return { recording: { state: "idle" }, jobs: [] };
        return [];
      });
    });
    await page.locator("#refresh-sources").click();
    await page.waitForTimeout(100);
    assert.match(
      await page.locator("#source-preview").innerText(),
      /Preview unavailable/,
    );
    assert.equal(await page.locator("#source-preview img").count(), 0);
  },
);

test(
  "a delayed video reply cannot reopen the editor after Library is selected",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "view-race-"));
    const source = path.join(root, "source.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=320x240:duration=1",
      "-c:v",
      "libx264",
      source,
    ]);
    const app = await _electron.launch({
      args: ["."],
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
    const video = await page.evaluate(
      (path) => window.midnight.execute("library.import", { path }),
      source,
    );
    await page.waitForSelector(".video-card");
    await app.evaluate(({ ipcMain }, video) => {
      ipcMain.removeHandler("command");
      ipcMain.handle("command", (_, name) => {
        if (name === "library.get")
          return new Promise((resolve) => {
            globalThis.releaseVideo = () => resolve(video);
          });
        if (name === "app.status")
          return { recording: { state: "idle" }, jobs: [] };
        if (name === "library.list") return [video];
        return [];
      });
    }, video);
    await page.locator(".video-card").click();
    await page.locator("#library-nav").click();
    await app.evaluate(() => globalThis.releaseVideo());
    await page.waitForTimeout(150);
    assert.equal(await page.locator("#library-view").isVisible(), true);
  },
);

test(
  "an unsupported source codec gets a compatible preview",
  { timeout: 30000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "codec-"));
    const source = path.join(root, "source.mkv");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=320x240:duration=1",
      "-c:v",
      "ffv1",
      source,
    ]);
    const app = await _electron.launch({
      args: ["."],
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
    const video = await page.evaluate(
      (path) => window.midnight.execute("library.import", { path }),
      source,
    );
    await page.evaluate(
      (id) => window.midnight.execute("playback.open", { id }),
      video.id,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#player").src.includes("/previews/") &&
        !document.querySelector("#preview-play").disabled,
      undefined,
      { timeout: 15000 },
    );
    await page.evaluate(() => window.midnight.execute("playback.play"));
    assert.equal(
      await page.locator("#player").evaluate((player) => player.paused),
      false,
    );
  },
);
