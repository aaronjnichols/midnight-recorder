// Split at the playhead and the parts on the timeline. Tests use real clicks,
// and read the saved timeline and the command log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, execFileSync } from "node:child_process";
import {
  launch,
  setSize,
  until,
  openEditor,
  forwardCommands,
} from "../test-support/electron.js";

const SHOTS = path.resolve("output/playwright/loom-next/tests");
const SIZES = [
  [1000, 720],
  [1440, 940],
];
const TOOLS = [
  "Trim & cut",
  "Transcript",
  "Text & shapes",
  "Captions",
  "Speed & sound",
  "Details",
];

function makeVideo(root, name, seconds, rate = 30) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2e3440:s=640x360:r=${rate}:d=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
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
const seekTo = async (call, time) => {
  await call("playback.seek", { seconds: time });
  await until(
    async () => Math.abs((await call("playback.status")).seconds - time) < 0.01,
    `No seek to ${time}.`,
  );
};
const draft = async (page) => [
  Number(await page.locator("#range-start").inputValue()),
  Number(await page.locator("#range-end").inputValue()),
];
const near = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} is not ${expected}`,
  );
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const split = (page) => page.getByRole("button", { name: /^Split/ });
const marks = (page) => page.locator("#timeline-marks .split-mark");
const trackPoint = async (page, time, total) => {
  const box = await page.locator("#timeline-track").boundingBox();
  return {
    x: box.x + (box.width * time) / total,
    y: box.y + box.height / 2,
  };
};
const clickTrack = async (page, time, total) => {
  const { x, y } = await trackPoint(page, time, total);
  await page.mouse.click(x, y);
};
const dragTrack = async (page, from, to, total) => {
  const a = await trackPoint(page, from, total);
  const b = await trackPoint(page, to, total);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
};
const history = async (call, id) => (await stored(call, id)).past.length;
async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
const pageScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollHeight - innerHeight);

test(
  "Split at playhead is one click, one undo step, in every tool, and changes nothing else",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-split-");
    const video = await call("library.import", {
      path: makeVideo(root, "split", 10),
      title: "Split",
    });
    await call("element.add", {
      id: video.id,
      type: "text",
      text: "Label",
      start: 1,
      end: 8,
    });
    await call("captions.add", {
      id: video.id,
      text: "Caption",
      start: 1,
      end: 8,
    });
    const forward = await forwardCommands(app, root);
    for (const [width, height] of SIZES) {
      await setSize(app, width, height);
      await openEditor(page, call, video);
      await ready(call);
      const before = await stored(call, video.id);
      const source = await page.locator("#player").getAttribute("src");
      let n = 0;
      for (const name of TOOLS) {
        await tab(page, name).click();
        const time = 1.1 + n++ * 1.3;
        await seekTo(call, time);
        // A manual draft stays through a split.
        await page.locator("#video-title").focus();
        await page.keyboard.press("i");
        const selected = await draft(page);
        assert.equal(await split(page).isVisible(), true, name);
        const past = await history(call, video.id);
        const sent = (await forward.log("edit.split")).length;
        await split(page).click();
        await until(
          async () => (await history(call, video.id)) === past + 1,
          `${name}: no split.`,
        );
        const log = await forward.log("edit.split");
        assert.equal(log.length, sent + 1, `${name}: one command.`);
        assert.equal(log.at(-1).args.id, video.id);
        near(log.at(-1).args.seconds, time, 0.01, name);
        assert.equal(typeof log.at(-1).args.revision, "string");
        await until(
          async () => (await marks(page).count()) === 1,
          `${name}: no mark on the track.`,
        );
        assert.deepEqual(await draft(page), selected, `${name}: the draft`);
        assert.equal(
          await page.locator("#save-state").innerText(),
          "Saved",
          name,
        );
        assert.equal(
          await page.locator("#player").getAttribute("src"),
          source,
          `${name}: no new preview.`,
        );
        const after = await stored(call, video.id);
        assert.deepEqual(after.segments, before.segments, name);
        assert.deepEqual(after.elements, before.elements, name);
        assert.deepEqual(after.captions, before.captions, name);
        assert.equal(await pageScroll(page), 0, `${name}: no page scroll`);
        await shot(page, `split-${name.split(" ")[0].toLowerCase()}-${width}`);

        // Undo removes the mark. The draft and the video stay.
        await button(page, "Undo").click();
        await until(
          async () => (await history(call, video.id)) === past,
          `${name}: no undo.`,
        );
        await until(
          async () => (await marks(page).count()) === 0,
          `${name}: the mark stayed.`,
        );
        assert.deepEqual(await draft(page), selected, `${name}: undo draft`);
        await page.keyboard.press("Escape");
      }
    }
  },
);

test(
  "Split waits for a valid time, and the S key does the same",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-guard-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "guard", 10),
      title: "Guard",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const enabled = () => split(page).isEnabled();

    assert.equal(await enabled(), false, "At the start.");
    assert.match(await split(page).getAttribute("title"), /start of the video/);
    await seekTo(call, 10);
    await until(
      async () =>
        /end of the video/.test(await split(page).getAttribute("title")),
      "No reason at the end.",
    );
    assert.equal(await enabled(), false, "At the end.");
    await seekTo(call, 4);
    await until(enabled, "A valid time.");

    // The key.
    await page.locator("#video-title").focus();
    await page.keyboard.press("s");
    await until(async () => (await marks(page).count()) === 1, "No S split.");
    assert.equal((await stored(call, video.id)).past.length, 1);

    // The same time again: no command and no history.
    await until(async () => !(await enabled()), "At a split.");
    assert.match(
      await split(page).getAttribute("title"),
      /already has a split/,
    );
    const sent = (await forward.log("edit.split")).length;
    await page.keyboard.press("s");
    await page.waitForTimeout(300);
    assert.equal((await forward.log("edit.split")).length, sent);
    assert.equal((await stored(call, video.id)).past.length, 1);

    // A fractional speed: the exact end and the mark stay refused.
    await tab(page, "Speed & sound").click();
    await page.getByLabel("Playback speed").selectOption("1.5");
    await until(
      async () => (await stored(call, video.id)).speed === 1.5,
      "The speed did not save.",
    );
    await until(
      async () => (await page.locator("#preview-state").innerText()) !== "",
      "No preview state.",
    );
    await page.waitForTimeout(300);
    await ready(call);
    const { parts } = await call("parts.list", { id: video.id });
    await seekTo(call, parts[1].end);
    await until(async () => !(await enabled()), "At the fractional end.");
    await seekTo(call, parts[1].start + 0.01);
    await until(async () => !(await enabled()), "Beside the mark.");
    await seekTo(call, parts[1].start + 0.5);
    await until(enabled, "After the mark.");

    // While a preview is prepared, the time is not known.
    await forward.hold("preview.start");
    await page.getByLabel("Playback speed").selectOption("1.25");
    await forward.held();
    assert.equal(await enabled(), false, "No preview.");
    await forward.release();
    await ready(call);
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
  },
);

test(
  "a track click selects a part, the ruler only seeks, and a drag makes a selection",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-click-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root, "click", 10),
      title: "Click",
    });
    await call("edit.split", { id: video.id, seconds: 3 });
    await call("edit.split", { id: video.id, seconds: 7 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await until(async () => (await marks(page).count()) === 2, "No marks.");
    const history0 = await history(call, video.id);

    // The marks are on the track at their times, and show no gap.
    const track = await page.locator("#timeline-track").boundingBox();
    const left = await marks(page)
      .first()
      .evaluate((node) => node.getBoundingClientRect().left);
    near(left, track.x + track.width * 0.3, 3, "The mark");
    assert.equal(
      await page.locator("#timeline-bars i").count(),
      1,
      "A split makes no kept part and no gap.",
    );

    // A click selects the part under the pointer and moves the playhead.
    await clickTrack(page, 5, 10);
    await until(
      async () => (await draft(page))[0] === 3,
      "The click did not select the part.",
    );
    assert.deepEqual(await draft(page), [3, 7]);
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 5) < 0.1,
      "The click did not seek.",
    );
    assert.match(await page.locator("#selection-chip").innerText(), /3\.00/);
    assert.equal(await button(page, "Remove the selection").isEnabled(), true);
    await shot(page, "part-selected-1440");

    // A click on the same part only seeks. The gold frame is on top.
    await clickTrack(page, 6, 10);
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 6) < 0.1,
      "No seek in the frame.",
    );
    assert.deepEqual(await draft(page), [3, 7]);

    // Another part replaces a part selection.
    await clickTrack(page, 9, 10);
    await until(
      async () => (await draft(page))[0] === 7,
      "The other part was not selected.",
    );
    assert.deepEqual(await draft(page), [7, 10]);

    // The ruler moves the playhead and keeps the selection.
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    await page.mouse.click(ruler.x + ruler.width * 0.15, ruler.y + 4);
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 1.5) < 0.1,
      "The ruler did not seek.",
    );
    assert.deepEqual(await draft(page), [7, 10], "The ruler selects nothing.");

    // A drag across a mark is a normal selection.
    await page.keyboard.press("Escape");
    await dragTrack(page, 2, 5, 10);
    const [start, end] = await draft(page);
    near(start, 2, 0.05, "Start");
    near(end, 5, 0.05, "End");

    // A manual selection stays through a click, so Set start, click, Set end
    // still works.
    await clickTrack(page, 9, 10);
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 9) < 0.1,
      "No seek.",
    );
    assert.deepEqual(await draft(page), [start, end], "The draft stays.");

    // A drag of a handle of a part selection makes a manual draft.
    await page.locator("#selection-clear").click();
    await clickTrack(page, 1, 10);
    await until(async () => (await draft(page))[1] === 3, "No part.");
    await page.locator("#selection-clear").click();
    assert.deepEqual(await draft(page), [0, 10]);

    assert.equal(
      await history(call, video.id),
      history0,
      "Selection is not an edit.",
    );
    const edits = (await forward.log()).filter((c) =>
      /^(edit\.|transcript\.cut)/.test(c.command),
    );
    assert.deepEqual(edits, [], "No edit command.");
  },
);

test(
  "the dock Keep and Remove use guarded part commands and one undo step",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-edit-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "edit", 10),
      title: "Edit",
    });
    await call("edit.configure", { id: video.id, speed: 1.25 });
    await call("edit.split", { id: video.id, seconds: 2.345678 });
    await call("edit.split", { id: video.id, seconds: 5.5 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const { parts, revision } = await call("parts.list", { id: video.id });
    const total = parts.at(-1).end;

    // Remove: the exact source of the part, not the two-decimal draft.
    await tab(page, "Details").click();
    await clickTrack(page, 4, total);
    await until(
      async () => Math.abs((await draft(page))[0] - parts[1].start) < 1e-5,
      "No part.",
    );
    const past = await history(call, video.id);
    await button(page, "Remove the selection").click();
    await until(
      async () => (await history(call, video.id)) === past + 1,
      "No removal.",
    );
    const removed = await forward.log("edit.removePart");
    assert.equal(removed.length, 1);
    assert.deepEqual(removed[0].args, {
      id: video.id,
      partId: parts[1].id,
      revision,
    });
    assert.equal((await forward.log("edit.cut")).length, 0);
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 0, end: parts[1].sourceStart },
      { start: parts[1].sourceEnd, end: 10 },
    ]);
    await ready(call);
    await button(page, "Undo").click();
    await until(
      async () => (await history(call, video.id)) === past,
      "No undo.",
    );
    await ready(call);

    // Keep: the part stays.
    await clickTrack(page, 1, total);
    await until(
      async () => (await draft(page))[0] === 0,
      "No part at the start.",
    );
    await button(page, "Keep only the selection").click();
    await until(
      async () => (await history(call, video.id)) === past + 1,
      "No keep.",
    );
    assert.equal((await forward.log("edit.keepPart")).length, 1);
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 0, end: parts[0].sourceEnd },
    ]);
    await ready(call);
    await button(page, "Undo").click();
    await until(
      async () => (await history(call, video.id)) === past,
      "No undo.",
    );
    await ready(call);

    // A changed handle makes a manual draft. Remove then uses edit.cut.
    await clickTrack(page, 4, total);
    await until(async () => (await draft(page))[1] > 4, "No part.");
    await page.locator("#range-handle-end").focus();
    await page.keyboard.press("ArrowLeft");
    await button(page, "Remove the selection").click();
    await until(
      async () => (await history(call, video.id)) === past + 1,
      "No cut.",
    );
    assert.equal((await forward.log("edit.cut")).length, 1);
    assert.equal((await forward.log("edit.removePart")).length, 1);
    await ready(call);
    await button(page, "Undo").click();
    await until(
      async () => (await history(call, video.id)) === past,
      "No undo.",
    );
    await ready(call);

    // Typing the same text also ends the part selection.
    await tab(page, "Trim & cut").click();
    await clickTrack(page, 4, total);
    await until(async () => (await draft(page))[1] > 4, "No part.");
    const field = page.locator("#range-start");
    const text = await field.inputValue();
    await field.fill("");
    await field.fill(text);
    await button(page, "Remove the selection").click();
    await until(
      async () => (await history(call, video.id)) === past + 1,
      "No cut after typing.",
    );
    assert.equal((await forward.log("edit.cut")).length, 2);
    assert.equal((await forward.log("edit.removePart")).length, 1);
  },
);

test(
  "the Parts list selects a part too small to click, and removes it",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-list-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "list", 600, 5),
      title: "List",
    });
    await call("edit.split", { id: video.id, seconds: 300 });
    await call("edit.split", { id: video.id, seconds: 300.06 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await page.waitForSelector("#parts:not([hidden])");
    const rows = page.locator("#part-list button");
    assert.equal(await rows.count(), 3);
    const row = rows.nth(1);
    assert.match(await row.innerText(), /5:00\.000/);
    assert.match(await row.innerText(), /5:00\.060/);
    assert.match(await row.innerText(), /0\.060 s/);
    assert.match(await row.getAttribute("aria-label"), /^Part 2/);
    await row.click();
    await until(
      async () => (await draft(page))[0] === 300,
      "The row did not select the part.",
    );
    assert.deepEqual(await draft(page), [300, 300.06]);
    assert.equal(await row.getAttribute("aria-pressed"), "true");
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 300) < 0.3,
      "The row did not seek.",
    );
    await shot(page, "parts-list-1000");

    // The action beside the list is the guarded command.
    const past = await history(call, video.id);
    await button(page, "Remove part").click();
    await until(
      async () => (await history(call, video.id)) === past + 1,
      "No removal.",
    );
    assert.equal((await forward.log("edit.removePart")).length, 1);
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 0, end: 300 },
      { start: 300.06, end: 600 },
    ]);
    await ready(call);
    await button(page, "Undo").click();
    await until(
      async () => (await history(call, video.id)) === past,
      "No undo.",
    );
    await ready(call);

    // Join removes one mark and no time.
    await rows.nth(0).click();
    await until(async () => (await draft(page))[1] === 300, "No first part.");
    await button(page, "Join with next").click();
    await until(
      async () => (await stored(call, video.id)).splits?.length === 1,
      "No join.",
    );
    assert.equal((await forward.log("edit.unsplit")).length, 1);
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 0, end: 600 },
    ]);
    await page.waitForSelector("#part-list button:nth-child(1)");
    await until(async () => (await rows.count()) === 2, "The row stayed.");
    assert.deepEqual(await draft(page), [0, 600], "The old part is gone.");

    // 200 marks: the list scrolls in the inspector, not the page.
    for (let n = 1; n < 200; n++)
      await call("edit.split", { id: video.id, seconds: n * 2.5 });
    await until(
      async () => (await rows.count()) === 201,
      "All parts did not show.",
      30000,
    );
    assert.equal(await pageScroll(page), 0);
    const list = await page.locator("#part-list").evaluate((node) => ({
      scroll: node.scrollHeight > node.clientHeight,
      height: node.clientHeight,
    }));
    assert.ok(list.scroll, "The list scrolls by itself.");
    assert.ok(list.height >= 90, `The list has room: ${list.height}.`);
    await rows.nth(150).scrollIntoViewIfNeeded();
    await rows.nth(150).click();
    assert.equal(await rows.nth(150).getAttribute("aria-pressed"), "true");
    await shot(page, "parts-list-long-1000");
  },
);

test(
  "a split from the CLI shows in the open editor, also with a full history",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-agent-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "agent", 10),
      title: "Agent",
    });
    const cli = async (name, args) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ["src/agent/cli.js", name, JSON.stringify(args)],
            {
              env: { ...process.env, MIDNIGHT_DATA: root },
              maxBuffer: 64 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    await openEditor(page, call, video);

    await cli("edit.split", { id: video.id, seconds: 4 });
    await until(async () => (await marks(page).count()) === 1, "No mark.");
    await until(
      () => button(page, "Undo").isEnabled(),
      "Undo did not become available.",
    );

    // A part that another client divides is not selected any more.
    await clickTrack(page, 2, 10);
    await until(async () => (await draft(page))[1] === 4, "No part.");
    await cli("edit.split", { id: video.id, seconds: 2 });
    await until(async () => (await marks(page).count()) === 2, "No mark.");
    await until(
      async () => (await draft(page))[1] === 10,
      "The divided part stayed selected.",
    );

    // A full history: the undo count does not change.
    for (let n = 0; n < 100; n++)
      await call("edit.configure", { id: video.id, fadeIn: n % 2 ? 0 : 0.1 });
    await ready(call);
    assert.equal((await stored(call, video.id)).past.length, 100);
    await cli("edit.split", { id: video.id, seconds: 8 });
    await until(
      async () => (await marks(page).count()) === 3,
      "The poll did not show the split.",
    );
    assert.equal((await stored(call, video.id)).past.length, 100);

    // A cut and an undo from the CLI also show.
    const list = await cli("parts.list", { id: video.id });
    await cli("edit.removePart", {
      id: video.id,
      partId: list.parts[3].id,
      revision: list.revision,
    });
    await until(
      async () => (await marks(page).count()) === 2,
      "The poll did not show the removal.",
    );
    await ready(call);
    assert.equal(
      await page.locator("#duration").innerText(),
      "0:08",
      "The new length shows.",
    );
  },
);

test(
  "a selected part keeps its true number after an earlier split",
  { timeout: 120000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-number-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root, "number", 10),
      title: "Number",
    });
    await call("edit.split", { id: video.id, seconds: 5 });
    await openEditor(page, call, video);
    await until(async () => (await marks(page).count()) === 1, "No mark.");
    const label = () => page.locator("#selection-word").innerText();

    await clickTrack(page, 7, 10);
    await until(async () => (await draft(page))[0] === 5, "No part.");
    assert.match(await label(), /^Part 2/);

    // A ruler click keeps the part. A split before it makes it the third part.
    const ruler = await page.locator("#timeline-ruler").boundingBox();
    await page.mouse.click(ruler.x + ruler.width * 0.2, ruler.y + 4);
    await until(
      async () => Math.abs((await call("playback.status")).seconds - 2) < 0.1,
      "The ruler did not seek.",
    );
    await until(() => split(page).isEnabled(), "Split is not available.");
    await split(page).click();
    await until(async () => (await marks(page).count()) === 2, "No mark.");
    assert.deepEqual(await draft(page), [5, 10], "The same part stays.");
    await until(
      async () => /^Part 3/.test(await label()),
      `The label is ${await label()}.`,
      5000,
    );
    assert.equal(
      await page.locator('#part-list button[aria-pressed="true"]').count(),
      1,
    );
    assert.match(
      await page
        .locator('#part-list button[aria-pressed="true"]')
        .getAttribute("aria-label"),
      /^Part 3/,
      "The dock and the list agree.",
    );

    // Undo makes it the second part again.
    await button(page, "Undo").click();
    await until(async () => (await marks(page).count()) === 1, "No undo.");
    await until(
      async () => /^Part 2/.test(await label()),
      `The label is ${await label()}.`,
      5000,
    );
  },
);

test(
  "fullscreen has no split or part controls, and a long video keeps the dock",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "parts-long-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "long", 3700, 1),
      title: "Long",
    });
    await call("edit.split", { id: video.id, seconds: 1800 });
    await openEditor(page, call, video);
    await seekTo(call, 3599);

    await page.locator("#video-title").focus();
    await page.keyboard.press("f");
    await page.waitForSelector(".player-shell.fullscreen");
    await page.waitForTimeout(300);
    assert.equal(await split(page).isVisible(), false);
    assert.equal(await page.locator("#timeline-track").isVisible(), false);
    await page.locator("#preview-fullscreen").click();
    await page.waitForSelector(".player-shell:not(.fullscreen)");
    await page.waitForTimeout(300);
    assert.equal(await split(page).isVisible(), true);
    assert.equal(await pageScroll(page), 0);
  },
);
