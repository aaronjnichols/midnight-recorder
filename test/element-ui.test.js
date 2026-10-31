import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { frameAt, region, isRed } from "../test-support/frames.js";

// Bounded wait for a page state. It does not assume a device or render time.
async function until(check, message, limit = 60000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  "the open editor preview shows a text element added by a shared command",
  { timeout: 120000 },
  async (t) => {
    await mkdir(".local/claude-editing", { recursive: true });
    const root = await mkdtemp(path.resolve(".local/claude-editing", "ui-"));
    const source = path.join(root, "dark.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1e2127:s=640x360:r=30:d=3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
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
      app.windows().find((p) => p.url().endsWith("/ui/index.html")) ||
      (await app.waitForEvent("window", {
        predicate: async (p) => {
          await p.waitForLoadState();
          return p.url().endsWith("/ui/index.html");
        },
      }));
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    const src = () =>
      page.evaluate(() => document.querySelector("#player").src);
    const video = await call("library.import", { path: source, title: "Dark" });
    await call("playback.open", { id: video.id });
    await until(
      async () => (await call("playback.status")).ready,
      "No preview.",
    );
    const original = await src();

    await call("element.add", {
      id: video.id,
      type: "text",
      text: "Preview",
      start: 0.5,
      end: 2.5,
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
      size: 0.12,
      background: "#FF0000",
      backgroundOpacity: 1,
    });
    // The editor reads the new edit state and loads a rendered preview.
    await until(
      async () =>
        (await src()) !== original && (await call("playback.status")).ready,
      "The preview did not change after element.add.",
    );
    const shot = async (seconds) => {
      await call("playback.seek", { seconds });
      await until(
        () =>
          page.evaluate((s) => {
            const p = document.querySelector("#player");
            return (
              Math.abs(p.currentTime - s) < 0.02 &&
              !p.seeking &&
              p.readyState >= 2
            );
          }, seconds),
        `The player did not seek to ${seconds}.`,
      );
      const file = path.join(root, `player-${seconds}.png`);
      await page.locator("#player").screenshot({ path: file });
      const [width, height] = execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        file,
      ])
        .toString()
        .trim()
        .split(",")
        .map(Number);
      return {
        file,
        width,
        height,
        ...region(frameAt(file, 0, width, height), isRed),
      };
    };
    const inside = await shot(1.5);
    t.diagnostic(`Screenshot: ${inside.file}`);
    assert.ok(inside.count > 1000, `Red pixels: ${inside.count}`);
    // The player keeps the video centered, so the box center is the center.
    assert.ok(Math.abs(inside.centerX / inside.width - 0.5) < 0.03);
    assert.ok(Math.abs(inside.centerY / inside.height - 0.5) < 0.03);
    const before = await shot(0.2);
    assert.equal(before.count, 0, "The element is not shown before start.");
  },
);
