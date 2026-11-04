// Plays one time range and stops at its end. It uses the shared playback
// commands. Each play has a token: a cancel changes the token, so a late reply
// stops at its next check and sends no more commands. A time alone cannot prove
// who sent a seek, so each seek of a play is expected once. Any other seek is
// manual, also a seek back to the exact start, and it cancels the play.
export function createRangePlayer({ player, call, onChange }) {
  let token = 0,
    playing = false,
    // True from the start of a play until its last command.
    live = false,
    // The time of the one seek of this play that the player did not report yet.
    ownSeek = null,
    frame = 0;

  function ended() {
    if (!playing) return;
    playing = false;
    onChange?.(false);
  }

  // A cancel, for a manual seek, a new selection, a timing change, or another
  // video. It sends no command, so it cannot change what the user did.
  function stop() {
    token++;
    live = false;
    ownSeek = null;
    cancelAnimationFrame(frame);
    ended();
  }

  // The Stop button: the video also stops.
  function halt() {
    stop();
    return call("playback.pause");
  }

  async function finish(mine, last) {
    ended();
    await call("playback.pause").catch(() => {});
    if (mine !== token) return;
    ownSeek = last;
    await call("playback.seek", { seconds: last }).catch(() => {});
    if (mine === token) live = false;
  }

  function watch(mine, last) {
    if (mine !== token) return;
    if (player.currentTime < last)
      frame = requestAnimationFrame(() => watch(mine, last));
    else finish(mine, last);
  }

  async function play(start, last) {
    stop();
    const mine = token;
    live = true;
    ownSeek = start;
    playing = true;
    onChange?.(true);
    try {
      await call("playback.seek", { seconds: start });
      if (mine !== token) return;
      await call("playback.play");
    } catch (error) {
      if (mine === token) stop();
      throw error;
    }
    if (mine === token) frame = requestAnimationFrame(() => watch(mine, last));
  }

  player.addEventListener("seeking", () => {
    if (!live) return;
    if (ownSeek !== null && Math.abs(player.currentTime - ownSeek) < 1e-6)
      ownSeek = null;
    else stop();
  });
  // Its own pause comes after the play ended.
  player.addEventListener("pause", () => {
    if (playing) stop();
  });

  return { play, stop, halt, active: () => playing };
}
