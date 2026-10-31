import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, trim, duration, undo, redo } from '../src/domain/timeline.js';
import * as timeline from '../src/domain/timeline.js';

test('trim keeps source times and undo restores the previous edit', () => {
  const original = createTimeline(20);
  const edited = trim(original, 3, 15);
  assert.deepEqual(edited.segments, [{ start: 3, end: 15 }]);
  assert.equal(duration(edited), 12);
  assert.deepEqual(undo(edited).segments, original.segments);
  assert.deepEqual(redo(undo(edited)).segments, edited.segments);
  assert.deepEqual(original.segments, [{ start: 0, end: 20 }]);
});

test('cut removes an edited time range across source segments after speed changes', () => {
  const fast = timeline.configure(createTimeline(20), { speed: 2, muted: true });
  const edited = timeline.cut(fast, 2, 4);
  assert.deepEqual(edited.segments, [{ start: 0, end: 4 }, { start: 8, end: 20 }]);
  assert.equal(duration(edited), 8);
  assert.equal(edited.muted, true);
  assert.deepEqual(trim(edited, 1, 4).segments, [{ start: 2, end: 4 }, { start: 8, end: 12 }]);
});

test('rejects empty ranges beyond the end and invalid settings', () => {
  assert.throws(() => trim(createTimeline(20), 20.0000001, 20.0000002), /range/);
  for (const speed of [0, NaN, Infinity, 3]) assert.throws(() => timeline.configure(createTimeline(20), { speed }), /Speed/);
  assert.throws(() => timeline.cut(createTimeline(20), 0, 20), /leave/);
  assert.throws(() => trim(createTimeline(20), -1, 4), /range/);
});
