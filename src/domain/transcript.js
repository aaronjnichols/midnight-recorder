// Pure transcript operations. No file, process, or Electron access.
import { duration } from "./timeline.js";
import { mapWords } from "./words.js";

export const MAX_WORD_PAGE = 1000;

function mappedWords(words, timeline) {
  let offset = 0;
  return timeline.segments.flatMap((segment, index) => {
    const kept = words.filter(
      (w) => w.end > segment.start && w.start < segment.end,
    );
    const result = kept.map((w, i) => ({
      ...w,
      sourceStart: w.start,
      sourceEnd: w.end,
      start:
        offset +
        (Math.max(w.start, segment.start) - segment.start) / timeline.speed,
      end:
        offset +
        (Math.min(w.end, segment.end) - segment.start) / timeline.speed,
      partial: w.start < segment.start || w.end > segment.end,
      cutBefore: index > 0 && i === 0,
    }));
    offset += (segment.end - segment.start) / timeline.speed;
    return result;
  });
}

function bounded(value, name, min, max, integer = false) {
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      `${name} must be ${integer ? "an integer " : ""}from ${min} to ${max}.`,
    );
  return value;
}
function view(data, timeline, args) {
  const timeBase = args.timeBase ?? "edited";
  if (!["source", "edited"].includes(timeBase))
    throw new Error("Invalid timeBase. Use source or edited.");
  return {
    timeBase,
    duration: timeBase === "source" ? data.duration : duration(timeline),
    words:
      timeBase === "source"
        ? data.words.map((w) => ({
            ...w,
            sourceStart: w.start,
            sourceEnd: w.end,
            partial: false,
            cutBefore: false,
          }))
        : mappedWords(data.words, timeline),
    audioAudible:
      data.outcome !== "no_audio" && (timeBase === "source" || !timeline.muted),
  };
}
function group(words) {
  const result = [];
  for (const w of words) {
    let last = result.at(-1);
    if (
      !last ||
      w.cutBefore ||
      w.segmentId !== last.segmentId ||
      w.start - last.end > 2
    ) {
      last = {
        segmentId: w.segmentId,
        start: w.start,
        end: w.end,
        text: "",
        partial: false,
        cutBefore: w.cutBefore,
      };
      result.push(last);
    }
    last.end = w.end;
    last.text += (last.text ? " " : "") + w.word.trim();
    last.partial ||= w.partial;
  }
  return result;
}
export function readTranscript(data, timeline, args = {}) {
  const current = view(data, timeline, args),
    start = args.start ?? 0,
    end = args.end ?? Math.min(current.duration, start + 30);
  bounded(start, "start", 0, current.duration);
  bounded(end, "end", start, current.duration);
  if (end <= start || end - start > 120)
    throw new Error("Select a positive window of at most 120 seconds.");
  const limit = bounded(args.limit ?? 200, "limit", 1, 500, true),
    offset = bounded(
      args.offset ?? 0,
      "offset",
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  const detail = args.detail ?? "segments";
  if (!["segments", "words"].includes(detail))
    throw new Error("Invalid detail. Use segments or words.");
  const all = current.words.filter((w) => w.end > start && w.start < end),
    words = all.slice(offset, offset + limit);
  return {
    timeBase: current.timeBase,
    audioAudible: current.audioAudible,
    duration: current.duration,
    start,
    end,
    text: textOf(words),
    ...(detail === "words" ? { words } : { segments: group(words) }),
    totalWords: all.length,
    nextOffset:
      offset + words.length < all.length ? offset + words.length : null,
  };
}

// A page of the canonical words with the current timeline. Without a window
// the list is the complete source, also removed words, so the same offset gives
// the same words after any edit. A window gives the words kept in that range of
// edited seconds. readTranscript is the frozen view of a job. This view is live.
export function readWords(words, timeline, args = {}) {
  const total = duration(timeline);
  const limit = bounded(args.limit ?? 200, "limit", 1, MAX_WORD_PAGE, true),
    offset = bounded(
      args.offset ?? 0,
      "offset",
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  const start = bounded(args.start ?? 0, "start", 0, total),
    end = bounded(args.end ?? total, "end", 0, total);
  const windowed = args.start !== undefined || args.end !== undefined;
  if (windowed && end <= start)
    throw new Error("Select a window where the end is after the start.");
  const view = mapWords(words, timeline);
  const list = windowed
    ? view.filter(
        (w) => w.state !== "removed" && w.end > start && w.start < end,
      )
    : view;
  const page = list.slice(offset, offset + limit);
  const count = (state) => view.filter((w) => w.state === state).length;
  return {
    total: words.length,
    matches: list.length,
    offset,
    limit,
    nextOffset:
      offset + page.length < list.length ? offset + page.length : null,
    kept: count("kept"),
    partial: count("partial"),
    removed: count("removed"),
    duration: total,
    words: page.map(({ fragments, ...word }) =>
      word.state === "partial" ? { ...word, fragments } : word,
    ),
  };
}

const tokens = (text) =>
  text
    .toLowerCase()
    .replace(/[’']/g, "")
    .match(/[\p{L}\p{N}]+/gu) || [];
const textOf = (words) => words.map((w) => w.word.trim()).join(" ");
export function searchTranscript(data, timeline, args) {
  if (typeof args.query !== "string" || args.query.length > 200)
    throw new Error("The query must be text of at most 200 characters.");
  const query = tokens(args.query);
  if (!query.length) throw new Error("The query must contain a word.");
  const current = view(data, timeline, args),
    words = current.words;
  const limit = bounded(args.limit ?? 10, "limit", 1, 20, true),
    offset = bounded(
      args.offset ?? 0,
      "offset",
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
  const contextSeconds = bounded(
    args.contextSeconds ?? 2,
    "contextSeconds",
    0,
    10,
  );
  const from = bounded(args.start ?? 0, "start", 0, current.duration);
  const to = bounded(
    args.end ?? current.duration,
    "end",
    from,
    current.duration,
  );
  const matches = [];
  const flat = words.flatMap((w, i) =>
    tokens(w.word).map((token) => ({ token, index: i })),
  );
  let nextOffset = null;
  for (let i = offset; i <= flat.length - query.length; i++) {
    if (!query.every((q, k) => flat[i + k].token === q)) continue;
    const match = words.slice(
      flat[i].index,
      flat[i + query.length - 1].index + 1,
    );
    if (
      match.some(
        (w, k) =>
          w.partial ||
          (k > 0 && (w.cutBefore || w.start - match[k - 1].end > 2)),
      )
    )
      continue;
    const start = match[0].start,
      end = match.at(-1).end;
    if (end <= from || start >= to) continue;
    if (matches.length === limit) {
      nextOffset = i;
      break;
    }
    const context = words.filter(
      (w) =>
        w.end > Math.max(0, start - contextSeconds) &&
        w.start < end + contextSeconds,
    );
    matches.push({
      start,
      end,
      text: textOf(match),
      context: {
        text: textOf(context.slice(0, 100)),
        words: context.slice(0, 100),
        truncated: context.length > 100,
      },
      ...(current.timeBase === "edited"
        ? {
            inspectionTimestamps: [
              Math.max(0, start - 0.5),
              (start + end) / 2,
              Math.max(0, Math.min(current.duration - 0.001, end + 0.5)),
            ],
          }
        : {}),
    });
  }
  return {
    timeBase: current.timeBase,
    audioAudible: current.audioAudible,
    matches,
    nextOffset,
  };
}
