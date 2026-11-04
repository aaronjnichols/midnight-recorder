import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import { frameAt, region } from "../test-support/frames.js";

// The current editor layout. Earlier stage files in claude-editing stay.
const SHOTS = path.resolve("output/playwright/loom-redesign/tests");

async function launch(t, prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/claude-editing", prefix));
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "No page errors."));
  const call = (name, args = {}) =>
    page.evaluate(([n, a]) => window.midnight.execute(n, a), [name, args]);
  return { root, app, page, call };
}

const setSize = (app, width, height) =>
  app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()
        .find((x) => x.webContents.getURL().endsWith("/ui/index.html"))
        .setSize(w, h),
    [width, height],
  );

// Bounded wait for a state. It does not assume a device or render time.
async function until(check, message, limit = 60000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function makeVideo(root, name, size, seconds = 8) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2e3440:s=${size}:r=30:d=${seconds}`,
    "-vf",
    "drawbox=x=iw*0.1:y=ih*0.1:w=iw*0.2:h=ih*0.1:color=0x88c0d0:t=fill",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
  return file;
}

async function openEditor(page, call, video) {
  await call("playback.open", { id: video.id });
  await page.waitForSelector("#editor:not([hidden])");
  return ready(page, call);
}
const ready = async (page, call) => {
  try {
    return await until(
      async () => (await call("playback.status")).ready,
      "The preview did not become ready.",
    );
  } catch (error) {
    const state = await page.evaluate(() => {
      const p = document.querySelector("#player");
      return {
        text: document.querySelector("#preview-state").textContent,
        src: p.getAttribute("src"),
        error: p.error && [p.error.code, p.error.message],
      };
    });
    throw new Error(`${error.message} ${JSON.stringify(state)}`);
  }
};
const list = (call, id) => call("element.list", { id });
const stored = async (call, id) => (await call("library.get", { id })).timeline;
// Advanced numbers are in a disclosure. A user opens it with a click.
async function openDisclosure(page, field) {
  const details = page.locator(`details:has(${field})`);
  if (!(await details.evaluate((node) => node.open)))
    await details.locator("summary").click();
}

// Drag with real mouse events from a point by an offset.
async function drag(page, from, dx, dy, { cancel = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++)
    await page.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
// The stage draws its outlines again after each change. Wait until an
// outline or handle has a box on screen.
const boxOf = (locator) =>
  until(() => locator.boundingBox(), "The outline has no box.", 10000);

test(
  "the element editor adds, edits, moves, resizes, orders, and deletes with one undo step each",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "editor-ui-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root, "Landscape sample", "640x360"),
      title: "Landscape sample",
    });
    await openEditor(page, call, video);
    await page.screenshot({
      path: path.join(SHOTS, "stage2-editor-before-1440.png"),
    });

    // Add a label at the playhead with a real button.
    await call("playback.seek", { seconds: 1 });
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 1) < 0.05,
      "Seek did not finish.",
    );
    await page.getByRole("button", { name: "Add label" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "No label.",
    );
    let [label] = (await list(call, video.id)).elements;
    assert.deepEqual([label.type, label.start, label.end], ["text", 1, 4]);
    assert.notEqual(label.background, "none");
    await page.waitForSelector(
      `.layer-row[data-id="${label.id}"] [aria-pressed="true"]`,
    );
    assert.equal(await page.locator("#el-text").inputValue(), "Label");
    assert.match(await page.locator("#element-panel").innerText(), /seconds/);
    assert.match(
      await page.locator("#element-panel").innerText(),
      /% of the video height/,
    );

    // Change the text. Typing Delete in the field changes text, not layers.
    await page.locator("#el-text").fill("Click Saved");
    await page.locator("#el-text").press("End");
    await page.locator("#el-text").press("Backspace");
    await page.locator("#el-text").press("Tab");
    await until(
      async () =>
        (await list(call, video.id)).elements[0]?.text === "Click Save",
      "The text did not save.",
    );
    assert.equal((await list(call, video.id)).elements.length, 1);

    // A trim removes the end of the label. Then a style change and a start
    // change must keep the stored source end.
    await call("edit.trim", { id: video.id, start: 0, end: 3 });
    await until(
      async () => (await page.locator("#duration").innerText()) === "0:03",
      "The trim did not show.",
    );
    const sourceEnd = (await list(call, video.id)).elements[0].sourceEnd;
    assert.equal(sourceEnd, 4);
    await page.locator("#el-size").fill("7");
    await page.locator("#el-size").press("Enter");
    await until(
      async () => (await list(call, video.id)).elements[0].size === 0.07,
      "The size did not save.",
    );
    await page.locator("#el-start").fill("1.5");
    await page.locator("#el-start").press("Enter");
    await until(
      async () => (await list(call, video.id)).elements[0].start === 1.5,
      "The start did not save.",
    );
    assert.equal((await list(call, video.id)).elements[0].sourceEnd, sourceEnd);
    await call("edit.undo", { id: video.id });
    await call("edit.undo", { id: video.id });
    await call("edit.undo", { id: video.id });
    await ready(page, call);

    // A rejected value shows an error and does not change the saved state.
    const before = await stored(call, video.id);
    await openDisclosure(page, "#el-x");
    await page.locator("#el-x").fill("90");
    await page.locator("#el-x").press("Enter");
    await page.waitForSelector("#message.error:not([hidden])");
    assert.deepEqual(await stored(call, video.id), before);
    assert.notEqual(await page.locator("#el-x").inputValue(), "90");

    // Move the label on the video with the pointer. One undo step.
    await ready(page, call);
    await call("playback.seek", { seconds: 2 });
    const item = page.locator(`.stage-item[data-id="${label.id}"]`);
    await item.waitFor();
    const stage = await page.locator("#stage").boundingBox();
    const box = await item.boundingBox();
    const past = before.past.length;
    await drag(page, center(box), stage.width * 0.1, stage.height * 0.05);
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "The move did not save.",
    );
    [label] = (await list(call, video.id)).elements;
    assert.ok(Math.abs(label.x - 0.15) < 0.01, `x ${label.x}`);
    assert.ok(Math.abs(label.y - 0.83) < 0.01, `y ${label.y}`);
    // A cancelled drag changes nothing.
    await drag(page, center(await boxOf(item)), 80, -40, {
      cancel: true,
    });
    await page.waitForTimeout(300);
    assert.equal((await stored(call, video.id)).past.length, past + 1);
    // Resize from the bottom right handle.
    const handle = page.locator(
      `.stage-item[data-id="${label.id}"] .handle[data-handle="se"]`,
    );
    await drag(page, center(await boxOf(handle)), stage.width * 0.1, 0);
    await until(
      async () => (await stored(call, video.id)).past.length === past + 2,
      "The resize did not save.",
    );
    [label] = (await list(call, video.id)).elements;
    assert.ok(Math.abs(label.width - 0.55) < 0.01, `width ${label.width}`);

    // Add an arrow and drag its tip.
    await page.getByRole("button", { name: "Add arrow" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 2,
      "No arrow.",
    );
    const arrow = (await list(call, video.id)).elements[1];
    const tip = page.locator(
      `.stage-item[data-id="${arrow.id}"] .handle[data-handle="tip"]`,
    );
    await tip.waitFor();
    await drag(
      page,
      center(await boxOf(tip)),
      stage.width * 0.1,
      -stage.height * 0.1,
    );
    await until(
      async () =>
        Math.abs((await list(call, video.id)).elements[1].x2 - 0.6) < 0.01,
      "The arrow tip did not move.",
    );
    assert.ok(
      Math.abs((await list(call, video.id)).elements[1].y2 - 0.4) < 0.01,
    );
    assert.equal((await list(call, video.id)).elements[1].x1, arrow.x1);

    // Layer order, duplicate, and delete with buttons and keys.
    await page
      .locator(`.layer-row[data-id="${arrow.id}"] .layer-select`)
      .click();
    await page.getByRole("button", { name: "Send element backward" }).click();
    await until(
      async () => (await list(call, video.id)).elements[0].id === arrow.id,
      "The arrow did not move back.",
    );
    await page.getByRole("button", { name: "Duplicate element" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 3,
      "No copy.",
    );
    await page.getByRole("button", { name: "Delete element" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 2,
      "No delete.",
    );
    await page
      .locator(`.layer-row[data-id="${arrow.id}"] .layer-select`)
      .focus();
    await page.keyboard.press("Delete");
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "Delete key.",
    );
    await page.keyboard.press("Control+z");
    await until(
      async () => (await list(call, video.id)).elements.length === 2,
      "Undo.",
    );
    await page.keyboard.press("Control+Shift+z");
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "Redo.",
    );
    await page.keyboard.press("Control+z");
    await until(
      async () => (await list(call, video.id)).elements.length === 2,
      "Undo 2.",
    );

    // Fades: a fade longer than the element shows the actual value.
    await page
      .locator(`.layer-row[data-id="${label.id}"] .layer-select`)
      .click();
    await openDisclosure(page, "#el-fade-in");
    await page.locator("#el-fade-in").fill("5");
    await page.locator("#el-fade-in").press("Enter");
    await until(
      async () =>
        /The video uses 3 s/.test(
          await page.locator("#el-fade-in-note").innerText(),
        ),
      "No actual fade note.",
    );
    // Video fades are in Speed & sound. Element fades are in Text & shapes.
    await page.getByRole("tab", { name: "Speed & sound", exact: true }).click();
    await page.locator("#video-fade-out").fill("1");
    await page.locator("#video-fade-out").press("Enter");
    await until(
      async () => (await list(call, video.id)).videoFades.fadeOut === 1,
      "The video fade did not save.",
    );
    await page.getByRole("tab", { name: "Text & shapes", exact: true }).click();
    await page.locator("#el-fade-in").fill("0");
    await page.locator("#el-fade-in").press("Enter");
    await until(
      async () => (await list(call, video.id)).elements[1].fadeIn === 0,
      "Fade reset.",
    );

    // A command from the CLI changes the visible controls.
    const env = { ...process.env, MIDNIGHT_DATA: root };
    await promisify(execFile)(
      process.execPath,
      [
        "src/agent/cli.js",
        "element.update",
        JSON.stringify({
          id: video.id,
          elementId: label.id,
          text: "From the CLI",
        }),
      ],
      { env },
    );
    await until(
      async () =>
        (await page.locator("#el-text").inputValue()) === "From the CLI",
      "The form did not show the CLI change.",
    );
    await until(
      async () =>
        /From the CLI/.test(
          await page.locator(`.layer-row[data-id="${label.id}"]`).innerText(),
        ),
      "The layer list did not show the CLI change.",
    );

    // The steady preview shows the rendered label at its box.
    await ready(page, call);
    await call("playback.seek", { seconds: 2 });
    await until(
      () =>
        page.evaluate(() => {
          const p = document.querySelector("#player");
          return (
            !p.seeking &&
            Math.abs(p.currentTime - 2) < 0.05 &&
            p.readyState >= 2
          );
        }),
      "The player did not seek.",
    );
    assert.equal(await page.locator("#source-frame").isVisible(), false);
    await page.screenshot({
      path: path.join(SHOTS, "stage2-editor-after-1440.png"),
    });
    const shot = path.join(root, "player.png");
    await page.locator("#player").screenshot({ path: shot });
    const [w, h] = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      shot,
    ])
      .toString()
      .trim()
      .split(",")
      .map(Number);
    // The label background (#1E2127) is darker than the video (#2E3440)
    // and lighter than the player background (#11141A).
    const dark = region(
      frameAt(shot, 0, w, h),
      ([r, g, b]) =>
        r >= 23 && r < 40 && g >= 26 && g < 44 && b >= 32 && b < 50,
      // The rounded player corners show the page color. Skip the edge.
      { left: 20, top: 20, right: w - 20, bottom: h - 20 },
    );
    assert.ok(
      Math.abs(dark.minX / w - 0.15) < 0.02,
      JSON.stringify([dark.minX, w]),
    );

    // Reload restores the saved elements.
    await page.reload();
    await page.waitForSelector(".video-card");
    await page.locator(".video-card").click();
    // A video opens with Trim & cut. Layers are in Text & shapes.
    await page.getByRole("tab", { name: "Text & shapes", exact: true }).click();
    await page.waitForSelector(`.layer-row[data-id="${label.id}"]`);
    assert.equal(await page.locator(".layer-row").count(), 2);
  },
);

test(
  "pointer editing maps to a portrait video at the minimum window size and in fullscreen",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "editor-portrait-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "Portrait sample", "360x640", 6),
      title: "Portrait sample",
    });
    await openEditor(page, call, video);
    await page.getByRole("button", { name: "Add rectangle" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "No box.",
    );
    const [box] = (await list(call, video.id)).elements;
    await ready(page, call);
    const stage = await page.locator("#stage").boundingBox();
    // The stage is the displayed portrait frame, not the 16:9 player box.
    assert.ok(
      Math.abs(stage.width / stage.height - 360 / 640) < 0.02,
      JSON.stringify(stage),
    );
    const item = await page
      .locator(`.stage-item[data-id="${box.id}"]`)
      .boundingBox();
    assert.ok(Math.abs((item.x - stage.x) / stage.width - box.x) < 0.01);
    assert.ok(Math.abs(item.width / stage.width - box.width) < 0.01);
    // A move far to the right stops at the frame edge.
    await drag(page, center(item), stage.width, 0);
    await until(
      async () =>
        Math.abs((await list(call, video.id)).elements[0].x - (1 - box.width)) <
        0.002,
      "The box did not stop at the edge.",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(SHOTS, "stage2-editor-portrait-1000.png"),
    });

    // Fullscreen: the stage follows the new displayed frame.
    await ready(page, call);
    await page.locator("#video-title").focus();
    await page.keyboard.press("f");
    await page.waitForSelector(".player-shell.fullscreen");
    // The page changes first, then the window. Measure after the window.
    await until(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().endsWith("/ui/index.html"))
            .isFullScreen(),
        ),
      "The window did not enter fullscreen.",
    );
    await page.waitForTimeout(300);
    const big = await until(async () => {
      const b = await page.locator("#stage").boundingBox();
      return b && b.height > stage.height * 1.2 ? b : null;
    }, "The stage did not follow fullscreen.");
    assert.ok(Math.abs(big.width / big.height - 360 / 640) < 0.02);
    const moved = (await list(call, video.id)).elements[0];
    const full = await page
      .locator(`.stage-item[data-id="${box.id}"]`)
      .boundingBox();
    await drag(page, center(full), -big.width * 0.2, 0);
    await until(
      async () =>
        Math.abs((await list(call, video.id)).elements[0].x - (moved.x - 0.2)) <
        0.01,
      "The fullscreen move did not save.",
    );
    await page.screenshot({
      path: path.join(SHOTS, "stage2-editor-portrait-fullscreen.png"),
    });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".player-shell:not(.fullscreen)");
  },
);

test(
  "the video stays visible while lower properties and layers are in use",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "editor-layout-");
    const video = await call("library.import", {
      path: makeVideo(root, "Layout sample", "640x360", 6),
      title: "Layout sample",
    });
    await openEditor(page, call, video);
    for (const kind of ["label", "rectangle", "arrow", "text"]) {
      const count = (await list(call, video.id)).elements.length;
      await page.getByRole("button", { name: `Add ${kind}` }).click();
      await until(
        async () => (await list(call, video.id)).elements.length === count + 1,
        `No ${kind}.`,
      );
    }
    const visible = (selector) =>
      page.locator(selector).evaluate((node) => {
        const box = node.getBoundingClientRect();
        const header = document
          .querySelector(".topbar")
          .getBoundingClientRect().bottom;
        return (
          box.top >= header - 1 &&
          box.bottom <= innerHeight + 1 &&
          box.height > 0
        );
      });
    for (const [width, height] of [
      [1440, 940],
      [1000, 720],
    ]) {
      await setSize(app, width, height);
      await page.waitForTimeout(300);
      // The text element is selected. Its lowest field is the opacity.
      await openDisclosure(page, "#el-opacity");
      await page.locator("#el-opacity").focus();
      await page.waitForTimeout(200);
      assert.equal(
        await visible("#el-opacity"),
        true,
        `${width}: opacity field`,
      );
      assert.equal(
        await visible(".player-wrap"),
        true,
        `${width}: video with properties`,
      );
      // The bottom layer row can show with the video.
      await page.locator(".layer-row:last-child .layer-select").focus();
      await page.waitForTimeout(200);
      assert.equal(
        await visible(".layer-row:last-child"),
        true,
        `${width}: layer row`,
      );
      assert.equal(
        await visible(".player-wrap"),
        true,
        `${width}: video with layers`,
      );
      await page.screenshot({
        path: path.join(SHOTS, `stage2-editor-layout-${width}.png`),
      });
    }
  },
);

test(
  "a drag that starts on an unselected element selects and moves it in one step",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "editor-drag-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root, "Drag sample", "640x360", 6),
      title: "Drag sample",
    });
    await openEditor(page, call, video);
    await call("playback.seek", { seconds: 1 });
    await page.getByRole("button", { name: "Add rectangle" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "No box.",
    );
    await page.getByRole("button", { name: "Add label" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 2,
      "No label.",
    );
    const [box] = (await list(call, video.id)).elements;
    await ready(page, call);
    const item = page.locator(`.stage-item[data-id="${box.id}"]`);
    await item.waitFor();
    assert.equal(
      await item.evaluate((node) => node.classList.contains("selected")),
      false,
    );
    const stage = await page.locator("#stage").boundingBox();
    const past = (await stored(call, video.id)).past.length;
    const start = await item.boundingBox();
    // Start inside the box, away from the label box below it.
    await drag(
      page,
      { x: start.x + 20, y: start.y + 20 },
      -stage.width * 0.1,
      0,
    );
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "The first drag did not save.",
    );
    const [moved] = (await list(call, video.id)).elements;
    assert.ok(Math.abs(moved.x - (box.x - 0.1)) < 0.01, `x ${moved.x}`);
    assert.equal(moved.y, box.y);
    await page.waitForSelector(`.stage-item.selected[data-id="${box.id}"]`);
  },
);

test(
  "at a fractional speed, new elements and playhead times keep a valid end",
  { timeout: 180000 },
  async (t) => {
    const { root, page, call } = await launch(t, "editor-speed-");
    const video = await call("library.import", {
      path: makeVideo(root, "Speed sample", "640x360", 10),
      title: "Speed sample",
    });
    await call("edit.configure", { id: video.id, speed: 1.5 });
    await openEditor(page, call, video);
    const total = 10 / 1.5;
    await call("playback.seek", { seconds: 5 });
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 5) < 0.05,
      "No seek.",
    );
    await page.getByRole("button", { name: "Add label" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "No label.",
    );
    let [label] = (await list(call, video.id)).elements;
    assert.ok(Math.abs(label.end - total) < 1e-6, String(label.end));
    // Enter in an unchanged field sends nothing, also when the shown value
    // is rounded.
    const past = (await stored(call, video.id)).past.length;
    await page.locator("#el-end").focus();
    await page.locator("#el-end").press("Enter");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#message.error").isVisible(), false);
    assert.equal((await stored(call, video.id)).past.length, past);
    // Shorten the label, then set its end at the last frame.
    await page.locator("#el-end").fill("6");
    await page.locator("#el-end").press("Enter");
    await until(
      async () => (await list(call, video.id)).elements[0].end === 6,
      "No end.",
    );
    await ready(page, call);
    await call("playback.seek", { seconds: total });
    await until(
      async () => (await call("playback.status")).seconds > total - 0.05,
      "No seek to the end.",
    );
    await page
      .getByRole("button", { name: "Set element end to the playhead time" })
      .click();
    await until(
      async () =>
        Math.abs((await list(call, video.id)).elements[0].end - total) < 1e-6,
      "The end did not go to the edited end.",
    );
    [label] = (await list(call, video.id)).elements;
    assert.equal(
      label.sourceEnd,
      10,
      "The source end stays on the source end.",
    );
    assert.equal(await page.locator("#message.error").isVisible(), false);
  },
);

test(
  "long text shows fit feedback, and the fit button makes the text fit its box",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "editor-fit-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "Fit sample", "640x360", 4),
      title: "Fit sample",
    });
    await openEditor(page, call, video);
    await page.getByRole("button", { name: "Add label" }).click();
    await until(
      async () => (await list(call, video.id)).elements.length === 1,
      "No label.",
    );
    assert.equal(await page.locator("#el-fit").isVisible(), false);
    await page
      .locator("#el-text")
      .fill("This label has far too many words for its small box on the video");
    await page.locator("#el-text").press("Tab");
    await page.waitForSelector("#el-fit:not([hidden])");
    assert.match(
      await page.locator("#el-fit").innerText(),
      /larger than its box/,
    );
    const before = (await list(call, video.id)).elements[0].size;
    await page
      .getByRole("button", { name: "Make the text fit the box" })
      .click();
    await until(
      async () => (await list(call, video.id)).elements[0].size < before,
      "The size did not change.",
    );
    await page.waitForSelector("#el-fit[hidden]", { state: "attached" });
    // The rendered preview shows all of the text inside the box.
    await ready(page, call);
    await page.screenshot({
      path: path.join(SHOTS, "stage2-editor-text-fit-1000.png"),
    });
  },
);
