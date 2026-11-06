import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Service } from "../src/application/service.js";
import { ShortcutStore } from "../src/adapters/shortcut-store.js";
import { shortcut } from "../src/ui/view-model.js";

test("a replacement changes only the selected action and respects text focus", () => {
  const context = {
    view: "editor",
    ready: true,
    shortcutOverrides: { split: "Control+Shift+B" },
  };
  const press = { key: "B", ctrlKey: true, shiftKey: true };
  assert.deepEqual(shortcut(press, context), { local: "split" });
  assert.equal(shortcut({ ...press, shiftKey: false }, context), null);
  assert.equal(shortcut({ key: "s" }, context), null);
  assert.equal(
    shortcut({ ...press, target: { tagName: "TEXTAREA" } }, context),
    null,
  );
  assert.equal(shortcut(press, { ...context, dialog: true }), null);
  assert.equal(shortcut(press, { ...context, view: "library" }), null);
  assert.deepEqual(shortcut({ key: "i" }, context), { local: "range-start" });
});

test("custom shortcuts persist and reset without saving conflicting or reserved keys", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "midnight-shortcuts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const open = () => new Service({ shortcutStore: new ShortcutStore(root) });
  const service = open();
  const bind = (action, key) =>
    service.execute("shortcuts.set", { action, key });
  const splitKeys = ({ actions }) =>
    actions.find(({ id }) => id === "split").keys;

  assert.deepEqual(splitKeys(await service.execute("shortcuts.list")), ["S"]);
  await assert.rejects(bind("split", "I"), /Set selection start/);
  await assert.rejects(bind("split", "Escape"), /reserved/i);
  await assert.rejects(bind("split", "Control+R"), /reserved/i);
  await assert.rejects(bind("split", "Control+M"), /reserved/i);
  assert.deepEqual(splitKeys(await bind("split", "Control+Shift+B")), [
    "Control+Shift+B",
  ]);
  assert.deepEqual(
    await service.execute("app.status").then((s) => s.shortcutOverrides),
    {
      split: "Control+Shift+B",
    },
  );
  await Promise.all([bind("search", "I"), bind("range-start", "J")]);
  await assert.rejects(bind("split", "J"), /Set selection start/);

  const reopened = open();
  assert.deepEqual((await reopened.execute("shortcuts.list")).overrides, {
    split: "Control+Shift+B",
    search: "I",
    "range-start": "J",
  });
  assert.deepEqual(splitKeys(await reopened.execute("shortcuts.reset")), ["S"]);
  assert.deepEqual((await open().execute("shortcuts.list")).overrides, {});
});

test("a failed preference write leaves the current keys in use", async () => {
  const shortcutStore = {
    load: async () => ({ split: "B" }),
    save: async () => {
      throw new Error("Disk full");
    },
  };
  const service = new Service({ shortcutStore });
  await assert.rejects(
    service.execute("shortcuts.set", { action: "split", key: "C" }),
    /Disk full/,
  );
  assert.deepEqual((await service.execute("shortcuts.list")).overrides, {
    split: "B",
  });
});

test("reset can replace a damaged shortcut file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "midnight-shortcuts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "shortcuts.json"), "{");
  const service = new Service({ shortcutStore: new ShortcutStore(root) });
  await assert.rejects(service.execute("shortcuts.list"));
  await writeFile(path.join(root, "shortcuts.json"), '{"split":42}');
  await assert.rejects(
    service.execute("shortcuts.list"),
    /settings are invalid/,
  );
  assert.deepEqual((await service.execute("shortcuts.reset")).overrides, {});
});
