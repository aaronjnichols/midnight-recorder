import {
  shortcutActions,
  shortcutKey,
  shortcutKeys,
} from "../domain/shortcuts.js";
import { readableError } from "./view-model.js";

const displayKey = (key) =>
  key
    .replace("Control+", "Ctrl+")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace(/Plus$/, "+");

export function createShortcutSettings(dialog, call, onChange) {
  const list = dialog.querySelector("#shortcut-list");
  const status = dialog.querySelector("#shortcut-status");
  const reset = dialog.querySelector("#reset-shortcuts");
  const rows = new Map();
  let overrides = {},
    serialized,
    capture,
    busy = false;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("shortcut-error", error);
  }

  function render() {
    for (const [item, button] of rows) {
      const keys = shortcutKeys(item, overrides).map(displayKey).join(" / ");
      button.textContent = capture === item ? "Press keys…" : keys;
      button.setAttribute("aria-label", `${item.label}, ${button.textContent}`);
    }
  }

  function sync(next) {
    if (!next) return;
    const data = JSON.stringify(next);
    if (data === serialized) return;
    serialized = data;
    overrides = next;
    render();
    for (const node of document.querySelectorAll("[data-shortcut]")) {
      const actions = node.dataset.shortcut
        .split(" ")
        .map((id) => shortcutActions.find((item) => item.id === id));
      const keys = actions.flatMap((item) => shortcutKeys(item, overrides));
      node.setAttribute("aria-keyshortcuts", keys.join(" "));
      const badge =
        node.querySelector("kbd") ??
        (node.nextElementSibling?.matches("kbd")
          ? node.nextElementSibling
          : null);
      if (badge) {
        badge.textContent = displayKey(keys[0]);
        badge.toggleAttribute("data-long-key", badge.textContent.length > 2);
        if (node.classList.contains("dock-mark"))
          badge.hidden = badge.textContent.length > 4;
      }
      if (node.dataset.shortcutTitle)
        node.title = `${node.dataset.shortcutTitle} (${keys.map(displayKey).join(" / ")})`;
    }
    onChange();
  }

  function cancelCapture() {
    capture = null;
    render();
    message("");
  }

  for (const scope of ["library", "editor"]) {
    const heading = document.createElement("h3");
    heading.textContent = scope === "library" ? "Library" : "Video editor";
    list.append(heading);
    for (const item of shortcutActions.filter(
      (action) => action.scope === scope,
    )) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const label = document.createElement("span");
      label.textContent = item.label;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary shortcut-key";
      button.addEventListener("click", () => {
        if (busy) return;
        capture = item;
        render();
        message("Press a key combination. Press Esc to cancel.");
      });
      rows.set(item, button);
      row.append(label, button);
      list.append(row);
    }
  }

  async function change(command, args, success) {
    busy = true;
    reset.disabled = true;
    try {
      const result = await call(command, args);
      capture = null;
      sync(result.overrides);
      render();
      message(success);
    } catch (error) {
      message(readableError(error.message), true);
    } finally {
      busy = false;
      reset.disabled = false;
    }
  }

  dialog.addEventListener("keydown", (event) => {
    if (!capture || event.target !== rows.get(capture)) return;
    if (event.key === "Tab") {
      cancelCapture();
      return;
    }
    event.preventDefault();
    if (busy || event.repeat || event.isComposing) return;
    if (event.key === "Escape") return cancelCapture();
    if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
    const key = shortcutKey(event);
    if (!key)
      return message(
        "This key combination is reserved or unavailable. Try another key.",
        true,
      );
    void change(
      "shortcuts.set",
      { action: capture.id, key },
      "Shortcut saved.",
    );
  });
  dialog.addEventListener("focusout", (event) => {
    if (capture && event.target === rows.get(capture) && !busy) cancelCapture();
  });
  dialog.addEventListener("close", cancelCapture);
  reset.addEventListener("click", () =>
    change("shortcuts.reset", {}, "Default shortcuts restored."),
  );

  for (const button of document.querySelectorAll("[data-open-shortcuts]")) {
    button.addEventListener("click", async () => {
      dialog.showModal();
      try {
        const result = await call("shortcuts.list");
        sync(result.overrides);
      } catch (error) {
        message(readableError(error.message), true);
      }
    });
  }

  return {
    sync,
    overrides: () => overrides,
    label(id, title) {
      const item = shortcutActions.find((action) => action.id === id);
      return `${title} (${shortcutKeys(item, overrides).map(displayKey).join(" / ")})`;
    },
  };
}
