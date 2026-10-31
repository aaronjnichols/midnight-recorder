import { mkdir, readFile, writeFile, rename, copyFile, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTimeline } from '../domain/timeline.js';

export class Library {
  constructor(root, { removeFile = file => rm(file, { force: true }) } = {}) { this.root = root; this.index = path.join(root, 'library.json'); this.removeFile = removeFile; }
  async load() {
    try { return JSON.parse(await readFile(this.index, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async save(records) {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.index + '.tmp', JSON.stringify(records, null, 2));
    await rename(this.index + '.tmp', this.index);
  }
  async list(query = '') {
    return (await this.load()).filter(v => v.title.toLowerCase().includes(query.toLowerCase()));
  }
  async get(id) {
    const video = (await this.load()).find(v => v.id === id);
    if (!video) throw new Error('Video was not found.');
    return video;
  }
  async import(source, metadata, title = path.basename(source, path.extname(source))) {
    const id = randomUUID();
    const target = path.join(this.root, 'media', id + path.extname(source));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    const video = { id, title, path: target, createdAt: new Date().toISOString(), metadata, timeline: createTimeline(metadata.duration) };
    await this.save([video, ...await this.load()]);
    return video;
  }
  async update(id, patch) {
    const records = await this.load();
    const index = records.findIndex(v => v.id === id);
    if (index < 0) throw new Error('Video was not found.');
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
      try { await this.save((await this.load()).filter(v => v.id !== id)); }
      catch (error) { await rename(backup, video.path); throw error; }
    } finally { await rm(backup, { force: true }).catch(() => {}); }
    return { deleted: id };
  }
}
