import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceFile } from "./replace-file.js";

export class ShortcutStore {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "shortcuts.json");
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      if (error instanceof SyntaxError)
        throw new Error(
          "The keyboard shortcut settings are invalid. Restore defaults.",
        );
      throw error;
    }
  }

  async save(overrides) {
    await mkdir(this.root, { recursive: true });
    const temp = this.file + ".tmp";
    await writeFile(temp, JSON.stringify(overrides, null, 2));
    await replaceFile(temp, this.file);
  }
}
