// The focused editor: the video, the tools, and the timeline fit the window.
// A user selects a part of the video on the timeline with the pointer, then
// keeps or removes it. Tests use real clicks, keys, and drag coordinates, and
// read the saved timeline and the command log.
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

// 10 seconds with a tone. The picture is 1280 x 720.
function makeVideo(root, name = "sample", seconds = 10, size = "1280x720") {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2e3440:s=${size}:r=30:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
    "-vf",
    "drawbox=x=iw*0.6:y=ih*0.6:w=iw*0.2:h=ih*0.2:color=0x88c0d0:t=fill",
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
const stored = async (call, id) => (await call("library.get", { id })).timeline;
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
const seconds = async (call) => (await call("playback.status")).seconds;
const inView = (locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (
      r.top < 0 ||
      r.left < 0 ||
      r.bottom > innerHeight ||
      r.right > innerWidth
    )
      return false;
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return hit === node || node.contains(hit) || hit?.control === node;
  });
const draft = async (page) => [
  Number(await page.locator("#range-start").inputValue()),
  Number(await page.locator("#range-end").inputValue()),
];
const near = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? "Value"}: ${actual} is not near ${expected}.`,
  );
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
// A point on the track at an edited time, from its box on screen.
const trackPoint = async (page, time, total) => {
  const box = await page.locator("#timeline-track").boundingBox();
  return { x: box.x + (box.width * time) / total, y: box.y + box.height / 2 };
};
async function drag(page, from, to, { finish = true, steps = 8 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++)
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  if (finish) await page.mouse.up();
}
const handle = async (page, which) =>
  center(await page.locator(`#range-handle-${which}`).boundingBox());
// A handle keeps its distance from the pointer, so it does not jump when the
// press starts. This drags it by the distance between two times.
async function dragHandle(page, which, from, to, total, options) {
  const start = await handle(page, which);
  const shift =
    (await trackPoint(page, to, total)).x -
    (await trackPoint(page, from, total)).x;
  await drag(page, start, { x: start.x + shift, y: start.y }, options);
}
// A point past the right end of the track, in the window.
const pastEnd = async (page) => {
  const box = await page.locator("#timeline-track").boundingBox();
  return { x: box.x + box.width + 11, y: box.y + box.height / 2 };
};
const editLog = async (forward) =>
  (await forward.log()).filter((c) =>
    /^(edit\.|element\.(add|update|remove|duplicate|order)|captions\.(add|update|delete|configure|remove|generate|apply))/.test(
      c.command,
    ),
  );

