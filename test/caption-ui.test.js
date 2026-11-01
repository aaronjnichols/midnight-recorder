// The caption workflow in the desktop editor, with the local speech engine
// and a short excerpt of public tutorial media. The test skips when the
// speech runtime or the media is not on this computer.
// Media: "First Steps", Mike Newbon, Blender Studio, CC-BY,
// https://studio.blender.org/training/blender-2-8-fundamentals/first-steps/
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  launch,
  setSize,
  until,
  openEditor,
  captionList,
} from "../test-support/electron.js";
import { frameAt, region, isWhite } from "../test-support/frames.js";

const TUTORIAL = path.resolve(".local/transcript-validation/blender.mp4");
// The current editor layout. Earlier stage files in claude-editing stay.
const SHOTS = path.resolve("output/playwright/claude-editing-ux");
const available = await access(TUTORIAL).then(
  () => true,
  () => false,
);

// Source 9.2 to 17.2 seconds: "It's a very powerful software that's been
// used in feature films, games, TV series, and a bunch of ..."
function excerpt(root) {
  const file = path.join(root, "first-steps-9-17.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "9.2",
    "-t",
    "8",
    "-i",
    TUTORIAL,
    "-vf",
    "scale=640:360",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
const style = async (call, id) => (await captionList(call, id)).style;

test(
  "the editor makes captions from speech, then corrects, styles, seeks, undoes, saves, and exports them",
  {
    timeout: 600000,
    skip: available ? false : "The tutorial media is not on this computer.",
  },
  async (t) => {
    const { root, app, page, call } = await launch(t, "caption-ui-");
    if (!(await call("transcript.capabilities")).available)
      return t.skip("The local speech engine is not set up.");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: excerpt(root),
      title: "First Steps excerpt",
    });
    await openEditor(page, call, video);
    await page.getByRole("tab", { name: "Captions", exact: true }).click();
    const generate = page.locator("#caption-generate");
    await until(
      () => generate.isEnabled(),
      "Make captions did not become available.",
    );
    assert.equal(await generate.textContent(), "Make captions from speech");

    // Generate. The job shows progress and a Cancel button while it runs.
    await generate.click();
    await page.waitForSelector("#caption-job:not([hidden])");
    assert.match(
      await page.locator("#caption-job-text").textContent(),
      /Starting|Preparing|Recognizing/,
    );
    assert.equal(await page.locator("#caption-cancel").isVisible(), true);
    await page.screenshot({
      path: path.join(SHOTS, "stage3-captions-progress-1440.png"),
    });
    await until(
      async () =>
        /^Added \d+ captions?\./.test(
          await page.locator("#caption-job-text").textContent(),
        ),
      "Captions were not added.",
      240000,
    );
    assert.equal(await page.locator("#caption-cancel").isVisible(), false);
    const made = await captionList(call, video.id);
    assert.ok(made.count >= 2, JSON.stringify(made.cues));
    assert.match(made.cues[0].text, /powerful software/i);
    assert.match(
      await page.locator("#caption-count").textContent(),
      /^\d+ captions/,
    );
    assert.equal(await page.locator("#caption-list > li").count(), made.count);
    await ready(call);

    // Select the second caption: the playhead moves to its start.
    const second = made.cues[1];
    const secondRow = page.locator(
      `.caption-row[data-id="${second.id}"] .caption-select`,
    );
    await secondRow.click();
    assert.equal(await secondRow.getAttribute("aria-pressed"), "true");
    await until(async () => {
      const { seconds } = await call("playback.status");
      return seconds >= second.start - 0.05 && seconds < second.end;
    }, "Selecting a caption did not move the playhead to it.");

    // Correct the text of the first caption.
    const first = made.cues[0];
    await page
      .locator(`.caption-row[data-id="${first.id}"] .caption-select`)
      .click();
    const corrected = "It's a very powerful program\nused in feature films,";
    await page.locator("#cap-text").fill(corrected);
    await page.locator("#cap-text").press("Tab");
    await until(
      async () =>
        (await captionList(call, video.id)).cues[0].text === corrected,
      "The correction was not saved.",
    );

    // Style for all captions: size, then position. Each is one undo step.
    await page.locator("#caption-style summary").click();
    await page.locator("#cap-size").fill("6");
    await page.locator("#cap-size").press("Enter");
    await until(
      async () => (await style(call, video.id)).size === 0.06,
      "Size not saved.",
    );
    await page.locator("#cap-position").selectOption("top");
    await until(
      async () => (await style(call, video.id)).verticalAlign === "top",
      "Position not saved.",
    );
    await page.locator("#video-title").click();
    await page.keyboard.press("Control+z");
    await until(
      async () => (await style(call, video.id)).verticalAlign === "bottom",
      "Undo failed.",
    );
    await page.keyboard.press("Control+Shift+z");
    await until(
      async () => (await style(call, video.id)).verticalAlign === "top",
      "Redo failed.",
    );
    await page.keyboard.press("Control+z");
    await until(
      async () => (await style(call, video.id)).verticalAlign === "bottom",
      "Undo failed.",
    );
    assert.equal(
      (await style(call, video.id)).size,
      0.06,
      "The size step stays.",
    );

    // Delete a caption with the Delete key, then undo it.
    const last = (await captionList(call, video.id)).cues.at(-1);
    await page
      .locator(`.caption-row[data-id="${last.id}"] .caption-select`)
      .click();
    await page.keyboard.press("Delete");
    await until(
      async () => (await captionList(call, video.id)).count === made.count - 1,
      "Delete failed.",
    );
    await page.locator("#video-title").click();
    await page.keyboard.press("Control+z");
    await until(
      async () => (await captionList(call, video.id)).count === made.count,
      "Undo failed.",
    );

    // The exact preview shows the caption. Hidden captions do not show.
    const player = async (name) => {
      await ready(call);
      const at = (first.start + first.end) / 2;
      await call("playback.seek", { seconds: at });
      await until(
        () =>
          page.evaluate((s) => {
            const p = document.querySelector("#player");
            return (
              Math.abs(p.currentTime - s) < 0.02 &&
              !p.seeking &&
              p.readyState >= 2
            );
          }, at),
        "The player did not seek.",
      );
      const file = path.join(SHOTS, `stage3-captions-player-${name}.png`);
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
      const frame = frameAt(file, 0, width, height);
      return region(frame, isWhite, {
        left: 0,
        top: Math.round(height * 0.75),
        right: width,
        bottom: height,
      }).count;
    };
    const shown = await player("shown");
    await page.locator("#caption-enabled").uncheck();
    await until(
      async () => (await captionList(call, video.id)).enabled === false,
      "Hide failed.",
    );
    const hidden = await player("hidden");
    assert.ok(
      shown > 200 && shown > hidden * 3,
      `Caption pixels: ${shown} shown, ${hidden} hidden.`,
    );
    await page.locator("#caption-enabled").check();
    await until(
      async () => (await captionList(call, video.id)).enabled === true,
      "Show failed.",
    );

    // Screenshots at both supported sizes, with a caption selected.
    await page
      .locator(`.caption-row[data-id="${first.id}"] .caption-select`)
      .click();
    if (await page.locator("#message").isVisible())
      await page.locator("#message-close").click();
    for (const [width, height] of [
      [1440, 940],
      [1000, 720],
    ]) {
      await setSize(app, width, height);
      await page.waitForTimeout(400);
      await page
        .locator("#caption-panel")
        .evaluate((node) => node.scrollIntoView({ block: "start" }));
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        player: document.querySelector("#player").getBoundingClientRect()
          .height,
        form: document.querySelector("#caption-form").getBoundingClientRect()
          .width,
      }));
      assert.ok(layout.overflow <= 0, JSON.stringify(layout));
      assert.ok(
        layout.player > 150 && layout.form > 200,
        JSON.stringify(layout),
      );
      await page.screenshot({
        path: path.join(SHOTS, `stage3-captions-editor-${width}.png`),
      });
      await page
        .locator("#caption-style")
        .evaluate((node) => node.scrollIntoView({ block: "end" }));
      await page.screenshot({
        path: path.join(SHOTS, `stage3-captions-style-${width}.png`),
      });
    }
    await setSize(app, 1440, 940);

    // Save and reload: the captions are in the library file and in the page.
    await page.reload();
    await page.waitForSelector("#library-view:not([hidden])");
    await openEditor(page, call, video);
    assert.equal(await page.locator("#caption-list > li").count(), made.count);
    const stored = JSON.parse(
      await readFile(path.join(root, "library.json"), "utf8"),
    ).find((v) => v.id === video.id);
    assert.equal(stored.timeline.captions.cues[0].text, corrected);
    assert.equal(stored.timeline.captions.style.size, 0.06);

    // Export with the Export button. The test answers the save dialog.
    const output = path.join(root, "captioned.mp4");
    await app.evaluate(({ ipcMain }, file) => {
      ipcMain.removeHandler("pick-export");
      ipcMain.handle("pick-export", () => file);
    }, output);
    await page.locator("#export").click();
    await until(
      async () => {
        const jobs = (await call("app.status")).jobs.filter(
          (j) => j.kind === "export",
        );
        if (jobs.some((j) => j.state === "failed"))
          assert.fail(JSON.stringify(jobs));
        return jobs.some((j) => j.state === "complete");
      },
      "The export did not complete.",
      240000,
    );
    const mid = (first.start + first.end) / 2;
    const exported = frameAt(output, mid, 640, 360);
    const frameFile = path.join(
      SHOTS,
      `stage3-captions-export-${mid.toFixed(2)}s.png`,
    );
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      output,
      "-ss",
      String(mid),
      "-frames:v",
      "1",
      frameFile,
    ]);
    assert.ok(
      region(exported, isWhite, { left: 0, top: 270, right: 640, bottom: 360 })
        .count > 200,
      "The exported frame shows the caption.",
    );
  },
);
