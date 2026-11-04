// Direct text editing with real pointer and keyboard input. Each test uses
// its own data folder. Pixel checks are in text-edit-visual.test.js.
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
} from "../test-support/electron.js";

function makeVideo(root, name = "text.mp4") {
  const file = path.join(root, name);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2e3440:s=640x360:r=30:d=6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

// An open editor with one text element, paused inside its time.
async function setup(t, prefix, extra = {}, options = {}) {
  const { root, app, page, call } = await launch(t, prefix);
  await setSize(app, 1000, 720);
  const video = await call("library.import", {
    path: makeVideo(root),
    title: "Text sample",
  });
  const { element } = await call("element.add", {
    id: video.id,
    type: "text",
    text: "Hello world",
    start: 0,
    end: 6,
    x: 0.1,
    y: 0.3,
    width: 0.8,
    height: 0.3,
    size: 0.12,
    ...extra,
  });
  const forward = await forwardCommands(app, root);
  await openEditor(page, call, video);
  if (options.seek !== false) {
    await call("playback.seek", { seconds: 2 });
    await page.waitForFunction(
      () => !document.querySelector("#player").seeking,
    );
  }
  return { root, app, page, call, video, element, forward };
}

const item = (page, element) =>
  page.locator(`.stage-item[data-id="${element.id}"]`);

async function center(locator, x = 0.5, y = 0.5) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

async function openBox(page, element, x = 0.5) {
  const point = await center(item(page, element), x);
  await page.mouse.dblclick(point.x, point.y);
  await page.waitForFunction(
    () => document.activeElement?.id === "draft-input",
  );
}

const value = (page) => page.locator("#draft-input").inputValue();
const shownText = (page) => page.locator("#draft-text").textContent();
const savedText = async (call, video) =>
  (await call("element.list", { id: video.id })).elements[0].text;
const history = async (call, video) =>
  (await call("library.get", { id: video.id })).timeline.past.length;

async function outsidePoint(page) {
  const box = await page.locator(".player-wrap").boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height - 8 };
}
async function clickOutside(page) {
  const point = await outsidePoint(page);
  await page.mouse.click(point.x, point.y);
}

const draftReady = (page) =>
  until(
    () =>
      page.evaluate(
        () =>
          document.querySelector("#draft-view").dataset.mode === "clean" &&
          !document.querySelector("#draft-view").hidden,
      ),
    "The draft picture did not become clean.",
    20000,
  );

test(
  "a double-click opens the box with the caret at the click point, and one session saves once",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-dbl-");
    await item(page, element).click();
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    const before = await history(call, video);
    // The first exact render of the open video.
    const renders = (await forward.log("preview.start")).length;
    await openBox(page, element, 0.5);

    // The text is centered, so the middle of the box is inside the text.
    const caret = await page
      .locator("#draft-input")
      .evaluate((node) => node.selectionStart);
    assert.ok(caret > 1 && caret < "Hello world".length - 1, `Caret: ${caret}`);
    assert.equal(
      await page.locator("#draft-input").evaluate((node) => node.selectionEnd),
      caret,
      "A double-click places a caret and selects nothing.",
    );

    await page.keyboard.type("ABC");
    const expected = `${"Hello world".slice(0, caret)}ABC${"Hello world".slice(caret)}`;
    assert.equal(await value(page), expected);
    // The draft shows at once, in the picture and in the inspector.
    assert.equal(await shownText(page), expected);
    assert.equal(await page.locator("#el-text").inputValue(), expected);
    // Nothing is saved or rendered per character.
    assert.equal((await forward.log("element.update")).length, 0);
    assert.equal((await forward.log("preview.start")).length, renders);
    assert.equal(await savedText(call, video), "Hello world");

    await clickOutside(page);
    await until(
      async () => (await savedText(call, video)) === expected,
      "Leaving the box did not save it.",
    );
    const updates = await forward.log("element.update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].args, {
      id: video.id,
      elementId: element.id,
      text: expected,
      expectedText: "Hello world",
    });
    assert.equal(await history(call, video), before + 1);
    assert.equal(await page.locator("#draft-editor").isHidden(), true);

    // One exact render follows, and one undo returns the whole session.
    await until(
      async () => (await forward.log("preview.start")).length === renders + 1,
      "No exact render started.",
    );
    await until(
      async () =>
        (await page.locator("#preview-state").innerText()) === "Preview ready",
      "The exact preview did not finish.",
      120000,
    );
    assert.equal((await forward.log("preview.start")).length, renders + 1);
    await page.locator("#undo").click();
    await until(
      async () => (await savedText(call, video)) === "Hello world",
      "One undo did not return the session.",
    );
  },
);

