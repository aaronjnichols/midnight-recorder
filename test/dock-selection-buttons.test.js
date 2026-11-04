// Set start and Set end are buttons on the timeline dock, beside Keep and
// Remove. A user can make a selection with clicks in every tool. I and O are
// optional. The buttons change only the draft selection. Keep and Remove are
// the edits. Tests use real clicks and read the saved timeline and the command
// log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  launch,
  setSize,
  until,
  openEditor,
  forwardCommands,
} from "../test-support/electron.js";

const SHOTS = path.resolve("output/playwright/loom-buttons");
const SIZES = [
  [1000, 720],
  [1440, 940],
];
const TOOLS = [
  "Trim & cut",
  "Text & shapes",
  "Captions",
  "Speed & sound",
  "Details",
];
const COMMANDS =
  /^(edit\.|element\.(add|update|remove|duplicate|order)|captions\.(add|update|delete|configure|remove|generate|apply))/;

// One frame for each second keeps a long video small.
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
  await page.locator("#range-start").inputValue(),
  await page.locator("#range-end").inputValue(),
];
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const controls = (page) => ({
  setStart: page.getByRole("button", { name: /^Set start/ }),
  setEnd: page.getByRole("button", { name: /^Set end/ }),
  keep: button(page, "Keep only the selection"),
  remove: button(page, "Remove the selection"),
  clear: button(page, "Clear the selection"),
  undo: button(page, "Undo"),
});
const edits = async (forward) =>
  (await forward.log()).filter((c) => COMMANDS.test(c.command));

// Finds what a user sees on the dock row. A button is not hidden, cut, or
// covered: all of its corners are the button itself, and no text is cut.
const dockProblems = (page) =>
  page.evaluate(() => {
    const row = document.querySelector(".dock-bar");
    const limit = row.getBoundingClientRect();
    const shown = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 ? box : null;
    };
    const problems = [];
    const names = {
      "#range-start-now": "Set start",
      "#range-end-now": "Set end",
      "#trim": "Keep",
      "#cut": "Remove",
      "#selection-chip": "Selection",
      "#selection-clear": "Clear",
      "#preview-play": "Play",
      "#preview-fullscreen": "Fullscreen",
      "#preview-volume": "Volume",
      "#zoom-out": "Zoom out",
      "#zoom-in": "Zoom in",
      "#zoom-fit": "Fit",
    };
    const boxes = [];
    for (const [selector, name] of Object.entries(names)) {
      const node = document.querySelector(selector);
      if (node.closest("[hidden]")) {
        if (!["#selection-chip", "#selection-clear"].includes(selector))
          problems.push(`${name} is hidden`);
        continue;
      }
      const box = shown(node);
      if (!box) {
        problems.push(`${name} has no size`);
        continue;
      }
      boxes.push({ name, box });
      if (
        box.left < limit.left ||
        box.right > limit.right ||
        box.top < limit.top ||
        box.bottom > limit.bottom
      )
        problems.push(`${name} is outside the row`);
      if (node.scrollWidth > node.clientWidth)
        problems.push(`${name} cuts its text`);
      // In from the corners: the hit area of a round button has no corners.
      const inset = Math.min(box.width, box.height) * 0.2;
      for (const [x, y] of [
        [box.left + inset, box.top + inset],
        [box.right - inset, box.top + inset],
        [box.left + inset, box.bottom - inset],
        [box.right - inset, box.bottom - inset],
      ]) {
        const hit = document.elementFromPoint(x, y);
        if (!(hit === node || node.contains(hit) || hit?.control === node))
          problems.push(`${name} is covered at ${x}, ${y}`);
      }
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].box,
          b = boxes[j].box;
        if (
          a.left < b.right &&
          b.left < a.right &&
          a.top < b.bottom &&
          b.top < a.bottom
        )
          problems.push(`${boxes[i].name} overlaps ${boxes[j].name}`);
      }
    const parts = [...row.children]
      .filter((node) => shown(node))
      .map((node) => node.getBoundingClientRect());
    parts.slice(1).forEach((part, i) => {
      if (part.left < parts[i].right) problems.push("The dock parts overlap");
    });
    if (row.scrollWidth > row.clientWidth) problems.push("The row is too wide");
    const hint = document.querySelector("#range-hint");
    if (!hint.hidden) {
      const box = shown(hint);
      if (!box) problems.push("The instruction has no size");
      else if (
        hint.scrollWidth > hint.clientWidth ||
        hint.scrollHeight > hint.clientHeight
      )
        problems.push(`The instruction is cut: ${hint.textContent}`);
    }
    return problems;
  });
