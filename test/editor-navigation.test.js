// Editor navigation: a user finds trim and cut without a search, the tools
// keep the user's work, and late command results do not change the tool.
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

const SHOTS = path.resolve("output/playwright/loom-redesign/tests");
const TOOLS = [
  "Trim & cut",
  "Text & shapes",
  "Captions",
  "Speed & sound",
  "Details",
];

// 10 seconds of a picture with silent sound.
function makeVideo(root, name = "sample") {
  const file = path.join(root, `${name}.mp4`);
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
    "-vf",
    "drawbox=x=iw*0.6:y=ih*0.6:w=iw*0.2:h=ih*0.2:color=0x88c0d0:t=fill",
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
const ready = (call) =>
  until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
const seconds = async (call) => (await call("playback.status")).seconds;
// In the window, with a size, and not under another element.
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
const tab = (page, name) => page.getByRole("tab", { name, exact: true });
// The visible name without decorative icons (aria-hidden).
const NAME = (node) =>
  [...node.childNodes]
    .filter(
      (c) => !(c.nodeType === 1 && c.getAttribute("aria-hidden") === "true"),
    )
    .map((c) => c.textContent)
    .join("")
    .trim();
const activeTool = (page) =>
  page.locator('[role="tab"][aria-selected="true"]').evaluate(NAME);
const field = (page, name) =>
  page.getByRole("spinbutton", { name: new RegExp(`^${name}`) });
const stored = async (call, id) => (await call("library.get", { id })).timeline;
const MUTATIONS =
  /^(edit\.|element\.(add|update|remove|duplicate|order)|captions\.(add|update|delete|configure|remove|generate|apply|cancel)|library\.(rename|delete|import)|export\.start)/;

async function sample(call, root, { elements = 1, captions = 2 } = {}) {
  const video = await call("library.import", {
    path: makeVideo(root),
    title: "Navigation sample",
  });
  for (let i = 0; i < elements; i++)
    await call("element.add", {
      id: video.id,
      type: i % 2 ? "rectangle" : "text",
      ...(i % 2 ? {} : { text: `Label ${i + 1}` }),
      start: 0,
      end: 8,
      x: 0.05 + (i % 3) * 0.1,
      y: 0.05 + Math.floor(i / 3) * 0.1,
      width: 0.25,
      height: 0.15,
    });
  for (let i = 0; i < captions; i++)
    await call("captions.add", {
      id: video.id,
      text: `Caption ${i + 1}`,
      start: i * 0.8,
      end: i * 0.8 + 0.7,
    });
  return video;
}

test(
  "trim and cut are found and used without scrolling at both window sizes",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "nav-trim-");
    // Many elements and captions make the other tools long.
    const video = await sample(call, root, { elements: 8, captions: 12 });
    for (const [width, height] of [
      [1440, 940],
      [1000, 720],
    ]) {
      await setSize(app, width, height);
      await openEditor(page, call, video);
      await page.waitForTimeout(300);
      const tools = page.getByRole("tablist", { name: "Editing tools" });
      assert.equal(await inView(tools), true, `${width}: tools`);
      const names = [];
      for (const item of await tools.getByRole("tab").all())
        names.push(await item.evaluate(NAME));
      assert.deepEqual(names, TOOLS);
      assert.equal(
        await activeTool(page),
        "Trim & cut",
        "A video opens with Trim & cut.",
      );
      const keep = page.getByRole("button", {
        name: "Keep only the selection",
        exact: true,
      });
      const remove = page.getByRole("button", {
        name: "Remove the selection",
        exact: true,
      });
      for (const [name, locator] of [
        ["start", field(page, "Selection start")],
        ["end", field(page, "Selection end")],
        [
          "set start",
          page.getByRole("button", {
            name: "Set start of the selection to the playhead",
          }),
        ],
        [
          "set end",
          page.getByRole("button", {
            name: "Set end of the selection to the playhead",
          }),
        ],
        ["keep", keep],
        ["remove", remove],
        ["reason", page.locator("#range-summary")],
        ["undo", page.getByRole("button", { name: "Undo", exact: true })],
        ["redo", page.getByRole("button", { name: "Redo", exact: true })],
        ["export", page.getByRole("button", { name: "Export MP4" })],
        ["play", page.locator("#preview-play")],
        ["video", page.locator(".player-wrap")],
      ])
        assert.equal(
          await inView(locator),
          true,
          `${width}: ${name} is in view`,
        );
      // Disabled actions say why, next to them.
      assert.equal(await keep.isDisabled(), true);
      assert.equal(await remove.isDisabled(), true);
      assert.match(
        await page.locator("#range-summary").innerText(),
        /full video.*I.*O/s,
      );
      await page.screenshot({
        path: path.join(SHOTS, `after-open-${width}.png`),
      });
    }

    // At the small size: select with the keyboard, remove, undo, redo.
    await page.locator("#video-title").focus();
    const past = (await stored(call, video.id)).past.length;
    await page.keyboard.press("ArrowRight");
    await until(
      async () => Math.abs((await seconds(call)) - 5) < 0.05,
      "No seek to 5.",
    );
    await page.keyboard.press("o");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
    await until(
      async () => Math.abs((await seconds(call)) - 2) < 0.05,
      "No seek to 2.",
    );
    await page.keyboard.press("i");
    assert.equal(await field(page, "Selection start").inputValue(), "2");
    assert.equal(await field(page, "Selection end").inputValue(), "5");
    assert.match(
      await page.locator("#range-summary").innerText(),
      /2\.00 s to 5\.00 s.*3\.00 s/,
    );
    assert.match(
      await page
        .getByRole("button", { name: /^Selection 2\.00 to 5\.00 s/ })
        .innerText(),
      /2\.00 to 5\.00/,
    );
    await page
      .getByRole("button", { name: "Remove the selection", exact: true })
      .click();
    await until(
      async () => (await page.locator("#timeline-bars i").count()) === 2,
      "No cut.",
    );
    assert.equal(
      (await stored(call, video.id)).past.length,
      past + 1,
      "One undo step.",
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await page.locator("#timeline-bars i").count()) === 1,
      "No undo.",
    );
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await until(
      async () => (await page.locator("#timeline-bars i").count()) === 2,
      "No redo.",
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await stored(call, video.id)).segments.length === 1,
      "No undo 2.",
    );

    // Typed times and Keep only the selection: one undo step, exact times.
    await ready(call);
    await field(page, "Selection start").fill("1.25");
    await field(page, "Selection end").fill("3.5");
    const before = (await stored(call, video.id)).past.length;
    await page
      .getByRole("button", { name: "Keep only the selection", exact: true })
      .click();
    await until(
      async () => (await stored(call, video.id)).past.length === before + 1,
      "No keep.",
    );
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 1.25, end: 3.5 },
    ]);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      async () => (await stored(call, video.id)).past.length === before,
      "No undo 3.",
    );

    // A fractional end at 1.5x speed: Set end at the end gives the exact end.
    // Speed is in Speed & sound.
    await tab(page, "Speed & sound").click();
    await page.getByLabel("Playback speed").selectOption("1.5");
    await until(
      async () => (await stored(call, video.id)).speed === 1.5,
      "No speed.",
    );
    await tab(page, "Trim & cut").click();
    await ready(call);
    await page.locator("#video-title").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await until(
      async () => (await seconds(call)) > 10 / 1.5 - 0.05,
      "No seek to the end.",
    );
    await page
      .getByRole("button", { name: "Set end of the selection to the playhead" })
      .click();
    await field(page, "Selection start").fill("1");
    const kept = (await stored(call, video.id)).past.length;
    await page
      .getByRole("button", { name: "Keep only the selection", exact: true })
      .click();
    await until(
      async () => (await stored(call, video.id)).past.length === kept + 1,
      "No keep 2.",
    );
    const [segment] = (await stored(call, video.id)).segments;
    assert.equal(segment.start, 1.5);
    assert.ok(segment.end <= 10 && segment.end > 9.9, JSON.stringify(segment));
  },
);