test(
  "ordinary gestures still move and resize, and a double-click does not nudge the box",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-move-",
    );
    const node = item(page, element);
    await node.click();
    // A drag moves the box.
    const start = await center(node);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 20, { steps: 4 });
    await page.mouse.up();
    await until(
      async () => (await forward.log("element.update")).length === 1,
      "A drag did not save.",
    );
    const moved = (await call("element.list", { id: video.id })).elements[0];
    assert.notEqual(moved.x, 0.1);
    assert.equal(moved.text, "Hello world");
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    await until(
      async () => (await call("playback.status")).ready,
      "No preview after the move.",
      120000,
    );

    // A handle resizes the box.
    await node.click();
    const handle = page.locator(
      `.stage-item[data-id="${element.id}"] .handle[data-handle="e"]`,
    );
    const edge = await center(handle);
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.down();
    await page.mouse.move(edge.x - 30, edge.y, { steps: 3 });
    await page.mouse.up();
    await until(
      async () => (await forward.log("element.update")).length === 2,
      "A resize did not save.",
    );
    await until(
      async () => (await call("playback.status")).ready,
      "No preview after the resize.",
      120000,
    );

    // A shaky double-click opens the box and moves nothing.
    const point = await center(node);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 1, point.y);
    await page.mouse.up();
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(point.x + 2, point.y + 1);
    await page.mouse.up({ clickCount: 2 });
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    assert.equal((await forward.log("element.update")).length, 2);
  },
);

test(
  "the Edit on video button and F2 open the same box",
  { timeout: 120000 },
  async (t) => {
    const { page, element } = await setup(t, "text-keys-");
    await item(page, element).click();
    const button = page.locator("#edit-text");
    assert.equal(await button.isVisible(), true);
    await button.click();
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    assert.equal(
      await page.locator("#draft-input").evaluate((node) => node.selectionEnd),
      "Hello world".length,
      "The caret is at the end.",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#draft-editor").isHidden(), true);

    // F2 from a place that is not a text field.
    await page.locator("#stage").evaluate((node) => {
      node.tabIndex = -1;
      node.focus();
    });
    await page.keyboard.press("F2");
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
  },
);

test(
  "the box has visible Done and Cancel controls that work without a blur save",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-btn-");
    await openBox(page, element);
    assert.equal(await page.locator("#draft-done").isVisible(), true);
    assert.equal(await page.locator("#draft-cancel").isVisible(), true);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Never saved");

    // Cancel with the pointer. The press does not take focus from the box,
    // so no blur saves the draft first.
    await page.locator("#draft-cancel").click();
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    assert.equal((await forward.log("element.update")).length, 0);
    assert.equal(await savedText(call, video), "Hello world");
    assert.equal(await page.locator("#el-text").inputValue(), "Hello world");

    // Cancel with the keyboard: Tab goes to the controls, not to an apply.
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Also never saved");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "draft-cancel",
    );
    assert.equal((await forward.log("element.update")).length, 0);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    assert.equal((await forward.log("element.update")).length, 0);

    // Done saves.
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Saved by Done");
    await page.locator("#draft-done").click();
    await until(
      async () => (await savedText(call, video)) === "Saved by Done",
      "Done did not save.",
    );
    assert.equal((await forward.log("element.update")).length, 1);
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
  },
);

