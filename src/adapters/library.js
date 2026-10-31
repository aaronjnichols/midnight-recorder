import {
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  rm,
  link,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createTimeline } from "../domain/timeline.js";

// Windows can refuse a rename for a short time while another program, for
// example a virus scanner, reads the new file. Try again for about 4
// seconds. Other errors fail at once.
async function replaceFile(renameFile, from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameFile(from, to);
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 12)
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50 * 2 ** attempt, 400)),
      );
    }
  }
}

export class Library {
  constructor(
    root,
    {
      removeFile = (file) => rm(file, { force: true }),
      rename: renameFile = rename,
    } = {},
  ) {
    this.root = root;
    this.index = path.join(root, "library.json");
    this.removeFile = removeFile;
    this.renameFile = renameFile;
  }
  async load() {
    try {
      return JSON.parse(await readFile(this.index, "utf8")).map((video) => ({
        ...video,
        url: pathToFileURL(video.path).href,
      }));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  async save(records) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.index + ".tmp", JSON.stringify(records, null, 2));
    await replaceFile(this.renameFile, this.index + ".tmp", this.index);
  }
  async list(query = "") {
    return (await this.load()).filter((v) =>
      v.title.toLowerCase().includes(query.toLowerCase()),
    );
  }
  async get(id) {
    const video = (await this.load()).find((v) => v.id === id);
    if (!video) throw new Error("Video was not found.");
    return video;
  }
  async import(
    source,
    metadata,
    title = path.basename(source, path.extname(source)),
  ) {
    const id = randomUUID();
    const timeline = createTimeline(metadata.duration);
    const target = path.join(this.root, "media", id + path.extname(source));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const video = {
      id,
      title,
      path: target,
      url: pathToFileURL(target).href,
      createdAt: new Date().toISOString(),
      metadata,
      timeline,
    };
    try {
      await this.save([video, ...(await this.load())]);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    return video;
  }
  async update(id, patch) {
    const records = await this.load();
    const index = records.findIndex((v) => v.id === id);
    if (index < 0) throw new Error("Video was not found.");
    records[index] = { ...records[index], ...patch };
    await this.save(records);
    return records[index];
  }
  async remove(id) {
    const video = await this.get(id);
    const backup = path.join(this.root, `${id}.delete-backup`);
    await link(video.path, backup).catch(() => copyFile(video.path, backup));
    try {
      await this.removeFile(video.path);
      try {
        await this.save((await this.load()).filter((v) => v.id !== id));
      } catch (error) {
        await rename(backup, video.path);
        throw error;
      }
    } finally {
      await rm(backup, { force: true }).catch(() => {});
    }
    return { deleted: id };
  }
}