test(
  "the open editor is a focused workspace that fits both window sizes",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-layout-");
    const video = await call("library.import", {
      path: makeVideo(root),
      title:
        "A long title that shows how the compact top bar keeps the actions in view at the smallest window",
    });
    for (const [width, height, minimum] of [
      [1000, 720, { width: 640, height: 355 }],
      [1440, 940, { width: 960, height: 540 }],
    ]) {
      await setSize(app, width, height);
      await openEditor(page, call, video);
      await page.waitForTimeout(300);
      const layout = await page.evaluate(() => {
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        const root = document.documentElement;
        return {
          sidebar: getComputedStyle(document.querySelector(".sidebar")).display,
          scrollY: root.scrollHeight - innerHeight,
          scrollX: root.scrollWidth - innerWidth,
          video: box(".player-wrap"),
          track: box("#timeline-track"),
          viewport: innerWidth,
        };
      });
      assert.equal(layout.sidebar, "none", `${width}: no library sidebar`);
      assert.ok(
        layout.scrollY <= 0,
        `${width}: no page scroll, ${layout.scrollY}`,
      );
      assert.ok(
        layout.scrollX <= 0,
        `${width}: no side scroll, ${layout.scrollX}`,
      );
      assert.ok(
        layout.video.width >= minimum.width &&
          layout.video.height >= minimum.height,
        `${width}: the video is ${layout.video.width} x ${layout.video.height}`,
      );
      assert.ok(
        layout.track.width >= layout.viewport * 0.9,
        `${width}: the timeline is ${layout.track.width} wide`,
      );
      assert.equal(
        await page.locator(".page-heading:visible").count(),
        0,
        `${width}: no large heading`,
      );
      for (const [name, locator] of [
        ["back", page.getByRole("button", { name: "Back to library" })],
        ["title", page.locator("#video-title")],
        ["undo", page.getByRole("button", { name: "Undo", exact: true })],
        ["redo", page.getByRole("button", { name: "Redo", exact: true })],
        ["export", page.getByRole("button", { name: "Export MP4" })],
        ["save state", page.locator("#save-state")],
        ["preview state", page.locator("#preview-state")],
        ["play", page.getByRole("button", { name: "Play preview" })],
        ["time", page.locator("#preview-time")],
        ["volume", page.getByRole("slider", { name: "Preview volume" })],
        ["fullscreen", page.getByRole("button", { name: "Fullscreen" })],
        ["keep", page.getByRole("button", { name: "Keep only the selection" })],
        ["remove", page.getByRole("button", { name: "Remove the selection" })],
        ["zoom in", page.getByRole("button", { name: "Zoom in" })],
        ["zoom out", page.getByRole("button", { name: "Zoom out" })],
        [
          "fit",
          page.getByRole("button", { name: "Fit the video in the timeline" }),
        ],
        ["start handle", page.getByRole("slider", { name: "Selection start" })],
        ["end handle", page.getByRole("slider", { name: "Selection end" })],
        ["ruler", page.locator("#timeline-ruler")],
        ["tools", page.getByRole("tablist", { name: "Editing tools" })],
        ["add text", page.getByRole("button", { name: "Add text" })],
        ["add arrow", page.getByRole("button", { name: "Add arrow" })],
      ])
        assert.equal(
          await inView(locator),
          true,
          `${width}: ${name} is in view`,
        );
      assert.ok(
        (await page.locator("#timeline-ruler span").count()) >= 3,
        `${width}: the ruler has times`,
      );
      await page.screenshot({
        path: path.resolve(
          `output/playwright/loom-redesign/test-open-${width}.png`,
        ),
      });
    }

    // Back to library returns the normal page.
    await page.getByRole("button", { name: "Back to library" }).click();
    await page.waitForSelector("#library-view:not([hidden])");
    assert.equal(await page.locator(".sidebar").isVisible(), true);
    assert.equal(await page.locator("#recorder").isVisible(), true);
    assert.equal(await page.locator("#editor").isHidden(), true);
    assert.equal(
      await page.evaluate(() => document.activeElement.dataset.id),
      video.id,
      "Focus returns to the video card.",
    );
  },
);

