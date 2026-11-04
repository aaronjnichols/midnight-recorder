import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";

async function launch(t, prefix, args = []) {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", prefix));
  const app = await _electron.launch({
    args: [".", ...args],
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
  page.on("pageerror", (error) => process.stderr.write(error.message + "\n"));
  const call = (name, args = {}) =>
    page.evaluate(
      ([name, args]) => window.midnight.execute(name, args),
      [name, args],
    );
  return { root, app, page, call };
}

function makeVideo(root, name, seconds = 2) {
  const file = path.join(root, name.replace(/\W+/g, "-") + ".mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=30:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

const setSize = (app, width, height) =>
  app.evaluate(
    ({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
        .setSize(width, height),
    [width, height],
  );

const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test(
  "library search shows a no-result state and keeps the library count",
  { timeout: 60000 },
  async (t) => {
    const { root, page, call } = await launch(t, "ui-library-");
    await page.waitForSelector("#source option", { state: "attached" });
    assert.match(await page.locator("#empty").innerText(), /library is empty/);
    const videos = [];
    for (const title of ["Alpha demo", "Beta notes"])
      videos.push(
        await call("library.import", { path: makeVideo(root, title), title }),
      );
    await page.waitForFunction(
      () => document.querySelectorAll(".video-card").length === 2,
    );
    await call("edit.cut", { id: videos[0].id, start: 0.5, end: 1 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".video-card")].some((card) =>
        card.innerText.includes("Edited"),
      ),
    );

    await page.locator("#search").fill("zzz");
    await page.waitForFunction(
      () => document.querySelectorAll(".video-card").length === 0,
    );
    const empty = await page.locator("#empty").innerText();
    assert.match(empty, /No videos match/);
    assert.match(empty, /zzz/);
    assert.doesNotMatch(empty, /library is empty/);
    assert.equal(await page.locator("#library-count").innerText(), "2");
    assert.match(await page.locator("#video-total").innerText(), /0 of 2/);
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".video-card").length === 2,
    );
    assert.equal(await page.locator("#search").inputValue(), "");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "search",
    );

    // Spaces alone are not a search. They must not cause a command error.
    await page.locator("#search").fill("   ");
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
    assert.equal(await page.locator(".video-card").count(), 2);

    // Slash moves focus to the search field. Escape clears the search.
    await page.locator("#search").fill("");
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("/");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "search",
    );
    await page.keyboard.type("alp");
    await page.waitForFunction(
      () => document.querySelectorAll(".video-card").length === 1,
    );
    assert.match(await page.locator("#video-total").innerText(), /1 of 2/);
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelectorAll(".video-card").length === 2,
    );
    assert.equal(await page.locator("#search").inputValue(), "");
  },
);

test(
  "editor keys, timeline, range, title, delete dialog, and exports work",
  { timeout: 120000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "ui-editor-");
    const video = await call("library.import", {
      path: makeVideo(root, "Editor sample", 10),
      title: "Editor sample",
    });
    await page.waitForSelector(".video-card");
    await page.locator(".video-card").click();
    await page.waitForSelector("#editor:not([hidden])");
    const ready = () =>
      page.waitForFunction(
        () => !document.querySelector("#preview-play").disabled,
        undefined,
        { timeout: 30000 },
      );
    await ready();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "video-title",
      "Opening a video moves focus to the editor heading.",
    );
    const near = async (expected) => {
      let seconds;
      for (let i = 0; i < 50; i++) {
        seconds = (await call("playback.status")).seconds;
        if (Math.abs(seconds - expected) < 0.25) return;
        await page.waitForTimeout(100);
      }
      assert.fail(`The playhead is at ${seconds}, not near ${expected}.`);
    };

    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.querySelector("#player").paused);
    await page.keyboard.press("k");
    await page.waitForFunction(() => document.querySelector("#player").paused);
    await call("playback.seek", { seconds: 0 });
    await page.keyboard.press("ArrowRight");
    await near(5);
    await page.keyboard.press("o");
    assert.equal(Number(await page.locator("#range-end").inputValue()), 5);
    await page.keyboard.press("Shift+ArrowLeft");
    await near(4);
    await page.keyboard.press("i");
    assert.equal(Number(await page.locator("#range-start").inputValue()), 4);
    assert.equal(await page.locator("#timeline-range").isVisible(), true);

    const track = await page.locator("#timeline-track").boundingBox();
    await page.mouse.click(
      track.x + track.width * 0.25,
      track.y + track.height / 2,
    );
    await near(2.5);

    // Undo is pressed while the cut is still in progress. The app must not
    // drop the key press.
    await page
      .getByRole("button", { name: "Remove the selection", exact: true })
      .click();
    await page.keyboard.press("Control+z");
    await page.waitForFunction(
      () => !document.querySelector("#redo").disabled,
      undefined,
      { timeout: 10000 },
    );
    assert.equal(await page.locator("#timeline-bars i").count(), 1);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForFunction(
      () => document.querySelectorAll("#timeline-bars i").length === 2,
    );
    assert.match(await page.locator("#video-info").innerText(), /Edited/);

    // The title and Delete video are in the Details tool.
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    assert.equal(await page.locator("#rename").isDisabled(), true);
    await page.locator("#rename-title").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" v2");
    assert.equal(await page.locator("#rename").isDisabled(), false);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector("#video-title").textContent ===
        "Editor sample v2",
    );
    assert.equal(await page.locator("#rename").isDisabled(), true);
    assert.equal(
      await page.locator("#player").evaluate((player) => player.paused),
      true,
      "A space typed in the title field must not start playback.",
    );

    await page.locator("#delete").click();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "keep-video",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#confirm-delete").evaluate((dialog) => dialog.open),
      false,
    );

    await call("export.start", {
      id: video.id,
      path: path.join(root, "exports", "sample export.mp4"),
    });
    await call("inspect.start", { id: video.id, timestamps: [1] });
    await page.waitForFunction(
      () =>
        document
          .querySelector("#message")
          .textContent.includes("Export complete"),
      undefined,
      { timeout: 60000 },
    );
    await page.waitForFunction(() =>
      document.querySelector("#export-jobs").textContent.includes("Exported"),
    );
    const jobs = await page.locator("#export-jobs").innerText();
    assert.match(jobs, /sample export\.mp4/);
    assert.doesNotMatch(jobs, /undefined/);
    assert.equal(await page.locator("#export-jobs .export-row").count(), 1);

    await setSize(app, 1000, 720);
    assert.equal(await noHorizontalOverflow(page), true);
  },
);