test(
  "Enter adds a line, Ctrl+Enter applies, and Escape cancels before it leaves fullscreen",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-key-");
    await openBox(page, element);
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line");
    assert.equal(await value(page), "Hello world\nSecond line");
    assert.equal(await shownText(page), "Hello world\nSecond line");
    assert.equal(
      await page.locator("#el-text").inputValue(),
      "Hello world\nSecond line",
    );
    assert.equal((await forward.log("element.update")).length, 0);
    await page.keyboard.press("Control+Enter");
    await until(
      async () => (await savedText(call, video)) === "Hello world\nSecond line",
      "Ctrl+Enter did not save.",
    );
    await until(
      async () => (await call("playback.status")).ready,
      "No preview after the save.",
      120000,
    );

    await call("playback.fullscreen", { enabled: true });
    await until(
      () =>
        page
          .locator(".player-shell")
          .evaluate((node) => node.classList.contains("fullscreen")),
      "No fullscreen.",
    );
    await openBox(page, element);
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    assert.equal(
      await page
        .locator(".player-shell")
        .evaluate((node) => node.classList.contains("fullscreen")),
      true,
      "The first Escape cancels only the edit.",
    );
    assert.equal(
      await savedText(call, video),
      "Hello world\nSecond line",
      "Escape saves nothing.",
    );
    assert.equal((await forward.log("element.update")).length, 1);
  },
);

test(
  "the inspector and the box are one draft and one session",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-one-");
    await item(page, element).click();
    await draftReady(page).catch(() => {});

    // Typing in the inspector shows at once on the picture.
    const field = page.locator("#el-text");
    await field.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");
    assert.equal(await shownText(page), "Hello world!");
    assert.equal(await page.locator("#draft-done").isVisible(), true);
    assert.equal((await forward.log("element.update")).length, 0);

    // The session goes on across the two surfaces.
    await openBox(page, element);
    assert.equal(await value(page), "Hello world!");
    await page.keyboard.press("Control+End");
    await page.keyboard.type("?");
    assert.equal(await field.inputValue(), "Hello world!?");
    await field.click();
    assert.equal((await forward.log("element.update")).length, 0);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("#");
    assert.equal(await value(page), "Hello world!?#");
    assert.equal(await shownText(page), "Hello world!?#");

    await clickOutside(page);
    await until(
      async () => (await savedText(call, video)) === "Hello world!?#",
      "The session did not save.",
    );
    assert.equal((await forward.log("element.update")).length, 1);
  },
);

test(
  "plain-text paste, copy, select all, and native undo stay in the box",
  { timeout: 120000 },
  async (t) => {
    const { app, page, call, video, element, forward } = await setup(
      t,
      "text-native-",
    );
    await openBox(page, element);
    // Line separators become lines. Control characters are removed.
    await app.evaluate(({ clipboard }) =>
      clipboard.writeText(
        `One\r\nTwo${String.fromCodePoint(0x2028)}Three${String.fromCodePoint(7)}`,
      ),
    );
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+V");
    assert.equal(await value(page), "One\nTwo\nThree");

    // Native undo works after a cleaned paste, and does not run edit.undo.
    await page.keyboard.press("Control+Z");
    assert.equal(await value(page), "Hello world");
    await page.keyboard.press("Control+Y");
    assert.equal(await value(page), "One\nTwo\nThree");
    assert.equal((await forward.log("edit.undo")).length, 0);
    assert.equal((await forward.log("edit.redo")).length, 0);

    // Copy and cut are native.
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+X");
    assert.equal(await value(page), "");
    // The Windows clipboard has CRLF line ends. The field has plain line ends.
    assert.equal(
      (await app.evaluate(({ clipboard }) => clipboard.readText())).replaceAll(
        "\r\n",
        "\n",
      ),
      "One\nTwo\nThree",
    );
    await page.keyboard.press("Control+V");
    assert.equal(await value(page), "One\nTwo\nThree");
    await page.keyboard.press("Control+Enter");
    await until(
      async () => (await savedText(call, video)) === "One\nTwo\nThree",
      "The pasted text did not save.",
    );
    // After the session, Ctrl+Z is the app undo for the whole session.
    await until(
      async () => (await call("playback.status")).ready,
      "No preview.",
      120000,
    );
    await page.locator("#stage").evaluate((node) => {
      node.tabIndex = -1;
      node.focus();
    });
    await page.keyboard.press("Control+Z");
    await until(
      async () => (await savedText(call, video)) === "Hello world",
      "App undo did not return the session.",
    );
  },
);