test(
  "tools keep the range, playhead, selection, and values, and show the selected item",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "nav-tools-");
    await setSize(app, 1000, 720);
    const video = await sample(call, root);
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const start = field(page, "Selection start"),
      end = field(page, "Selection end");
    await start.fill("1.5");
    await end.fill("4.25");
    await call("playback.seek", { seconds: 3 });
    const pastBefore = (await stored(call, video.id)).past.length;
    const mutations = async () =>
      (await forward.log())
        .filter((c) => MUTATIONS.test(c.command))
        .map((c) => c.command);
    const src = () => page.locator("#player").getAttribute("src");
    const source = await src();

    // Click each tool, then move with the arrow keys on the tabs.
    for (const name of TOOLS) {
      await tab(page, name).click();
      assert.equal(await activeTool(page), name);
      assert.equal(
        await page.getByRole("tabpanel", { name }).isVisible(),
        true,
      );
    }
    await tab(page, "Trim & cut").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await activeTool(page), "Text & shapes");
    await page.keyboard.press("End");
    assert.equal(await activeTool(page), "Details");
    await page.keyboard.press("ArrowRight");
    assert.equal(await activeTool(page), "Trim & cut", "The keys go around.");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await activeTool(page), "Details");
    await page.keyboard.press("Home");
    assert.equal(await activeTool(page), "Trim & cut");
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute("role")),
      "tab",
      "Focus stays on the tabs.",
    );
    // Hidden tools are not in the Tab order.
    assert.equal(await page.locator("#caption-generate").isHidden(), true);
    assert.equal(
      Math.abs((await seconds(call)) - 3) < 0.05,
      true,
      "Tab keys do not seek.",
    );
    assert.deepEqual(
      [await start.inputValue(), await end.inputValue()],
      ["1.5", "4.25"],
    );
    assert.deepEqual(
      await mutations(),
      [],
      "Navigation sends no edit command.",
    );
    assert.equal((await stored(call, video.id)).past.length, pastBefore);
    assert.equal(await src(), source, "No new preview.");

    // A selection shows its tool and its properties, in view.
    const [element] = (await call("element.list", { id: video.id })).elements;
    const outline = page.locator(`.stage-item[data-id="${element.id}"]`);
    await outline.waitFor();
    await outline.click();
    assert.equal(await activeTool(page), "Text & shapes");
    assert.equal(
      await inView(page.locator("#el-text")),
      true,
      "Element text in view.",
    );
    // The selection stays when the user opens another tool.
    await tab(page, "Captions").click();
    assert.equal(
      await page.locator(".stage-item.selected").getAttribute("data-id"),
      element.id,
    );
    const [first, second] = (await captionList(call, video.id)).cues;
    await call("playback.seek", { seconds: 6 });
    await page
      .locator(`.caption-row[data-id="${second.id}"] .caption-select`)
      .click();
    assert.equal(await activeTool(page), "Captions");
    assert.equal(
      await inView(page.locator("#cap-text")),
      true,
      "Caption text in view.",
    );
    await until(
      async () => Math.abs((await seconds(call)) - second.start) < 0.05,
      "The first click did not seek to the caption.",
    );
    assert.equal(
      await page.locator(".stage-item.selected").count(),
      0,
      "One selection.",
    );

    // A caption draft is saved when the user leaves the field, as before.
    await page.locator("#cap-text").fill("Draft text");
    await tab(page, "Trim & cut").click();
    await until(
      async () =>
        (await captionList(call, video.id)).cues[1].text === "Draft text",
      "The draft was not saved on leave.",
    );
    assert.deepEqual(
      [await start.inputValue(), await end.inputValue()],
      ["1.5", "4.25"],
    );
    await tab(page, "Captions").click();
    assert.equal(await page.locator("#cap-text").inputValue(), "Draft text");
    assert.equal(
      await page
        .locator(`.caption-row[data-id="${second.id}"] .caption-select`)
        .getAttribute("aria-pressed"),
      "true",
      "The caption stays selected.",
    );

    // An edit from outside and a caption change keep the tool and the range.
    await call("captions.update", {
      id: video.id,
      cueId: first.id,
      text: "From the CLI",
    });
    await until(
      async () =>
        (
          await page.locator(`.caption-row[data-id="${first.id}"]`).innerText()
        ).includes("From the CLI"),
      "The CLI change did not show.",
    );
    assert.equal(await activeTool(page), "Captions");
    // The Trim & cut fields are hidden now. Their values stay.
    assert.deepEqual(
      [
        await page.locator("#range-start").inputValue(),
        await page.locator("#range-end").inputValue(),
      ],
      ["1.5", "4.25"],
    );

    // I and O work in any tool. The timeline shows the selection, and its
    // button opens Trim & cut.
    await ready(call);
    await call("playback.seek", { seconds: 2 });
    await until(
      async () => Math.abs((await seconds(call)) - 2) < 0.05,
      "No seek.",
    );
    await page.locator("#video-title").focus();
    await page.keyboard.press("i");
    await page
      .getByRole("button", { name: /^Selection 2\.00 to 4\.25 s/ })
      .click();
    assert.equal(await activeTool(page), "Trim & cut");
    assert.equal(await start.inputValue(), "2");
    // Escape in fullscreen leaves fullscreen and keeps the tool.
    await page.locator("#video-title").focus();
    await page.keyboard.press("f");
    await page.waitForSelector(".player-shell.fullscreen");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".player-shell:not(.fullscreen)");
    assert.equal(await activeTool(page), "Trim & cut");
  },
);

