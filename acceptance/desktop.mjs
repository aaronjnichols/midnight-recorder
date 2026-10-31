import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Run these checks in a normal Windows desktop session.
// They require real window capture and a working audio output device.
async function launch(t) {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "acceptance-"));
  const app = await _electron.launch({
    args: ["."],
    timeout: 20000,
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
  return { app, page, call, root };
}

test(
  "real screen capture contains visible desktop content",
  { timeout: 30000 },
  async (t) => {
    const { page, call } = await launch(t);
    await page.evaluate(() => {
      const marker = document.createElement("div");
      marker.textContent = "Screen capture check";
      Object.assign(marker.style, {
        position: "fixed",
        inset: "0",
        background: "white",
        color: "black",
        zIndex: "1000",
        fontSize: "48px",
      });
      document.body.append(marker);
    });
    const sources = await call("capture.sources");
    await call("recording.start", {
      sourceId: sources.find((s) => s.id.startsWith("screen:")).id,
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const video = await call("recording.stop");
    const frames = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      video.path,
      "-vf",
      "scale=1:1,format=gray",
      "-an",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(
      [...frames].some((value) => value > 8),
      "Screen capture is black. Run this check in a normal Windows desktop session.",
    );
  },
);

test(
  "real window capture contains visible app content",
  { timeout: 30000 },
  async (t) => {
    const { app, call } = await launch(t);
    const sourceId = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Midnight Recorder")
        .getMediaSourceId(),
    );
    await call("recording.start", { sourceId });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const video = await call("recording.stop");
    const frames = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      video.path,
      "-vf",
      "scale=1:1,format=gray",
      "-an",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.ok(
      [...frames].some((value) => value > 20),
      "Window capture is black. Run this check in a normal Windows desktop session.",
    );
  },
);

test(
  "system audio capture contains a test tone",
  { timeout: 30000 },
  async (t) => {
    const { page, call } = await launch(t);
    await page.evaluate(async () => {
      window.testAudio = new AudioContext();
      await window.testAudio.resume();
      const oscillator = window.testAudio.createOscillator(),
        gain = window.testAudio.createGain();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.02;
      oscillator.connect(gain).connect(window.testAudio.destination);
      oscillator.start();
    });
    const sources = await call("capture.sources");
    await call("recording.start", {
      sourceId: sources.find((s) => s.id.startsWith("screen:")).id,
      systemAudio: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const video = await call("recording.stop");
    await page.evaluate(() => window.testAudio.close());
    assert.equal(
      video.metadata.hasAudio,
      true,
      "The capture has no system audio track.",
    );
    const report = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        video.path,
        "-af",
        "astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
        "-vn",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    const levels = [...report.matchAll(/RMS_level=([-\d.]+)/g)].map((match) =>
      Number(match[1]),
    );
    assert.ok(
      levels.some((level) => level > -60),
      "System audio is silent. Check the Windows audio output and run this check again.",
    );
  },
);