test(
  "IME composition shows in the draft, and Enter and Escape belong to the composition",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-ime-");
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "にほ",
      selectionStart: 2,
      selectionEnd: 2,
    });
    assert.equal(await value(page), "にほ");
    assert.equal(await shownText(page), "にほ");
    // A real keydown during composition has isComposing set.
    await page.locator("#draft-input").evaluate((node) => {
      for (const key of ["Escape", "Enter"])
        node.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            ctrlKey: key === "Enter",
            isComposing: true,
            bubbles: true,
          }),
        );
    });
    assert.equal(await page.locator("#draft-editor").isHidden(), false);
    assert.equal((await forward.log("element.update")).length, 0);
    await cdp.send("Input.insertText", { text: "日本" });
    assert.equal(await value(page), "日本");
    await page.keyboard.press("Control+Enter");
    await until(
      async () => (await savedText(call, video)) === "日本",
      "The composed text did not save.",
    );
  },
);

test(
  "limits: an empty or long draft stays with its reason, and nothing is saved",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-lim-");
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Delete");
    // Empty is a normal step while typing.
    assert.equal(await page.locator("#draft-problem").isHidden(), true);
    await page.keyboard.press("Control+Enter");
    assert.match(
      await page.locator("#draft-problem").innerText(),
      /visible character/,
    );
    assert.equal(await page.locator("#draft-editor").isHidden(), false);
    assert.equal((await forward.log("element.update")).length, 0);

    // Typing ends the refusal. Long text shows its reason at once and is
    // not cut.
    const long = "x".repeat(510);
    await page.locator("#draft-input").evaluate((node, text) => {
      node.focus();
      document.execCommand("insertText", false, text);
    }, long);
    assert.equal(await value(page), long);
    assert.match(
      await page.locator("#draft-problem").innerText(),
      /at most 500 characters/,
    );
    // Leaving the box does not lose the text.
    await clickOutside(page);
    assert.equal((await forward.log("element.update")).length, 0);
    assert.equal(await page.locator("#el-text").inputValue(), long);
    assert.match(await page.locator("#save-state").innerText(), /^Not saved/);
    assert.equal(await page.locator("#draft-done").isVisible(), true);

    // Fix it and save.
    await page.locator("#el-text").fill("Fixed");
    await page.locator("#draft-done").click();
    await until(
      async () => (await savedText(call, video)) === "Fixed",
      "The fixed text did not save.",
    );
    assert.equal((await forward.log("element.update")).length, 1);
  },
);

test(
  "a save error keeps the draft, says so, and a retry saves",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-err-");
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Keep me");
    await forward.stub("element.update", { error: "Disk is full." });
    await clickOutside(page);
    await until(
      async () =>
        /Disk is full/.test(await page.locator("#draft-problem").innerText()),
      "The error did not show.",
    );
    assert.match(await page.locator("#save-state").innerText(), /^Not saved/);
    assert.notEqual(
      await page.locator("#preview-state").innerText(),
      "Preview ready",
    );
    assert.equal(await shownText(page), "Keep me");
    assert.equal(await page.locator("#el-text").inputValue(), "Keep me");
    assert.equal(await savedText(call, video), "Hello world");
    assert.equal(await page.locator("#draft-done").innerText(), "Try again");

    await forward.unstub("element.update");
    await page.locator("#draft-done").click();
    await until(
      async () => (await savedText(call, video)) === "Keep me",
      "The retry did not save.",
    );
    await until(
      async () => (await page.locator("#save-state").innerText()) === "Saved",
      "The state did not return to Saved.",
    );
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
  },
);