test(
  "a user selects a part on the timeline and removes or keeps it with one undo step",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-range-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Range sample",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const keep = page.getByRole("button", {
      name: "Keep only the selection",
      exact: true,
    });
    const remove = page.getByRole("button", {
      name: "Remove the selection",
      exact: true,
    });
    assert.equal(await remove.isDisabled(), true);

    // Drag on the track: a draft selection. Nothing changes in the media.
    const past = (await stored(call, video.id)).past.length;
    const source = await page.locator("#player").getAttribute("src");
    await drag(
      page,
      await trackPoint(page, 2, 10),
      await trackPoint(page, 5, 10),
    );
    let [start, end] = await draft(page);
    near(start, 2, 0.03, "Start");
    near(end, 5, 0.03, "End");
    assert.equal(await remove.isEnabled(), true);
    // A small window shows only the times. The name has all of the words.
    assert.match(
      await page.locator("#selection-chip").innerText(),
      /^\d\.\d\d to \d\.\d\d s/,
    );
    assert.match(
      await page.locator("#selection-chip").getAttribute("aria-label"),
      /^Selection \d\.\d\d to \d\.\d\d s/,
    );
    assert.deepEqual(await editLog(forward), [], "A draft sends no edit.");
    assert.equal((await stored(call, video.id)).past.length, past);
    assert.equal(await page.locator("#player").getAttribute("src"), source);
    // The selection and handles are on the track where the times are.
    const frame = await page.locator("#timeline-range").boundingBox();
    const track = await page.locator("#timeline-track").boundingBox();
    near((frame.x - track.x) / track.width, start / 10, 0.005, "Frame left");
    near(
      (frame.x + frame.width - track.x) / track.width,
      end / 10,
      0.005,
      "Frame right",
    );

    // Escape during a handle drag restores the draft from before the drag.
    const before = await draft(page);
    await drag(page, await handle(page, "end"), await trackPoint(page, 8, 10), {
      finish: false,
    });
    assert.notDeepEqual(
      await draft(page),
      before,
      "The draft follows the drag.",
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(await draft(page), before, "Escape restores the draft.");
    await page.mouse.up();
    assert.deepEqual(await draft(page), before, "The release adds no change.");

    // A lost pointer also restores the draft.
    await drag(
      page,
      await handle(page, "start"),
      await trackPoint(page, 1, 10),
      { finish: false },
    );
    await page.evaluate(() =>
      document
        .querySelector("#timeline-scroll")
        .dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }),
        ),
    );
    assert.deepEqual(await draft(page), before, "Pointer cancel restores it.");
    await page.mouse.up();

    // Handles: the start moves. It stops at the end handle.
    await dragHandle(page, "start", before[0], 3, 10);
    [start, end] = await draft(page);
    near(start, 3, 0.03, "New start");
    assert.equal(end, before[1], "The other end stays.");
    await drag(
      page,
      await handle(page, "start"),
      await trackPoint(page, 9.5, 10),
    );
    [start, end] = await draft(page);
    assert.ok(start < end, `${start} must be before ${end}.`);
    near(end - start, 0.05, 0.011, "Smallest selection");
    // The end handle goes to the track end and stops there.
    await drag(page, await handle(page, "end"), await pastEnd(page));
    assert.equal((await draft(page))[1], 10);

    // Drag the selection body: the length stays.
    await page.locator("#range-start").fill("2");
    await page.locator("#range-end").fill("4");
    const body = center(await page.locator("#timeline-range").boundingBox());
    const shift =
      (await trackPoint(page, 6, 10)).x - (await trackPoint(page, 3, 10)).x;
    await drag(page, body, { x: body.x + shift, y: body.y });
    [start, end] = await draft(page);
    near(start, 5, 0.03, "Moved start");
    near(end - start, 2, 0.011, "Same length");

    // A click moves the playhead and keeps the selection.
    await ready(call);
    const point = await trackPoint(page, 1, 10);
    await page.mouse.click(point.x, point.y);
    await until(
      async () => Math.abs((await seconds(call)) - 1) < 0.05,
      "The click did not move the playhead.",
    );
    assert.deepEqual(await draft(page), [start, end], "The selection stays.");

    // Remove: one command, one undo step, with the times of the handles.
    assert.deepEqual(await editLog(forward), [], "No edit before the action.");
    await remove.click();
    await until(
      async () => (await stored(call, video.id)).segments.length === 2,
      "No cut.",
    );
    const timeline = await stored(call, video.id);
    assert.equal(timeline.past.length, past + 1);
    assert.equal((await editLog(forward)).length, 1);
    near(timeline.segments[0].end, start, 1e-9);
    near(timeline.segments[1].start, end, 1e-9);
    assert.equal(await page.locator("#timeline-bars i").count(), 2);
    // The selection ends with the edit.
    assert.equal(await remove.isDisabled(), true);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await stored(call, video.id)).segments.length === 1,
      "No undo.",
    );

    // Keep: drag a new selection and keep it.
    await ready(call);
    await drag(
      page,
      await trackPoint(page, 4, 10),
      await trackPoint(page, 2, 10),
    );
    [start, end] = await draft(page);
    near(start, 2, 0.03, "Reverse drag start");
    near(end, 4, 0.03, "Reverse drag end");
    await keep.click();
    await until(
      async () =>
        (await stored(call, video.id)).past.length === past + 1 &&
        (await stored(call, video.id)).segments[0].start !== 0,
      "No keep.",
    );
    const [kept] = (await stored(call, video.id)).segments;
    near(kept.start, start, 1e-9);
    near(kept.end, end, 1e-9);
  },
);

