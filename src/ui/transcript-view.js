// Pure rules of the Transcript tool and the Parts list. No DOM or Electron
// dependency, so node:test checks them directly.
import { timelineParts } from "../domain/timeline.js";
import { clock } from "./view-model.js";

const count = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;

// Time as m:ss.mmm. A short part needs more digits than the timeline shows.
export function clockMillis(value) {
  const time = Math.round((Number.isFinite(value) ? value : 0) * 1000);
  const whole = Math.floor(time / 1000);
  return `${clock(whole)}.${String(time % 1000).padStart(3, "0")}`;
}

// Time as m:ss.hh, the same two decimals as the selection on the timeline.
const clockHundredths = (value) => {
  const time = Math.round(value * 100);
  const whole = Math.floor(time / 100);
  return `${clock(whole)}.${String(time % 100).padStart(2, "0")}`;
};
export const rangeText = (start, end) =>
  `${clockHundredths(start)} to ${clockHundredths(end)}`;

const speechText = (progress = {}) =>
  progress.phase === "speech" && progress.totalRegions
    ? `Reading the speech: part ${progress.completedRegions} of ${progress.totalRegions}.`
    : progress.phase === "audio"
      ? "Reading the audio."
      : "Starting speech recognition.";

// What the panel shows. load is the progress of the word pages. Words show only
// with the kind ready. The other kinds have one message and their actions.
export function transcriptPanel({
  video,
  capability,
  job = null,
  load = null,
  sourceCurrent = true,
}) {
  const view = (kind, title, text, extra = {}) => ({
    kind,
    title,
    text,
    tone: "note",
    progress: null,
    canStart: false,
    canCancel: false,
    startLabel: "Make transcript",
    warning: "",
    ...extra,
  });
  const noAudio = () =>
    view(
      "no_audio",
      "No sound",
      "This video has no sound, so it has no words to select. You can still trim and cut on the timeline.",
    );
  if (video.metadata.hasAudio === false) return noAudio();
  if (job?.state === "complete") {
    const outcome = job.result?.outcome;
    if (outcome === "no_audio") return noAudio();
    if (outcome === "no_speech")
      return view(
        "no_speech",
        "No speech",
        "No speech was found in this video, so there are no words to select.",
      );
    if (!load || load.loaded < load.total)
      return view(
        "loading",
        "Loading the words",
        load ? `${load.loaded} of ${load.total} words.` : "Reading the words.",
        { progress: load?.total ? load.loaded / load.total : null },
      );
    return view("ready", "Transcript", "", {
      ...(sourceCurrent
        ? {}
        : {
            warning:
              "The source file changed after this transcript. Make a new transcript before you cut words.",
            canStart: true,
            startLabel: "Make a new transcript",
          }),
    });
  }
  if (job?.state === "running")
    return view("running", "Making the transcript", speechText(job.progress), {
      canCancel: true,
      progress:
        job.progress?.phase === "speech" && job.progress.totalRegions
          ? job.progress.completedRegions / job.progress.totalRegions
          : null,
    });
  if (job?.state === "cancelling")
    return view("running", "Making the transcript", "Cancelling.");
  if (!capability)
    return view("checking", "Transcript", "Checking speech recognition.");
  if (!capability.available)
    return view(
      "unavailable",
      "Speech recognition is not set up",
      "To set it up, run npm run setup:transcription in the app folder, then start the app again.",
    );
  const limit = capability.maxSourceSeconds ?? 3600;
  if (video.metadata.duration > limit)
    return view(
      "too_long",
      "This video is too long",
      `Speech recognition reads at most ${limit / 60} minutes of source video. Import a shorter video to edit by words.`,
    );
  if (job?.state === "cancelled")
    return view(
      "cancelled",
      "Transcript cancelled",
      "Nothing changed. You can start again.",
      { canStart: true },
    );
  if (job?.state === "failed")
    return view(
      "failed",
      "The transcript failed",
      job.error ?? "Speech recognition stopped.",
      { tone: "error", canStart: true, startLabel: "Try again" },
    );
  return view(
    "idle",
    "Edit by words",
    "Make a transcript, then select words to cut that footage. Speech recognition runs on this computer.",
    { canStart: true },
  );
}

// One line for the footer. selection is the result of selectWords.
export function wordSummary(selection) {
  if (!selection) return "";
  if (!selection.keptWords) return selection.reason;
  const parts = [
    count(selection.keptWords, "word"),
    rangeText(selection.start, selection.end),
    `${selection.length.toFixed(2)} s`,
  ];
  const notes = [];
  if (selection.removedWords)
    notes.push(`${selection.removedWords} already cut`);
  if (selection.partialWords) notes.push(`${selection.partialWords} part cut`);
  if (notes.length) parts.push(notes.join(", "));
  return parts.join(" · ");
}

// The text of the kept words from one index to another.
export function selectionText(view, low, high) {
  return view
    .slice(low, high + 1)
    .filter((word) => word.state !== "removed")
    .map((word) => word.text)
    .join(" ");
}

