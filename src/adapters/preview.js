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
  // Short names keep preview paths below the 260-character Windows limit
  // that Chromium playback needs: 16 hex characters for the folder and 32
  // (128 bits) for the file.
  directory(id) {
    return path.join(this.root, this.#hash(id).slice(0, 16));
  }
  #hash(text) {
    return createHash("sha256").update(text).digest("hex");
  }
  async remove(id) {
    await rm(this.directory(id), { recursive: true, force: true });
    // Folder name from before short names.
    await rm(path.join(this.root, this.#hash(id)), {
      recursive: true,
      force: true,
    });
  }
  prepare(video) {
    const {
      segments,
      speed,
      muted,
      elements = [],
      fadeIn = 0,
      fadeOut = 0,
      captions = null,
    } = video.timeline;
    // Render version 3 has the exact 30 fps output clock, so previews from
    // older renders are not used again. Elements and the overlay renderer
    // version are part of the key, so a cached preview cannot hide changed
    // elements. Overlay version 2 draws shapes, arrows, and fades. Video
    // fades are in the key when they are set, so a video without fades keeps
    // its key. Captions and the caption renderer version are in the key when
    // the video has captions.
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
          ...(elements.length ? { overlayVersion: 2, elements } : {}),
          ...(fadeIn || fadeOut ? { fadeIn, fadeOut } : {}),
          ...(captions ? { captionVersion: 1, captions } : {}),
        }),
      )
      .digest("hex");
    if (this.pending.has(key)) return this.pending.get(key);
    const output = path.join(
      this.directory(video.id),
      key.slice(0, 32) + ".mp4",
    );
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
