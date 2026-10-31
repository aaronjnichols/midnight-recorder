import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../src/adapters/library.js";

test("import copies source, saves edits, and loads records after restart", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "library # 100%-"));
  const source = path.join(root, "input.webm");
  await writeFile(source, "original");
  const library = new Library(path.join(root, "data"));
  const video = await library.import(
    source,
    { duration: 10, hasAudio: true, width: 640, height: 360 },
    "Demo",
  );
  assert.notEqual(video.path, source);
  assert.equal(fileURLToPath(video.url), video.path);
  assert.equal(await readFile(video.path, "utf8"), "original");
  await library.update(video.id, { title: "New title" });
  const reopened = new Library(path.join(root, "data"));
  assert.equal((await reopened.get(video.id)).title, "New title");
  assert.equal((await reopened.list("title")).length, 1);
  await reopened.remove(video.id);
  assert.equal((await reopened.list()).length, 0);
  assert.equal(await readFile(source, "utf8"), "original");
});

test("a failed import removes its incomplete library copy", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "import-error-"));
  const source = path.join(root, "input.webm");
  await writeFile(source, "video");
  const library = new Library(path.join(root, "data"));
  await mkdir(path.join(root, "data", "library.json"), { recursive: true });
  await assert.rejects(() => library.import(source, { duration: 2 }));
  assert.deepEqual(await readdir(path.join(root, "data", "media")), []);
});

test("a refused file deletion keeps the record available for retry", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "delete-"));
  const source = path.join(root, "input.webm");
  await writeFile(source, "video");
  const library = new Library(path.join(root, "data"), {
    removeFile: async () => {
      throw new Error("File is locked");
    },
  });
  const video = await library.import(source, { duration: 2 });
  await assert.rejects(() => library.remove(video.id), /locked/);
  assert.equal((await library.get(video.id)).id, video.id);
  assert.equal(await readFile(video.path, "utf8"), "video");
});
