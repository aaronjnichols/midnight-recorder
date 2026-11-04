// Elements and captions on the timeline: a user sees their time, selects them,
// and changes their time with the pointer. One gesture is one command and one
// undo step. Also the caption panel at the smallest window.
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

function makeVideo(root, name = "sample", seconds = 10) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2e3440:s=1280x720:r=30:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  return file;
}
const list = async (call, id) => (await call("element.list", { id })).elements;
const stored = async (call, id) => (await call("library.get", { id })).timeline;
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
const seconds = async (call) => (await call("playback.status")).seconds;
const near = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? "Value"}: ${actual} is not near ${expected}.`,
  );
const bar = (page, id) => page.locator(`.lane-bar[data-id="${id}"]`);
const edge = (page, id, name) =>
  page.locator(`.lane-bar[data-id="${id}"] .lane-handle[data-edge="${name}"]`);
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
const pixelsFor = async (page, time, total) =>
  ((await page.locator("#timeline-track").boundingBox()).width * time) / total;
async function drag(page, from, dx, { finish = true } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++)
    await page.mouse.move(from.x + (dx * i) / 6, from.y);
  if (finish) await page.mouse.up();
}
const activeTool = (page) =>
  page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tool");
const commandsOf = (forward, name) => forward.log(name);

test(
  "an element shows on the timeline, and a drag changes its time in one step",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "lanes-element-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Lane sample",
    });
    await call("element.add", {
      id: video.id,
      type: "text",
      text: "First label",
      start: 1,
      end: 4,
    });
    await call("element.add", {
      id: video.id,
      type: "rectangle",
      start: 5,
      end: 8,
    });
    const [text, box] = await list(call, video.id);
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);

    // A bar for each element, at its time, in the Trim & cut tool too.
    const track = await page.locator("#timeline-track").boundingBox();
    const place = await bar(page, text.id).boundingBox();
    near((place.x - track.x) / track.width, 0.1, 0.005, "Bar start");
    near(place.width / track.width, 0.3, 0.005, "Bar length");
    assert.match(await bar(page, text.id).innerText(), /First label/);
    assert.match(
      await bar(page, text.id).getAttribute("title"),
      /1\.00.*4\.00/,
    );
    assert.equal(await page.locator(".lane-handle").count(), 0);

    // A click selects the element, opens its tool, and moves the playhead.
    await ready(call);
    await call("playback.seek", { seconds: 9 });
    await bar(page, text.id).click();
    assert.equal(await activeTool(page), "elements");
    await page.waitForSelector(
      `.layer-row[data-id="${text.id}"] [aria-pressed="true"]`,
    );
    await until(
      async () => Math.abs((await seconds(call)) - 1) < 0.05,
      "The click did not move the playhead into the element.",
    );
    assert.equal(await edge(page, text.id, "end").isVisible(), true);

    // The end handle: only the end changes, in one step.
    const past = (await stored(call, video.id)).past.length;
    await drag(
      page,
      center(await edge(page, text.id, "end").boundingBox()),
      await pixelsFor(page, 2, 10),
    );
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "The drag did not save.",
    );
    let updates = await commandsOf(forward, "element.update");
    assert.equal(updates.length, 1, "One command for one drag.");
    assert.deepEqual(Object.keys(updates[0].args).sort(), [
      "elementId",
      "end",
      "id",
    ]);
    near((await list(call, video.id))[0].end, 6, 0.05, "New end");
    assert.equal((await list(call, video.id))[0].start, 1);

    // The start handle: only the start changes.
    await ready(call);
    await drag(
      page,
      center(await edge(page, text.id, "start").boundingBox()),
      await pixelsFor(page, 1, 10),
    );
    await until(
      async () => (await stored(call, video.id)).past.length === past + 2,
      "The start did not save.",
    );
    updates = await commandsOf(forward, "element.update");
    assert.deepEqual(Object.keys(updates[1].args).sort(), [
      "elementId",
      "id",
      "start",
    ]);

    // Undo returns one step.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await list(call, video.id))[0].start === 1,
      "Undo did not return the start.",
    );

    // Escape during a drag: no command, and the bar returns.
    await ready(call);
    const before = await bar(page, text.id).boundingBox();
    const count = (await commandsOf(forward, "element.update")).length;
    await drag(
      page,
      center(await edge(page, text.id, "end").boundingBox()),
      100,
      { finish: false },
    );
    assert.notEqual(
      (await bar(page, text.id).boundingBox()).width,
      before.width,
      "The bar follows the drag.",
    );
    await page.keyboard.press("Escape");
    assert.equal((await bar(page, text.id).boundingBox()).width, before.width);
    await page.mouse.up();
    // A lost pointer also sends nothing.
    await drag(
      page,
      center(await edge(page, text.id, "end").boundingBox()),
      60,
      { finish: false },
    );
    await page.evaluate(() =>
      document
        .querySelector("#timeline-scroll")
        .dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
        ),
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal((await commandsOf(forward, "element.update")).length, count);

    // The first drag of an unselected element selects and moves it: the body
    // sends both times and keeps the length.
    const body = center(await bar(page, box.id).boundingBox());
    await drag(page, body, -(await pixelsFor(page, 2, 10)));
    await until(async () => {
      const [, moved] = await list(call, video.id);
      return Math.abs(moved.start - 3) < 0.06;
    }, "The first drag did not move the element.");
    const [, moved] = await list(call, video.id);
    near(moved.end - moved.start, 3, 0.011, "Same length");
    assert.equal(await activeTool(page), "elements");
    await page.waitForSelector(
      `.layer-row[data-id="${box.id}"] [aria-pressed="true"]`,
    );
    const last = (await commandsOf(forward, "element.update")).at(-1);
    assert.deepEqual(Object.keys(last.args).sort(), [
      "elementId",
      "end",
      "id",
      "start",
    ]);

    // A press without a move sends nothing.
    const quiet = (await commandsOf(forward, "element.update")).length;
    await bar(page, box.id).click();
    await page.waitForTimeout(300);
    assert.equal((await commandsOf(forward, "element.update")).length, quiet);

    // The end stops at the end of the video. At a fractional speed it is the
    // exact end.
    await call("edit.configure", { id: video.id, speed: 1.5 });
    const total = 10 / 1.5;
    await until(
      async () => (await page.locator("#duration").innerText()) === "0:06",
      "The speed did not show.",
    );
    await ready(call);
    await drag(
      page,
      center(await edge(page, box.id, "end").boundingBox()),
      2000,
    );
    await until(
      async () => Math.abs((await list(call, video.id))[1].end - total) < 1e-6,
      "The end did not stop at the exact end.",
    );
    assert.equal((await list(call, video.id))[1].sourceEnd, 10);

    // An element that a cut removed has no bar.
    await call("edit.configure", { id: video.id, speed: 1 });
    await call("edit.cut", { id: video.id, start: 0.5, end: 7 });
    await until(
      async () => (await bar(page, text.id).count()) === 0,
      "A removed element still has a bar.",
    );
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
  },
);

test(
  "a caption shows on the timeline and stops at the captions around it",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "lanes-caption-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Caption lanes",
    });
    for (const [text, start, end] of [
      ["First words", 1, 2],
      ["Second words", 3, 4],
      ["Third words", 6, 7],
    ])
      await call("captions.add", { id: video.id, text, start, end });
    const [first, second, third] = (await captionList(call, video.id)).cues;
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await ready(call);

    // The first click selects the caption and moves the playhead to it.
    await call("playback.seek", { seconds: 9 });
    await bar(page, second.id).click();
    assert.equal(await activeTool(page), "captions");
    assert.equal(await page.locator("#cap-text").inputValue(), "Second words");
    await until(
      async () => Math.abs((await seconds(call)) - 3) < 0.05,
      "The first click did not seek.",
    );

    // The end stops at the start of the next caption, with no error.
    await drag(
      page,
      center(await edge(page, second.id, "end").boundingBox()),
      await pixelsFor(page, 6, 10),
    );
    await until(
      async () =>
        Math.abs((await captionList(call, video.id)).cues[1].end - 6) < 0.001,
      "The end did not stop at the next caption.",
    );
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
    const updates = await forward.log("captions.update");
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(updates[0].args).sort(), [
      "cueId",
      "end",
      "id",
    ]);

    // The start stops at the end of the previous caption.
    await ready(call);
    await drag(
      page,
      center(await edge(page, second.id, "start").boundingBox()),
      -(await pixelsFor(page, 6, 10)),
    );
    await until(
      async () =>
        Math.abs((await captionList(call, video.id)).cues[1].start - 2) < 0.001,
      "The start did not stop at the previous caption.",
    );

    // The body moves and stops between its neighbors.
    await ready(call);
    await bar(page, first.id).click();
    const body = center(await bar(page, first.id).boundingBox());
    await drag(page, body, -(await pixelsFor(page, 3, 10)));
    await until(
      async () => (await captionList(call, video.id)).cues[0].start < 0.01,
      "The body did not stop at the start of the video.",
    );
    const moved = (await captionList(call, video.id)).cues[0];
    near(moved.end - moved.start, 1, 0.011, "Same length");
    assert.equal(third.start, 6);
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
  },
);

test(
  "a lane drag ends when the video or its timing changes, and sends nothing",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "lanes-late-");
    await setSize(app, 1000, 720);
    const first = await call("library.import", {
      path: makeVideo(root, "first"),
      title: "First",
    });
    const second = await call("library.import", {
      path: makeVideo(root, "second"),
      title: "Second",
    });
    await call("element.add", {
      id: first.id,
      type: "rectangle",
      start: 2,
      end: 5,
    });
    const [box] = await list(call, first.id);
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, first);
    await bar(page, box.id).click();

    // A cut from another client during a drag.
    await drag(
      page,
      center(await edge(page, box.id, "end").boundingBox()),
      80,
      { finish: false },
    );
    await call("edit.cut", { id: first.id, start: 8, end: 9 });
    await until(
      async () => (await page.locator("#timeline-bars i").count()) === 2,
      "The cut did not show.",
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal((await forward.log("element.update")).length, 0);
    near((await list(call, first.id))[0].end, 5, 1e-6, "The end stays");

    // Another video opens during a drag.
    await ready(call);
    await drag(
      page,
      center(await edge(page, box.id, "end").boundingBox()),
      80,
      { finish: false },
    );
    await call("playback.open", { id: second.id });
    await until(
      async () =>
        (await page.locator("#video-title").textContent()) === "Second",
      "The second video did not open.",
    );
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal((await forward.log("element.update")).length, 0);
    assert.equal(await page.locator(".lane-bar").count(), 0);
  },
);

test(
  "many elements and captions do not make the timeline taller",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "lanes-many-");
    await setSize(app, 1000, 720);
    const empty = await call("library.import", {
      path: makeVideo(root, "empty"),
      title: "Empty",
    });
    const full = await call("library.import", {
      path: makeVideo(root, "full"),
      title: "Full",
    });
    for (let i = 0; i < 12; i++)
      await call("element.add", {
        id: full.id,
        type: "rectangle",
        start: 0.5,
        end: 9,
      });
    for (let i = 0; i < 18; i++)
      await call("captions.add", {
        id: full.id,
        text: `Caption ${i + 1}`,
        start: i * 0.5,
        end: i * 0.5 + 0.4,
      });
    const size = () =>
      page.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          dock: box(".timeline-dock").height,
          video: box(".player-wrap").height,
          scroll: document.documentElement.scrollHeight - innerHeight,
        };
      });
    await openEditor(page, call, empty);
    const before = await size();
    await openEditor(page, call, full);
    await until(
      async () => (await page.locator(".lane-bar").count()) === 30,
      "All items show on the lanes.",
    );
    assert.deepEqual(await size(), before);
    // Every element stays reachable: the selected bar is in front.
    const elements = await list(call, full.id);
    await page.getByRole("tab", { name: "Text & shapes", exact: true }).click();
    await page
      .locator(`.layer-row[data-id="${elements[0].id}"] .layer-select`)
      .click();
    const selected = page.locator(".lane-bar.selected");
    assert.equal(await selected.count(), 1);
    assert.equal(await selected.getAttribute("data-id"), elements[0].id);
    const point = center(await selected.boundingBox());
    assert.equal(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y).closest(".lane-bar")?.dataset.id,
        point,
      ),
      elements[0].id,
    );
  },
);

test(
  "captions read as a list at the smallest window and can select the video",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "lanes-panel-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "panel", 24),
      title: "Caption panel",
    });
    for (let i = 0; i < 20; i++)
      await call("captions.add", {
        id: video.id,
        text: `Caption number ${i + 1} with some words`,
        start: i + 0.1,
        end: i + 0.9,
      });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await page.getByRole("tab", { name: "Captions", exact: true }).click();
    const { cues } = await captionList(call, video.id);
    const row = (cue) =>
      page.locator(`.caption-row[data-id="${cue.id}"] .caption-select`);
    const shown = (locator) =>
      locator.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const panel = document
          .querySelector("#tool-panels")
          .getBoundingClientRect();
        const form = document.querySelector("#caption-form");
        const bottom = form.hidden
          ? panel.bottom
          : form.getBoundingClientRect().top;
        return r.top >= panel.top - 1 && r.bottom <= bottom + 1;
      });

    // With a selected caption, rows of the list and the form both show.
    await row(cues[1]).click();
    await page.waitForTimeout(200);
    assert.equal(await shown(row(cues[1])), true, "The selected row shows.");
    assert.equal(await shown(row(cues[2])), true, "The next row shows.");
    assert.equal(await page.locator("#cap-text").isVisible(), true);
    // The next row is free to click. The form does not cover it.
    await row(cues[2]).click();
    assert.equal(await row(cues[2]).getAttribute("aria-pressed"), "true");
    await row(cues[1]).click();
    assert.equal(await row(cues[1]).getAttribute("aria-pressed"), "true");
    const text = await row(cues[1]).evaluate(
      (node) => getComputedStyle(node.querySelector(".caption-text")).fontSize,
    );
    assert.equal(text, "13px", "Caption text is readable.");

    // A selection on the timeline: Remove is a separate, explicit edit.
    await page.getByRole("button", { name: "Select on timeline" }).click();
    near(
      Number(await page.locator("#range-start").inputValue()),
      cues[1].start,
      0.01,
      "Draft start",
    );
    near(
      Number(await page.locator("#range-end").inputValue()),
      cues[1].end,
      0.01,
      "Draft end",
    );
    assert.equal(
      (await stored(call, video.id)).segments.length,
      1,
      "A draft does not change the video.",
    );
    assert.equal(
      (await forward.log()).filter((c) => c.command.startsWith("edit.")).length,
      0,
    );
    // Delete caption removes the caption and not the video.
    await page.getByRole("button", { name: "Delete caption" }).click();
    await until(
      async () => (await captionList(call, video.id)).count === 19,
      "The caption was not deleted.",
    );
    assert.equal((await stored(call, video.id)).segments.length, 1);
    await page
      .getByRole("button", { name: "Remove the selection", exact: true })
      .click();
    await until(
      async () => (await stored(call, video.id)).segments.length === 2,
      "The cut did not run.",
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await stored(call, video.id)).segments.length === 1,
      "No undo.",
    );

    // The list follows the playhead. The undo reloads the preview first.
    await page.waitForTimeout(400);
    await ready(call);
    await page.keyboard.press("Escape");
    await page.locator("#video-title").focus();
    await page.keyboard.press("Escape");
    await call("playback.seek", { seconds: 15.5 });
    const current = page.locator(".caption-row.current .caption-select");
    await current.waitFor();
    await until(
      () => shown(current),
      "The list did not follow the playhead.",
      5000,
    );

    // Typing stops the follow: the caret and the scroll stay.
    const later = (await captionList(call, video.id)).cues[4];
    await row(later).click();
    const field = page.locator("#cap-text");
    await field.fill("Draft words");
    await field.press("Home");
    const scroll = () =>
      page.locator("#tool-panels").evaluate((node) => node.scrollTop);
    const top = await scroll();
    await call("playback.seek", { seconds: 20.5 });
    await page.waitForTimeout(500);
    assert.equal(await scroll(), top, "The list stays while the user types.");
    assert.deepEqual(
      await field.evaluate((node) => [
        document.activeElement === node,
        node.selectionStart,
        node.value,
      ]),
      [true, 0, "Draft words"],
    );
    // Leaving the field saves the draft, and the preview renders again.
    await page.locator("#video-title").click();
    await until(
      async () =>
        (await captionList(call, video.id)).cues[4].text === "Draft words",
      "The draft did not save.",
    );
    await page.waitForTimeout(400);
    await ready(call);

    // A manual scroll also stops the follow for some time.
    await page.locator("#tool-panels").hover();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);
    const browsed = await scroll();
    await call("playback.seek", { seconds: 3.5 });
    await page.waitForTimeout(500);
    assert.equal(await scroll(), browsed, "Manual browsing stays.");
  },
);
