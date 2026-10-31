import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as adapter from "../src/adapters/transcriber.js";

test("local transcriber caches source audio and keeps edit changes out of recognition", async () => {
  assert.equal(typeof adapter.LocalTranscriber, "function");
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "transcriber-test-"));
  const source = path.join(root, "source.mp4");
  await writeFile(source, "source");
  let calls = 0;
  const runner = {
    identity: async () => ({ engine: "test", fingerprint: "one" }),
    transcribe: async (audio, options) => {
      calls++;
      return {
        words: [
          {
            word: "Hello",
            start: 0.2,
            end: 0.6,
            probability: 0.9,
            segmentId: 0,
          },
        ],
      };
    },
  };
  const media = {
    extractAudio: async (video, file) => writeFile(file, "pcm audio"),
  };
  const engine = new adapter.LocalTranscriber(root, media, { runner });
  const video = {
    id: "test",
    path: source,
    metadata: { hasAudio: true, duration: 2 },
  };
  const result = await engine.prepare(video, {
    language: "en",
    vocabulary: [],
  });
  assert.equal(result.outcome, "ready");
  assert.equal(result.cached, false);
  const cached = await engine.prepare(
    { ...video, timeline: { speed: 2 } },
    { language: "en", vocabulary: [] },
  );
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);
  await engine.prepare(video, { language: "en", vocabulary: ["Midnight"] });
  assert.equal(calls, 2);
  await engine.remove(video.id);
  assert.deepEqual(
    await readdir(engine.directory(video.id)).catch((e) =>
      e.code === "ENOENT" ? [] : Promise.reject(e),
    ),
    [],
  );
});

test("cancel reaches engine startup before audio extraction", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "transcriber-cancel-"));
  const control = new AbortController();
  let reached;
  const started = new Promise((resolve) => {
    reached = resolve;
  });
  const runner = {
    identity: async ({ signal } = {}) => {
      reached();
      await new Promise((resolve, reject) => {
        if (!signal)
          return setTimeout(() => reject(Error("Missing startup signal")), 20);
        signal.addEventListener(
          "abort",
          () => reject(Error("Startup aborted")),
          { once: true },
        );
      });
    },
  };
  const engine = new adapter.LocalTranscriber(root, {}, { runner });
  const task = engine.prepare(
    { id: "test", metadata: { hasAudio: true, duration: 5 } },
    { language: "en", vocabulary: [] },
    { signal: control.signal },
  );
  await started;
  control.abort();
  await assert.rejects(task, /Startup aborted/);
});

test("no audio, silence, cancellation, and invalid words do not create false transcripts", async () => {
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local", "transcriber-fail-"));
  let calls = 0;
  const runner = {
    identity: async () => ({ fingerprint: "one" }),
    transcribe: async () => {
      calls++;
      return { words: [] };
    },
  };
  const media = { extractAudio: async (v, f) => writeFile(f, "silence") };
  const engine = new adapter.LocalTranscriber(root, media, { runner });
  const noAudio = await engine.prepare(
    { id: "none", metadata: { hasAudio: false, duration: 5 } },
    { language: "en", vocabulary: [] },
  );
  assert.equal(noAudio.outcome, "no_audio");
  assert.equal(calls, 0);
  const video = { id: "silence", metadata: { hasAudio: true, duration: 5 } };
  assert.equal(
    (await engine.prepare(video, { language: "en", vocabulary: [] })).outcome,
    "no_speech",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    engine.prepare(
      video,
      { language: "en", vocabulary: [] },
      { signal: controller.signal },
    ),
    /abort/i,
  );
  runner.transcribe = async () => ({
    words: [{ word: "bad", start: NaN, end: 2 }],
  });
  await assert.rejects(
    engine.prepare(video, { language: "en", vocabulary: ["different"] }),
    /word/i,
  );
  assert.equal(
    (await readdir(engine.directory(video.id))).filter((f) =>
      f.startsWith("work-"),
    ).length,
    0,
  );
});