const layout = (page) =>
  page.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      dock: box(".timeline-dock").height,
      row: box(".dock-bar").height,
      video: [box(".player-wrap").width, box(".player-wrap").height],
      scroll: document.documentElement.scrollHeight - innerHeight,
    };
  });
const leftOf = (locator) =>
  locator.evaluate((node) => node.getBoundingClientRect().left);

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test(
  "Set start and Set end work with clicks in every tool at both window sizes",
  { timeout: 480000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "dock-tools-");
    const video = await call("library.import", {
      path: makeVideo(root, "tools", 10),
      title: "Dock buttons",
    });
    await call("element.add", {
      id: video.id,
      type: "text",
      text: "Label",
      start: 0,
      end: 8,
    });
    const forward = await forwardCommands(app, root);
    const c = controls(page);

    for (const [width, height] of SIZES) {
      await setSize(app, width, height);
      await openEditor(page, call, video);
      await ready(call);
      await page.waitForTimeout(300);

      // The labels, the shortcuts, and the names. The name has the visible
      // label, so voice control and screen readers find the same words.
      assert.equal(await c.setStart.count(), 1, "One Set start button.");
      assert.equal(await c.setEnd.count(), 1, "One Set end button.");
      for (const [locator, label, key, word] of [
        [c.setStart, "Set start", "I", "start"],
        [c.setEnd, "Set end", "O", "end"],
      ]) {
        const text = await locator.evaluate(
          (node) => node.querySelector(".dock-mark-label").innerText,
        );
        assert.equal(text, label);
        // The key shows when the window has space. The tip always has it.
        assert.equal(
          await locator.locator("kbd").isVisible(),
          width >= 1200,
          `${width}: the key label`,
        );
        assert.equal(await locator.getAttribute("aria-keyshortcuts"), key);
        const tip = await locator.getAttribute("title");
        assert.match(tip, new RegExp(`selection ${word}`));
        assert.match(tip, /playhead/);
        assert.match(tip, new RegExp(`Shortcut: ${key}\\b`));
        assert.match(
          await locator.getAttribute("aria-label"),
          new RegExp(`^${label} of the selection to the playhead`),
        );
      }
      // The buttons are beside Keep and Remove, in the order of the work.
      assert.deepEqual(
        await page
          .locator(".dock-selection button:not(.selection-chip)")
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => !node.closest("[hidden]"))
              .map((node) => node.id),
          ),
        ["range-start-now", "range-end-now", "trim", "cut"],
      );
      const empty = await layout(page);
      assert.equal(empty.row, 44, `${width}: one row`);
      assert.ok(empty.scroll <= 0, `${width}: no page scroll`);
      assert.deepEqual(await dockProblems(page), [], `${width}: no selection`);

      // Every tool, with a different selection. Only clicks make it.
      let n = 0;
      for (const name of TOOLS) {
        await tab(page, name).click();
        const past = (await stored(call, video.id)).past.length;
        const source = await page.locator("#player").getAttribute("src");
        const before = (await edits(forward)).length;
        const start = 1 + n * 0.5,
          end = 6.25 + n * 0.75;
        n++;
        assert.deepEqual(await dockProblems(page), [], `${width}: ${name}`);

        // A click does not move the other button under the pointer.
        const place = await leftOf(c.setEnd);
        await seekTo(call, start);
        await c.setStart.click();
        assert.equal(await leftOf(c.setEnd), place, `${name}: no layout jump`);
        await seekTo(call, end);
        await c.setEnd.click();
        assert.equal(await leftOf(c.setEnd), place, `${name}: no layout jump`);

        assert.deepEqual(await draft(page), [String(start), String(end)], name);
        assert.equal(await c.keep.isEnabled(), true, name);
        assert.equal(await c.remove.isEnabled(), true, name);
        assert.equal(
          await page
            .locator('[role="tab"][aria-selected="true"]')
            .getAttribute("aria-controls"),
          await tab(page, name).getAttribute("aria-controls"),
          `${name}: the tool stays open.`,
        );
        // The chip shows the selection. The tip and the name have all of it.
        const chip = page.locator("#selection-chip");
        const times = `${start.toFixed(2)} to ${end.toFixed(2)} s`;
        const long = `${(end - start).toFixed(2)} s long`;
        assert.match(await chip.innerText(), new RegExp(times));
        for (const value of [
          await chip.getAttribute("title"),
          await chip.getAttribute("aria-label"),
        ]) {
          assert.match(value, new RegExp(`^Selection ${times}`));
          assert.match(value, new RegExp(long));
          assert.match(value, /Open Trim & cut/);
        }
        assert.match(
          await page.locator("#selection-status").textContent(),
          new RegExp(`${start.toFixed(2)} s to ${end.toFixed(2)} s.*${long}`),
          `${name}: a screen reader gets the selection in every tool.`,
        );
        assert.deepEqual(await dockProblems(page), [], `${width}: ${name}`);
        assert.deepEqual(await layout(page), empty, `${width}: ${name}: size`);

        // Selection alone is not an edit.
        assert.equal(
          (await edits(forward)).length,
          before,
          `${name}: no command`,
        );
        const saved = await stored(call, video.id);
        assert.equal(saved.past.length, past, `${name}: no history`);
        assert.deepEqual(saved.segments, [{ start: 0, end: 10 }], name);
        assert.equal(
          await page.locator("#player").getAttribute("src"),
          source,
          `${name}: no new preview`,
        );
        assert.equal(await page.locator("#save-state").innerText(), "Saved");
        await shot(
          page,
          `selected-${name.split(" ")[0].toLowerCase()}-${width}`,
        );
        await c.clear.click();
        assert.deepEqual(await draft(page), ["0", "10"], `${name}: cleared`);
      }

      // Remove from Captions: the exact cut, one command, one undo step.
      await tab(page, "Captions").click();
      await seekTo(call, 2.25);
      await c.setStart.click();
      await seekTo(call, 5.5);
      await c.setEnd.click();
      const past = (await stored(call, video.id)).past.length;
      const sent = (await forward.log("edit.cut")).length;
      await c.remove.click();
      await until(
        async () => (await stored(call, video.id)).past.length === past + 1,
        "Remove did not save.",
      );
      assert.deepEqual((await stored(call, video.id)).segments, [
        { start: 0, end: 2.25 },
        { start: 5.5, end: 10 },
      ]);
      const cuts = await forward.log("edit.cut");
      assert.equal(cuts.length, sent + 1, "One command.");
      assert.deepEqual(cuts.at(-1).args, {
        id: video.id,
        start: 2.25,
        end: 5.5,
      });
      await c.undo.click();
      await until(
        async () => (await stored(call, video.id)).past.length === past,
        "Undo did not return.",
      );
      assert.deepEqual((await stored(call, video.id)).segments, [
        { start: 0, end: 10 },
      ]);
      await ready(call);

      // Keep from Details: the exact trim, one command, one undo step.
      await tab(page, "Details").click();
      await seekTo(call, 1.75);
      await c.setStart.click();
      await seekTo(call, 7.25);
      await c.setEnd.click();
      const trims = (await forward.log("edit.trim")).length;
      await c.keep.click();
      await until(
        async () => (await stored(call, video.id)).past.length === past + 1,
        "Keep did not save.",
      );
      assert.deepEqual((await stored(call, video.id)).segments, [
        { start: 1.75, end: 7.25 },
      ]);
      const kept = await forward.log("edit.trim");
      assert.equal(kept.length, trims + 1, "One command.");
      assert.deepEqual(kept.at(-1).args, {
        id: video.id,
        start: 1.75,
        end: 7.25,
      });
      await c.undo.click();
      await until(
        async () => (await stored(call, video.id)).past.length === past,
        "Undo did not return.",
      );
      assert.deepEqual((await stored(call, video.id)).segments, [
        { start: 0, end: 10 },
      ]);
      await ready(call);
      assert.equal(
        await page.locator("#message.error:not([hidden])").count(),
        0,
      );
    }
  },
);