test(
  "Delete and Backspace change only the selection of the open tool",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "nav-delete-");
    await setSize(app, 1000, 720);
    const video = await sample(call, root, { elements: 1, captions: 2 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const deletes = async () =>
      (await forward.log()).filter(
        (c) =>
          c.command === "captions.delete" || c.command === "element.remove",
      ).length;
    const counts = async () => [
      (await call("element.list", { id: video.id })).elements.length,
      (await captionList(call, video.id)).count,
    ];

    // A caption is selected. In another tool, the keys do not delete it.
    const [cue] = (await captionList(call, video.id)).cues;
    await tab(page, "Captions").click();
    await page
      .locator(`.caption-row[data-id="${cue.id}"] .caption-select`)
      .click();
    for (const other of ["Trim & cut", "Speed & sound", "Details"]) {
      await tab(page, other).click();
      await page.locator("#video-title").focus();
      for (const key of ["Delete", "Backspace"]) await page.keyboard.press(key);
      await page.waitForTimeout(300);
      assert.deepEqual(await counts(), [1, 2], `${other}: nothing is deleted`);
      assert.equal(await activeTool(page), other, "The tool does not change.");
    }
    // An element is selected. In another tool, the keys do not delete it.
    const [element] = (await call("element.list", { id: video.id })).elements;
    await ready(call);
    await call("playback.seek", { seconds: 1 });
    await page.locator(`.stage-item[data-id="${element.id}"]`).click();
    assert.equal(await activeTool(page), "Text & shapes");
    for (const other of ["Captions", "Trim & cut"]) {
      await tab(page, other).click();
      await page.locator("#video-title").focus();
      for (const key of ["Delete", "Backspace"]) await page.keyboard.press(key);
      await page.waitForTimeout(300);
      assert.deepEqual(await counts(), [1, 2], `${other}: nothing is deleted`);
    }
    assert.equal(await deletes(), 0, "No delete command.");

    // In the tool of the selection, Delete works as before, one undo step.
    await tab(page, "Text & shapes").click();
    await page.locator("#video-title").focus();
    await page.keyboard.press("Delete");
    await until(
      async () => (await counts())[0] === 0,
      "The element was not deleted.",
    );
    await tab(page, "Captions").click();
    await page
      .locator(`.caption-row[data-id="${cue.id}"] .caption-select`)
      .click();
    await page.keyboard.press("Backspace");
    await until(
      async () => (await counts())[1] === 1,
      "The caption was not deleted.",
    );
    // Typing in a field still changes the text, not the captions.
    const [left] = (await captionList(call, video.id)).cues;
    await page
      .locator(`.caption-row[data-id="${left.id}"] .caption-select`)
      .click();
    await page.locator("#cap-text").press("End");
    await page.locator("#cap-text").press("Backspace");
    assert.equal((await counts())[1], 1);
    assert.equal(
      await page.locator("#cap-text").inputValue(),
      left.text.slice(0, -1),
    );
  },
);

