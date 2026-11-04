// Real screen pixels of the draft picture. A DOM check alone cannot prove that
// old glyphs are gone or that other layers stay. Screenshots stay in
// output/playwright/direct-text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  launch,
  setSize,
  until,
  openEditor,
  forwardCommands,
} from "../test-support/electron.js";
import { frameAt, region } from "../test-support/frames.js";

const SHOTS = path.resolve("output/playwright/direct-text");
mkdirSync(SHOTS, { recursive: true });

function makeVideo(root, size, tag = [], name = "visual.mp4") {
  const file = path.join(root, name);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x3B5B7A:s=${size}:r=30:d=4`,
    ...tag,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "12",
    file,
  ]);
  return file;
}

const close = (a, b, limit) =>
  Math.abs(a[0] - b[0]) <= limit &&
  Math.abs(a[1] - b[1]) <= limit &&
  Math.abs(a[2] - b[2]) <= limit;
const white = ([r, g, b]) => r > 225 && g > 225 && b > 225;
// The player colors of #E02020 and #2020E0 in an untagged HD video.
const RED = [240, 51, 28];
const BLUE = [29, 42, 234];

// A shape below the text, a shape above it, and a caption.
async function scene(call, video) {
  await call("element.add", {
    id: video.id,
    type: "rectangle",
    start: 0,
    end: 4,
    x: 0.02,
    y: 0.3,
    width: 0.2,
    height: 0.4,
    fill: "#E02020",
    fillOpacity: 1,
    stroke: "none",
  });
  const { element } = await call("element.add", {
    id: video.id,
    type: "text",
    text: "OLD WORDS HERE",
    start: 0,
    end: 4,
    x: 0.1,
    y: 0.35,
    width: 0.8,
    height: 0.3,
    size: 0.09,
    color: "#FFFFFF",
    outline: "none",
  });
  await call("element.add", {
    id: video.id,
    type: "rectangle",
    start: 0,
    end: 4,
    x: 0.72,
    y: 0.3,
    width: 0.2,
    height: 0.4,
    fill: "#2020E0",
    fillOpacity: 1,
    stroke: "none",
  });
  await call("captions.add", {
    id: video.id,
    start: 0,
    end: 4,
    text: "Caption stays",
  });
  return element;
}

// A screenshot of the frame on screen, as RGB pixels.
async function frame(page, name) {
  const box = await page.locator("#stage").boundingBox();
  const clip = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, clip });
  return {
    ...frameAt(file, 0, clip.width, clip.height),
    file,
    width: clip.width,
    height: clip.height,
  };
}

// The share of a 0-to-1 rectangle that a color test matches.
function share(picture, match, [x1, y1, x2, y2]) {
  const area = {
    left: Math.round(x1 * picture.width),
    top: Math.round(y1 * picture.height),
    right: Math.round(x2 * picture.width),
    bottom: Math.round(y2 * picture.height),
  };
  const found = region(picture, match, area);
  return found.count / ((area.right - area.left) * (area.bottom - area.top));
}

async function typeOnVideo(page, element, text) {
  const node = page.locator(`.stage-item[data-id="${element.id}"]`);
  const box = await node.boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(
    () => document.activeElement?.id === "draft-input",
  );
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await until(
    () =>
      page.evaluate(
        () => document.querySelector("#draft-view").dataset.mode === "clean",
      ),
    "The clean picture did not arrive.",
    20000,
  );
  // The image and the text are on screen after two frames.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

const exactReady = (page) =>
  until(
    async () =>
      (await page.locator("#preview-state").innerText()) === "Preview ready" &&
      (await page.locator("#draft-view").isHidden()) &&
      (await page.evaluate(() => !document.querySelector("#player").seeking)),
    "The exact preview did not show.",
    120000,
  );

async function prepared(t, prefix, width, height, size, tag) {
  const { root, app, page, call } = await launch(t, prefix);
  await setSize(app, width, height);
  const video = await call("library.import", {
    path: makeVideo(root, size, tag),
    title: "Visual",
  });
  const element = await scene(call, video);
  const forward = await forwardCommands(app, root);
  await openEditor(page, call, video);
  await call("playback.seek", { seconds: 2 });
  await page.waitForFunction(() => !document.querySelector("#player").seeking);
  await page.waitForTimeout(200);
  return { root, app, page, call, video, element, forward };
}

for (const [name, width, height, size] of [
  ["small", 1000, 720, "1280x720"],
  ["large", 1440, 940, "1920x1080"],
  ["portrait", 1440, 940, "720x1280"],
])
  test(
    `the draft replaces old glyphs and keeps all other layers: ${name}`,
    { timeout: 180000 },
    async (t) => {
      const { page, element } = await prepared(
        t,
        `text-visual-${name}-`,
        width,
        height,
        size,
      );
      const before = await frame(page, `${name}-1-exact-before`);
      // "NEW" is short and centered, so the band beside it had old letters.
      // The text is wider on a narrow frame, so the band is further out.
      const side = name === "portrait" ? 0.16 : 0.26;
      const left = [side, 0.42, side + 0.12, 0.58];
      assert.ok(share(before, white, left) > 0.02, "Old letters were here.");
      const capBand = [0.05, 0.75, 0.95, 1];
      const capInk = (picture) => {
        const light = ([r, g, b]) => r > 190 && g > 190 && b > 190;
        return {
          share: share(picture, light, capBand),
          bounds: region(picture, light, {
            left: Math.round(capBand[0] * picture.width),
            top: Math.round(capBand[1] * picture.height),
            right: Math.round(capBand[2] * picture.width),
            bottom: picture.height,
          }),
        };
      };
      const caption = capInk(before);
      assert.ok(caption.share > 0.003, `Caption pixels: ${caption.share}`);

      await typeOnVideo(page, element, "NEW");
      const draft = await frame(page, `${name}-2-draft`);

      // The old text is gone from all of the band beside the new text.
      assert.equal(share(draft, white, left), 0, "No old glyph stays.");
      // The new text is on the picture.
      assert.ok(share(draft, white, [0.4, 0.42, 0.6, 0.58]) > 0.02);
      // The shape below, the shape above, and the caption stay. The image and
      // the video scale small letters a little differently, so the caption
      // check uses its place and its amount of ink.
      const lower = [0.03, 0.32, 0.09, 0.68];
      const upper = [0.74, 0.32, 0.9, 0.68];
      const isRed = (pixel) => close(pixel, RED, 30);
      const isBlue = (pixel) => close(pixel, BLUE, 30);
      assert.ok(share(draft, isRed, lower) > 0.95, "The lower shape stays.");
      assert.ok(share(draft, isBlue, upper) > 0.95, "The upper shape stays.");
      const stayed = capInk(draft);
      const ratio = stayed.share / caption.share;
      assert.ok(ratio > 0.7 && ratio < 1.4, `Caption ink ratio: ${ratio}.`);
      for (const key of ["minX", "maxX", "minY", "maxY"])
        assert.ok(
          Math.abs(stayed.bounds[key] - caption.bounds[key]) <= 3,
          `Caption ${key}: ${stayed.bounds[key]}, ${caption.bounds[key]}.`,
        );

      // Layer order: long text goes under the shape above it.
      await page.keyboard.press("Control+A");
      await page.keyboard.type("LONG WORDS GO UNDER THE BLUE SHAPE");
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const order = await frame(page, `${name}-3-layer-order`);
      assert.ok(
        share(order, white, [0.74, 0.42, 0.88, 0.58]) === 0,
        "The shape above covers the draft text.",
      );
      assert.ok(share(order, isBlue, upper) > 0.95);
    },
  );

test(
  "the draft text sits where the exact render puts it, at each window size",
  { timeout: 240000 },
  async (t) => {
    const { app, page, call, element } = await prepared(
      t,
      "text-visual-place-",
      1440,
      940,
      "1920x1080",
    );
    await typeOnVideo(page, element, "Placed Hg");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line");
    await page.waitForTimeout(100);
    const box = [0.23, 0.36, 0.71, 0.64];
    const bounds = (picture) => {
      const area = {
        left: Math.round(box[0] * picture.width),
        top: Math.round(box[1] * picture.height),
        right: Math.round(box[2] * picture.width),
        bottom: Math.round(box[3] * picture.height),
      };
      return region(picture, white, area);
    };
    const draftLarge = bounds(await frame(page, "place-1-draft-1440"));
    await setSize(app, 1000, 720);
    await page.waitForTimeout(400);
    const draftSmall = await frame(page, "place-2-draft-1000");
    await setSize(app, 1440, 940);
    await page.waitForTimeout(400);

    await page.keyboard.press("Control+Enter");
    await exactReady(page);
    await page.waitForTimeout(300);
    const exactLarge = bounds(await frame(page, "place-3-exact-1440"));
    for (const key of ["minX", "maxX", "minY", "maxY"])
      assert.ok(
        Math.abs(draftLarge[key] - exactLarge[key]) <= 3,
        `${key}: draft ${draftLarge[key]}, exact ${exactLarge[key]}.`,
      );
    // The ink has nearly the same area, so the font and the weight match.
    const ratio = draftLarge.count / exactLarge.count;
    assert.ok(ratio > 0.85 && ratio < 1.15, `Ink ratio: ${ratio}`);

    await setSize(app, 1000, 720);
    await page.waitForTimeout(400);
    const exactSmall = await frame(page, "place-4-exact-1000");
    const a = bounds(draftSmall),
      b = bounds(exactSmall);
    for (const key of ["minX", "maxX", "minY", "maxY"])
      assert.ok(
        Math.abs(a[key] - b[key]) <= 3,
        `${key} at 1000: draft ${a[key]}, exact ${b[key]}.`,
      );
    assert.ok(call);
  },
);

// The real player decides these colors: with no tag it shows H.264 as BT.709
// from 720 lines and as BT.601 below, and with a tag it follows the tag.
for (const [name, size, tag] of [
  ["untagged HD", "1920x1080", []],
  ["untagged SD", "640x360", []],
  [
    "tagged HD",
    "1920x1080",
    ["-vf", "setparams=colorspace=bt709", "-colorspace", "bt709"],
  ],
])
  test(
    `the picture and the text box do not jump in color at the swap: ${name}`,
    { timeout: 180000 },
    async (t) => {
      const slug = name.replace(" ", "-").toLowerCase();
      const { page, call, video, element } = await prepared(
        t,
        `text-visual-color-${slug}-`,
        1440,
        940,
        size,
        tag,
      );
      const exact = await frame(page, `color-${slug}-1-exact`);
      await typeOnVideo(page, element, "Color");
      const draft = await frame(page, `color-${slug}-2-draft`);
      const at = (picture, x, y) =>
        picture.at(
          Math.round(x * picture.width),
          Math.round(y * picture.height),
        );
      for (const [part, x, y] of [
        ["video", 0.5, 0.15],
        ["video", 0.95, 0.95],
        ["red shape", 0.05, 0.5],
        ["blue shape", 0.82, 0.5],
      ])
        assert.ok(
          close(at(draft, x, y), at(exact, x, y), 6),
          `${part}: draft ${at(draft, x, y)}, exact ${at(exact, x, y)}.`,
        );

      // The draft text box has the same colors as the rest of the picture.
      await page.keyboard.press("Escape");
      const list = await call("element.list", { id: video.id });
      await call("element.update", {
        id: video.id,
        elementId: list.elements[1].id,
        background: "#E02020",
        backgroundOpacity: 1,
      });
      // The page reads a change from another client in its next poll.
      await until(
        async () =>
          (await page.locator("#preview-state").innerText()) !==
          "Preview ready",
        "The page did not read the change.",
      );
      await exactReady(page);
      const boxed = await frame(page, `color-${slug}-3-box-exact`);
      await typeOnVideo(page, element, "Box");
      const typed = await frame(page, `color-${slug}-4-box-draft`);
      const spot = [0.3, 0.38];
      assert.ok(
        close(at(typed, ...spot), at(boxed, ...spot), 6),
        `Box: draft ${at(typed, ...spot)}, exact ${at(boxed, ...spot)}.`,
      );
    },
  );

// Review U2: without clean images, Apply must not drop the other layers.
for (const [name, block] of [
  // No job ends, so neither the frame nor the exact preview arrives.
  ["blocked", (forward) => forward.stub("export.status", { state: "running" })],
  [
    "failed",
    (forward) => forward.stub("preview.frame", { error: "No frame." }),
  ],
])
  test(
    `a save with a ${name} frame keeps the other layers until the exact preview`,
    { timeout: 180000 },
    async (t) => {
      const { page, element, forward } = await prepared(
        t,
        `text-visual-fallback-${name}-`,
        1440,
        940,
        "1920x1080",
      );
      await block(forward);
      const node = page.locator(`.stage-item[data-id="${element.id}"]`);
      const box = await node.boundingBox();
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(
        () => document.activeElement?.id === "draft-input",
      );
      await page.keyboard.press("Control+A");
      await page.keyboard.type("NEW");
      await page.waitForTimeout(100);
      if (name === "failed") await forward.hold("preview.start");
      await page.keyboard.press("Control+Enter");
      if (name === "failed") await forward.held();
      else await page.waitForTimeout(800);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const held = await frame(page, `fallback-${name}-1-after-apply`);
      const isRed = (pixel) => close(pixel, RED, 30);
      const isBlue = (pixel) => close(pixel, BLUE, 30);
      assert.ok(
        share(held, isRed, [0.03, 0.32, 0.07, 0.68]) > 0.9,
        "The lower shape stays.",
      );
      // The opaque plate covers its own box only. The upper shape is over the
      // box, so these strips are the parts of it outside the plate.
      for (const strip of [
        [0.74, 0.305, 0.9, 0.32],
        [0.74, 0.68, 0.9, 0.695],
      ])
        assert.ok(share(held, isBlue, strip) > 0.9, "The upper shape stays.");
      assert.ok(
        share(held, white, [0.05, 0.75, 0.95, 1]) > 0.003,
        "The caption stays.",
      );
      assert.ok(
        share(held, white, [0.4, 0.42, 0.6, 0.58]) > 0.02,
        "The new text stays.",
      );
      assert.equal(
        share(held, white, [0.26, 0.42, 0.38, 0.58]),
        0,
        "No old glyph shows.",
      );
      assert.equal(
        await page.locator("#draft-view").getAttribute("data-mode"),
        "plate",
      );
      assert.match(await page.locator("#stage-note").innerText(), /plate/);
      await forward.unstub("export.status");
      await forward.release();
    },
  );

test(
  "the plate covers the old text and does not show it through",
  { timeout: 180000 },
  async (t) => {
    const { page, element, forward } = await prepared(
      t,
      "text-visual-plate-",
      1440,
      940,
      "1920x1080",
    );
    await forward.hold("preview.frame");
    const node = page.locator(`.stage-item[data-id="${element.id}"]`);
    const box = await node.boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(
      () => document.activeElement?.id === "draft-input",
    );
    await forward.held();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("NEW");
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const plate = await frame(page, "plate-1-blocked-frame");
    assert.equal(
      share(plate, white, [0.24, 0.42, 0.4, 0.58]),
      0,
      "No old glyph shows on the plate.",
    );
    assert.ok(share(plate, white, [0.4, 0.42, 0.6, 0.58]) > 0.02);
    await forward.release();
  },
);

test(
  "a fade, an opacity, and fullscreen stay coherent",
  { timeout: 180000 },
  async (t) => {
    const { root, app, page, call } = await launch(t, "text-visual-fade-");
    await setSize(app, 1440, 940);
    const video = await call("library.import", {
      path: makeVideo(root, "1280x720"),
      title: "Fade",
    });
    const { element } = await call("element.add", {
      id: video.id,
      type: "text",
      text: "Faded",
      start: 0,
      end: 4,
      x: 0.1,
      y: 0.3,
      width: 0.8,
      height: 0.4,
      size: 0.12,
      opacity: 0.5,
      background: "#FFFFFF",
      backgroundOpacity: 1,
      outline: "none",
    });
    await call("edit.configure", { id: video.id, fadeIn: 4 });
    const forward = await forwardCommands(app, root);
    await openEditor(page, call, video);
    await call("playback.seek", { seconds: 2 });
    await page.waitForFunction(
      () => !document.querySelector("#player").seeking,
    );
    await page.waitForTimeout(200);
    const exact = await frame(page, "fade-1-exact");
    await typeOnVideo(page, element, "Fade");
    const draft = await frame(page, "fade-2-draft");
    // A box corner far from the text: opacity and video fade together.
    const x = Math.round(draft.width * 0.12);
    const y = Math.round(draft.height * 0.32);
    assert.ok(
      close(draft.at(x, y), exact.at(x, y), 10),
      `Draft ${draft.at(x, y)}, exact ${exact.at(x, y)}.`,
    );

    await call("playback.fullscreen", { enabled: true });
    await page.waitForTimeout(400);
    const wide = await frame(page, "fade-3-fullscreen");
    const stage = await page.locator("#stage").boundingBox();
    const input = await page.locator("#draft-box").boundingBox();
    // The box follows the larger picture.
    assert.ok(Math.abs(input.x - stage.x - stage.width * 0.1) < 2);
    assert.ok(Math.abs(input.width - stage.width * 0.8) < 2);
    assert.ok(wide.width > draft.width);
    assert.ok(forward);
  },
);

test("the export has the saved text", { timeout: 240000 }, async (t) => {
  const { root, page, call, video, element } = await prepared(
    t,
    "text-visual-export-",
    1000,
    720,
    "1280x720",
  );
  await typeOnVideo(page, element, "Exported words");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");
  await page.keyboard.press("Control+Enter");
  await exactReady(page);
  const output = path.join(root, "edited.mp4");
  const job = await call("export.start", { id: video.id, path: output });
  await until(
    async () =>
      (await call("export.status", { jobId: job.id })).state === "complete",
    "The export did not finish.",
    120000,
  );

  // A control video with the expected text from the start, through the
  // same shared commands, and another with the old text.
  const control = async (text, name) => {
    const copy = await call("library.import", {
      path: path.join(root, "visual.mp4"),
      title: name,
    });
    await scene(call, copy);
    const list = await call("element.list", { id: copy.id });
    await call("element.update", {
      id: copy.id,
      elementId: list.elements[1].id,
      text,
    });
    const file = path.join(root, `${name}.mp4`);
    const started = await call("export.start", { id: copy.id, path: file });
    await until(
      async () =>
        (await call("export.status", { jobId: started.id })).state ===
        "complete",
      "The control export did not finish.",
      120000,
    );
    return file;
  };
  const same = await control("Exported words\nSecond line", "same");
  const old = await control("OLD WORDS HERE", "old");
  const difference = (a, b) => {
    const one = frameAt(a, 2, 1280, 720),
      two = frameAt(b, 2, 1280, 720);
    let total = 0;
    for (let i = 0; i < one.data.length; i++)
      total += Math.abs(one.data[i] - two.data[i]);
    return total / one.data.length;
  };
  assert.ok(
    difference(output, same) < 0.05,
    `Against the expected text: ${difference(output, same)}.`,
  );
  assert.ok(
    difference(output, old) > 0.5,
    `Against the old text: ${difference(output, old)}.`,
  );
});