test(
  "a change from another client does not vanish under a draft, and the user decides",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-con-");
    // An untouched session follows the saved change.
    await openBox(page, element);
    await call("element.update", {
      id: video.id,
      elementId: element.id,
      text: "From the CLI",
    });
    await until(
      async () => (await value(page)) === "From the CLI",
      "An untouched session did not follow.",
    );
    await page.keyboard.press("Control+End");
    await page.keyboard.type("!");

    // A touched session keeps its draft, and the guard stops the overwrite.
    await call("element.update", {
      id: video.id,
      elementId: element.id,
      text: "Newer from the CLI",
    });
    await page.waitForTimeout(1800);
    assert.equal(await value(page), "From the CLI!");
    await page.locator("#draft-done").click();
    await until(
      async () =>
        /changed after/.test(await page.locator("#draft-problem").innerText()),
      "The conflict did not show.",
    );
    assert.equal(await savedText(call, video), "Newer from the CLI");
    assert.equal(await shownText(page), "From the CLI!");
    assert.equal(await page.locator("#draft-done").innerText(), "Save my text");

    // Another change after the conflict. The retry reads the fresh text.
    await call("element.update", {
      id: video.id,
      elementId: element.id,
      text: "Newest from the CLI",
    });
    await page.locator("#draft-done").click();
    await until(
      async () => (await savedText(call, video)) === "From the CLI!",
      "Save my text did not save.",
    );
    const updates = (await forward.log("element.update")).filter(
      (entry) => entry.args.expectedText,
    );
    assert.equal(updates.at(-1).args.expectedText, "Newest from the CLI");
  },
);

test(
  "Discard after a conflict returns to the saved text",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element } = await setup(t, "text-discard-");
    await openBox(page, element);
    await page.keyboard.type("x");
    await call("element.update", {
      id: video.id,
      elementId: element.id,
      text: "From the CLI",
    });
    await page.locator("#draft-done").click();
    await until(
      async () =>
        (await page.locator("#draft-cancel").innerText()) === "Discard",
      "No discard control.",
    );
    await page.locator("#draft-cancel").click();
    await until(
      async () =>
        (await page.locator("#el-text").inputValue()) === "From the CLI",
      "The saved text did not return.",
    );
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    assert.equal(await savedText(call, video), "From the CLI");
  },
);

test(
  "a blocked frame reply does not hide typing, and a late reply does not change it",
  { timeout: 120000 },
  async (t) => {
    const { page, element, forward } = await setup(t, "text-held-");
    await forward.hold("preview.frame");
    await openBox(page, element);
    await forward.held();
    // Before a change, the exact frame stays, with only the caret.
    assert.equal(await page.locator("#draft-view").isHidden(), true);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Typed while blocked");
    assert.equal(await page.locator("#draft-view").isHidden(), false);
    assert.equal(
      await page.locator("#draft-view").getAttribute("data-mode"),
      "plate",
    );
    assert.equal(await shownText(page), "Typed while blocked");
    assert.match(await page.locator("#stage-note").innerText(), /plate/);
    assert.equal(
      await page.locator("#preview-state").innerText(),
      "Draft view",
    );

    await forward.release();
    await draftReady(page);
    assert.equal(await value(page), "Typed while blocked");
    assert.equal(await shownText(page), "Typed while blocked");
    assert.equal(await page.locator("#stage-note").isHidden(), true);
    // Typing goes on with the clean picture.
    await page.keyboard.type("!");
    assert.equal(await shownText(page), "Typed while blocked!");
  },
);

test(
  "a failed frame keeps the typing on the plate",
  { timeout: 120000 },
  async (t) => {
    const { page, element, forward } = await setup(t, "text-frame-err-");
    await forward.stub("preview.frame", { error: "FFmpeg failed." });
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Still visible");
    assert.equal(await shownText(page), "Still visible");
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator("#draft-view").getAttribute("data-mode"),
      "plate",
    );
    assert.equal(await shownText(page), "Still visible");
  },
);

test(
  "the saved text stays on the picture until the exact preview shows",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-keep-",
    );
    await openBox(page, element);
    await draftReady(page).catch(() => {});
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Saved words");
    await draftReady(page);
    await forward.hold("preview.start");
    await page.keyboard.press("Control+Enter");
    await forward.held();
    await until(
      async () => (await savedText(call, video)) === "Saved words",
      "No save.",
    );
    assert.equal(await page.locator("#draft-editor").isHidden(), true);
    assert.equal(await page.locator("#draft-view").isVisible(), true);
    assert.equal(await shownText(page), "Saved words");
    assert.notEqual(
      await page.locator("#preview-state").innerText(),
      "Preview ready",
    );
    // The note about the original video does not show over a true picture.
    assert.equal(await page.locator("#stage-note").isHidden(), true);
    await forward.release();
    await until(
      async () =>
        (await page.locator("#preview-state").innerText()) === "Preview ready",
      "The exact preview did not finish.",
      120000,
    );
    await until(
      () => page.locator("#draft-view").isHidden(),
      "The draft view did not end.",
    );
  },
);

