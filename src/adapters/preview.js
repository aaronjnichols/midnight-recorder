import path from "node:path";
import { stat, rm, mkdir, mkdtemp, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { draftFramePlan, draftFrameIndex } from "../domain/draft-frame.js";
import { draftBaseRevision } from "../domain/inspection.js";
import { FRAME_RATE } from "./media.js";

// Limits of draft frames. A draft frame shows in the editor window, so a large
// source does not need a full-size image.
const FRAME_LIMITS = {
  longEdge: 1920,
  bytes: 16 * 1024 * 1024,
  deadlineMs: 20000,
  pending: 4,
  cached: 6,
};
// A new value here makes new draft frames after a renderer change.
const FRAME_VERSION = 1;

// The size of a draft image: the frame, or less if its long edge is over the
// limit. Both sides stay even.
function imageSize({ width, height }) {
  const scale = Math.min(1, FRAME_LIMITS.longEdge / Math.max(width, height));
  const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return scale === 1
    ? { width, height }
    : { width: even(width), height: even(height) };
}

export class PreviewCache {
  constructor(root, media, { frameDeadlineMs = FRAME_LIMITS.deadlineMs } = {}) {
    this.root = path.join(root, "previews");
    this.media = media;
    this.pending = new Map();
    this.frameDeadlineMs = frameDeadlineMs;
    // Draft frame work in progress, by key. Callers of one key share it.
    this.frameWork = new Map();
    // Finished draft frames of each video, oldest first, and the cleanup that
    // comes before them.
    this.frameStores = new Map();
    // Increases when a video is removed, so late work can see it.
    this.removals = new Map();
    // The finished metadata read of each source file.
    this.frameInfo = new Map();
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
    this.removals.set(id, (this.removals.get(id) ?? 0) + 1);
    this.frameStores.delete(id);
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
  // The images of one draft frame around one element. A change to the element
  // itself makes no new images, so typing never renders. The exact preview and
  // the export do not use these images.
  //
  // This part has no await: a delete after this line counts for this request,
  // and the limit applies before any metadata read. Callers of one key share
  // the work, and nothing cancels it, so a stale page cannot stop a reader.
  async frame(video, { elementId, seconds }) {
    const removal = this.removals.get(video.id) ?? 0;
    const frameIndex = draftFrameIndex(video.timeline, seconds, FRAME_RATE);
    const key = this.#hash(
      JSON.stringify({
        version: FRAME_VERSION,
        id: video.id,
        path: video.path,
        metadata: video.metadata,
        baseRevision: draftBaseRevision(video, elementId),
        frameIndex,
        elementId,
      }),
    ).slice(0, 32);
    if (this.frameWork.has(key)) return this.frameWork.get(key);
    if (this.frameWork.size >= FRAME_LIMITS.pending)
      throw new Error("Too many frame requests. Wait, then try again.");
    const work = this.#withDeadline((signal) =>
      this.#readFrame(video, { elementId, seconds, key }, removal, signal),
    );
    this.frameWork.set(key, work);
    work.finally(() => this.frameWork.delete(key)).catch(() => {});
    return work;
  }
  // The deadline covers all of the work, also a read that does not stop.
  #withDeadline(action) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("The draft frame took too long. Try again."));
      }, this.frameDeadlineMs);
    });
    return Promise.race([action(controller.signal), expired]).finally(() =>
      clearTimeout(timer),
    );
  }
  // A library source file does not change, so one finished read is enough.
  // Reads in progress are not shared, so one deadline cannot stop another.
  async #renderInfo(video, signal) {
    const known = this.frameInfo.get(video.path);
    if (known) return known;
    const info = await this.media.renderInfo(video.path, { signal });
    this.frameInfo.set(video.path, info);
    return info;
  }
  // Frames from an earlier run are not in the store. All work of a video waits
  // for this one cleanup, so it cannot delete a new work folder.
  #frameStore(id) {
    if (!this.frameStores.has(id))
      this.frameStores.set(id, {
        entries: new Map(),
        ready: rm(path.join(this.directory(id), "frames"), {
          recursive: true,
          force: true,
        }).catch(() => {}),
      });
    return this.frameStores.get(id);
  }
  async #readFrame(video, { elementId, seconds, key }, removal, signal) {
    const { id } = video;
    const removed = () => (this.removals.get(id) ?? 0) !== removal;
    const check = () => {
      if (removed()) throw new Error("The video was deleted.");
    };
    try {
      const { frame, displayColor } = await this.#renderInfo(video, signal);
      check();
      const source = await stat(video.path);
      check();
      const plan = draftFramePlan(
        video.timeline,
        frame,
        elementId,
        seconds,
        FRAME_RATE,
      );
      const name = this.#hash(
        JSON.stringify([key, source.size, source.mtimeMs]),
      ).slice(0, 32);
      const store = this.#frameStore(id);
      await store.ready;
      check();
      const image = imageSize(frame);
      const files =
        store.entries.get(name) ??
        (await this.#renderFrame(
          video,
          { plan, frame, image, displayColor },
          { name, store, check },
          signal,
        ));
      return {
        seconds: plan.seconds,
        frameIndex: plan.frameIndex,
        elementId,
        baseRevision: draftBaseRevision(video, elementId),
        frame,
        image,
        displayColor,
        fadeOpacity: plan.fadeOpacity,
        ...files,
      };
    } catch (error) {
      // A delete removes the work folder, so FFmpeg can fail for that reason.
      if (removed()) throw new Error("The video was deleted.");
      throw error;
    } finally {
      // A delete during the work can come after the folder was made.
      if (removed())
        await rm(this.directory(id), { recursive: true, force: true });
    }
  }
  async #renderFrame(video, request, { name, store, check }, signal) {
    const folder = path.join(this.directory(video.id), "frames");
    await mkdir(folder, { recursive: true });
    check();
    const temporary = await mkdtemp(path.join(folder, ".work-"));
    const names = {
      under: path.join(temporary, "under.png"),
      over: request.plan.above.length ? path.join(temporary, "over.png") : null,
    };
    try {
      await this.media.draftFrame(video, request, names, { signal });
      check();
      for (const file of Object.values(names))
        if (file && (await stat(file)).size > FRAME_LIMITS.bytes)
          throw new Error("The draft frame is too large.");
      // Both images have new names in the same folder, so a reader never
      // finds one image without the other. The result lists a file only
      // after its rename.
      const published = (image) => path.join(folder, `${name}-${image}.png`);
      if (names.over) await rename(names.over, published("over"));
      await rename(names.under, published("under"));
      const link = (file) => ({ path: file, url: pathToFileURL(file).href });
      const files = {
        under: link(published("under")),
        over: names.over ? link(published("over")) : null,
      };
      this.#keepFrame(store, name, files);
      return files;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
  #keepFrame({ entries }, name, files) {
    entries.set(name, files);
    while (entries.size > FRAME_LIMITS.cached) {
      const [oldest, old] = entries.entries().next().value;
      entries.delete(oldest);
      for (const file of [old.under, old.over])
        if (file) rm(file.path, { force: true }).catch(() => {});
    }
  }
}
