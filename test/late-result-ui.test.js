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

function plainVideo(root, name) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2e3440:s=640x360:r=30:d=8",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}
const title = (page) => page.locator("#video-title").textContent();
const rowCount = (page, list) => page.locator(`${list} > li`).count();
const pressed = (page, selector) =>
  page.locator(selector).getAttribute("aria-pressed");
const settle = (page) => page.waitForTimeout(400);
// An edit renders a new preview. The playhead works when it is ready.
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );

// Each reply is held until the page changed. Then the late reply arrives.
// The page must keep the video and the selection that the user chose.
test(
  "late element and caption results cannot change another video or the selection",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "late-ui-");
    await setSize(app, 1440, 940);
    const a = await call("library.import", {
      path: plainVideo(root, "first"),
      title: "First video",
    });
    const b = await call("library.import", {
      path: plainVideo(root, "second"),
      title: "Second video",
    });
    const forward = await forwardCommands(app, root);
    const openFirst = () => openEditor(page, call, a);
    const openSecond = async () => {
      await call("playback.open", { id: b.id });
      await until(
        async () => (await title(page)) === "Second video",
        "The second video did not open.",
      );
    };

    // 1. A late element.add reply after the user opened another video.
    await openFirst();
    await forward.hold("element.add");
    await page.locator("#add-text").click();
    await forward.held();
    await openSecond();
    await forward.release();
    await settle(page);
    assert.equal(await title(page), "Second video");
    assert.equal(await rowCount(page, "#layer-list"), 0, "No layer of A on B.");
    const [text] = (await call("element.list", { id: a.id })).elements;
    assert.equal(text.type, "text", "The command itself completed on A.");

    // 2. A late element.add reply after the user selected another layer.
    await openFirst();
    await until(
      async () => (await rowCount(page, "#layer-list")) === 1,
      "No layer row.",
    );
    // Layers are in Text & shapes. Open it before the held reply: a tool
    // change also stops a pending selection, so it must not occur here.
    await page.getByRole("tab", { name: "Text & shapes", exact: true }).click();
    await forward.hold("element.add");
    await page.locator("#add-ellipse").click();
    await forward.held();
    const textRow = `.layer-row[data-id="${text.id}"] .layer-select`;
    await page.locator(textRow).click();
    // Focus leaves the list. A row with focus selects itself again when the
    // list draws again, so only the selection guard keeps the choice here.
    await page.locator("#video-title").click();
    await forward.release();
    await until(
      async () => (await rowCount(page, "#layer-list")) === 2,
      "The ellipse row did not show.",
    );
    await settle(page);
    assert.equal(
      await pressed(page, textRow),
      "true",
      "The user choice stays.",
    );
    assert.match(
      await page.locator("#element-heading").textContent(),
      /^Element: Text/,
    );

    // 3. A late captions.add reply after the user opened another video.
    await page.keyboard.press("Escape");
    await ready(call);
    await call("playback.seek", { seconds: 1 });
    await page.getByRole("tab", { name: "Captions", exact: true }).click();
    await forward.hold("captions.add");
    await page.locator("#caption-add").click();
    await forward.held();
    await openSecond();
    await forward.release();
    await settle(page);
    assert.equal(await title(page), "Second video");
    assert.equal(
      await page.locator("#caption-count").textContent(),
      "No captions",
    );
    assert.equal(
      await rowCount(page, "#caption-list"),
      0,
      "No caption of A on B.",
    );
    assert.equal((await captionList(call, a.id)).count, 1);

    // 4. A late captions.add reply after the user selected another caption.
    await openFirst();
    await call("captions.add", { id: a.id, text: "Second", start: 4, end: 5 });
    await until(
      async () => (await rowCount(page, "#caption-list")) === 2,
      "The second caption row did not show.",
    );
    await ready(call);
    await call("playback.seek", { seconds: 6 });
    // The open video changed, so the editor shows Trim & cut. Open Captions
    // before the held reply.
    await page.getByRole("tab", { name: "Captions", exact: true }).click();
    await forward.hold("captions.add");
    await page.locator("#caption-add").click();
    await forward.held();
    const second = (await captionList(call, a.id)).cues.find(
      (c) => c.text === "Second",
    );
    const secondRow = `.caption-row[data-id="${second.id}"] .caption-select`;
    await page.locator(secondRow).click();
    await page.locator("#video-title").click();
    await forward.release();
    await until(
      async () => (await rowCount(page, "#caption-list")) === 3,
      "The new caption row did not show.",
    );
    await settle(page);
    assert.equal(
      await pressed(page, secondRow),
      "true",
      "The user choice stays.",
    );
    assert.equal(await page.locator("#cap-text").inputValue(), "Second");
  },
);