test(
  "recording state and controls stay visible at the minimum window size",
  { timeout: 90000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "ui-recording-", [
      "--use-fake-device-for-media-stream",
    ]);
    await page.waitForSelector("#source option", { state: "attached" });
    await setSize(app, 1000, 720);
    const inView = (selector) =>
      page.locator(selector).evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          box.right <= innerWidth
        );
      });
    assert.equal(
      await inView("#start"),
      true,
      "Start recording must be visible without scrolling.",
    );
    const video = await call("library.import", {
      path: makeVideo(root, "Clip"),
      title: "Clip",
    });
    await page.locator("#camera-only").check();
    await page.locator("#start").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#record-status")
        .textContent.startsWith("Starts in"),
    );
    assert.equal(await inView("#cancel-recording"), true);
    assert.match(
      await page.locator("#recording-pill").innerText(),
      /Starts in/,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#record-status").textContent === "Recording",
      undefined,
      { timeout: 15000 },
    );
    assert.equal(await inView("#stop"), true, "Stop must be visible.");
    assert.equal(await inView("#pause"), true, "Pause must be visible.");
    await page.waitForFunction(() =>
      /^0:0[1-9]$/.test(document.querySelector("#record-time").textContent),
    );

    await call("playback.open", { id: video.id });
    await page.waitForSelector("#editor:not([hidden])");
    assert.equal(await page.locator("#recording-pill").isVisible(), true);
    assert.match(
      await page.locator("#recording-pill").innerText(),
      /Recording/,
    );
    await page.locator("#recording-pill").click();
    await page.waitForSelector("#library-view:not([hidden])");
    assert.equal(await page.evaluate(() => document.activeElement.id), "stop");
    assert.equal(await inView("#stop"), true);

    await page.locator("#pause").click();
    await page.waitForFunction(() =>
      document.querySelector("#recording-pill").textContent.includes("Paused"),
    );
    await page.locator("#pause").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#record-status").textContent === "Recording",
    );
    await page.locator("#stop").click();
    await page.waitForSelector("#editor:not([hidden])");
    assert.equal(await page.locator("#recording-pill").isVisible(), false);
    assert.equal(await noHorizontalOverflow(page), true);
  },
);

