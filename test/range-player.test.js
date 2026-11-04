// Play selection: it stops at the end of the range, and it never moves the
// playhead after the user or another video took over. These tests run the real
// controller with a fake video element and held command replies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRangePlayer } from "../src/ui/range-player.js";

globalThis.requestAnimationFrame ??= (callback) => setTimeout(callback, 1);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// Each fixture ends its play, so no frame timer stays after a test.
function fixture(t) {
  const player = new EventTarget();
  player.currentTime = 0;
  const log = [];
  const held = new Map();
  const call = (name, args = {}) => {
    log.push([name, args.seconds]);
    if (name === "playback.seek") {
      player.currentTime = args.seconds;
      player.dispatchEvent(new Event("seeking"));
    }
    if (name === "playback.pause") player.dispatchEvent(new Event("pause"));
    const gate = held.get(name);
    return gate ? gate.promise : Promise.resolve({});
  };
  const hold = (name) => {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    held.set(name, { promise });
    return () => {
      held.delete(name);
      release({});
    };
  };
  const changes = [];
  const range = createRangePlayer({
    player,
    call,
    onChange: (active) => changes.push(active),
  });
  t.after(() => range.stop());
  const seekManually = (seconds) => {
    player.currentTime = seconds;
    player.dispatchEvent(new Event("seeking"));
  };
  return { player, log, hold, range, changes, seekManually };
}

test("it plays the range, pauses at the end, and shows the exact end", async (t) => {
  const { player, log, range, changes } = fixture(t);
  await range.play(1, 2);
  assert.deepEqual(log, [
    ["playback.seek", 1],
    ["playback.play", undefined],
  ]);
  assert.equal(range.active(), true);
  player.currentTime = 1.5;
  await tick();
  assert.equal(log.length, 2, "Not at the end yet.");
  player.currentTime = 2.01;
  await tick();
  assert.deepEqual(log.slice(2), [
    ["playback.pause", undefined],
    ["playback.seek", 2],
  ]);
  assert.equal(range.active(), false);
  assert.deepEqual(changes, [true, false]);
});

test("a stop during the final pause cancels the final seek", async (t) => {
  const { player, log, hold, range } = fixture(t);
  await range.play(1, 2);
  const release = hold("playback.pause");
  player.currentTime = 2.01;
  await tick();
  assert.equal(log.at(-1)[0], "playback.pause");
  // Another video opened. The old end must not seek it.
  range.stop();
  release();
  await tick();
  assert.equal(
    log.filter(([name]) => name === "playback.seek").length,
    1,
    "Only the first seek.",
  );
});

test("a manual seek during the final pause cancels the final seek", async (t) => {
  const { player, log, hold, range, seekManually } = fixture(t);
  await range.play(1, 2);
  const release = hold("playback.pause");
  player.currentTime = 2.01;
  await tick();
  seekManually(8);
  release();
  await tick();
  assert.equal(log.filter(([name]) => name === "playback.seek").length, 1);
  assert.equal(player.currentTime, 8);
});

test("a new play during the final pause keeps only the new range", async (t) => {
  const { player, log, hold, range } = fixture(t);
  await range.play(1, 2);
  const release = hold("playback.pause");
  player.currentTime = 2.01;
  await tick();
  await range.play(5, 6);
  release();
  await tick();
  assert.deepEqual(
    log.filter(([name]) => name === "playback.seek"),
    [
      ["playback.seek", 1],
      ["playback.seek", 5],
    ],
  );
});

test("the user Stop pauses the video, and a cancel does not", async (t) => {
  const stopped = fixture(t);
  await stopped.range.play(1, 2);
  await stopped.range.halt();
  assert.equal(stopped.log.at(-1)[0], "playback.pause");
  assert.equal(stopped.range.active(), false);
  stopped.player.currentTime = 3;
  await tick();
  assert.equal(
    stopped.log.filter(([name]) => name === "playback.pause").length,
    1,
    "One pause.",
  );

  const cancelled = fixture(t);
  await cancelled.range.play(1, 2);
  cancelled.range.stop();
  assert.equal(cancelled.range.active(), false);
  assert.equal(cancelled.log.at(-1)[0], "playback.play", "No pause.");
});

test("a manual seek during the first seek cancels the play", async (t) => {
  const { log, hold, range, seekManually, changes } = fixture(t);
  const release = hold("playback.seek");
  const started = range.play(1, 2);
  await tick();
  seekManually(8);
  assert.equal(range.active(), false, "The manual seek ends it.");
  release();
  await started;
  assert.equal(
    log.filter(([name]) => name === "playback.play").length,
    0,
    "No play after the manual seek.",
  );
  assert.deepEqual(changes, [true, false]);
});

test("a manual pause or seek during playback ends the watch", async (t) => {
  const paused = fixture(t);
  await paused.range.play(1, 2);
  paused.player.dispatchEvent(new Event("pause"));
  assert.equal(paused.range.active(), false);
  paused.player.currentTime = 3;
  await tick();
  assert.equal(paused.log.length, 2, "No command after the manual pause.");

  const moved = fixture(t);
  await moved.range.play(1, 2);
  moved.seekManually(9);
  assert.equal(moved.range.active(), false);
  await tick();
  assert.equal(moved.log.length, 2, "No command after the manual seek.");
});

test("a seek back to the start or near it is a manual seek", async (t) => {
  for (const time of [1, 1.01, 0.995]) {
    const { player, log, range, seekManually } = fixture(t);
    await range.play(1, 2);
    player.currentTime = 1.7;
    await tick();
    seekManually(time);
    assert.equal(range.active(), false, `${time}: the play ended.`);
    player.currentTime = 3;
    await tick();
    assert.equal(log.length, 2, `${time}: no command after it.`);
  }
});

test("a manual seek to the start during the first seek cancels the play", async (t) => {
  for (const time of [1, 1.01]) {
    const { log, hold, range, seekManually } = fixture(t);
    const release = hold("playback.seek");
    const started = range.play(1, 2);
    await tick();
    seekManually(time);
    assert.equal(range.active(), false, `${time}: the play ended.`);
    release();
    await started;
    assert.equal(
      log.filter(([name]) => name === "playback.play").length,
      0,
      `${time}: no play.`,
    );
  }
});

test("its own final seek is not a manual seek", async (t) => {
  const { player, log, range, changes } = fixture(t);
  await range.play(1, 2);
  player.currentTime = 2.01;
  await tick();
  assert.equal(log.at(-1)[1], 2);
  assert.deepEqual(changes, [true, false], "One end, not a second cancel.");
});

test("its own seek does not cancel it", async (t) => {
  const { range, log } = fixture(t);
  await range.play(1.25, 2);
  assert.equal(range.active(), true);
  assert.equal(log.at(-1)[0], "playback.play");
  range.stop();
});

test("a rejected command ends the play and reaches the caller", async (t) => {
  const { range, player } = fixture(t);
  const failing = createRangePlayer({
    player,
    call: () => Promise.reject(new Error("The preview is not ready.")),
  });
  await assert.rejects(failing.play(1, 2), /not ready/);
  assert.equal(failing.active(), false);
  assert.equal(range.active(), false);
});