test(
  "a style change of a text box shows at once, and the exact preview replaces it",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-style-",
    );
    await item(page, element).click();
    await until(
      async () => (await forward.log("preview.frame")).length > 0,
      "Selection did not prepare a frame.",
    );
    await page.waitForTimeout(800);
    await forward.hold("preview.start");
    await page.locator("#el-size").fill("20");
    await page.locator("#el-size").press("Enter");
    await forward.held();
    await until(
      async () =>
        (await call("element.list", { id: video.id })).elements[0].size === 0.2,
      "No save.",
    );
    await until(
      () => page.locator("#draft-view").isVisible(),
      "The style change did not show.",
    );
    assert.equal(
      await page.locator("#draft-view").getAttribute("data-mode"),
      "clean",
    );
    assert.equal(await shownText(page), "Hello world");
    await forward.release();
    await until(
      () => page.locator("#draft-view").isHidden(),
      "The draft view did not end.",
      120000,
    );
  },
);

test(
  "going to another element applies the draft, and the new selection stays",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(t, "text-sw-");
    const { element: other } = await call("element.add", {
      id: video.id,
      type: "rectangle",
      start: 0,
      end: 6,
      x: 0.02,
      y: 0.02,
      width: 0.1,
      height: 0.1,
      fill: "#FF0000",
    });
    await until(
      () => item(page, other).isVisible(),
      "The second element did not show.",
    );
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Applied by the switch");
    await forward.hold("element.update");
    await item(page, other).click();
    await forward.held();
    // The new selection does not wait, and the reply does not change it.
    await until(
      async () =>
        (await page.locator("#element-heading").innerText()) ===
        "Element: Rectangle 1",
      "The selection did not change.",
    );
    // The render waits, so the page must keep the saved text on the picture
    // also with another element selected.
    await forward.release();
    await forward.hold("preview.start");
    await forward.held();
    await until(
      async () =>
        (await call("element.list", { id: video.id })).elements[0].text ===
        "Applied by the switch",
      "The switch did not save.",
    );
    assert.equal(
      await page.locator("#element-heading").innerText(),
      "Element: Rectangle 1",
    );
    assert.equal((await forward.log("element.update")).length, 1);
    assert.equal(await page.locator("#draft-view").isVisible(), true);
    assert.equal(await shownText(page), "Applied by the switch");
    await forward.release();
    await until(
      () => page.locator("#draft-view").isHidden(),
      "The draft view did not end.",
      120000,
    );
  },
);

// Found in a screenshot. A caret past the frame edge made the browser scroll
// the player, so the whole picture moved and stayed moved.
test(
  "long text does not scroll the picture",
  { timeout: 120000 },
  async (t) => {
    const { page, element } = await setup(t, "text-scroll-");
    const scrolled = () =>
      page.evaluate(() => {
        const moved = [];
        for (
          let node = document.querySelector("#draft-input");
          node;
          node = node.parentElement
        )
          if (node.scrollLeft || node.scrollTop)
            moved.push(`${node.id || node.className}`);
        return moved;
      });
    const before = await page.locator("#stage").boundingBox();
    await openBox(page, element);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("x".repeat(90));
    assert.deepEqual(await scrolled(), [], "Long line.");
    assert.deepEqual(await page.locator("#stage").boundingBox(), before);
    for (let line = 0; line < 9; line++) await page.keyboard.press("Enter");
    assert.deepEqual(await scrolled(), [], "Many lines.");
    assert.deepEqual(await page.locator("#stage").boundingBox(), before);
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+End");
    assert.deepEqual(await scrolled(), [], "Caret moves.");
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.locator("#stage").boundingBox(), before);
  },
);

test(
  "Escape on the Edit on video button cancels the draft",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-button-esc-",
    );
    await item(page, element).click();
    await page.locator("#el-text").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" not saved");
    await page.locator("#edit-text").focus();
    await page.keyboard.press("Escape");
    assert.equal((await forward.log("element.update")).length, 0);
    assert.equal(await page.locator("#el-text").inputValue(), "Hello world");
    assert.equal(await savedText(call, video), "Hello world");
    assert.equal(
      await page.locator("#element-heading").innerText(),
      "Element: Text: Hello world",
      "The selection stays.",
    );
  },
);