// The kept words in edited time, with their index in the full list. Word times
// can overlap or nest. reach is the latest end so far.
export function timedWords(view) {
  const list = [];
  let reach = -Infinity;
  for (const [index, word] of view.entries())
    if (word.state !== "removed") {
      reach = Math.max(reach, word.end);
      list.push({ index, start: word.start, end: word.end, reach });
    }
  return list;
}

// The index of the word at an edited time, or -1. Each time update runs this,
// so it finds the last word that started with a binary search. Then it goes
// back only while an earlier word can reach the time.
export function wordAt(timed, time) {
  let low = 0,
    high = timed.length - 1,
    last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timed[middle].start <= time) {
      last = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  for (let index = last; index >= 0 && timed[index].reach > time; index--)
    if (time < timed[index].end) return timed[index].index;
  return -1;
}

const running = (job) => ["running", "cancelling"].includes(job?.state);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A cached result of the same audio, engine, and options has the same words.
const sameWords = (a, b) =>
  b.result.cached === true &&
  sameJson(a.options, b.options) &&
  sameJson(a.result?.identity, b.result.identity) &&
  a.result?.wordCount === b.result.wordCount;

// What the panel does with the speech jobs of its video. A request on the panel
// continues. Only a newer result replaces words. A selection waits, because new
// words have other IDs. action is keep, watch, load, switch, or show.
export function chooseJob({
  jobs,
  current = null,
  hasWords = false,
  hasSelection = false,
}) {
  const keep = { action: "keep" };
  const list = [...jobs].sort((a, b) =>
    String(a.startedAt).localeCompare(String(b.startedAt)),
  );
  const newest = list.at(-1);
  if (!newest || running(current)) return keep;
  // A job list can be from before the current job. It cannot roll it back.
  if (
    current?.state === "complete" &&
    String(newest.startedAt).localeCompare(String(current.startedAt)) < 0
  )
    return keep;
  if (running(newest))
    return hasWords || current?.id === newest.id
      ? keep
      : { action: "watch", job: newest };
  if (newest.state === "complete" && newest.result) {
    if (current?.id === newest.id || (hasWords && hasSelection)) return keep;
    return hasWords &&
      current?.state === "complete" &&
      sameWords(current, newest)
      ? { action: "switch", job: newest }
      : { action: "load", job: newest };
  }
  // The newest job ended without words.
  if (hasWords) return keep;
  const done = list.findLast((job) => job.state === "complete" && job.result);
  if (done && current?.id !== done.id) return { action: "load", job: done };
  return current?.id === newest.id ? keep : { action: "show", job: newest };
}

// The next kept word in a direction. The ends stay.
export function moveWord(view, index, direction) {
  for (
    let next = index + direction;
    next >= 0 && next < view.length;
    next += direction
  )
    if (view[next].state !== "removed") return next;
  return Math.min(Math.max(index, 0), view.length - 1);
}

// A key on the focused transcript. Null leaves the key to the page, so Space,
// undo, and the other shortcuts still work. Delete does not cut: only the
// labeled button cuts.
export function transcriptKey({ key, shiftKey, ctrlKey, metaKey, altKey }) {
  if (altKey) return null;
  if (ctrlKey || metaKey)
    return key.toLowerCase() === "a" && !shiftKey ? { all: true } : null;
  const step = { ArrowRight: 1, ArrowLeft: -1 }[key];
  if (step) return shiftKey ? { extend: step } : { move: step };
  const paragraph = { ArrowDown: 1, ArrowUp: -1 }[key];
  if (paragraph)
    return shiftKey ? { extendParagraph: paragraph } : { paragraph };
  if (key === "Enter") return { seek: true };
  if (key === "Escape") return { clear: true };
  return null;
}

// One row for each part of the edited video.
export function partRows(timeline, selectedId) {
  return timelineParts(timeline).map((part) => {
    const startText = clockMillis(part.start),
      endText = clockMillis(part.end),
      lengthText = `${(part.end - part.start).toFixed(3)} s`;
    return {
      id: part.id,
      number: part.index + 1,
      start: part.start,
      end: part.end,
      startText,
      endText,
      lengthText,
      seam: part.seamBefore,
      splitBefore: part.splitBefore,
      splitAfter: part.splitAfter,
      selected: part.id === selectedId,
      label: `Part ${part.index + 1}, ${startText} to ${endText}, ${lengthText}`,
    };
  });
}

// The message after a word cut. The caption text does not change, so the
// message tells where to check it.
export function cutNotice(selection, captions) {
  const changed = captions.partial + captions.removed;
  const text = `Cut ${count(selection.keptWords, "word")}, ${selection.length.toFixed(2)} s. Undo with Ctrl+Z.`;
  return changed
    ? `${text} Check ${count(changed, "caption")} in Captions: the cut changed their speech, not their text.`
    : text;
}