test(
  "late add and apply results do not change the tool or the focus",
  { timeout: 300000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "nav-late-");
    await setSize(app, 1440, 940);
    const video = await sample(call, root, { elements: 1, captions: 1 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    const focused = () => page.locator(":focus").evaluate(NAME);
    const elementCount = async () =>
      (await call("element.list", { id: video.id })).elements.length;

    // 1. No selection. A held element add ends after the user opens Captions.
    await forward.hold("element.add");
    await page.getByRole("button", { name: "Add text" }).click();
    await forward.held();
    await tab(page, "Captions").click();
    await forward.release();
    await until(async () => (await elementCount()) === 2, "No element.");
    await page.waitForTimeout(400);
    assert.equal(await activeTool(page), "Captions");
    assert.equal(
      await focused(),
      "Captions",
      "The focus stays on the user's tab.",
    );
    assert.equal(await page.locator(".stage-item.selected").count(), 0);

    // 2. No selection. A held caption add ends after the user opens Trim & cut.
    await ready(call);
    await call("playback.seek", { seconds: 5 });
    await forward.hold("captions.add");
    await page
      .getByRole("button", { name: "Add a caption at the playhead" })
      .click();
    await forward.held();
    await tab(page, "Trim & cut").click();
    await forward.release();
    await until(
      async () => (await captionList(call, video.id)).count === 2,
      "No caption.",
    );
    await page.waitForTimeout(400);
    assert.equal(await activeTool(page), "Trim & cut");
    assert.equal(await focused(), "Trim & cut");
    assert.equal(
      await page.locator('.caption-select[aria-pressed="true"]').count(),
      0,
    );

    // 3. An element is selected. A held add ends after the user opens
    // Speed & sound. The first element stays selected.
    const [element] = (await call("element.list", { id: video.id })).elements;
    await ready(call);
    await call("playback.seek", { seconds: 1 });
    await page.locator(`.stage-item[data-id="${element.id}"]`).click();
    assert.equal(await activeTool(page), "Text & shapes");
    await forward.hold("element.add");
    await page.getByRole("button", { name: "Add rectangle" }).click();
    await forward.held();
    await tab(page, "Speed & sound").click();
    await forward.release();
    await until(async () => (await elementCount()) === 3, "No rectangle.");
    await page.waitForTimeout(400);
    assert.equal(await activeTool(page), "Speed & sound");
    assert.equal(await focused(), "Speed & sound");
    assert.equal(
      await page.locator(".stage-item.selected").getAttribute("data-id"),
      element.id,
    );

    // 4. A caption job that ends after the user opens another tool.
    await forward.stub("transcript.capabilities", { available: true });
    const job = {
      jobId: "job-1",
      videoId: video.id,
      progress: { phase: "speech", completedRegions: 1, totalRegions: 2 },
      timing: "estimated",
    };
    await forward.stub("captions.generate", {
      ...job,
      state: "running",
      message: "Recognizing speech: part 1 of 2.",
    });
    await forward.stub("captions.status", {
      ...job,
      state: "applied",
      applied: { added: 2, removed: 2 },
      warning: null,
      message: "Added 2 captions.",
    });
    await call("playback.open", { id: video.id });
    await ready(call);
    await tab(page, "Captions").click();
    await forward.hold("captions.status", "applied");
    await until(
      () => page.locator("#caption-generate").isEnabled(),
      "Make captions is not available.",
    );
    await page.locator("#caption-generate").click();
    await page.getByRole("button", { name: "Replace captions" }).click();
    await forward.held();
    await tab(page, "Details").click();
    await forward.release();
    await page.waitForTimeout(800);
    assert.equal(await activeTool(page), "Details");
    assert.equal(await focused(), "Details");
    assert.equal(await page.locator("#caption-generate").isHidden(), true);
  },
);