test(
  "Use playhead at the end of a fractional-speed video keeps a valid end",
  { timeout: 60000 },
  async (t) => {
    const { root, page, call } = await launch(t, "ui-range-end-");
    const video = await call("library.import", {
      path: makeVideo(root, "Fast clip", 10),
      title: "Fast clip",
    });
    await call("edit.configure", { id: video.id, speed: 1.5 });
    await call("playback.open", { id: video.id });
    await page.waitForFunction(
      () => !document.querySelector("#preview-play").disabled,
      undefined,
      { timeout: 30000 },
    );
    const total = 10 / 1.5;
    await page.evaluate(() => document.activeElement.blur());
    // Two Right arrow presses move the playhead 5 seconds, then to the end.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    let playhead;
    for (let i = 0; i < 50; i++) {
      playhead = (await call("playback.status")).seconds;
      if (playhead > total - 0.05) break;
      await page.waitForTimeout(100);
    }
    assert.ok(playhead > total - 0.05, `The playhead is at ${playhead}.`);

    await page.keyboard.press("o");
    const end = Number(await page.locator("#range-end").inputValue());
    assert.ok(
      end <= total + 1e-9,
      `End ${end} is after the edited end ${total}.`,
    );
    assert.ok(Math.abs(end - playhead) <= 0.005 + 1e-9, `End ${end}.`);
    await page.locator("#range-start").fill("1");
    assert.equal(
      await page.locator("#trim").isDisabled(),
      false,
      "Keep range must accept the playhead end.",
    );

    // The Set end button sets the same end.
    await page.locator("#range-end").fill("3");
    await page.locator("#range-end-now").click();
    assert.equal(Number(await page.locator("#range-end").inputValue()), end);

    // The maximum in the message must be a value that the app accepts.
    await page.locator("#range-end").fill("99");
    const message = await page.locator("#range-summary").innerText();
    const maximum = message.match(/maximum is (\d+(?:\.\d+)?)/)?.[1];
    assert.ok(maximum, message);
    await page.locator("#range-end").fill(maximum);
    assert.equal(
      await page.locator("#trim").isDisabled(),
      false,
      `The message shows ${maximum}. The app must accept it.`,
    );

    await page.locator("#range-end-now").click();
    await page
      .getByRole("button", { name: "Keep only the selection", exact: true })
      .click();
    await page.waitForFunction(
      async (id) =>
        (await window.midnight.execute("library.get", { id })).timeline.past
          .length === 2 ||
        document.querySelector("#message.error:not([hidden])") !== null,
      video.id,
    );
    assert.equal(
      await page.locator("#message.error:not([hidden])").count(),
      0,
      await page.locator("#message").textContent(),
    );
    const [segment] = (await call("library.get", { id: video.id })).timeline
      .segments;
    assert.equal(segment.start, 1.5);
    assert.ok(segment.end <= 10, `Segment end ${segment.end}.`);
    assert.ok(Math.abs(segment.end - end * 1.5) < 1e-9);
    // Chromium reports the end as 6.666666. A playhead within half of the
    // 0.01 display step of the end gives the full source end.
    if (total - playhead < 0.005) {
      assert.equal(end, total);
      assert.equal(segment.end, 10);
    }
    t.diagnostic(`playhead ${playhead}, end ${end}, source end ${segment.end}`);
  },
);

test(
  "recorded time survives a page reload while paused and after a resume",
  { timeout: 90000 },
  async (t) => {
    const { root, page, call } = await launch(t, "ui-reload-", [
      "--use-fake-device-for-media-stream",
    ]);
    await page.waitForSelector("#source option", { state: "attached" });
    const shown = async () => {
      const [minutes, seconds] = (
        await page.locator("#record-time").textContent()
      )
        .split(":")
        .map(Number);
      return minutes * 60 + seconds;
    };
    const reload = async (label) => {
      await page.reload();
      await page.waitForFunction(
        (label) =>
          document.querySelector("#record-status")?.textContent === label &&
          !document.querySelector("#record-time").hidden,
        label,
      );
    };

    await call("recording.start", { cameraOnly: true });
    await page.waitForTimeout(2200);
    await call("recording.pause");
    await page.waitForTimeout(3500);
    await reload("Paused");
    let recording = (await call("app.status")).recording;
    assert.ok(
      recording.recordedSeconds > 1.5 && recording.recordedSeconds < 3,
      `Paused time is ${recording.recordedSeconds}.`,
    );
    assert.equal(await shown(), Math.floor(recording.recordedSeconds));
    // An agent reads the same retained time through the CLI.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/agent/cli.js", "app.status"],
      { env: { ...process.env, MIDNIGHT_DATA: root } },
    );
    assert.equal(
      JSON.parse(stdout).recording.recordedSeconds,
      recording.recordedSeconds,
    );

    const paused = recording.recordedSeconds;
    const resumed = Date.now();
    await call("recording.resume");
    await page.waitForTimeout(1500);
    await reload("Recording");
    const after = await shown();
    recording = (await call("app.status")).recording;
    // A reload takes some seconds. Only the pause of 3.5 seconds or more must
    // not count.
    const expected = paused + (Date.now() - resumed) / 1000;
    assert.ok(
      Math.abs(recording.recordedSeconds - expected) < 0.75,
      `Time after resume is ${recording.recordedSeconds}, not ${expected}. Pauses must not count.`,
    );
    assert.ok(
      Math.abs(after - recording.recordedSeconds) <= 1.2,
      `The page shows ${after}. The service reports ${recording.recordedSeconds}.`,
    );
    const video = await call("recording.stop");
    assert.ok(
      Math.abs(video.metadata.duration - recording.recordedSeconds) < 1.5,
      `Saved ${video.metadata.duration} s. Reported ${recording.recordedSeconds} s.`,
    );
  },
);