test(
  "zoom, Fit, and scroll keep the timeline times correct",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-zoom-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "zoom", 30),
      title: "Zoom sample",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const fit = page.getByRole("button", {
      name: "Fit the video in the timeline",
    });
    const zoomIn = page.getByRole("button", { name: "Zoom in" });
    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    const scroller = page.locator("#timeline-scroll");
    const fitWidth = (await page.locator("#timeline-track").boundingBox())
      .width;
    assert.equal(await zoomOut.isDisabled(), true, "Fit is the smallest zoom.");
    assert.equal(await fit.isDisabled(), true);
    await zoomIn.click();
    await zoomIn.click();
    await zoomIn.click();
    const zoomed = (await page.locator("#timeline-track").boundingBox()).width;
    assert.ok(zoomed > fitWidth * 3, `The track is ${zoomed} wide.`);
    assert.equal(await zoomOut.isEnabled(), true);
    assert.ok((await page.locator("#timeline-ruler span").count()) >= 3);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Only the timeline scrolls.",
    );

    // Scroll, then drag on the zoomed track. The box of the track on screen
    // is the mapping, so these points are real times.
    await scroller.evaluate((node) => {
      node.scrollLeft = node.scrollWidth * 0.4;
    });
    await page.waitForTimeout(100);
    const view = await scroller.boundingBox();
    const box = await page.locator("#timeline-track").boundingBox();
    const timeAtX = (x) => ((x - box.x) / box.width) * 30;
    const from = { x: view.x + view.width * 0.3, y: box.y + box.height / 2 };
    const to = { x: view.x + view.width * 0.6, y: from.y };
    await drag(page, from, to);
    const [start, end] = await draft(page);
    near(start, timeAtX(from.x), 0.02, "Zoomed start");
    near(end, timeAtX(to.x), 0.02, "Zoomed end");

    // A handle drag to the edge of the view pans the timeline. The time
    // follows the pan.
    const scrolled = await scroller.evaluate((node) => node.scrollLeft);
    await page.mouse.move(...Object.values(await handle(page, "end")));
    await page.mouse.down();
    await page.mouse.move(view.x + view.width - 4, from.y, { steps: 4 });
    await until(
      async () =>
        (await scroller.evaluate((node) => node.scrollLeft)) > scrolled + 60,
      "The timeline did not pan at the edge.",
      5000,
    );
    await page.mouse.up();
    const after = await draft(page);
    const right = await page.locator("#timeline-track").boundingBox();
    near(
      after[1],
      ((view.x + view.width - 4 - right.x) / right.width) * 30,
      0.1,
      "Time after the pan",
    );

    // Ctrl + wheel zooms about the pointer. The time under it stays.
    const under = { x: view.x + view.width * 0.5, y: from.y };
    const timeUnder = async () => {
      const b = await page.locator("#timeline-track").boundingBox();
      return ((under.x - b.x) / b.width) * 30;
    };
    const earlier = await timeUnder();
    await page.mouse.move(under.x, under.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await until(
      async () =>
        (await page.locator("#timeline-track").boundingBox()).width !==
        right.width,
      "Ctrl + wheel did not zoom.",
      5000,
    );
    near(await timeUnder(), earlier, 0.05, "Time under the pointer");

    // Fit shows the full video. The selection stays. Zoom sends no edit.
    await fit.click();
    near(
      (await page.locator("#timeline-track").boundingBox()).width,
      fitWidth,
      1,
      "Fit width",
    );
    assert.equal(await scroller.evaluate((node) => node.scrollLeft), 0);
    assert.deepEqual(await draft(page), after);
    assert.deepEqual(await editLog(forward), []);

    // The view follows a playhead that is out of view.
    await zoomIn.click();
    await zoomIn.click();
    await ready(call);
    await call("playback.seek", { seconds: 28 });
    await until(
      () =>
        page.evaluate(() => {
          const line = document
            .querySelector("#timeline-playhead-line")
            .getBoundingClientRect();
          const view = document
            .querySelector("#timeline-scroll")
            .getBoundingClientRect();
          return line.left >= view.left && line.right <= view.right;
        }),
      "The view did not follow the playhead.",
      5000,
    );
  },
);

test(
  "a handle at the end keeps the exact fractional end at 1.5x speed",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-end-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Fractional sample",
    });
    await call("edit.configure", { id: video.id, speed: 1.5 });
    await openEditor(page, call, video);
    const total = 10 / 1.5;
    // The start handle at the left end. The end handle stays at the exact end.
    await dragHandle(page, "start", 0, 1, total);
    assert.equal(
      await page.locator("#range-end").inputValue(),
      String(total),
      "The end stays exact.",
    );
    // Away from the end and back again.
    await dragHandle(page, "end", total, 4, total);
    near((await draft(page))[1], 4, 0.03, "End");
    await drag(page, await handle(page, "end"), await pastEnd(page));
    assert.equal(await page.locator("#range-end").inputValue(), String(total));
    const [start] = await draft(page);
    await page
      .getByRole("button", { name: "Keep only the selection", exact: true })
      .click();
    await until(
      async () => (await stored(call, video.id)).past.length === 2,
      "No keep.",
    );
    const [segment] = (await stored(call, video.id)).segments;
    assert.equal(segment.end, 10, "The source end stays exact.");
    near(segment.start, start * 1.5, 1e-9);
  },
);

