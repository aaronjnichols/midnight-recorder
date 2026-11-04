// The timeline shows real sound and real frames, or tells the true state.
// The tests read the canvas pixels. The media has a known pattern.
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

// 6 seconds: red with a tone, green with silence, blue with a tone.
function patternVideo(root, name = "pattern") {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=48000:d=6",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "3:a",
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
function plainVideo(root, name, audio) {
  const file = path.join(root, `${name}.mp4`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x336699:s=320x180:r=30:d=4",
    ...(audio ? ["-f", "lavfi", "-i", audio, "-t", "4", "-c:a", "aac"] : []),
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
const track = (page) => page.locator("#timeline-track");
const audioState = (page) => track(page).getAttribute("data-audio");
const framesState = (page) => track(page).getAttribute("data-frames");
const note = (page) => page.locator("#timeline-note");
const ready = (page, audio = "ready", frames = "ready") =>
  until(
    async () =>
      (await audioState(page)) === audio &&
      (await framesState(page)) === frames,
    `The overview did not reach ${audio} and ${frames}.`,
    60000,
  );

// The strength of the wave at a track fraction: the share of bright blue
// pixels in a column of the sound zone. The frames are above that zone.
const wave = (page, fraction) =>
  page.evaluate((at) => {
    const canvas = document.querySelector("#timeline-canvas");
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const x = Math.round(canvas.width * at);
    const height = canvas.height;
    const top = Math.round(height * 0.6);
    const data = canvas
      .getContext("2d")
      .getImageData(x, top, 1, height - top).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 3] > 100 && data[i + 2] > 120) lit++;
    return { lit: lit / (data.length / 4), scale };
  }, fraction);
// The average color of the frame zone at a track fraction.
const frameColor = (page, fraction) =>
  page.evaluate((at) => {
    const canvas = document.querySelector("#timeline-canvas");
    const x = Math.round(canvas.width * at);
    const [r, g, b] = canvas
      .getContext("2d")
      .getImageData(x, Math.round(canvas.height * 0.2), 1, 1).data;
    return { r, g, b };
  }, fraction);

test(
  "the track shows the real sound and frames and follows an edit without a new read",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "visual-real-");
    await setSize(app, 1000, 720);
    const video = await call("library.import", {
      path: patternVideo(root),
      title: "Pattern",
    });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await ready(page);
    assert.equal(await note(page).isHidden(), true, "Nothing to tell.");

    assert.ok((await wave(page, 1 / 6)).lit > 0.3, "Tone at the start.");
    assert.ok((await wave(page, 1 / 2)).lit < 0.12, "Silence in the middle.");
    assert.ok((await wave(page, 5 / 6)).lit > 0.3, "Tone at the end.");
    const red = await frameColor(page, 1 / 6);
    assert.ok(red.r > 150 && red.g < 100, JSON.stringify(red));
    const blue = await frameColor(page, 5 / 6);
    assert.ok(blue.b > 150 && blue.r < 100, JSON.stringify(blue));

    // A cut of the first tone. The track shows the new order at once.
    const reads = (await forward.log("overview.start")).length;
    await call("edit.cut", { id: video.id, start: 0, end: 2 });
    await until(
      async () => (await page.locator("#duration").innerText()) === "0:04",
      "The cut did not show.",
    );
    await until(
      async () => (await wave(page, 1 / 4)).lit < 0.12,
      "The silence did not move to the start.",
      5000,
    );
    assert.ok((await wave(page, 3 / 4)).lit > 0.3, "The tone follows.");
    const green = await frameColor(page, 1 / 4);
    assert.ok(green.g > 80 && green.r < 80, JSON.stringify(green));
    assert.equal(
      (await forward.log("overview.start")).length,
      reads,
      "An edit needs no new read.",
    );

    // Mute: the same levels show as muted, and the state says so.
    await call("edit.configure", { id: video.id, muted: true });
    await until(
      async () =>
        /muted/i.test(
          await note(page)
            .innerText()
            .catch(() => ""),
        ),
      "The muted state did not show.",
      5000,
    );
    await page.screenshot({
      path: path.resolve("output/playwright/loom-redesign/test-muted.png"),
    });

    // A zoomed view shows the same sound at the same times.
    await call("edit.configure", { id: video.id, muted: false });
    await call("edit.undo", { id: video.id });
    await call("edit.undo", { id: video.id });
    await call("edit.undo", { id: video.id });
    await until(
      async () => (await page.locator("#duration").innerText()) === "0:06",
      "The undo did not show.",
    );
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.locator("#timeline-scroll").evaluate((node) => {
      node.scrollLeft = (node.scrollWidth - node.clientWidth) / 2;
    });
    await page.waitForTimeout(100);
    // The middle of the view is the middle of the video: silence.
    assert.ok((await wave(page, 0.5)).lit < 0.12, "Zoomed silence.");
    assert.ok((await wave(page, 0.02)).lit > 0.3, "Zoomed tone.");
  },
);