test(
  "the dock fits short and hour-long selections at the smallest window",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "dock-long-");
    const short = await call("library.import", {
      path: makeVideo(root, "short", 10),
      title: "Short",
    });
    const long = await call("library.import", {
      path: makeVideo(root, "long", 3700, 1),
      title: "Long",
    });
    const c = controls(page);
    const chip = page.locator("#selection-chip");
    const fill = async (start, end) => {
      await tab(page, "Trim & cut").click();
      await page.locator("#range-start").fill(start);
      await page.locator("#range-end").fill(end);
    };

    for (const [width, height] of SIZES) {
      await setSize(app, width, height);

      // A short selection and the shortest times.
      await openEditor(page, call, short);
      await page.waitForTimeout(300);
      const size = await layout(page);
      assert.deepEqual(await dockProblems(page), [], `${width}: empty`);
      await fill("2", "2.05");
      for (const name of TOOLS) {
        await tab(page, name).click();
        assert.deepEqual(await dockProblems(page), [], `${width}: ${name}`);
      }
      assert.match(await chip.innerText(), /2\.00 to 2\.05 s/);
      assert.deepEqual(await layout(page), size, `${width}: short`);
      await shot(page, `short-selection-${width}`);

      // The longest times of this video, and a selection of about one hour.
      await openEditor(page, call, long);
      await page.waitForTimeout(300);
      const before = await layout(page);
      assert.deepEqual(await dockProblems(page), [], `${width}: empty, long`);
      await seekTo(call, 3599);
      await until(
        async () =>
          /^(59:5|1:00:)/.test(await page.locator("#preview-time").innerText()),
        "The time did not show.",
        10000,
      );
      assert.deepEqual(await dockProblems(page), [], `${width}: long time`);
      await shot(page, `long-no-selection-${width}`);

      for (const [start, end] of [
        ["1234.56", "3456.78"],
        ["12.34", "3699.99"],
      ]) {
        await fill(start, end);
        for (const name of TOOLS) {
          await tab(page, name).click();
          assert.deepEqual(
            await dockProblems(page),
            [],
            `${width}: ${name}, ${start} to ${end}`,
          );
          assert.equal(await c.keep.isEnabled(), true);
        }
        const times = `${start} to ${end} s`;
        assert.match(await chip.innerText(), new RegExp(times));
        const exact = (Number(end) - Number(start)).toFixed(2);
        for (const value of [
          await chip.getAttribute("title"),
          await chip.getAttribute("aria-label"),
        ])
          assert.match(value, new RegExp(`${times}, ${exact} s long`));
        assert.deepEqual(await layout(page), before, `${width}: long`);
      }
      await shot(page, `long-selection-${width}`);
    }
  },
);

