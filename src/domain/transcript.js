// Pure transcript operations. No file, process, or Electron access.
import { duration } from "./timeline.js";

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
