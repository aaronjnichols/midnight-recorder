import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/application/service.js";
import { recordedSeconds } from "../src/domain/recording.js";

function fixture({ failImport = false } = {}) {
  let time = Date.parse("2026-10-31T12:00:00.000Z");
  const tasks = [];
  const pushed = [];
  const state = { failImport };
  const service = new Service({
    now: () => time,
    scheduler: {
      setTimeout: (fn) => tasks.push(fn),
      clearTimeout: () => {},
    },
    recordingFeedback: {
      prepare: async () => {},
      update: (recording) => pushed.push(recording),
    },
    capture: {
      start: async () => {},
      pause: async () => {},
      resume: async () => {},
      stop: async () => "pending.webm",
      cancel: async () => {},
    },
    media: { probe: async () => ({ duration: 1 }) },
    library: {
      import: async () => {
        if (state.failImport) throw new Error("Import failed");
        return { id: "saved" };
      },
    },
  });
  const status = async () => (await service.execute("app.status")).recording;
  const tick = async () => {
    tasks.shift()();
    await service.queue;
  };
  return {
    service,
    pushed,
    state,
    status,
    tick,
    advance: (seconds) => (time += seconds * 1000),
    now: () => time,
  };
}

test("the service keeps recorded time through pauses for a reloaded page or agent", async () => {
  const { service, pushed, status, advance, now } = fixture();
  const started = await service.execute("recording.start", {
    cameraOnly: true,
  });
  assert.equal(started.state, "recording");
  assert.equal(started.pausedSeconds, 0);
  assert.equal(Date.parse(started.startedAt), now());
  advance(10);
  await service.execute("recording.pause");
  advance(50);

  // A page that loads during the pause reads only the shared state.
  let current = await status();
  assert.equal(current.state, "paused");
  assert.equal(current.recordedSeconds, 10);
  assert.equal(recordedSeconds(current, now()), 10);
  assert.equal(recordedSeconds(pushed.at(-1), now()), 10);

  await service.execute("recording.resume");
  advance(5);
  // A page that loads after the resume must not count the earlier pause.
  current = await status();
  assert.equal(current.state, "recording");
  assert.equal(current.pausedSeconds, 50);
  assert.equal(current.pausedAt, undefined);
  assert.equal(current.recordedSeconds, 15);
  assert.equal(recordedSeconds(pushed.at(-1), now()), 15);

  await service.execute("recording.pause");
  advance(20);
  await service.execute("recording.resume");
  advance(1);
  current = await status();
  assert.equal(current.pausedSeconds, 70);
  assert.equal(current.recordedSeconds, 16);

  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.deepEqual(await status(), { state: "idle" });
});

test("failure and stop keep the recorded time fixed, and countdown starts at zero", async () => {
  const { service, state, status, tick, advance, now } = fixture({
    failImport: true,
  });
  await service.execute("recording.countdown", { cameraOnly: true });
  advance(3);
  assert.equal((await status()).recordedSeconds, undefined);
  await tick();
  await tick();
  await tick();
  let current = await status();
  assert.equal(current.state, "recording");
  assert.equal(current.pausedSeconds, 0);
  assert.equal(current.recordedSeconds, 0);

  advance(4);
  await service.execute("recording.pause");
  advance(6);
  await service.execute("recording.fail", {
    recordingId: current.id,
    error: "Disk full",
  });
  advance(100);
  current = await status();
  assert.equal(current.state, "failed");
  assert.equal(current.recordedSeconds, 4);
  await service.execute("recording.cancel");
  assert.deepEqual(await status(), { state: "idle" });

  const second = await service.execute("recording.start", {
    cameraOnly: true,
  });
  advance(7);
  await service.execute("recording.fail", {
    recordingId: second.id,
    error: "Disk full",
  });
  advance(30);
  assert.equal((await status()).recordedSeconds, 7);
  await service.execute("recording.cancel");

  await service.execute("recording.start", { cameraOnly: true });
  advance(8);
  await assert.rejects(service.execute("recording.stop"), /Import failed/);
  advance(60);
  current = await status();
  assert.equal(current.state, "stopped");
  assert.equal(Date.parse(current.stoppedAt), now() - 60000);
  assert.equal(current.recordedSeconds, 8);
  state.failImport = false;
  assert.equal((await service.execute("recording.stop")).id, "saved");
  assert.deepEqual(await status(), { state: "idle" });
});

test("recorded seconds exclude pauses and need a start time", () => {
  const start = "2026-10-31T12:00:00.000Z";
  const at = (seconds) => Date.parse(start) + seconds * 1000;
  const iso = (seconds) => new Date(at(seconds)).toISOString();
  assert.equal(recordedSeconds({ state: "idle" }, at(5)), 0);
  assert.equal(recordedSeconds({ state: "starting", id: "r" }, at(5)), 0);
  assert.equal(
    recordedSeconds({ state: "recording", startedAt: start }, at(2.5)),
    2.5,
  );
  const paused = {
    state: "paused",
    startedAt: start,
    pausedSeconds: 3,
    pausedAt: iso(13),
  };
  assert.equal(recordedSeconds(paused, at(99)), 10);
  assert.equal(
    recordedSeconds(
      { ...paused, state: "stopped", stoppedAt: iso(50) },
      at(99),
    ),
    10,
  );
  assert.equal(
    recordedSeconds(
      {
        state: "stopped",
        startedAt: start,
        pausedSeconds: 3,
        stoppedAt: iso(20),
      },
      at(99),
    ),
    17,
  );
});