test(
  "the instruction tells about the buttons, and a wrong order sends nothing",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "dock-order-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "order", 10),
      title: "Order",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const c = controls(page);
    const hint = page.locator("#range-hint");

    // The instruction names the buttons. Its tip has the optional keys.
    assert.match(await hint.innerText(), /Set start.*Set end/s);
    const tip = await hint.getAttribute("title");
    assert.match(tip, /Drag on the timeline/);
    assert.match(tip, /keys I and O/);
    assert.match(
      await page.locator("#range-summary").innerText(),
      /full video.*Set start.*Set end.*I.*O/s,
    );
    assert.match(
      await page.locator("#tool-trim .hint").first().innerText(),
      /Set start.*Set end/s,
    );
    await shot(page, "instruction-1000");

    // The exact fields stay in the inspector. They do not have the buttons.
    assert.equal(await page.locator("#tool-trim button").count(), 0);
    assert.equal(await page.locator("#range-start").isVisible(), true);
    assert.equal(await page.locator("#range-end").isVisible(), true);
    // All of Trim & cut shows at the smallest window, without a scroll.
    assert.equal(
      await page
        .locator("#tool-panels")
        .evaluate((node) => node.scrollHeight - node.clientHeight),
      0,
      "The instructions make the inspector scroll.",
    );

    // An end before the start: the reason shows in every tool, in full.
    await tab(page, "Details").click();
    await seekTo(call, 7);
    await c.setStart.click();
    await seekTo(call, 3);
    await c.setEnd.click();
    assert.deepEqual(await draft(page), ["7", "3"]);
    assert.equal(await hint.innerText(), "The end must be after the start.");
    assert.equal(await c.keep.isDisabled(), true);
    assert.equal(await c.remove.isDisabled(), true);
    assert.deepEqual(await dockProblems(page), []);
    await shot(page, "wrong-order-1000");
    assert.deepEqual(await edits(forward), [], "A wrong order sends no edit.");

    // A second click at a good time repairs it.
    await seekTo(call, 1);
    await c.setStart.click();
    assert.deepEqual(await draft(page), ["1", "3"]);
    assert.equal(await c.keep.isEnabled(), true);

    // The keys stay. A key works when a dock button has the focus.
    await seekTo(call, 2);
    await c.setStart.focus();
    await page.keyboard.press("i");
    await until(
      async () => (await draft(page))[0] === "2",
      "I did not set the start.",
      5000,
    );
    await seekTo(call, 4);
    await page.keyboard.press("o");
    await until(
      async () => (await draft(page))[1] === "4",
      "O did not set the end.",
      5000,
    );
    // The keyboard reaches the buttons too.
    await seekTo(call, 1.5);
    await c.setStart.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await draft(page), ["1.5", "4"]);
    assert.deepEqual(await edits(forward), [], "A selection sends no edit.");
  },
);

