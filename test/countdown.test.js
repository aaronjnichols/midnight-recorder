import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/application/service.js";

function fixture({ failStart = false } = {}) {
  const tasks = new Map();
  const events = [];
  let next = 0;
  const service = new Service({
    scheduler: {
      setTimeout(fn, ms) {
        assert.equal(ms, 1000);
        tasks.set(++next, fn);
        return next;
      },
      clearTimeout(id) {
        tasks.delete(id);
      },
    },
    recordingFeedback: {
      prepare: async () => events.push("prepare"),
      update: (state) =>
        events.push(
          state.state === "countdown" ? state.remaining : state.state,
        ),
    },
    capture: {
      start: async () => {
        events.push("capture");
        if (failStart) throw new Error("Camera unavailable");
      },
      cancel: async () => events.push("cancel"),
      pause: async () => events.push("pause"),
      resume: async () => events.push("resume"),
      stop: async () => "pending.webm",
    },
    media: { probe: async () => ({ duration: 1 }) },
    library: { import: async () => ({ id: "saved" }) },
  });
  const tick = async () => {
    assert.equal(tasks.size, 1);
    const [id, fn] = tasks.entries().next().value;
    tasks.delete(id);
    fn();
    await service.queue;
  };
  return { service, events, tasks, tick };
}

test("countdown shows three full seconds before capture starts", async () => {
  const { service, events, tick } = fixture();
  const first = await service.execute("recording.countdown", {
    cameraOnly: true,
  });
  assert.equal(first.state, "countdown");
  assert.equal(first.remaining, 3);
  assert.deepEqual(events, ["prepare", 3]);
  await assert.rejects(
    service.execute("recording.start", { cameraOnly: true }),
    /active/,
  );
  await assert.rejects(service.execute("recording.stop"), /countdown/);
  await assert.rejects(service.execute("recording.pause"), /countdown/);
  for (const remaining of [2, 1]) {
    await tick();
    assert.equal(
      (await service.execute("app.status")).recording.remaining,
      remaining,
    );
    assert.ok(!events.includes("capture"));
  }
  await tick();
  const started = (await service.execute("app.status")).recording;
  assert.equal(started.id, first.id);
  assert.equal(started.state, "recording");
  assert.equal(started.remaining, undefined);
  assert.deepEqual(events, [
    "prepare",
    3,
    2,
    1,
    "starting",
    "capture",
    "recording",
  ]);
  await service.execute("recording.pause");
  await service.execute("recording.resume");
  await service.execute("recording.stop");
  assert.deepEqual(events.slice(-6), [
    "paused",
    "resume",
    "recording",
    "stopped",
    "cancel",
    "idle",
  ]);
});

test("cancel removes the countdown and a stale timer cannot start capture", async () => {
  const { service, events, tasks, tick } = fixture();
  await service.execute("recording.countdown", { cameraOnly: true });
  const stale = [...tasks.values()][0];
  await service.execute("recording.cancel");
  assert.equal(tasks.size, 0);
  assert.deepEqual((await service.execute("app.status")).recording, {
    state: "idle",
  });
  await service.execute("recording.countdown", { cameraOnly: true });
  stale();
  await service.queue;
  assert.equal(service.recording.remaining, 3);
  await tick();
  await service.execute("recording.cancel");
  assert.ok(!events.includes("capture"));
  assert.ok(!events.includes("cancel"));
});

test("a failed start after countdown removes feedback and reports the error", async () => {
  const { service, events, tick } = fixture({ failStart: true });
  await service.execute("recording.countdown", { cameraOnly: true });
  await tick();
  await tick();
  await tick();
  assert.equal(service.recording.state, "idle");
  assert.equal(service.recording.error, "Camera unavailable");
  assert.equal(events.at(-1), "idle");
});

test("immediate start remains available and failed capture removes feedback", async () => {
  const { service, events } = fixture();
  const recording = await service.execute("recording.start", {
    cameraOnly: true,
  });
  assert.equal(recording.state, "recording");
  await service.execute("recording.fail", {
    recordingId: recording.id,
    error: "Disk full",
  });
  assert.deepEqual(events.slice(-2), ["failed", "pause"]);
  await service.execute("recording.cancel");
  assert.equal(events.at(-1), "idle");
});
