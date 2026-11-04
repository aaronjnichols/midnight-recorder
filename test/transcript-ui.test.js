// The Transcript tool: select words with the mouse or the keys, and cut that
// footage in one shared edit. The main test uses the local speech engine and
// public tutorial media, and skips when they are not on this computer. Stubs
// give only the states that the engine does not give on request.
// Media: "First Steps", Mike Newbon, Blender Studio, CC-BY,
// https://studio.blender.org/training/blender-2-8-fundamentals/first-steps/
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
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

const TUTORIAL = path.resolve(".local/transcript-validation/blender.mp4");
const SHOTS = path.resolve("output/playwright/loom-next/tests");
const available = await access(TUTORIAL).then(
  () => true,
  () => false,
);

function excerpt(root, name = "first-steps") {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-t",
    "40",
    "-i",
    TUTORIAL,
    "-vf",
    "scale=640:360",
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
function silentVideo(root, name, seconds = 6, audio = false) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2e3440:s=640x360:r=30:d=${seconds}`,
    ...(audio
      ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", String(seconds)]
      : []),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac"] : []),
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
const word = (page, index) => page.locator(`.tw[data-index="${index}"]`);
const state = (page) => page.locator("#transcript-state");
const summary = (page) => page.locator("#transcript-selection");
const cutButton = (page) => button(page, "Cut selected words");
async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
// A press in a word, a move, and a release in another word.
async function dragWords(page, from, to) {
  await word(page, from).scrollIntoViewIfNeeded();
  const a = await word(page, from).boundingBox();
  const b = await word(page, to).boundingBox();
  const left = to >= from;
  await page.mouse.move(a.x + (left ? 1 : a.width - 1), a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.move(b.x + (left ? b.width - 1 : 1), b.y + b.height / 2);
  await page.mouse.up();
}
const makeTranscript = async (page) => {
  await tab(page, "Transcript").click();
  await button(page, "Make transcript").click();
  await page.waitForSelector(".tw", { timeout: 300000 });
  await until(
    async () =>
      (await page.locator("#transcript-words").getAttribute("data-loaded")) ===
      "true",
    "The words did not load.",
    60000,
  );
};
const words = async (call, jobId) =>
  (await call("transcript.words", { jobId, limit: 1000 })).words;
const jobOf = async (call, id) =>
  (await call("app.status")).jobs.findLast(
    (job) => job.kind === "transcript" && job.videoId === id,
  );

test(
  "the panel tells each state honestly, with Cancel and Retry",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-states-");
    await setSize(app, 1000, 720);
    const silent = await call("library.import", {
      path: silentVideo(root, "silent"),
      title: "Silent",
    });
    const sound = await call("library.import", {
      path: silentVideo(root, "sound", 6, true),
      title: "Sound",
    });
    const forward = await forwardCommands(app, root);
    const panel = page.locator("#tool-transcript");
    await forward.stub("transcript.capabilities", { available: false });

    // No sound.
    await openEditor(page, call, silent);
    await tab(page, "Transcript").click();
    assert.equal(await panel.isVisible(), true);
    await until(
      async () => /No sound/.test(await state(page).innerText()),
      "No sound did not show.",
    );
    assert.equal(await button(page, "Make transcript").count(), 0);
    await shot(page, "transcript-no-sound-1000");

    // Speech recognition is not set up.
    await openEditor(page, call, sound);
    await tab(page, "Transcript").click();
    await until(
      async () => /setup:transcription/.test(await state(page).innerText()),
      "The setup message did not show.",
    );
    assert.equal(await button(page, "Make transcript").isVisible(), false);

    // A start error shows and the button stays.
    await forward.stub("transcript.capabilities", {
      available: true,
      maxSourceSeconds: 3600,
    });
    await openEditor(page, call, silent);
    await openEditor(page, call, sound);
    await tab(page, "Transcript").click();
    await until(
      () => button(page, "Make transcript").isVisible(),
      "Make transcript did not show.",
    );
    await shot(page, "transcript-idle-1000");
    await forward.stub("transcript.start", {
      error: "A speech job is active.",
    });
    await button(page, "Make transcript").click();
    await until(
      async () =>
        /speech job is active/.test(
          await page.locator("#message-text").innerText(),
        ),
      "The error did not show.",
    );
    assert.equal(await button(page, "Make transcript").isVisible(), true);

    // Progress, Cancel, then Make transcript again.
    const job = {
      id: "job-1",
      kind: "transcript",
      videoId: sound.id,
      state: "running",
      progress: { phase: "speech", completedRegions: 1, totalRegions: 4 },
    };
    await forward.stub("transcript.start", job);
    await forward.stub("transcript.status", job);
    await button(page, "Make transcript").click();
    await until(
      async () => /part 1 of 4/.test(await state(page).innerText()),
      "The progress did not show.",
    );
    assert.equal(
      await page.locator("#transcript-progress").getAttribute("value"),
      "0.25",
    );
    await shot(page, "transcript-progress-1000");
    await forward.stub("transcript.cancel", { ...job, state: "cancelling" });
    await button(page, "Cancel").click();
    await forward.stub("transcript.status", { ...job, state: "cancelled" });
    await until(
      async () => /cancelled/.test(await state(page).innerText()),
      "The cancel did not show.",
    );
    assert.equal(await button(page, "Make transcript").isVisible(), true);

    // A failure gives its reason and a retry.
    await forward.stub("transcript.status", {
      ...job,
      state: "failed",
      error: "Engine stopped.",
    });
    await button(page, "Make transcript").click();
    await until(
      async () => /Engine stopped/.test(await state(page).innerText()),
      "The failure did not show.",
    );
    assert.equal(await button(page, "Try again").isVisible(), true);
    await shot(page, "transcript-failed-1000");

    // No speech.
    await forward.stub("transcript.status", {
      ...job,
      state: "complete",
      result: { outcome: "no_speech", wordCount: 0 },
    });
    await forward.stub("transcript.words", {
      words: [],
      total: 0,
      nextOffset: null,
      sourceCurrent: true,
      revision: "r",
    });
    await button(page, "Try again").click();
    await until(
      async () => /No speech/.test(await state(page).innerText()),
      "No speech did not show.",
    );
    assert.equal(await cutButton(page).isVisible(), false);
    assert.equal(
      (await forward.log()).filter((c) =>
        /^(edit\.|transcript\.cut)/.test(c.command),
      ).length,
      0,
      "No edit.",
    );
  },
);

test(
  "a video that is too long tells the limit",
  { timeout: 120000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-long-");
    await setSize(app, 1000, 720);
    const file = path.join(root, "long.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2e3440:s=160x90:r=1:d=3700",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=8000:cl=mono",
      "-t",
      "3700",
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
    const video = await call("library.import", { path: file, title: "Long" });
    const forward = await forwardCommands(app, root);
    await forward.stub("transcript.capabilities", {
      available: true,
      maxSourceSeconds: 3600,
    });
    await openEditor(page, call, video);
    await tab(page, "Transcript").click();
    await until(
      async () => /60 minutes/.test(await state(page).innerText()),
      "The limit did not show.",
    );
    assert.equal(await button(page, "Make transcript").isVisible(), false);
  },
);

test(
  "a long transcript loads all its pages, and a selection reaches the last page",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-pages-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: silentVideo(root, "pages", 30, true),
      title: "Pages",
    });
    const forward = await forwardCommands(app, root);
    const job = {
      id: "job-pages",
      kind: "transcript",
      videoId: video.id,
      state: "complete",
      result: { outcome: "ready", wordCount: 3500 },
    };
    await forward.stub("transcript.capabilities", {
      available: true,
      maxSourceSeconds: 3600,
    });
    await forward.stub("transcript.start", job);
    await forward.stub("transcript.status", job);
    // Each read gets the page of its offset.
    await app.evaluate(() => {
      const total = 3500;
      Object.defineProperty(globalThis.stubs, "transcript.words", {
        enumerable: true,
        get() {
          const { offset = 0, limit } = globalThis.commandLog.at(-1).args;
          const words = [];
          for (
            let index = offset;
            index < Math.min(total, offset + limit);
            index++
          )
            words.push({
              id: `w${index}`,
              text: `word${index}`,
              sourceStart: index * 0.008,
              sourceEnd: index * 0.008 + 0.006,
              paragraph: Math.floor(index / 50),
            });
          return {
            words,
            total,
            nextOffset: offset + limit < total ? offset + limit : null,
            sourceCurrent: true,
          };
        },
      });
    });
    await openEditor(page, call, video);
    await makeTranscript(page);
    assert.equal(await page.locator(".tw").count(), 3500, "No word is lost.");
    assert.equal(
      (await forward.log("transcript.words")).length,
      4,
      "Four bounded pages.",
    );
    assert.ok(
      (await forward.log("transcript.words")).every(
        (entry) => entry.args.limit <= 1000,
      ),
    );

    // A selection from the first page to the last page.
    const area = page.locator("#transcript-words");
    await area.focus();
    await page.keyboard.press("Control+a");
    await until(
      async () => /3500 words/.test(await summary(page).innerText()),
      `All words were not selected: ${await summary(page).innerText()}`,
    );
    assert.equal((await draft(page))[0], 0);
    near((await draft(page))[1], 3499 * 0.008 + 0.006, 0.001, "The end");
    await page.keyboard.press("Escape");

    // The last word is in the list, and it can be selected.
    await word(page, 3499).scrollIntoViewIfNeeded();
    await word(page, 3499).dblclick();
    await until(
      async () => /^1 word/.test(await summary(page).innerText()),
      "The last word was not selected.",
    );
    assert.equal(await page.evaluate(() => scrollY), 0);
  },
);

test(
  "real words: select with the mouse, inspect the range, cut, undo, and redo",
  {
    timeout: 900000,
    skip: available ? false : "The tutorial media is not on this computer.",
  },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-real-");
    if (!(await call("transcript.capabilities")).available)
      return t.skip("The local speech engine is not set up.");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: excerpt(root),
      title: "First Steps",
    });
    await call("captions.add", {
      id: video.id,
      text: "A corrected caption",
      start: 2,
      end: 5,
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await makeTranscript(page);
    const job = await jobOf(call, video.id);
    const list = await words(call, job.id);
    assert.ok(list.length > 40, `${list.length} words.`);
    assert.equal(await page.locator(".tw").count(), list.length);

    // Text that is easy to read, in its own focused panel.
    const size = await word(page, 0).evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).fontSize),
    );
    assert.ok(size >= 13 && size <= 14, `Font size ${size}.`);
    const panel = await page.locator("#transcript-words").boundingBox();
    assert.ok(panel.height >= 240, `Text height ${panel.height}.`);
    assert.equal(await cutButton(page).isVisible(), true, "A stable action.");
    assert.equal(await cutButton(page).isDisabled(), true, "Nothing selected.");
    assert.match(await summary(page).innerText(), /Select words/);
    await shot(page, "transcript-ready-1000");
    assert.match(
      await page.locator("#tool-transcript").innerText(),
      /Captions/,
      "The panel tells where text corrections are.",
    );

    // Forward across lines.
    const first = 6,
      last = 24;
    const past = (await stored(call, video.id)).past.length;
    await dragWords(page, first, last);
    await until(
      async () => /19 words/.test(await summary(page).innerText()),
      `The selection did not show: ${await summary(page).innerText()}`,
    );
    const [start, end] = await draft(page);
    near(start, list[first].start, 0.001, "Draft start");
    near(end, list[last].end, 0.001, "Draft end");
    const frame = await page.locator("#timeline-range").boundingBox();
    const track = await page.locator("#timeline-track").boundingBox();
    const total = (await call("playback.status")).duration;
    near(frame.x, track.x + (track.width * start) / total, 2, "The gold frame");
    assert.match(await page.locator("#selection-chip").innerText(), /to/);
    assert.equal(await cutButton(page).isEnabled(), true);
    await shot(page, "transcript-selected-1000");

    // Reverse gives the same selection.
    await page.keyboard.press("Escape");
    await dragWords(page, last, first);
    await until(
      async () => /19 words/.test(await summary(page).innerText()),
      "The reverse selection did not show.",
    );
    assert.deepEqual(await draft(page), [start, end], "The same range.");

    // Copy has the selected words.
    await page.keyboard.press("Control+C");
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(
      copied,
      list
        .slice(first, last + 1)
        .map((w) => w.text)
        .join(" "),
    );

    // Selection and seeking are not edits.
    assert.equal((await stored(call, video.id)).past.length, past);
    await word(page, 2).click();
    await until(
      async () =>
        Math.abs((await call("playback.status")).seconds - list[2].start) <
        0.05,
      "A word click did not seek.",
    );
    assert.equal((await stored(call, video.id)).past.length, past);
    assert.match(await summary(page).innerText(), /Select words/);
    assert.equal(await cutButton(page).isDisabled(), true);

    // A drag ends with a click. It does not seek.
    const before = (await call("playback.status")).seconds;
    await dragWords(page, 10, 12);
    await until(
      async () => /3 words/.test(await summary(page).innerText()),
      "No selection.",
    );
    near((await call("playback.status")).seconds, before, 0.01, "No seek");

    // Cut: one shared command, one undo step, and the join at the playhead.
    await forward.hold("preview.start");
    await cutButton(page).click();
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "No cut.",
    );
    const cuts = await forward.log("transcript.cut");
    assert.equal(cuts.length, 1);
    assert.deepEqual(Object.keys(cuts[0].args).sort(), [
      "from",
      "id",
      "jobId",
      "revision",
      "to",
    ]);
    assert.equal(cuts[0].args.from, "w10");
    assert.equal(cuts[0].args.to, "w12");
    assert.equal((await forward.log("edit.cut")).length, 0);
    await forward.held();
    await forward.release();
    await ready(call);
    assert.deepEqual((await stored(call, video.id)).segments, [
      { start: 0, end: list[10].sourceStart },
      {
        start: list[12].sourceEnd,
        end: (await stored(call, video.id)).segments.at(-1).end,
      },
    ]);
    near(
      (await call("playback.status")).seconds,
      list[10].start,
      0.05,
      "The playhead is at the join",
    );
    for (const index of [10, 11, 12])
      assert.equal(
        await word(page, index).getAttribute("data-state"),
        "removed",
      );
    assert.equal(await word(page, 9).getAttribute("data-state"), null);
    assert.equal(await cutButton(page).isDisabled(), true, "Selection ended.");
    assert.equal(
      (await stored(call, video.id)).captions.cues[0].text,
      "A corrected caption",
      "A cut does not change caption text.",
    );
    await shot(page, "transcript-cut-1000");

    // Undo and redo update the same page, with no new words read.
    const reads = (await forward.log("transcript.words")).length;
    const node = await word(page, 11).elementHandle();
    await button(page, "Undo").click();
    await until(
      async () => (await word(page, 11).getAttribute("data-state")) === null,
      "Undo did not return the word.",
    );
    await ready(call);
    await button(page, "Redo").click();
    await until(
      async () =>
        (await word(page, 11).getAttribute("data-state")) === "removed",
      "Redo did not remove the word.",
    );
    await ready(call);
    assert.equal(
      await node.evaluate((item) => item.isConnected),
      true,
      "The same nodes: the list does not rebuild.",
    );
    assert.equal(
      (await forward.log("transcript.words")).length,
      reads,
      "A timing change needs no new read.",
    );
    assert.equal(
      (await forward.log("transcript.start")).length,
      1,
      "No new recognition.",
    );

    // A speed change remaps the words and the selection.
    await dragWords(page, 20, 22);
    await until(
      async () => /3 words/.test(await summary(page).innerText()),
      "No selection.",
    );
    const [slow] = await draft(page);
    await call("edit.configure", { id: video.id, speed: 2 });
    await until(
      async () => Math.abs((await draft(page))[0] - slow / 2) < 0.01,
      "The selection did not follow the speed.",
      10000,
    );
    await ready(call);
    assert.match(await summary(page).innerText(), /3 words/);
    await call("edit.configure", { id: video.id, speed: 1 });
    await ready(call);

    // A selection over removed words uses only kept words.
    await page.keyboard.press("Escape");
    await dragWords(page, 8, 14);
    await until(
      async () => /already cut/.test(await summary(page).innerText()),
      `No note: ${await summary(page).innerText()}`,
    );
    assert.match(await summary(page).innerText(), /^4 words/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#message.error:not([hidden])").count(), 0);
  },
);

test(
  "the keys select words, the word draft is safe, and scroll stays",
  {
    timeout: 900000,
    skip: available ? false : "The tutorial media is not on this computer.",
  },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-keys-");
    if (!(await call("transcript.capabilities")).available)
      return t.skip("The local speech engine is not set up.");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: excerpt(root),
      title: "First Steps",
    });
    await call("edit.split", { id: video.id, seconds: 30 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await makeTranscript(page);
    const job = await jobOf(call, video.id);
    const list = await words(call, job.id);
    const area = page.locator("#transcript-words");

    // Keys: a caret, Shift extends, Esc clears, and Delete does not cut.
    await area.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".tw.caret").count(), 1);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await until(
      async () => /3 words/.test(await summary(page).innerText()),
      "The keys did not select.",
    );
    const past = (await stored(call, video.id)).past.length;
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    assert.equal((await stored(call, video.id)).past.length, past);
    assert.equal((await forward.log("transcript.cut")).length, 0);
    await page.keyboard.press("Enter");
    await until(
      async () => (await call("playback.status")).seconds > 0.1,
      "Enter did not seek.",
    );
    await page.keyboard.press("Escape");
    assert.match(await summary(page).innerText(), /Select words/);
    assert.equal((await draft(page))[0], 0, "The draft ended.");

    // Tab reaches the action.
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "transcript-cut",
    );

    // A word draft stays through a track click: the click does not select a
    // part. The dock Remove is the same guarded cut.
    await page.keyboard.press("Escape");
    await area.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await until(
      async () => /words/.test(await summary(page).innerText()),
      "No selection.",
    );
    const selected = await draft(page);
    const track = await page.locator("#timeline-track").boundingBox();
    await page.mouse.click(track.x + track.width * 0.9, track.y + 20);
    await page.waitForTimeout(300);
    assert.deepEqual(await draft(page), selected, "The word draft stays.");
    assert.match(await summary(page).innerText(), /words/);

    // A drag of a gold handle, then Esc, returns the word selection. The owner
    // and the words stay together.
    const words0 = await summary(page).innerText();
    const handle = await page.locator("#range-handle-end").boundingBox();
    await page.mouse.move(handle.x + 6, handle.y + 20);
    await page.mouse.down();
    await page.mouse.move(handle.x + 40, handle.y + 20, { steps: 4 });
    assert.match(
      await summary(page).innerText(),
      /Select words/,
      "A manual drag ends the word selection.",
    );
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.deepEqual(await draft(page), selected, "The draft returns.");
    assert.equal(await summary(page).innerText(), words0, "The words return.");
    assert.equal(await cutButton(page).isEnabled(), true);
    const ownedPast = (await stored(call, video.id)).past.length;
    await button(page, "Remove the selection").click();
    await until(
      async () => (await stored(call, video.id)).past.length === ownedPast + 1,
      "The restored selection did not cut.",
    );
    assert.equal((await forward.log("transcript.cut")).length, 1);
    assert.equal((await forward.log("edit.cut")).length, 0);
    await ready(call);
    await button(page, "Undo").click();
    await until(
      async () => (await stored(call, video.id)).past.length === ownedPast,
      "No undo.",
    );
    await ready(call);
    await page.keyboard.press("Escape");
    await area.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await until(
      async () => /words/.test(await summary(page).innerText()),
      "No selection.",
    );

    // Set end ends the word selection, so Remove is then a manual cut and not a
    // word cut. Here the end is before the start, so Esc clears the draft.
    await page.getByRole("button", { name: /^Set end/ }).click();
    assert.match(await summary(page).innerText(), /Select words/);
    assert.equal(await cutButton(page).isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal((await draft(page))[0], 0, "The draft ended.");

    // The dock Remove with a word selection uses transcript.cut.
    await area.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await until(
      async () => /word/.test(await summary(page).innerText()),
      "No selection.",
    );
    await button(page, "Remove the selection").click();
    await until(
      async () => (await stored(call, video.id)).past.length === past + 1,
      "No cut.",
    );
    assert.equal((await forward.log("transcript.cut")).length, 2);
    assert.equal((await forward.log("edit.cut")).length, 0);
    await ready(call);

    // Manual scroll, polling, and playback keep the place and the selection.
    const place = await area.evaluate((node) => {
      node.scrollTop = 120;
      return node.scrollTop;
    });
    await page.mouse.move(
      (await area.boundingBox()).x + 40,
      (await area.boundingBox()).y + 40,
    );
    await page.mouse.wheel(0, 1);
    await page.waitForTimeout(100);
    const scrolled = await area.evaluate((node) => node.scrollTop);
    assert.ok(scrolled >= place, "The wheel moved the list.");
    await until(
      () => page.locator("#transcript-follow").isVisible(),
      "Follow playhead did not show.",
    );
    await page.keyboard.press("Space");
    await page.waitForTimeout(2200);
    await call("playback.pause");
    assert.equal(
      await area.evaluate((node) => node.scrollTop),
      scrolled,
      "Polling and playback did not move the list.",
    );

    // Follow playhead returns to the current word.
    await call("playback.seek", { seconds: list.at(-1).start - 2 });
    await page.locator("#transcript-follow").click();
    await until(
      async () => (await page.locator(".tw.current").count()) <= 1,
      "No current word.",
    );
    await until(
      async () => (await area.evaluate((node) => node.scrollTop)) !== scrolled,
      "Follow did not move the list.",
    );
    assert.equal(await page.locator("#transcript-follow").isVisible(), false);
  },
);

test(
  "a late reply does not reach another video, and an external job and cut show",
  {
    timeout: 900000,
    skip: available ? false : "The tutorial media is not on this computer.",
  },
  async (t) => {
    const { root, app, page, call } = await launch(t, "transcript-late-");
    if (!(await call("transcript.capabilities")).available)
      return t.skip("The local speech engine is not set up.");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: excerpt(root),
      title: "First Steps",
    });
    const other = await call("library.import", {
      path: silentVideo(root, "other", 6, true),
      title: "Other",
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
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await tab(page, "Transcript").click();

    // A job from the CLI shows in the open panel, and its words load.
    const job = await cli("transcript.start", { id: video.id });
    await page.waitForSelector(".tw", { timeout: 300000 });
    assert.equal((await forward.log("transcript.start")).length, 0);
    await until(
      async () =>
        (await page
          .locator("#transcript-words")
          .getAttribute("data-loaded")) === "true",
      "The words did not load.",
    );

    // A cut from the CLI shows without a new read.
    const reads = (await forward.log("transcript.words")).length;
    const list = await cli("transcript.words", { jobId: job.id });
    await cli("transcript.cut", {
      id: video.id,
      jobId: job.id,
      from: "w3",
      to: "w4",
      revision: list.revision,
    });
    await until(
      async () =>
        (await word(page, 3).getAttribute("data-state")) === "removed",
      "The external cut did not show.",
    );
    assert.equal((await forward.log("transcript.words")).length, reads);
    await ready(call);

    // A selection made on an old view does not cut after an external edit.
    await dragWords(page, 20, 22);
    await until(
      async () => /3 words/.test(await summary(page).innerText()),
      "No selection.",
    );
    await forward.hold("transcript.cut");
    await cli("edit.configure", { id: video.id, speed: 1.25 }).catch(() => {});
    await cutButton(page).click();
    await page.waitForTimeout(600);
    await forward.release();
    await until(
      async () => (await stored(call, video.id)).speed === 1.25,
      "The speed did not save.",
    );
    await ready(call);

    // A late word page belongs to its video.
    await call("edit.configure", { id: video.id, speed: 1 });
    await ready(call);
    await page.keyboard.press("Escape");
    await openEditor(page, call, other);
    await tab(page, "Transcript").click();
    await forward.hold("transcript.words");
    await openEditor(page, call, video);
    await tab(page, "Transcript").click();
    await forward.held();
    await openEditor(page, call, other);
    await tab(page, "Transcript").click();
    await forward.release();
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".tw").count(), 0, "No words of a video.");
    assert.equal(await page.locator("#transcript-state").isVisible(), true);
    assert.equal((await stored(call, other.id)).past.length, 0);
  },
);