test(
  "a failed save of an old session parks the draft, and it comes back on selection",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-park-",
    );
    const { element: other } = await call("element.add", {
      id: video.id,
      type: "rectangle",
      start: 0,
      end: 6,
      x: 0.02,
      y: 0.02,
      width: 0.1,
      height: 0.1,
      fill: "#FF0000",
    });
    await until(() => item(page, other).isVisible(), "No second element.");
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Parked words");
    await forward.stub("element.update", { error: "Disk is full." });
    await item(page, other).click();
    await until(
      async () =>
        /Parked words/.test(await page.locator("#message").innerText()),
      "The error did not name the text.",
    );
    // Focus and selection stay with the other element.
    assert.equal(
      await page.locator("#element-heading").innerText(),
      "Element: Rectangle 1",
    );
    assert.match(await page.locator("#save-state").innerText(), /^Not saved/);

    await forward.unstub("element.update");
    await item(page, element).click();
    await until(
      async () =>
        (await page.locator("#el-text").inputValue()) === "Parked words",
      "The draft did not return.",
    );
    assert.equal(await page.locator("#draft-done").innerText(), "Try again");
    await page.locator("#draft-done").click();
    await until(
      async () =>
        (await call("element.list", { id: video.id })).elements[0].text ===
        "Parked words",
      "The parked draft did not save.",
    );
  },
);

test(
  "a late reply of an old save does not mark newer typing as saved",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-late-",
    );
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("First");
    await forward.hold("element.update");
    await page.keyboard.press("Control+Enter");
    await forward.held();
    // The user opens the box again during the save.
    await openBox(page, element);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" second");
    assert.equal(await value(page), "First second");
    await forward.release();
    await until(
      async () => (await savedText(call, video)) === "First",
      "The first save did not finish.",
    );
    await page.waitForTimeout(300);
    assert.equal(await value(page), "First second");
    assert.equal(await shownText(page), "First second");
    assert.match(await page.locator("#save-state").innerText(), /^Not saved/);
    await page.keyboard.press("Control+Enter");
    await until(
      async () => (await savedText(call, video)) === "First second",
      "The second session did not save.",
    );
    const updates = await forward.log("element.update");
    assert.equal(updates.at(-1).args.expectedText, "First");
  },
);

test(
  "going to another video or the library applies to the old video",
  { timeout: 180000 },
  async (t) => {
    const { root, page, call, video, element, forward } = await setup(
      t,
      "text-video-",
    );
    const second = await call("library.import", {
      path: makeVideo(root, "second.mp4"),
      title: "Second",
    });
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Stays with the first");
    await forward.hold("element.update");
    await call("playback.open", { id: second.id });
    await forward.held();
    await until(
      async () => (await page.locator("#video-title").innerText()) === "Second",
      "The other video did not open.",
    );
    await forward.release();
    await until(
      async () => (await savedText(call, video)) === "Stays with the first",
      "The switch did not save to the first video.",
    );
    assert.equal(
      (await call("element.list", { id: second.id })).elements.length,
      0,
    );
    assert.equal(await page.locator("#draft-view").isHidden(), true);
    assert.equal(await page.locator("#draft-editor").isHidden(), true);

    // A session also applies when the user goes to the library.
    await call("playback.open", { id: video.id });
    await until(
      async () => (await call("playback.status")).ready,
      "No preview.",
      120000,
    );
    await call("playback.seek", { seconds: 2 });
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Back to the library");
    await page.locator("#back").click();
    await until(
      async () => (await savedText(call, video)) === "Back to the library",
      "Going to the library did not save.",
    );
  },
);

test(
  "the box moves the playhead into an element that the frame does not show",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element } = await setup(
      t,
      "text-time-",
      { start: 3, end: 5 },
      { seek: false },
    );
    await page.locator("#stage").waitFor({ state: "attached" });
    await page.evaluate(() =>
      document.querySelector('[data-tool="elements"]').click(),
    );
    await page.locator(".layer-select").first().focus();
    const button = page.locator("#edit-text");
    await button.click();
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    await until(async () => {
      const { seconds } = await call("playback.status");
      return seconds >= 3 && seconds < 5;
    }, "The playhead did not move into the element.");
    assert.ok(video && element);
  },
);