test(
  "keys move the handles, and the ruler moves the playhead",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-keys-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Keys sample",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const seeks = async () => (await forward.log("playback.seek")).length;
    const startHandle = page.getByRole("slider", { name: "Selection start" });
    const endHandle = page.getByRole("slider", { name: "Selection end" });
    assert.equal(await endHandle.getAttribute("aria-valuemax"), "10");
    await startHandle.focus();
    const earlier = await seeks();
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await draft(page), [0.1, 10]);
    await page.keyboard.press("Shift+ArrowRight");
    assert.deepEqual(await draft(page), [1.1, 10]);
    await page.keyboard.press("ArrowLeft");
    assert.deepEqual(await draft(page), [1, 10]);
    assert.equal(await startHandle.getAttribute("aria-valuenow"), "1");
    await endHandle.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    assert.deepEqual(await draft(page), [1, 9]);
    assert.match(await endHandle.getAttribute("aria-valuetext"), /9\.00/);
    await page.keyboard.press("End");
    assert.deepEqual(await draft(page), [1, 10]);
    await startHandle.focus();
    await page.keyboard.press("Home");
    assert.deepEqual(await draft(page), [0, 10]);
    assert.equal(
      await seeks(),
      earlier,
      "Handle keys do not move the playhead.",
    );
    assert.deepEqual(await editLog(forward), []);

    // The ruler moves the playhead, also with a drag. It does not select.
    await ready(call);
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    const y = ruler.y + ruler.height / 2;
    await page.mouse.click(ruler.x + ruler.width * 0.3, y);
    await until(
      async () => Math.abs((await seconds(call)) - 3) < 0.05,
      "The ruler did not move the playhead.",
    );
    await drag(
      page,
      { x: ruler.x + ruler.width * 0.3, y },
      { x: ruler.x + ruler.width * 0.7, y },
    );
    await until(
      async () => Math.abs((await seconds(call)) - 7) < 0.05,
      "The ruler drag did not move the playhead.",
    );
    assert.deepEqual(await draft(page), [0, 10], "No selection.");
    const slider = page.getByRole("slider", { name: "Playhead" });
    await until(
      async () => Number(await slider.getAttribute("aria-valuenow")) > 6.9,
      "The playhead slider has the time.",
      5000,
    );
    assert.equal(await slider.getAttribute("aria-valuemax"), "10");

    // I and O still set the draft, in any tool, and the handles follow.
    await page.locator("#video-title").focus();
    await page.keyboard.press("i");
    await until(
      async () => Math.abs((await draft(page))[0] - 7) < 0.05,
      "I did not set the start.",
      5000,
    );
    near(
      Number(await startHandle.getAttribute("aria-valuenow")),
      7,
      0.05,
      "Handle value",
    );
    // Esc clears the draft selection when nothing else is selected.
    await page.keyboard.press("Escape");
    assert.deepEqual(await draft(page), [0, 10]);
    assert.equal(await page.locator("#selection-chip").isHidden(), true);
  },
);