test(
  "no sound, silent sound, a read error, and a retry are honest",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "visual-states-");
    await setSize(app, 1440, 940);
    const none = await call("library.import", {
      path: plainVideo(root, "none"),
      title: "No sound",
    });
    const silent = await call("library.import", {
      path: plainVideo(root, "silent", "anullsrc=r=48000:cl=mono"),
      title: "Silent",
    });
    const forward = await forwardCommands(app, root);

    await openEditor(page, call, none);
    await ready(page, "none");
    assert.match(await note(page).innerText(), /no sound/i);
    assert.equal(await page.locator("#overview-retry").isHidden(), true);
    // Without sound the frames fill the track: there is no wave and no empty
    // sound zone. The picture is one color, so all of the column is the same.
    const column = await page.evaluate(() => {
      const canvas = document.querySelector("#timeline-canvas");
      const x = Math.round(canvas.width / 2);
      const data = canvas
        .getContext("2d")
        .getImageData(x, 0, 1, canvas.height).data;
      const blue = [];
      for (let i = 2; i < data.length; i += 4) blue.push(data[i]);
      return blue;
    });
    assert.ok(
      Math.max(...column) - Math.min(...column) < 12,
      `A video without sound has no wave: ${Math.min(...column)} to ${Math.max(...column)}`,
    );

    await openEditor(page, call, silent);
    await ready(page, "silent");
    assert.match(await note(page).innerText(), /silent/i);
    assert.ok(
      (await wave(page, 0.5)).lit < 0.12,
      "A silent track has no wave.",
    );

    // A failed read says so, and Retry reads again.
    await forward.stub("overview.start", { error: "The disk is busy." });
    await openEditor(page, call, none);
    await until(
      async () => (await audioState(page)) === "failed",
      "The error did not show.",
    );
    assert.match(await note(page).innerText(), /cannot read/i);
    assert.equal(await page.locator("#overview-retry").isVisible(), true);
    await page.screenshot({
      path: path.resolve("output/playwright/loom-redesign/test-failed.png"),
    });
    await app.evaluate(() => delete globalThis.stubs["overview.start"]);
    await page.locator("#overview-retry").click();
    await ready(page, "none");
    assert.equal(await page.locator("#overview-retry").isHidden(), true);
  },
);

test(
  "the track shows the read state, and a late result cannot reach another video",
  { timeout: 240000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "visual-late-");
    await setSize(app, 1000, 720);
    const first = await call("library.import", {
      path: patternVideo(root, "first"),
      title: "First",
    });
    const second = await call("library.import", {
      path: plainVideo(root, "second"),
      title: "Second",
    });
    const forward = await forwardCommands(app, root);

    // Hold the data of the first video until the second video is open.
    await forward.hold("overview.result");
    await call("playback.open", { id: first.id });
    await page.waitForSelector("#editor:not([hidden])");
    await forward.held();
    assert.match(await note(page).innerText(), /reading/i);
    await openEditor(page, call, second);
    await until(
      async () =>
        (await page.locator("#video-title").textContent()) === "Second",
      "The second video did not open.",
    );
    await forward.release();
    await ready(page, "none");
    await page.waitForTimeout(500);
    assert.equal(
      await track(page).getAttribute("data-overview"),
      second.id,
      "The track belongs to the open video.",
    );
    assert.equal(await audioState(page), "none");

    // A read that is running when the user goes back to the library stops.
    await page.getByRole("button", { name: "Back to library" }).click();
    await page.waitForSelector("#library-view:not([hidden])");
    assert.equal(await track(page).getAttribute("data-overview"), "");
  },
);