// Review U1: the picture of a draft is a still frame, so a client cannot play
// or seek under it, and the draft is not lost.
test(
  "playback waits for a text edit, and says what to do",
  { timeout: 120000 },
  async (t) => {
    const { page, call, element, forward } = await setup(t, "text-play-");
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Open draft");
    await draftReady(page);
    for (const [name, args] of [
      ["playback.play", {}],
      ["playback.seek", { seconds: 4 }],
    ])
      await assert.rejects(() => call(name, args), /text edit is open/);
    const open = await call("playback.status");
    assert.equal(open.paused, true);
    assert.equal(open.ready, false, "A client cannot play this picture.");
    assert.equal(await value(page), "Open draft");
    assert.equal((await forward.log("element.update")).length, 0);

    // A saved draft waits for the exact preview in the same way.
    await forward.hold("preview.start");
    await page.keyboard.press("Control+Enter");
    await forward.held();
    await assert.rejects(() => call("playback.play"), /being prepared/);
    const saved = await call("playback.status");
    assert.equal(saved.paused, true);
    assert.equal(saved.ready, false);
    await forward.release();
    await until(
      () => page.locator("#draft-view").isHidden(),
      "The draft view did not end.",
      120000,
    );
    // After the session, playback works.
    await call("playback.seek", { seconds: 4 });
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 4) < 0.1,
      "Seek did not work after the session.",
    );
  },
);

// Review U3: a reply for another picture must not show.
test(
  "a frame reply for another edit state does not become the clean picture",
  { timeout: 120000 },
  async (t) => {
    const { page, element, forward } = await setup(t, "text-identity-");
    await forward.stub("export.status", {
      state: "complete",
      result: {
        baseRevision: "another edit state",
        elementId: element.id,
        frameIndex: 60,
        frame: { width: 640, height: 360 },
        under: { url: "file:///missing.png" },
        over: null,
        fadeOpacity: 0,
        displayColor: null,
      },
    });
    await openBox(page, element);
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Typed");
    await page.waitForTimeout(600);
    assert.equal(
      await page.locator("#draft-view").getAttribute("data-mode"),
      "plate",
    );
    assert.equal(await shownText(page), "Typed");
    await forward.unstub("export.status");
    const logged = (await forward.log("preview.frame")).at(-1);
    assert.ok(logged.args.revision, "The request has the edit revision.");
  },
);

// Review U4: the visible button is part of the session.
test(
  "Edit on video goes on with the draft from the inspector, as one session",
  { timeout: 120000 },
  async (t) => {
    const { page, call, video, element, forward } = await setup(
      t,
      "text-button-",
    );
    await item(page, element).click();
    const before = await history(call, video);
    const field = page.locator("#el-text");
    await field.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" one");
    await page.locator("#edit-text").click();
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    assert.equal((await forward.log("element.update")).length, 0);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" two");
    await page.locator("#draft-done").click();
    await until(
      async () => (await savedText(call, video)) === "Hello world one two",
      "The session did not save.",
    );
    assert.equal((await forward.log("element.update")).length, 1);
    assert.equal(await history(call, video), before + 1);

    // The same from the keyboard: focus goes to the button, then Enter.
    await until(
      async () => (await call("playback.status")).ready,
      "No preview.",
      120000,
    );
    await field.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" three");
    await page.locator("#edit-text").focus();
    assert.equal((await forward.log("element.update")).length, 1);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    await page.keyboard.press("Control+Enter");
    await until(
      async () =>
        (await savedText(call, video)) === "Hello world one two three",
      "The second session did not save.",
    );
    assert.equal((await forward.log("element.update")).length, 2);
  },
);

test("a video is paused for an edit", { timeout: 120000 }, async (t) => {
  const { page, call, element } = await setup(t, "text-pause-");
  await call("playback.play");
  await until(
    async () => !(await call("playback.status")).paused,
    "No playback.",
  );
  await openBox(page, element);
  await until(
    async () => (await call("playback.status")).paused,
    "The video did not pause.",
  );
});
