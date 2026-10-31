import path from "node:path";
import { stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export class PreviewCache {
  constructor(root, media) {
    this.root = path.join(root, "previews");
    this.media = media;
    this.pending = new Map();
  }
  directory(id) {
    return path.join(this.root, createHash("sha256").update(id).digest("hex"));
  }
  async remove(id) {
    await rm(this.directory(id), { recursive: true, force: true });
  }
  prepare(video) {
    const { segments, speed, muted, elements = [] } = video.timeline;
    // Render version 3 has the exact 30 fps output clock, so previews from
    // older renders are not used again. Elements and the overlay renderer
    // version are part of the key, so a cached preview cannot hide changed
    // elements.
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          renderVersion: 3,
          id: video.id,
          path: video.path,
          metadata: video.metadata,
          segments,
          speed,
          muted,
          ...(elements.length ? { overlayVersion: 1, elements } : {}),
        }),
      )
      .digest("hex");
    if (this.pending.has(key)) return this.pending.get(key);
    const output = path.join(this.directory(video.id), key + ".mp4");
    const work = (async () => {
      let metadata;
      try {
        await stat(output);
        metadata = await this.media.probe(output);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        metadata = (await this.media.export(video, output)).metadata;
      }
      return { path: output, url: pathToFileURL(output).href, metadata };
    })();
    this.pending.set(key, work);
    work.finally(() => this.pending.delete(key)).catch(() => {});
    return work;
  }
}