test(
  "a field saves when the user goes to the timeline, and the top bar shows the true save state",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-save-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Save sample",
    });
    await call("element.add", {
      id: video.id,
      type: "text",
      text: "Before",
      start: 0,
      end: 6,
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const save = page.locator("#save-state");
    assert.equal(await save.innerText(), "Saved");
    const [element] = (await call("element.list", { id: video.id })).elements;
    await page.locator(`.stage-item[data-id="${element.id}"]`).click();

    // A field with a change that is not saved is not "Saved".
    await page.locator("#el-text").fill("After");
    assert.match(await save.innerText(), /^Not saved yet/);
    // A hold on the reply shows the save in progress.
    await forward.hold("element.update");
    const point = await trackPoint(page, 8, 10);
    await page.mouse.click(point.x, point.y);
    await forward.held();
    assert.equal(await save.innerText(), "Saving…");
    await forward.release();
    await until(
      async () =>
        (await call("element.list", { id: video.id })).elements[0].text ===
        "After",
      "Leaving the field did not save it.",
    );
    await until(
      async () => (await save.innerText()) === "Saved",
      "The state did not return to Saved.",
    );

    // A rejected edit does not show Saved as the result of the last action.
    await page.locator("details:has(#el-x) summary").click();
    await page.locator("#el-x").fill("90");
    await page.locator("#el-x").press("Enter");
    await until(
      async () => /^Not saved/.test(await save.innerText()),
      "A rejected edit showed as saved.",
      5000,
    );
    // The next good change clears it.
    await page.locator("#el-text").fill("Later");
    await page.locator("#el-text").press("Tab");
    await until(
      async () => (await save.innerText()) === "Saved",
      "The state did not clear.",
    );
    // The preview state is true while a new preview renders.
    await until(
      async () =>
        (await page.locator("#preview-state").innerText()) === "Preview ready",
      "The preview did not finish.",
      120000,
    );
  },
);

test(
  "a handle drag keeps the exact value of the other end",
  { timeout: 120000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-exact-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Exact sample",
    });
    await openEditor(page, call, video);
    await page.locator("#range-start").fill("0.123456");
    await page.locator("#range-end").fill("5");
    await dragHandle(page, "end", 5, 6, 10);
    assert.equal(
      await page.locator("#range-start").inputValue(),
      "0.123456",
      "The start did not move, so its value stays.",
    );
    await page.locator("#range-end").fill("5.654321");
    await dragHandle(page, "start", 0.123456, 1, 10);
    assert.equal(await page.locator("#range-end").inputValue(), "5.654321");
    // Keys on a handle keep the other end too.
    await page.getByRole("slider", { name: "Selection start" }).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#range-end").inputValue(), "5.654321");
  },
);

test(
  "a cancelled press on the ruler returns the video to the earlier time",
  { timeout: 120000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-press-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Press sample",
    });
    await openEditor(page, call, video);
    await call("playback.seek", { seconds: 2 });
    await until(
      async () => Math.abs((await seconds(call)) - 2) < 0.05,
      "No seek.",
    );
    // The press moves the video at once. Escape comes before any move.
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    await page.mouse.move(ruler.x + ruler.width * 0.7, ruler.y + 5);
    await page.mouse.down();
    await until(
      async () => Math.abs((await seconds(call)) - 7) < 0.05,
      "The press did not move the video.",
    );
    await page.keyboard.press("Escape");
    await until(
      async () => Math.abs((await seconds(call)) - 2) < 0.05,
      "Escape did not return the video.",
    );
    await page.mouse.up();
    await page.waitForTimeout(200);
    near(await seconds(call), 2, 0.05, "The release adds no seek");
  },
);

test(
  "a timing change from outside ends a drag and does not bring back the old draft",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-mapping-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Mapping sample",
    });
    await call("edit.trim", { id: video.id, start: 0, end: 8 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await page.locator("#range-start").fill("1");
    await page.locator("#range-end").fill("3");
    await drag(page, await handle(page, "end"), await trackPoint(page, 5, 8), {
      finish: false,
    });
    assert.notEqual((await draft(page))[1], 3, "The drag is active.");

    // The same length with another source mapping, as from another client.
    const saved = await call("library.get", { id: video.id });
    await forward.stub("library.revision", {
      id: video.id,
      title: saved.title,
      revision: "changed-outside",
      history: { undo: 2, redo: 0 },
    });
    await forward.stub("library.get", {
      ...saved,
      timeline: {
        ...saved.timeline,
        segments: [{ start: 2, end: 10 }],
        past: [...saved.timeline.past, saved.timeline.past[0]],
      },
    });
    await until(
      async () => (await draft(page))[1] === 8,
      "The new mapping did not reset the selection.",
      10000,
    );
    // The pointer still moves. The old drag does not write a draft.
    const point = await trackPoint(page, 2, 8);
    await page.mouse.move(point.x, point.y, { steps: 3 });
    assert.deepEqual(await draft(page), [0, 8]);
    await page.keyboard.press("Escape");
    assert.deepEqual(await draft(page), [0, 8], "No old draft returns.");
    await page.mouse.up();
    assert.deepEqual(await draft(page), [0, 8]);
  },
);

