import { test } from "node:test";
import assert from "node:assert/strict";
import { createInspectionSource } from "../test-support/inspection-fixture.js";
import { launch, openEditor, until } from "../test-support/electron.js";

test(
  "shortcut settings capture keys, report conflicts, and restore defaults",
  { timeout: 60000 },
  async (t) => {
    const { page, call } = await launch(t, "shortcut-settings-");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const search = dialog.getByRole("button", { name: /Search the library/ });
    await page
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    await search.click();
    await page.keyboard.press("Shift+G");
    await until(
      async () => (await search.textContent()).includes("Shift+G"),
      "The new binding did not appear.",
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.keyboard.press("/");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((node) => node === document.activeElement),
      false,
    );
    assert.equal(
      await page.locator(".search-field kbd").textContent(),
      "Shift+G",
    );
    await page.keyboard.press("Shift+G");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((node) => node === document.activeElement),
      true,
    );

    await call("shortcuts.set", { action: "search", key: "B" });
    await until(
      () =>
        page
          .locator("#search")
          .getAttribute("aria-keyshortcuts")
          .then((key) => key === "B"),
      "The page did not pick up the shared command update.",
    );
    await page
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    const split = dialog.getByRole("button", { name: /Split at the playhead/ });
    await split.click();
    await page.keyboard.press("Control+r");
    await until(
      async () => (await dialog.innerText()).includes("reserved"),
      "The reserved key did not show an error.",
    );
    await page.keyboard.press("I");
    await until(
      async () => (await dialog.innerText()).includes("already uses"),
      "The conflict did not appear.",
    );
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    await dialog.getByRole("button", { name: "Restore defaults" }).click();
    await until(
      async () => (await search.textContent()).includes("Ctrl+F"),
      "The default binding did not return.",
    );
    assert.deepEqual((await call("shortcuts.list")).overrides, {});
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page.keyboard.press("/");
    assert.equal(
      await page
        .locator("#search")
        .evaluate((node) => node === document.activeElement),
      true,
    );
  },
);

test(
  "an editor binding controls the real edit after the dialog closes",
  { timeout: 60000 },
  async (t) => {
    const { root, page, call } = await launch(t, "shortcut-editor-");
    const video = await call("library.import", {
      path: await createInspectionSource(root),
    });
    await openEditor(page, call, video);
    await page.getByRole("tab", { name: "Details" }).click();
    await page
      .getByRole("button", { name: "Keyboard shortcuts", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const split = dialog.getByRole("button", { name: /Split at the playhead/ });
    await split.click();
    await page.keyboard.press("B");
    await until(
      async () => (await split.textContent()) === "B",
      "The new split binding did not appear.",
    );
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await call("playback.seek", { seconds: 2 });
    assert.equal(
      await page.locator("#split").getAttribute("aria-keyshortcuts"),
      "B",
    );
    await until(
      async () =>
        /\(B\)$/.test(await page.locator("#split").getAttribute("title")),
      "The split tooltip did not show the new binding.",
    );
    await page.keyboard.press("s");
    assert.equal((await call("parts.list", { id: video.id })).parts.length, 1);
    await page.keyboard.press("b");
    await until(
      async () =>
        (await call("parts.list", { id: video.id })).parts.length === 2,
      "The new key did not split the video.",
    );
    assert.equal(
      (await call("library.get", { id: video.id })).timeline.past.length,
      1,
    );
  },
);
