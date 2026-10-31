// Recorded time excludes pauses. The service stores these recording fields:
// startedAt: ISO time when capture started.
// pausedSeconds: total seconds of completed pauses.
// pausedAt: ISO time when the current pause or capture failure started.
// stoppedAt: ISO time when capture stopped.
export function recordedSeconds(recording, now) {
  const started = Date.parse(recording?.startedAt);
  if (!Number.isFinite(started)) return 0;
  const held = recording.pausedAt ?? recording.stoppedAt;
  const end = held === undefined ? now : Date.parse(held);
  const seconds = (end - started) / 1000 - (recording.pausedSeconds || 0);
  return Math.max(0, Math.round(seconds * 1000) / 1000);
}
