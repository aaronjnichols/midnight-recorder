// The first key is the primary default. The other keys are default aliases.
const action = (id, label, keys, scope = "editor") => ({
  id,
  label,
  keys,
  scope,
});
export const shortcutActions = [
  action("search", "Search the library", ["/", "Control+F"], "library"),
  action("play", "Play or pause", ["Space", "K"]),
  action("seek-back", "Move back 5 seconds", ["ArrowLeft"]),
  action("seek-forward", "Move forward 5 seconds", ["ArrowRight"]),
  action("seek-back-small", "Move back 1 second", ["Shift+ArrowLeft"]),
  action("seek-forward-small", "Move forward 1 second", ["Shift+ArrowRight"]),
  action("range-start", "Set selection start", ["I"]),
  action("range-end", "Set selection end", ["O"]),
  action("split", "Split at the playhead", ["S"]),
  action("zoom-in", "Zoom in", ["Plus", "="]),
  action("zoom-out", "Zoom out", ["-"]),
  action("zoom-fit", "Fit the timeline", ["0"]),
  action("undo", "Undo", ["Control+Z"]),
  action("redo", "Redo", ["Control+Shift+Z", "Control+Y"]),
  action("fullscreen", "Fullscreen", ["F"]),
  action("delete-element", "Delete the selected element or caption", [
    "Delete",
    "Backspace",
  ]),
  action("edit-text", "Edit selected text on the video", ["F2"]),
];

const punctuation = new Set(Array.from("!@#$%^&*()_-=.,/?<>:;'\"[]{}|\\~`"));
const keys =
  /^(?:[A-Z0-9]|Space|Plus|ArrowLeft|ArrowRight|Delete|Backspace|F2|F8|F9)$/;
// These Ctrl combinations are used by system, window, or clipboard controls.
const reservedControl = new Set([
  "A",
  "C",
  "V",
  "X",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "T",
  "W",
  "0",
  "-",
  "=",
  "Plus",
  "Space",
  "Backspace",
  "Delete",
]);

export function shortcutKey(event) {
  if (event.altKey || event.isComposing) return null;
  const key =
    event.key === " "
      ? "Space"
      : event.key === "+"
        ? "Plus"
        : /^[a-z]$/i.test(event.key)
          ? event.key.toUpperCase()
          : event.key;
  if (!keys.test(key) && !punctuation.has(key)) return null;
  const control = event.ctrlKey || event.metaKey;
  // On many keyboards Shift is necessary to type a symbol such as Plus.
  const shift = event.shiftKey && key !== "Plus" && !punctuation.has(key);
  return (control ? "Control+" : "") + (shift ? "Shift+" : "") + key;
}

export function shortcutKeys(action, overrides = {}) {
  const key = overrides[action.id];
  return key ? [key] : action.keys;
}

function validateShortcut(overrides, id, key) {
  const selected = shortcutActions.find((item) => item.id === id);
  if (!selected) throw new Error("Select a shortcut action.");
  if (typeof key !== "string") throw new Error("A shortcut must be a string.");
  const name = key.split("+").at(-1);
  const control = key.startsWith("Control+");
  const shift = /^(?:Control\+)?Shift\+/.test(key);
  if (
    !/^(?:Control\+)?(?:Shift\+)?[^+]+$/.test(key) ||
    (!keys.test(name) && !punctuation.has(name)) ||
    (shift && (name === "Plus" || punctuation.has(name))) ||
    (control && reservedControl.has(name)) ||
    (control && shift && ["I", "J"].includes(name))
  )
    throw new Error(
      "This key combination is reserved or unavailable. Try another key.",
    );

  const conflict = shortcutActions.find(
    (item) =>
      item.id !== id &&
      item.scope === selected.scope &&
      shortcutKeys(item, overrides).includes(key),
  );
  if (conflict) throw new Error(`${conflict.label} already uses this key.`);
}

export function setShortcut(overrides, id, key) {
  validateShortcut(overrides, id, key);
  return { ...overrides, [id]: key };
}

export function validateShortcutOverrides(overrides) {
  try {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      throw new Error("Expected shortcut settings.");
    for (const [id, key] of Object.entries(overrides)) {
      validateShortcut(overrides, id, key);
    }
  } catch {
    throw new Error(
      "The keyboard shortcut settings are invalid. Restore defaults.",
    );
  }
  return overrides;
}

export function shortcutSettings(overrides) {
  return {
    overrides,
    actions: shortcutActions.map((item) => ({
      ...item,
      keys: shortcutKeys(item, overrides),
    })),
  };
}
