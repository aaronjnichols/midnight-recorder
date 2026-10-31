import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { duration } from "../src/domain/timeline.js";

for (const speed of [1.5, 0.75]) {
  test(
    `Keep range preserves the untouched full end at ${speed}x speed`,
    { timeout: 30000 },
    async (t) => {
      await mkdir(".local", { recursive: true });
      const root = await mkdtemp(path.resolve(".local", "trim-end-"));
      const source = path.join(root, "source.mp4");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=blue:size=320x240:duration=10",
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
      const call = (name, args = {}) =>
        page.evaluate(
          ([name, args]) => window.midnight.execute(name, args),
          [name, args],
        );
      const video = await call("library.import", { path: source });
      assert.equal(video.metadata.duration, 10);
      await call("playback.open", { id: video.id });
      await page.locator("#speed").selectOption(String(speed));
      await page.waitForFunction(
        () => Number(document.querySelector("#range-end").value) !== 10,
      );
      await page.locator("#range-start").fill("1");
      await page
        .getByRole("button", { name: "Keep range", exact: true })
        .click();
      await page.waitForFunction(async (id) => {
        const video = await window.midnight.execute("library.get", { id });
        return (
          video.timeline.past.length === 2 ||
          document.querySelector("#message.error:not([hidden])") !== null
        );
      }, video.id);
      await page.screenshot({
        path: path.join(root, "trim-end.png"),
      });
      const stored = JSON.parse(
        await readFile(path.join(root, "library.json"), "utf8"),
      ).find((item) => item.id === video.id);
      assert.deepEqual(stored.timeline.segments, [{ start: speed, end: 10 }]);
      assert.equal(stored.timeline.speed, speed);
      assert.equal(stored.timeline.past.length, 2);
      assert.equal(duration(stored.timeline), (10 - speed) / speed);
    },
  );
}

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