test(
  "a late seek of a drag does not reach another video",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-scrub-");
    await setSize(app, 1000, 720);
    const first = await call("library.import", {
      path: makeVideo(root, "first"),
      title: "First",
    });
    const second = await call("library.import", {
      path: makeVideo(root, "second"),
      title: "Second",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, first);
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    const y = ruler.y + 5;
    // The reply of the first seek waits. The next time waits behind it.
    await forward.hold("playback.seek");
    await page.mouse.move(ruler.x + ruler.width * 0.3, y);
    await page.mouse.down();
    await forward.held();
    await page.mouse.move(ruler.x + ruler.width * 0.6, y, { steps: 3 });
    const before = (await forward.log("playback.seek")).length;
    assert.equal(before, 1, "One seek at a time.");

    await call("playback.open", { id: second.id });
    await until(
      async () =>
        (await page.locator("#video-title").textContent()) === "Second",
      "The second video did not open.",
    );
    await forward.release();
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(
      (await forward.log("playback.seek")).length,
      before,
      "No seek of the first video reaches the second video.",
    );
    assert.ok((await seconds(call)) < 0.1, "The second video stays at 0.");
  },
);

test(
  "a late seek of a drag does not reach a new time mapping of the same video",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-remap-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Mapping",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    const y = ruler.y + 5;
    await forward.hold("playback.seek");
    await page.mouse.move(ruler.x + ruler.width * 0.3, y);
    await page.mouse.down();
    await forward.held();
    await page.mouse.move(ruler.x + ruler.width * 0.6, y, { steps: 3 });
    assert.equal((await forward.log("playback.seek")).length, 1);

    // The same video gets another mapping, and its preview becomes ready.
    await call("edit.cut", { id: video.id, start: 0, end: 2 });
    await until(
      async () =>
        (await page.locator("#timeline-bars i").count()) === 1 &&
        (await page.locator("#duration").innerText()) === "0:08",
      "The cut did not show.",
    );
    await page.waitForTimeout(400);
    await ready(call);
    await forward.release();
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(
      (await forward.log("playback.seek")).length,
      1,
      "The old time does not go to the new mapping.",
    );
  },
);

test(
  "applying a caption draft shows its save state on its own video",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-apply-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Draft",
    });
    const forward = await forwardCommands(app, root);
    await forward.stub("transcript.capabilities", { available: true });
    const job = {
      jobId: "job-1",
      videoId: video.id,
      timing: "estimated",
      progress: {},
    };
    await forward.stub("captions.generate", {
      ...job,
      state: "draft",
      message: "The video changed. Add the captions to the current edits.",
    });
    await forward.stub("captions.status", {
      ...job,
      state: "draft",
      message: "The video changed. Add the captions to the current edits.",
    });
    await openEditor(page, call, video);
    await page.getByRole("tab", { name: "Captions", exact: true }).click();
    await until(
      () => page.locator("#caption-generate").isEnabled(),
      "Make captions is not available.",
    );
    await page.locator("#caption-generate").click();
    const apply = page.locator("#caption-apply");
    await apply.waitFor();
    const save = page.locator("#save-state");

    await forward.stub("captions.apply", { error: "The draft is too old." });
    await forward.hold("captions.apply");
    await apply.click();
    await forward.held();
    assert.equal(await save.innerText(), "Saving…", "The apply shows.");
    await forward.release();
    await until(
      async () => (await save.innerText()) === "Not saved",
      "The rejected apply did not show.",
      5000,
    );
  },
);

