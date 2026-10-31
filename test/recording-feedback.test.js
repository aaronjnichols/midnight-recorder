import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

test(
  "Record shows 3, 2, 1 and a protected screen border with pause and stop cleanup",
  { timeout: 45000 },
  async (t) => {
    await mkdir(".local", { recursive: true });
    const root = await mkdtemp(path.resolve(".local", "feedback-"));
    const app = await _electron.launch({
      args: [".", "--use-fake-device-for-media-stream"],
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
    await page.waitForSelector("#source option", { state: "attached" });
    const worker = app.windows().find((p) => p.url().endsWith("/capture.html"));
    await worker.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = () =>
        navigator.mediaDevices.getUserMedia({ video: true });
    });
    const call = (name, args = {}) =>
      page.evaluate(
        ([name, args]) => window.midnight.execute(name, args),
        [name, args],
      );
    const sources = await call("capture.sources");
    const source = sources.find((s) => s.id.startsWith("screen:"));
    await page.locator("#source").selectOption(source.id);
    await page.locator("#start").click();
    assert.equal((await call("app.status")).recording.state, "countdown");
    assert.equal(await page.locator("#stop").isDisabled(), true);
    assert.equal(await page.locator("#pause").isDisabled(), true);
    await page.locator("#cancel-recording").click();
    await page.waitForTimeout(3200);
    assert.equal((await call("app.status")).recording.state, "idle");
    assert.deepEqual(
      await readdir(path.join(root, "pending")).catch(() => []),
      [],
    );

    const overlayReady = app.waitForEvent("window", {
      predicate: async (p) => {
        await p.waitForLoadState();
        return p.url().endsWith("/recording-feedback.html");
      },
    });
    await page.locator("#start").click();
    const overlay = await overlayReady;
    assert.ok(
      overlay,
      "A native feedback window must cover the selected display.",
    );
    await overlay.waitForFunction(
      () => document.querySelector("#count").textContent === "3",
    );
    const properties = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("/recording-feedback.html"),
      );
      return {
        protected: win.isContentProtected(),
        focusable: win.isFocusable(),
        top: win.isAlwaysOnTop(),
        bounds: win.getBounds(),
        displays: screen
          .getAllDisplays()
          .map((d) => ({ id: String(d.id), bounds: d.bounds })),
      };
    });
    assert.equal(properties.protected, true);
    assert.equal(properties.focusable, false);
    assert.equal(properties.top, true);
    assert.deepEqual(
      properties.bounds,
      (source.displayId
        ? properties.displays.find((d) => d.id === source.displayId)
        : properties.displays[0]
      ).bounds,
    );
    await mkdir("output/playwright", { recursive: true });
    const saveOverlay = async (name) => {
      const image = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().endsWith("/recording-feedback.html"),
        );
        return (await win.webContents.capturePage()).toPNG().toString("base64");
      });
      await writeFile(
        path.join("output/playwright", name),
        Buffer.from(image, "base64"),
      );
    };
    await saveOverlay("04-countdown.png");
    for (const count of ["2", "1"]) {
      await overlay.waitForFunction(
        (count) => document.querySelector("#count").textContent === count,
        count,
      );
    }
    await page.waitForFunction(
      () =>
        document.querySelector("#record-status").textContent === "Recording",
    );
    await overlay.waitForFunction(
      () => document.body.dataset.state === "recording",
    );
    assert.equal(await overlay.locator("#countdown").isVisible(), false);
    assert.equal(await overlay.locator("#border").isVisible(), true);
    assert.equal(await overlay.locator("#badge").textContent(), "● Recording");
    await saveOverlay("05-recording-border.png");
    await page.waitForTimeout(1400);
    await page.locator("#pause").click();
    await overlay.waitForFunction(
      () => document.body.dataset.state === "paused",
    );
    assert.equal(await overlay.locator("#badge").textContent(), "Ⅱ Paused");
    await saveOverlay("06-paused-border.png");
    await page.locator("#pause").click();
    await page.locator("#stop").click();
    assert.equal((await call("app.status")).recording.state, "idle");
    assert.equal((await call("library.list")).length, 1);
    assert.equal(
      app.windows().filter((p) => p.url().endsWith("/recording-feedback.html"))
        .length,
      0,
    );

    await worker.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        throw new Error("Test source closed");
      };
    });
    await call("recording.countdown", { sourceId: source.id });
    await page.waitForFunction(() =>
      document
        .querySelector("#message")
        .textContent.includes("Test source closed"),
    );
    assert.equal((await call("app.status")).recording.state, "idle");
    assert.equal(
      app.windows().filter((p) => p.url().endsWith("/recording-feedback.html"))
        .length,
      0,
    );
  },
);
