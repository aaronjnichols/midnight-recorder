// Helpers for Electron UI tests. Each test uses its own data folder.
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";

export async function launch(t, prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/claude-editing", prefix));
  const app = await _electron.launch({
    args: ["."],
    env: { ...process.env, MIDNIGHT_DATA: root },
  });
  t.after(async () => {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  });
  const page =
    app.windows().find((p) => p.url().endsWith("/ui/index.html")) ||
    (await app.waitForEvent("window", {
      predicate: async (p) => {
        await p.waitForLoadState();
        return p.url().endsWith("/ui/index.html");
      },
    }));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "No page errors."));
  const call = (name, args = {}) =>
    page.evaluate(([n, a]) => window.midnight.execute(n, a), [name, args]);
  return { root, app, page, call };
}

export const setSize = (app, width, height) =>
  app.evaluate(
    ({ BrowserWindow }, [w, h]) =>
      BrowserWindow.getAllWindows()
        .find((x) => x.webContents.getURL().endsWith("/ui/index.html"))
        .setSize(w, h),
    [width, height],
  );

// Bounded wait for a state. It does not assume a device or render time.
export async function until(check, message, limit = 60000) {
  const end = Date.now() + limit;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function openEditor(page, call, video) {
  await call("playback.open", { id: video.id });
  await page.waitForSelector("#editor:not([hidden])");
  await until(
    async () => (await call("playback.status")).ready,
    "The preview did not become ready.",
    120000,
  );
}

// Page commands go to the app service through its local agent server, the
// same service and queue. A rule holds one matching reply until the test
// releases it, so the test can change the page before a late reply arrives.
// This needs no change to the app.
export async function forwardCommands(app, root) {
  const connection = JSON.parse(
    await readFile(path.join(root, "connection.json"), "utf8"),
  );
  await app.evaluate(({ ipcMain }, { port, token }) => {
    globalThis.holdRule = null;
    globalThis.commandLog = [];
    globalThis.stubs = {};
    ipcMain.removeHandler("command");
    ipcMain.handle("command", async (_, command, args) => {
      globalThis.commandLog.push({ command, args });
      // A stub replaces the service for one command, for example the
      // speech capability. { error } is a rejected command.
      if (command in globalThis.stubs) {
        const stub = globalThis.stubs[command];
        if (stub?.error) throw new Error(stub.error);
        return stub;
      }
      const response = await fetch(`http://127.0.0.1:${port}/command`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command, args }),
      });
      const body = await response.json();
      const rule = globalThis.holdRule;
      if (
        rule &&
        !rule.held &&
        rule.command === command &&
        (!rule.state || body.result?.state === rule.state)
      ) {
        rule.held = true;
        rule.result = body.result;
        await new Promise((resolve) => (rule.release = resolve));
      }
      if (!response.ok) throw new Error(body.error);
      return body.result;
    });
  }, connection);
  return {
    // Hold the next reply of a command, optionally with a result state.
    hold: (command, state) =>
      app.evaluate((_, rule) => (globalThis.holdRule = rule), {
        command,
        state,
      }),
    held: () =>
      until(
        () => app.evaluate(() => globalThis.holdRule?.held === true),
        "The reply was not held.",
        120000,
      ),
    heldResult: () => app.evaluate(() => globalThis.holdRule?.result),
    stub: (command, result) =>
      app.evaluate(
        (_, [name, value]) => (globalThis.stubs[name] = value),
        [command, result],
      ),
    // Page and test commands with their arguments, in order.
    log: (command) =>
      app.evaluate(
        (_, name) => globalThis.commandLog.filter((c) => c.command === name),
        command,
      ),
    release: () =>
      app.evaluate(() => {
        const rule = globalThis.holdRule;
        globalThis.holdRule = null;
        rule?.release?.();
      }),
  };
}

// Shared command results, read directly.
export const captionList = (call, id) =>
  call("captions.list", { id, limit: 200 });