test(
  "the save state belongs to the open video",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-owner-");
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
      type: "text",
      text: "Box",
      start: 0,
      end: 6,
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, first);
    const save = page.locator("#save-state");
    const [element] = (await call("element.list", { id: first.id })).elements;
    const reject = async () => {
      await page.locator(`.stage-item[data-id="${element.id}"]`).click();
      const details = page.locator("details:has(#el-x)");
      if (!(await details.evaluate((node) => node.open)))
        await details.locator("summary").click();
      await page.locator("#el-x").fill("90");
      await page.locator("#el-x").press("Enter");
    };
    const openSecond = async () => {
      await call("playback.open", { id: second.id });
      await until(
        async () =>
          (await page.locator("#video-title").textContent()) === "Second",
        "The second video did not open.",
      );
    };

    // A rejected edit of the first video.
    await reject();
    await until(
      async () => (await save.innerText()) === "Not saved",
      "The first video shows no failure.",
      5000,
    );
    await openSecond();
    assert.equal(
      await save.innerText(),
      "Saved",
      "The second video has no failure.",
    );

    // A late rejection of the first video does not reach the second video.
    await openEditor(page, call, first);
    await forward.hold("element.update");
    await reject();
    await forward.held();
    await until(
      async () => (await save.innerText()) === "Saving…",
      "The save did not show.",
      5000,
    );
    await openSecond();
    assert.equal(await save.innerText(), "Saved");
    await forward.release();
    await page.waitForTimeout(300);
    assert.equal(await save.innerText(), "Saved", "The late reply stays out.");
  },
);

test(
  "a long video keeps the dock in one row, and the top bar shows a running export",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-long-");
    await setSize(app, 1000, 720);
    // More than one hour. One frame for each second keeps the file small.
    const file = path.join(root, "long.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2e3440:s=320x180:r=1:d=3700",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const video = await call("library.import", {
      path: file,
      title: "Long sample",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await page.locator("#range-start").fill("1234.56");
    await page.locator("#range-end").fill("3456.78");
    await call("playback.seek", { seconds: 3599 });
    await until(
      async () =>
        /^(59:5|1:00:)/.test(await page.locator("#preview-time").innerText()),
      "The time did not show.",
      10000,
    );
    assert.match(
      await page.locator("#selection-chip").innerText(),
      /1234\.56 to 3456\.78/,
    );
    const overlap = await page.evaluate(() => {
      const row = document.querySelector(".dock-bar");
      const parts = [...row.children].map((node) =>
        node.getBoundingClientRect(),
      );
      return {
        gaps: parts.slice(1).map((part, i) => part.left - parts[i].right),
        right: parts.at(-1).right - row.getBoundingClientRect().right,
        height: row.getBoundingClientRect().height,
      };
    });
    assert.ok(
      overlap.gaps.every((gap) => gap >= 0),
      JSON.stringify(overlap),
    );
    assert.ok(overlap.right <= 0, JSON.stringify(overlap));
    for (const name of ["#trim", "#cut", "#preview-time", "#zoom-fit"])
      assert.equal(await inView(page.locator(name)), true, name);
    assert.ok((await page.locator("#timeline-ruler span").count()) >= 3);

    // A running export shows in the top bar. It opens Details.
    await forward.stub("app.status", {
      recording: { state: "idle" },
      jobs: [
        {
          id: "job",
          kind: "export",
          videoId: video.id,
          state: "running",
          path: path.join(root, "out.mp4"),
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const progress = page.locator("#export-progress");
    await progress.waitFor();
    assert.equal(await inView(progress), true);
    await progress.click();
    assert.equal(
      await page.getByRole("tabpanel", { name: "Details" }).isVisible(),
      true,
    );
    assert.match(await page.locator("#export-jobs").innerText(), /out\.mp4/);
  },
);

test(
  "fullscreen keeps the playback controls and hides the editing controls",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "workspace-full-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root),
      title: "Fullscreen sample",
    });
    await openEditor(page, call, video);
    await page.locator("#video-title").focus();
    await page.keyboard.press("f");
    await page.waitForSelector(".player-shell.fullscreen");
    await page.waitForTimeout(500);
    assert.equal(await inView(page.locator("#preview-play")), true);
    assert.equal(await inView(page.locator("#preview-fullscreen")), true);
    assert.equal(await inView(page.locator("#preview-time")), true);
    assert.equal(await page.locator("#trim").isVisible(), false);
    assert.equal(await page.locator("#zoom-in").isVisible(), false);
    assert.equal(await inView(page.locator(".player-wrap")), true);
    await page.locator("#preview-play").click();
    await until(
      async () => !(await call("playback.status")).paused,
      "Play did not work in fullscreen.",
    );
    await page.locator("#preview-play").click();
    await page.locator("#preview-fullscreen").click();
    await page.waitForSelector(".player-shell:not(.fullscreen)");
    await page.waitForTimeout(300);
    assert.equal(await inView(page.locator("#trim")), true);
  },
);
