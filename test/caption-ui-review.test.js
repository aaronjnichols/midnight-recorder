// Regressions for the confirmed stage 3 caption UI review cases. Held
// replies are real service results. The test releases each one after it
// changes the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  launch,
  setSize,
  until,
  openEditor,
  forwardCommands,
  captionList,
} from "../test-support/electron.js";

// 10 seconds of a plain picture with silent sound.
function soundVideo(root) {
  const file = path.join(root, "silent-sound.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2e3440:s=640x360:r=30:d=10",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono",
    "-t",
    "10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}
const pressed = (page, list) =>
  page
    .locator(`${list} .layer-select[aria-pressed="true"]`)
    .evaluateAll((nodes) => nodes.map((n) => n.closest("li").dataset.id));
const rows = (page, list) => page.locator(`${list} > li`).count();
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
const settle = (page) => page.waitForTimeout(400);
const cueId = async (call, id, text) =>
  (await captionList(call, id)).cues.find((c) => c.text === text).id;
const row = (id) => `.caption-row[data-id="${id}"] .caption-select`;

test(
  "caption UI review cases: markers, fractional end, replace scope, and pending selections",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "caption-ui-review-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: soundVideo(root),
      title: "Review",
    });
    await call("captions.add", {
      id: video.id,
      text: "First caption",
      start: 1,
      end: 2,
    });
    await call("captions.add", {
      id: video.id,
      text: "Second caption",
      start: 3,
      end: 4,
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const first = await cueId(call, video.id, "First caption");
    const second = await cueId(call, video.id, "Second caption");
    const tool = (name) => page.getByRole("tab", { name, exact: true }).click();
    await tool("Captions");

    // UI 6: the first click on a row that is not selected selects it and
    // moves the playhead to it. The playhead starts outside the caption.
    await call("playback.seek", { seconds: 0 });
    const seeks = async () =>
      (await forward.log("playback.seek")).map((c) => c.args.seconds);
    const earlier = (await seeks()).length;
    await page.locator(row(first)).click();
    await until(
      async () => (await seeks()).slice(earlier).includes(1),
      "The first click did not seek.",
      5000,
    );
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 1) < 0.05,
      "The playhead did not move to the caption.",
    );

    // UI 1: the selected row shows its state without a saved edit.
    assert.deepEqual(await pressed(page, "#caption-list"), [first]);
    await page.locator(row(second)).click();
    assert.deepEqual(await pressed(page, "#caption-list"), [second]);
    assert.equal(
      await page.locator("#cap-text").inputValue(),
      "Second caption",
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(await pressed(page, "#caption-list"), []);
    assert.equal(await page.locator("#caption-form").isHidden(), true);

    // UI 2: at 1.5x speed the edited video is 6.666... seconds. A caption
    // at 5 seconds ends at the edited end.
    // A command from outside the page shows after the next status poll.
    const shows = (seconds) =>
      until(
        () =>
          page.evaluate(
            (s) =>
              Math.abs(Number(document.querySelector("#range-end").max) - s) <
              1e-6,
            seconds,
          ),
        `The page did not show ${seconds} seconds.`,
      );
    await call("edit.configure", { id: video.id, speed: 1.5 });
    await shows(10 / 1.5);
    await ready(call);
    await call("playback.seek", { seconds: 5 });
    await page.locator("#caption-add").click();
    await until(
      async () => (await captionList(call, video.id)).count === 3,
      "The caption at the playhead was not added.",
      15000,
    ).catch(async (error) => {
      const shown = await page.locator("#message-text").textContent();
      throw new Error(`${error.message} Message: ${shown}`);
    });
    const [request] = await forward
      .log("captions.add")
      .then((l) => l.filter((c) => c.args.text === "New caption"));
    assert.ok(request.args.end <= 10 / 1.5, JSON.stringify(request.args));
    const added = (await captionList(call, video.id)).cues.at(-1);
    assert.ok(Math.abs(added.end - 10 / 1.5) < 1e-6, JSON.stringify(added));
    await call("edit.configure", { id: video.id, speed: 1 });
    await shows(10);
    await ready(call);

    // UI 3: Replace sends the scope that the confirmation shows. A change to
    // that scope closes the confirmation.
    await forward.stub("transcript.capabilities", { available: true });
    await forward.stub("captions.generate", { error: "Stopped by the test." });
    await call("playback.open", { id: video.id });
    await ready(call);
    await until(
      () => page.locator("#caption-generate").isEnabled(),
      "Make captions did not become available.",
    );
    const confirm = page.locator("#caption-replace");
    // The selection times are in Trim & cut.
    await tool("Trim & cut");
    await page.locator("#range-start").fill("1");
    await page.locator("#range-end").fill("4");
    await tool("Captions");
    await page.locator("#caption-range-only").check();
    await page.locator("#caption-generate").click();
    assert.equal(await confirm.isVisible(), true);
    assert.match(await confirm.textContent(), /selected range/);
    await page.locator("#caption-range-only").uncheck();
    assert.equal(await confirm.isHidden(), true, "A scope change closes it.");
    await page.locator("#caption-range-only").check();
    await page.locator("#caption-generate").click();
    await tool("Trim & cut");
    await page.locator("#range-end").fill("5");
    await tool("Captions");
    assert.equal(await confirm.isHidden(), true, "A range change closes it.");
    await page.locator("#caption-generate").click();
    await page.locator("#caption-replace-yes").click();
    await until(
      async () => (await forward.log("captions.generate")).length === 1,
      "No request.",
    );
    assert.deepEqual((await forward.log("captions.generate"))[0].args, {
      id: video.id,
      apply: true,
      start: 1,
      end: 5,
      replace: true,
    });
    await page.locator("#caption-range-only").uncheck();
    await page.locator("#caption-generate").click();
    assert.match(await confirm.textContent(), /all 3 captions/);
    await page.locator("#caption-replace-yes").click();
    await until(
      async () => (await forward.log("captions.generate")).length === 2,
      "No request.",
    );
    assert.deepEqual((await forward.log("captions.generate"))[1].args, {
      id: video.id,
      apply: true,
      replace: true,
    });

    // UI 4a: a pending element add cannot take the selection from a caption
    // that the user selected. The element editor had no selection.
    await page
      .locator("#message-close")
      .click()
      .catch(() => {});
    await page.keyboard.press("Escape");
    await forward.hold("element.add");
    await page.locator("#add-ellipse").click();
    await forward.held();
    await page.locator(row(first)).click();
    await forward.release();
    await until(
      async () => (await rows(page, "#layer-list")) === 1,
      "No ellipse row.",
    );
    await settle(page);
    assert.deepEqual(await pressed(page, "#caption-list"), [first]);
    assert.equal(await page.locator("#cap-text").inputValue(), "First caption");
    assert.equal(await page.locator("#element-form").isHidden(), true);
    assert.deepEqual(await pressed(page, "#layer-list"), []);

    // UI 4b: the reverse. A pending caption add cannot take the selection
    // from an element. The caption editor had no selection.
    const [ellipse] = (await call("element.list", { id: video.id })).elements;
    await page.keyboard.press("Escape");
    await ready(call);
    await call("playback.seek", { seconds: 6 });
    await forward.hold("captions.add");
    await page.locator("#caption-add").click();
    await forward.held();
    // Layers are in Text & shapes. This tool change also stops the pending
    // caption selection, so two guards protect this path now.
    await tool("Text & shapes");
    await page
      .locator(`.layer-row[data-id="${ellipse.id}"] .layer-select`)
      .click();
    // Focus leaves the layer list. A focused layer row selects itself again
    // when the list draws again, so only the selection token keeps the
    // choice here.
    await page.locator("#video-title").click();
    await forward.release();
    await until(
      async () => (await rows(page, "#caption-list")) === 4,
      "No new caption row.",
    );
    await settle(page);
    assert.deepEqual(await pressed(page, "#layer-list"), [ellipse.id]);
    assert.equal(await page.locator("#element-form").isVisible(), true);
    assert.equal(await page.locator("#caption-form").isHidden(), true);
    assert.deepEqual(await pressed(page, "#caption-list"), []);

    // UI 5: a late add result does not select the text of another draft.
    await page.keyboard.press("Escape");
    await ready(call);
    await call("playback.seek", { seconds: 4.5 });
    // Open Captions before the held reply: a tool change also stops a
    // pending selection.
    await tool("Captions");
    await forward.hold("captions.add");
    await page.locator("#caption-add").click();
    await forward.held();
    await page.locator(row(second)).click();
    const text = page.locator("#cap-text");
    await text.fill("Draft remains here");
    await text.press("End");
    const caret = () =>
      text.evaluate((node) => [
        node.selectionStart,
        node.selectionEnd,
        document.activeElement === node,
      ]);
    assert.deepEqual(await caret(), [18, 18, true]);
    await forward.release();
    await until(
      async () => (await rows(page, "#caption-list")) === 5,
      "No new caption row.",
    );
    await settle(page);
    assert.equal(await text.inputValue(), "Draft remains here");
    assert.deepEqual(await caret(), [18, 18, true]);
    await page.keyboard.type("X");
    assert.equal(await text.inputValue(), "Draft remains hereX");
  },
);
