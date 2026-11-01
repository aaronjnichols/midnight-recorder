import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Service, commands } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";

// A speech adapter that the test controls. Each prepare call waits until
// the test finishes it, so the test can change the video during recognition.
function speech({ available = true } = {}) {
  const calls = [];
  return {
    calls,
    capabilities: async () =>
      available
        ? { available: true }
        : {
            available: false,
            reason: "No runtime.",
            setup: "npm run setup:transcription",
          },
    prepare: (video, options, { signal, onProgress }) =>
      new Promise((resolve, reject) => {
        onProgress({ phase: "speech", completedRegions: 1, totalRegions: 4 });
        calls.push({ video, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("Cancelled.")));
      }),
  };
}
const sentence = (i, at, gap = 0) => ({
  word: ` Sentence${i}.`,
  start: at,
  end: at + 0.6,
  probability: 0.9,
  segmentId: i + gap,
});
const result = (words, extra = {}) => ({
  outcome: words.length ? "ready" : "no_speech",
  words,
  duration: 60,
  cached: false,
  identity: { model: "test" },
  audioSha256: "abc",
  ...extra,
});

async function setup(options = {}) {
  await mkdir(".local/claude-editing", { recursive: true });
  const root = await mkdtemp(
    path.resolve(".local/claude-editing", "caption-service-"),
  );
  const file = path.join(root, "input.webm");
  await writeFile(file, "video");
  const transcription = speech(options);
  const seconds = options.duration ?? 60;
  const service = new Service({
    library: new Library(path.join(root, "data")),
    media: {
      probe: async () => ({
        duration: seconds,
        width: 1280,
        height: 720,
        hasAudio: true,
      }),
    },
    transcription,
  });
  const video = await service.execute("library.import", { path: file });
  return { service, video, transcription };
}
async function settle(service, jobId, states) {
  for (let i = 0; i < 200; i++) {
    const status = await service.execute("captions.status", { jobId });
    if (states.includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`The caption job did not reach ${states}.`);
}
const stored = async (service, id) =>
  (await service.execute("library.get", { id })).timeline;

test("caption commands are shared commands with documented limits", async () => {
  const names = commands.map((c) => c.name);
  for (const name of [
    "captions.generate",
    "captions.status",
    "captions.cancel",
    "captions.draft",
    "captions.apply",
    "captions.list",
    "captions.update",
    "captions.add",
    "captions.delete",
    "captions.configure",
    "captions.remove",
    "library.revision",
  ])
    assert.ok(names.includes(name), name);
  const list = commands.find((c) => c.name === "captions.list").inputSchema;
  assert.equal(list.properties.limit.maximum, 200);
  const { service, video } = await setup({ available: false });
  await assert.rejects(
    service.execute("captions.generate", { id: video.id }),
    /speech recognition is not set up.*npm run setup:transcription/i,
  );
  assert.equal((await stored(service, video.id)).past.length, 0);
});

test("generated captions apply as one undo step and keep labels and shapes", async () => {
  const { service, video, transcription } = await setup();
  await service.execute("element.add", {
    id: video.id,
    type: "rectangle",
    start: 0,
    end: 5,
  });
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  const running = await service.execute("captions.status", {
    jobId: job.jobId,
  });
  assert.equal(running.state, "running");
  assert.match(running.message, /part 1 of 4/);
  const before = (await stored(service, video.id)).past.length;
  transcription.calls[0].resolve(
    result([0, 2, 4, 6].map((at, i) => sentence(i, at))),
  );
  const done = await settle(service, job.jobId, ["applied", "failed"]);
  assert.equal(done.state, "applied", done.error);
  assert.equal(done.applied.added, 4);
  const timeline = await stored(service, video.id);
  assert.equal(timeline.past.length, before + 1, "One undo step.");
  assert.equal(timeline.captions.cues.length, 4);
  assert.equal(timeline.elements.length, 1, "The shape stays.");
  const list = await service.execute("captions.list", { id: video.id });
  assert.deepEqual(
    list.cues.map((c) => c.text),
    ["Sentence0.", "Sentence1.", "Sentence2.", "Sentence3."],
  );
  assert.equal(list.revision.length, 16);
  await service.execute("edit.undo", { id: video.id });
  assert.equal((await stored(service, video.id)).captions, null);
  assert.equal((await stored(service, video.id)).elements.length, 1);
  await service.execute("edit.redo", { id: video.id });
  assert.equal((await stored(service, video.id)).captions.cues.length, 4);
  // Replacing is deliberate, and the check runs before recognition.
  await assert.rejects(
    service.execute("captions.generate", { id: video.id }),
    /has captions.*replace/,
  );
  assert.equal(transcription.calls.length, 1);
  // A style change does not run speech again.
  await service.execute("captions.configure", {
    id: video.id,
    size: 0.05,
    enabled: false,
  });
  assert.equal(transcription.calls.length, 1);
  const again = await service.execute("captions.generate", {
    id: video.id,
    replace: true,
    apply: true,
  });
  transcription.calls[1].resolve(result([sentence(0, 1), sentence(1, 3)]));
  const replaced = await settle(service, again.jobId, ["applied", "failed"]);
  assert.equal(replaced.state, "applied", replaced.error);
  assert.deepEqual([replaced.applied.added, replaced.applied.removed], [2, 4]);
  const kept = await stored(service, video.id);
  assert.equal(kept.captions.cues.length, 2);
  assert.equal(kept.captions.style.size, 0.05, "The style stays.");
  assert.equal(kept.captions.enabled, false);
  assert.equal(kept.elements.length, 1);
});

test("an edit during recognition keeps a draft, and apply uses the current edits", async () => {
  const { service, video, transcription } = await setup();
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  // During recognition: add a label, and cut source 10 to 20.
  await service.execute("element.add", {
    id: video.id,
    type: "text",
    text: "Label",
    start: 0,
    end: 2,
  });
  await service.execute("edit.cut", { id: video.id, start: 10, end: 20 });
  const words = [0, 5, 12, 15, 25, 30].map((at, i) => sentence(i, at));
  transcription.calls[0].resolve(result(words));
  const status = await settle(service, job.jobId, [
    "draft",
    "applied",
    "failed",
  ]);
  assert.equal(status.state, "draft", "The changed video gets a draft.");
  assert.match(status.message, /changed/);
  // A video without captions has no captions key, or null after an undo.
  assert.equal((await stored(service, video.id)).captions ?? null, null);
  const draft = await service.execute("captions.draft", {
    jobId: job.jobId,
    limit: 2,
  });
  // Words in the cut part are not in the draft.
  assert.equal(draft.count, 4);
  // A normal draft with several cues fits. Its check uses unique IDs.
  assert.equal(draft.fits, true, draft.reason);
  assert.equal(draft.cues.length, 2);
  assert.equal(draft.nextOffset, 2);
  assert.deepEqual(
    draft.cues.map((c) => c.text),
    ["Sentence0.", "Sentence1."],
  );
  // A different edit after the draft read makes the revision stale.
  await service.execute("element.add", {
    id: video.id,
    type: "arrow",
    start: 0,
    end: 2,
  });
  await assert.rejects(
    service.execute("captions.apply", {
      jobId: job.jobId,
      revision: draft.revision,
    }),
    /changed/,
  );
  const fresh = await service.execute("captions.draft", { jobId: job.jobId });
  const applied = await service.execute("captions.apply", {
    jobId: job.jobId,
    revision: fresh.revision,
  });
  assert.equal(applied.added, 4);
  const timeline = await stored(service, video.id);
  assert.equal(timeline.elements.length, 2, "Edits during recognition stay.");
  assert.equal(timeline.segments.length, 2, "The cut stays.");
  assert.deepEqual(
    timeline.captions.cues.map((c) => c.text),
    ["Sentence0.", "Sentence1.", "Sentence4.", "Sentence5."],
  );
  // Apply once only.
  await assert.rejects(
    service.execute("captions.apply", { jobId: job.jobId }),
    /already/,
  );
});

test("a caption correction during recognition is not overwritten", async () => {
  const { service, video, transcription } = await setup();
  const first = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[0].resolve(result([sentence(0, 1), sentence(1, 4)]));
  await settle(service, first.jobId, ["applied"]);
  const [cue] = (await service.execute("captions.list", { id: video.id })).cues;
  const second = await service.execute("captions.generate", {
    id: video.id,
    replace: true,
    apply: true,
  });
  await service.execute("captions.update", {
    id: video.id,
    cueId: cue.id,
    text: "Fixed.",
  });
  transcription.calls[1].resolve(result([sentence(0, 1), sentence(1, 4)]));
  assert.equal(
    (await settle(service, second.jobId, ["draft", "applied"])).state,
    "draft",
  );
  assert.equal(
    (await service.execute("captions.list", { id: video.id })).cues[0].text,
    "Fixed.",
  );
});

test("no audio, no speech, cancel, and failure do not change the video", async () => {
  const { service, video, transcription } = await setup();
  const before = await stored(service, video.id);
  const silent = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[0].resolve(result([], { outcome: "no_speech" }));
  const none = await settle(service, silent.jobId, ["no_speech"]);
  assert.match(none.message, /No speech/);
  const mute = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[1].resolve(result([], { outcome: "no_audio" }));
  assert.match(
    (await settle(service, mute.jobId, ["no_audio"])).message,
    /no sound/i,
  );
  const stopped = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  await service.execute("captions.cancel", { jobId: stopped.jobId });
  assert.match(
    (await settle(service, stopped.jobId, ["cancelled"])).message,
    /cancelled/i,
  );
  const broken = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[3].reject(new Error("Decoder failed"));
  const failed = await settle(service, broken.jobId, ["failed"]);
  assert.match(failed.error, /Decoder failed/);
  assert.deepEqual(await stored(service, video.id), before);
  await assert.rejects(
    service.execute("captions.apply", { jobId: silent.jobId }),
    /No speech/,
  );
});

test("capacity and the complete word list are checked before any change", async () => {
  const { service, video, transcription } = await setup({ duration: 300 });
  // 600 short sentences, one each 0.4 seconds. Each cue can show for 0.4
  // seconds, longer than the shortest generated cue, so none join.
  const words = Array.from({ length: 600 }, (_, i) => ({
    word: ` w${i}.`,
    start: i * 0.4,
    end: i * 0.4 + 0.3,
    probability: 0.9,
    segmentId: i,
  }));
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[0].resolve(result(words));
  const failed = await settle(service, job.jobId, ["failed"]);
  assert.match(
    failed.error,
    /600 captions.*at most 500.*shorter range, for example from 0 to 200 seconds/,
  );
  assert.equal((await stored(service, video.id)).captions ?? null, null);
  // All of the words are used, not one 500-word read window.
  const draft = await service.execute("captions.draft", {
    jobId: job.jobId,
    limit: 1,
  });
  assert.equal(draft.words, 600);
  assert.equal(draft.count, 600);
  assert.equal(draft.fits, false);
  const ranged = await service.execute("captions.generate", {
    id: video.id,
    start: 0,
    end: 160,
    apply: true,
  });
  transcription.calls[1].resolve(result(words));
  const done = await settle(service, ranged.jobId, ["applied", "failed"]);
  assert.equal(done.state, "applied", done.error);
  assert.equal(done.applied.added, 400);
  // Cues 375 to 399 start from 150 to 159.6 seconds.
  const page = await service.execute("captions.list", {
    id: video.id,
    start: 150,
    end: 160,
  });
  assert.equal(page.matches, 25);
  assert.ok(page.cues.every((c) => c.end <= 160 + 1e-9));
});

test("cue corrections and track commands return summaries, not the transcript", async () => {
  const { service, video, transcription } = await setup();
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[0].resolve(
    result([sentence(0, 1), sentence(1, 4), sentence(2, 8)]),
  );
  await settle(service, job.jobId, ["applied"]);
  const [a, b] = (await service.execute("captions.list", { id: video.id }))
    .cues;
  const updated = await service.execute("captions.update", {
    id: video.id,
    cueId: a.id,
    text: "Corrected.",
    end: 2,
  });
  assert.equal(updated.cue.text, "Corrected.");
  assert.equal(updated.cue.end, 2);
  assert.equal(updated.video, undefined);
  assert.equal(updated.captions.count, 3);
  assert.equal(typeof updated.revision, "string");
  const added = await service.execute("captions.add", {
    id: video.id,
    text: "Added.",
    start: 6,
    end: 7,
  });
  assert.equal(added.captions.count, 4);
  await assert.rejects(
    service.execute("captions.update", {
      id: video.id,
      cueId: b.id,
      start: 0.5,
    }),
    /overlaps/,
  );
  const deleted = await service.execute("captions.delete", {
    id: video.id,
    cueId: b.id,
  });
  assert.equal(deleted.deleted, b.id);
  const styled = await service.execute("captions.configure", {
    id: video.id,
    background: "#000000",
    backgroundOpacity: 0.7,
  });
  assert.equal(styled.captions.style.background, "#000000");
  const revision = await service.execute("library.revision", { id: video.id });
  assert.equal(revision.revision, styled.revision);
  // A small poll result: the history size shows a change to Undo and Redo.
  const timeline = await stored(service, video.id);
  assert.deepEqual(revision.history, {
    undo: timeline.past.length,
    redo: timeline.future.length,
  });
  assert.equal(revision.timeline, undefined);
  const removed = await service.execute("captions.remove", { id: video.id });
  assert.equal(removed.removed, 3);
  assert.equal(
    (await service.execute("captions.list", { id: video.id })).exists,
    false,
  );
  await service.execute("edit.undo", { id: video.id });
  assert.equal(
    (await service.execute("captions.list", { id: video.id })).count,
    3,
  );
});

test("review 10: kept speech that cannot show is reported, not silently omitted", async () => {
  const { service, video, transcription } = await setup();
  // Keep source 0 to 0.02 and 1 to 60.
  await service.execute("edit.cut", { id: video.id, start: 0.02, end: 1 });
  const job = await service.execute("captions.generate", { id: video.id });
  transcription.calls[0].resolve(
    result([
      { word: " Early.", start: 0, end: 0.01, probability: 0.9, segmentId: 0 },
      { word: " Gone.", start: 0.5, end: 0.6, probability: 0.9, segmentId: 1 },
      { word: " Later.", start: 1, end: 1.5, probability: 0.9, segmentId: 2 },
    ]),
  );
  await settle(service, job.jobId, ["draft"]);
  const draft = await service.execute("captions.draft", { jobId: job.jobId });
  assert.deepEqual(
    draft.cues.map((c) => c.text),
    ["Later."],
  );
  assert.equal(draft.droppedWords, 1, "Gone. is in the cut part.");
  assert.equal(draft.skippedWords, 1, "Early. is kept but cannot show.");
  assert.equal(draft.shortenedCues, 0);
  assert.match(
    draft.warning,
    /1 word is in the edited video but too short.*not in the captions/,
  );
  const applied = await service.execute("captions.apply", { jobId: job.jobId });
  assert.equal(applied.skippedWords, 1);
  assert.match(applied.warning, /not in the captions/);
  const status = await service.execute("captions.status", { jobId: job.jobId });
  assert.equal(status.state, "applied");
  assert.equal(status.applied.skippedWords, 1);
  assert.equal(status.warning, applied.warning);
  assert.match(
    status.message,
    /^Added 1 caption\. 1 word is in the edited video but too short/,
  );
  // Without omissions there is no warning.
  const clean = await setup();
  const plain = await clean.service.execute("captions.generate", {
    id: clean.video.id,
    apply: true,
  });
  clean.transcription.calls[0].resolve(result([sentence(0, 1)]));
  const done = await settle(clean.service, plain.jobId, ["applied"]);
  assert.equal(done.warning, null);
  assert.equal(done.applied.skippedWords, 0);
});

test("review 12: kept speech that is all too short is reported, not called no speech", async () => {
  const { service, video, transcription } = await setup();
  await service.execute("edit.trim", { id: video.id, start: 0, end: 0.02 });
  const before = await stored(service, video.id);
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[0].resolve(
    result([
      { word: " Early.", start: 0, end: 0.01, probability: 0.9, segmentId: 0 },
    ]),
  );
  const status = await settle(service, job.jobId, [
    "no_speech",
    "applied",
    "failed",
    "draft",
  ]);
  assert.equal(status.state, "no_speech", "No captions were made.");
  assert.equal(status.skippedWords, 1);
  assert.match(status.warning, /1 word is in the edited video but too short/);
  assert.match(
    status.message,
    /^Speech was recognized, but 1 word is too short to show.*no captions\. Nothing changed\./,
  );
  assert.doesNotMatch(status.message, /No speech/);
  assert.deepEqual(await stored(service, video.id), before);
  await assert.rejects(
    service.execute("captions.apply", { jobId: job.jobId }),
    /Speech was recognized, but 1 word is too short.*Nothing changed/,
  );
  // Real absence of speech keeps its own message and no counts.
  const silent = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  transcription.calls[1].resolve(result([], { outcome: "no_speech" }));
  const none = await settle(service, silent.jobId, ["no_speech"]);
  assert.match(none.message, /^No speech was found/);
  assert.equal(none.skippedWords, null);
  assert.equal(none.warning, null);
});

// Holds the service queue until the returned function runs. Commands and
// background work wait behind it in order.
function holdQueue(service) {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const held = service.enqueue(() => gate);
  return async () => {
    open();
    await held;
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("review 5: a cancel before a queued automatic apply stops the apply", async () => {
  const { service, video, transcription } = await setup();
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  const release = holdQueue(service);
  const cancel = service.execute("captions.cancel", { jobId: job.jobId });
  // Recognition is complete now. The automatic apply waits behind the cancel.
  transcription.calls[0].resolve(result([sentence(0, 1), sentence(1, 4)]));
  await tick();
  await release();
  assert.equal((await cancel).state, "cancelled");
  await service.enqueue(() => {});
  const status = await service.execute("captions.status", { jobId: job.jobId });
  assert.equal(status.state, "cancelled");
  assert.match(status.message, /cancelled.*Nothing changed/);
  const timeline = await stored(service, video.id);
  assert.equal(timeline.captions ?? null, null);
  assert.equal(timeline.past.length, 0);
  await assert.rejects(
    service.execute("captions.apply", { jobId: job.jobId }),
    /cancelled/,
  );
});

test("review 5: a cancel after the apply does not claim success", async () => {
  const { service, video, transcription } = await setup();
  const job = await service.execute("captions.generate", {
    id: video.id,
    apply: true,
  });
  const release = holdQueue(service);
  transcription.calls[0].resolve(result([sentence(0, 1), sentence(1, 4)]));
  await tick();
  // The automatic apply is first in the queue, then the cancel.
  const cancel = service.execute("captions.cancel", { jobId: job.jobId });
  await release();
  await assert.rejects(cancel, /already added.*Undo/);
  const status = await service.execute("captions.status", { jobId: job.jobId });
  assert.equal(status.state, "applied");
  assert.equal((await stored(service, video.id)).captions.cues.length, 2);
});

test("review 6: a range without kept speech keeps the existing captions", async () => {
  const { service, video, transcription } = await setup();
  await service.execute("captions.add", {
    id: video.id,
    text: "Keep me",
    start: 5,
    end: 6,
  });
  const before = await stored(service, video.id);
  const job = await service.execute("captions.generate", {
    id: video.id,
    start: 5,
    end: 6,
    replace: true,
    apply: true,
  });
  // Speech only at source 1 to 2, outside the range.
  const elsewhere = [
    { word: " Elsewhere.", start: 1, end: 2, probability: 0.9, segmentId: 0 },
  ];
  transcription.calls[0].resolve(result(elsewhere));
  const states = ["no_speech", "applied", "failed", "draft"];
  const status = await settle(service, job.jobId, states);
  assert.equal(status.state, "no_speech");
  assert.match(status.message, /No speech.*range.*Nothing changed/);
  assert.deepEqual(await stored(service, video.id), before);
  await assert.rejects(
    service.execute("captions.apply", { jobId: job.jobId }),
    /No speech/,
  );
  // All speech is in a part that the edit removed: no change either.
  await service.execute("edit.cut", { id: video.id, start: 0.5, end: 2.5 });
  const cutBefore = await stored(service, video.id);
  const whole = await service.execute("captions.generate", {
    id: video.id,
    replace: true,
    apply: true,
  });
  transcription.calls[1].resolve(result(elsewhere));
  assert.equal((await settle(service, whole.jobId, states)).state, "no_speech");
  assert.deepEqual(await stored(service, video.id), cutBefore);
  // A job without automatic apply reports the same on apply.
  const manual = await service.execute("captions.generate", {
    id: video.id,
    replace: true,
  });
  transcription.calls[2].resolve(result(elsewhere));
  await settle(service, manual.jobId, ["draft", "no_speech"]);
  await assert.rejects(
    service.execute("captions.apply", { jobId: manual.jobId }),
    /No speech.*Nothing changed/,
  );
  assert.deepEqual(await stored(service, video.id), cutBefore);
});
