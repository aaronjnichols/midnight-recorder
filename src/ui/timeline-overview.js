// Loads the timeline overview of the open video through the shared commands.
// The sound can arrive before the frames. A token stops the results of a video
// that is not open any more, and its read is cancelled.
const POLL_MS = 250;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reading = (videoId) => ({
  videoId,
  audio: { state: "reading" },
  frames: { state: "reading", items: [] },
});
const closed = () => ({
  videoId: "",
  audio: { state: "idle" },
  frames: { state: "idle", items: [] },
});

function bytes(base64) {
  const text = atob(base64);
  const result = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
  return result;
}

// A frame image, ready to draw.
function picture({ seconds, data }) {
  const image = new Image();
  image.src = `data:image/jpeg;base64,${data}`;
  return image.decode().then(() => ({ seconds, image }));
}

export function createOverview({ call, onChange }) {
  let token = 0,
    job = null,
    view = closed();

  const show = (next) => {
    view = next;
    onChange();
  };
  // The page leaves a read. Another caller can share it, so the read stops
  // only when no caller needs it.
  const leave = ({ id, holder }) =>
    call("overview.cancel", { jobId: id, holder }).catch(() => {});
  function cancelJob() {
    const running = job;
    job = null;
    if (running) leave(running);
  }

  async function read(mine, jobId, videoId) {
    const result = await call("overview.result", {
      jobId,
      includeData: true,
      buckets: 1,
    });
    const items = await Promise.all((result.frames.items ?? []).map(picture));
    if (mine !== token) return;
    const { audio, frames } = result;
    show({
      videoId,
      audio: {
        ...audio,
        ...(audio.levels ? { levels: bytes(audio.levels) } : {}),
      },
      frames: { ...frames, items },
    });
  }

  async function load(id) {
    const mine = ++token;
    cancelJob();
    show(reading(id));
    try {
      const started = await call("overview.start", { id });
      if (mine !== token) {
        if (started.state === "running") leave(started);
        return;
      }
      job = started;
      let status = started,
        sound = false;
      while (status.state === "running") {
        if (status.progress && !sound) {
          sound = true;
          await read(mine, started.id, id);
          if (mine !== token) return;
        }
        await wait(POLL_MS);
        if (mine !== token) return;
        status = await call("export.status", { jobId: started.id });
        if (mine !== token) return;
      }
      job = null;
      if (status.state !== "complete")
        throw new Error(status.error || "The read stopped.");
      await read(mine, started.id, id);
    } catch (error) {
      if (mine !== token) return;
      job = null;
      show({
        videoId: id,
        audio: { state: "failed", error: error.message },
        frames: { state: "failed", error: error.message, items: [] },
      });
    }
  }

  return {
    load,
    clear() {
      token++;
      cancelJob();
      show(closed());
    },
    view: () => view,
  };
}