test(
  "the buttons wait for the preview, give the exact end, and leave in fullscreen",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "dock-state-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: makeVideo(root, "state", 10),
      title: "State",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const c = controls(page);

    // While the edited preview is prepared, the playhead time is not known.
    await forward.hold("preview.start");
    await tab(page, "Speed & sound").click();
    await page.getByLabel("Playback speed").selectOption("1.5");
    await forward.held();
    assert.equal(await c.setStart.isDisabled(), true);
    assert.equal(await c.setEnd.isDisabled(), true);
    assert.deepEqual(await dockProblems(page), [], "Disabled buttons show.");
    const held = await draft(page);
    await page.locator("#video-title").focus();
    await page.keyboard.press("i");
    await page.keyboard.press("o");
    await page.waitForTimeout(200);
    assert.deepEqual(await draft(page), held, "The keys wait too.");
    await forward.release();
    await ready(call);
    await until(
      () => c.setStart.isEnabled(),
      "Set start stays disabled.",
      5000,
    );
    assert.equal(await c.setEnd.isEnabled(), true);

    // The end at 1.5x speed has more decimals. A click gives the exact end,
    // in a tool without the fields, and Keep accepts it.
    const total = 10 / 1.5;
    await page.locator("#video-title").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await until(
      async () => (await call("playback.status")).seconds > total - 0.05,
      "No seek to the end.",
    );
    await c.setEnd.click();
    const end = Number((await draft(page))[1]);
    assert.ok(end <= total + 1e-9, `End ${end}.`);
    await seekTo(call, 1);
    await c.setStart.click();
    const past = (await stored(call, video.id)).past.length;
    await c.keep.click();
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "No keep.",
    );
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
    const [segment] = (await stored(call, video.id)).segments;
    assert.equal(segment.start, 1.5);
    assert.ok(segment.end <= 10 && segment.end > 9.9, JSON.stringify(segment));
    await ready(call);

    // Fullscreen has only the playback controls.
    await page.locator("#video-title").focus();
    await page.keyboard.press("f");
    await page.waitForSelector(".player-shell.fullscreen");
    await page.waitForTimeout(300);
    assert.equal(await c.setStart.isVisible(), false);
    assert.equal(await c.setEnd.isVisible(), false);
    await page.locator("#preview-fullscreen").click();
    await page.waitForSelector(".player-shell:not(.fullscreen)");
    await page.waitForTimeout(300);
    assert.equal(await c.setStart.isVisible(), true);
    assert.equal(await c.setEnd.isVisible(), true);
  },
);
