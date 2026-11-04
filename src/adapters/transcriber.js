// Local speech adapter.
import path from "node:path";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  mkdtemp,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export async function hashFile(file, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class LocalTranscriber {
  constructor(root, media, { runner } = {}) {
    this.root = path.join(root, "transcripts");
    this.media = media;
    this.runner = runner;
  }
  directory(id) {
    return path.join(this.root, digest(id));
  }
  capabilities() { return this.runner.capabilities(); }
  // The size and time of the source file. A word cut compares them with the
  // values from the start of its job.
  async fingerprint(video) {
    const { size, mtimeMs } = await stat(video.path);
    return { size, mtimeMs };
  }
  async remove(id) {
    await rm(this.directory(id), { recursive: true, force: true });
  }
  async prepare(video, options, { signal, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    if (!video.metadata.hasAudio)
      return {
        outcome: "no_audio",
        words: [],
        duration: video.metadata.duration,
        cached: false,
        options,
      };
    const directory = this.directory(video.id);
    await mkdir(directory, { recursive: true });
    const temporary = await mkdtemp(path.join(directory, "work-"));
    try {
      signal?.throwIfAborted();
      const identity = await this.runner.identity({ signal });
      signal?.throwIfAborted();
      onProgress({ phase: "audio" });
      const audio = path.join(temporary, "audio.wav");
      await this.media.extractAudio(video, audio, { signal });
      const audioSha256 = await hashFile(audio, signal);
      const key = digest({ audioSha256, identity, options }),
        cache = path.join(directory, key + ".json");
      try {
        return { ...JSON.parse(await readFile(cache, "utf8")), cached: true };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      onProgress({ phase: "speech" });
      const raw = await this.runner.transcribe(audio, options, {
        signal,
        onProgress,
      });
      if (
        !Array.isArray(raw.words) ||
        raw.words.some(
          (w) =>
            typeof w.word !== "string" ||
            w.word.length > 200 ||
            !Number.isFinite(w.start) ||
            !Number.isFinite(w.end) ||
            w.start < 0 ||
            w.end <= w.start ||
            w.end > video.metadata.duration + 0.1,
        )
      )
        throw new Error("The speech engine returned invalid word times.");
      const result = {
        ...raw,
        outcome: raw.words.length ? "ready" : "no_speech",
        duration: video.metadata.duration,
        audioSha256,
        identity,
        options,
        cached: false,
      };
      signal?.throwIfAborted();
      const pending = path.join(directory, randomUUID() + ".tmp");
      await writeFile(pending, JSON.stringify(result));
      await rename(pending, cache);
      return result;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
