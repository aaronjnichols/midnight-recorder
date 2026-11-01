// Captions from speech. Pure functions. No file, process, or Electron access.
//
// Input words are the complete speech result in source seconds. A caption
// cue stores source seconds too, so it stays on its speech after trim, cut,
// and speed changes. Grouping limits use edited seconds, because the viewer
// reads at the edited speed.
import {
  duration,
  sourceTime,
  sourceEndTime,
  withCaptions,
} from "./timeline.js";
import {
  placement,
  sourceTimes,
  checkText,
  checkBox,
  between,
  choice,
  color,
  textBoxPixels,
  FONTS,
  ALIGN,
  VERTICAL_ALIGN,
  LIMITS,
} from "./elements.js";

export const CAPTION_LIMITS = {
  cues: 500,
  characters: 200,
  lines: 3,
  // Grouping, in edited seconds.
  pause: 1,
  maxSeconds: 6,
  minSeconds: 0.8,
  hold: 0.3,
  // Words below this model probability mark the cue to check.
  probability: 0.5,
  lineChars: 42,
  // A generated cue that would show for less time joins the next cue.
  shortest: 0.3,
};

// Every stored cue shows for at least the element minimum, 0.05 seconds.
const SHOW_MINIMUM = LIMITS.minSeconds;

const round = (value) => Math.round(value * 1e6) / 1e6;

// Recognized text can contain any character. Control characters and line
// separators become spaces, so generated text obeys the same rules as typed
// caption text.
const clean = (text) =>
  String(text)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/ {2,}/g, " ");

// Text longer than the cue limit is shortened, ends with "…", and is marked
// to check. More than three lines join on the last line.
function bounded(text) {
  let lines = text.split("\n");
  if (lines.length > CAPTION_LIMITS.lines)
    lines = [
      ...lines.slice(0, CAPTION_LIMITS.lines - 1),
      lines.slice(CAPTION_LIMITS.lines - 1).join(" "),
    ];
  const chars = [...lines.join("\n")];
  if (chars.length <= CAPTION_LIMITS.characters)
    return { text: lines.join("\n"), cut: false };
  return {
    text:
      chars
        .slice(0, CAPTION_LIMITS.characters - 1)
        .join("")
        .trimEnd() + "…",
    cut: true,
  };
}

// Words in the kept segments. A word belongs to the segment that contains its
// time midpoint, so a word across a cut shows once. Its times are clipped to
// that segment, and it is marked partial. A word with its midpoint in removed
// content is dropped. Words never join across a segment boundary.
//
// A token with spaces in it, which the speech engine does not usually give,
// becomes one word for each part. The parts share the token time in
// proportion to their length. These times are estimates, so the parts are
// marked to check.
// Complete words. A token without a leading space, for example 's or a
// comma, joins the word before it. The cut policy applies to the complete
// word, so a suffix cannot stay alone after its word was cut.
function completeWords(words) {
  const list = [];
  for (const token of [...words].sort((a, b) => a.start - b.start)) {
    const raw = clean(token.word);
    const last = list.at(-1);
    if (last && raw.trim() && !/^\s/.test(raw)) {
      last.text += raw;
      last.end = Math.max(last.end, token.end);
      last.probability = Math.min(
        last.probability ?? 1,
        token.probability ?? 1,
      );
      last.tokens++;
      continue;
    }
    list.push({
      text: raw,
      start: token.start,
      end: token.end,
      probability: token.probability,
      segmentId: token.segmentId,
      tokens: 1,
    });
  }
  return list;
}

export function retainedWords(words, timeline) {
  const sorted = completeWords(words);
  const kept = [];
  // Source tokens in a kept segment, with or without visible text.
  let elapsed = 0,
    placed = 0;
  for (const [index, segment] of timeline.segments.entries()) {
    for (const word of sorted) {
      const middle = (word.start + word.end) / 2;
      if (middle < segment.start || middle >= segment.end) continue;
      const from = Math.max(word.start, segment.start),
        to = Math.min(word.end, segment.end);
      if (to <= from) continue;
      placed += word.tokens;
      const raw = word.text;
      const parts = raw.trim().split(" ").filter(Boolean);
      const weight = parts.reduce((sum, p) => sum + p.length + 1, 0);
      let at = from;
      for (const [n, part] of parts.entries()) {
        const until =
          n === parts.length - 1
            ? to
            : at + ((to - from) * (part.length + 1)) / weight;
        kept.push({
          text: part,
          // A token without a leading space joins the word before it, for
          // example 's in It's.
          attach: n === 0 && !/^\s/.test(raw),
          sourceStart: at,
          sourceEnd: until,
          start: (elapsed + at - segment.start) / timeline.speed,
          end: (elapsed + until - segment.start) / timeline.speed,
          segment: index,
          segmentStart: segment.start,
          elapsed,
          speech: word.segmentId,
          probability: word.probability,
          partial: from > word.start + 1e-9 || to < word.end - 1e-9,
          estimated: parts.length > 1,
        });
        at = until;
      }
    }
    elapsed += segment.end - segment.start;
  }
  // dropped: words in removed content.
  return { words: kept, dropped: words.length - placed };
}

// Two balanced lines when the text is longer than one line. Longer text
// (only after a manual correction) wraps on more lines.
export function splitLines(text, lineChars = CAPTION_LIMITS.lineChars) {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  if (flat.length <= lineChars) return flat;
  const spaces = [...flat.matchAll(/ /g)].map((m) => m.index);
  let best = null;
  for (const at of spaces) {
    const longest = Math.max(at, flat.length - at - 1);
    if (!best || longest < best.longest) best = { at, longest };
  }
  if (best && best.longest <= lineChars)
    return `${flat.slice(0, best.at)}\n${flat.slice(best.at + 1)}`;
  const lines = [];
  let line = "";
  for (const word of flat.split(" ")) {
    if (line && line.length + 1 + word.length > lineChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// Characters per line that fit the caption area. An average character is
// about half of the font size wide.
export function lineCharsFor(frame, style) {
  const area = style.width * frame.width,
    font = style.size * frame.height;
  return Math.max(
    12,
    Math.min(CAPTION_LIMITS.lineChars, Math.floor(area / (0.52 * font))),
  );
}

const sentenceEnd = (text) => /[.?!]["')\]]*$/.test(text);

// A word with its attached tokens, for example it + 's, or Yes + ",". A cue
// boundary is never inside a unit. A unit does not cross a cut.
function units(words, limits) {
  const list = [];
  for (const word of words) {
    const low = (word.probability ?? 1) < limits.probability;
    const last = list.at(-1);
    if (word.attach && last && last.segment === word.segment) {
      last.text += word.text;
      last.end = Math.max(last.end, word.end);
      last.count++;
      last.check ||= word.partial || word.estimated || low;
      last.partial ||= word.partial;
      continue;
    }
    list.push({
      ...word,
      count: 1,
      check: word.partial || word.estimated || low,
    });
  }
  return list;
}
const join = (a, b) => ({
  segment: a.segment,
  units: [...a.units, ...b.units],
  text: `${a.text} ${b.text}`,
  first: a.first,
  last: b.last.end >= a.last.end ? b.last : a.last,
});

// Cues from words. Options: lineChars, and an optional edited range [start,
// end).
//
// Range policy: a word belongs to the range that contains its edited time
// midpoint. Cues stay in the range: a cue does not start before the range
// start or end after the range end. If the speech of a word starts before the
// range or ends after it, the cue shows the full word and is marked to check.
//
// Every cue shows for at least CAPTION_LIMITS.shortest seconds if it can. A
// group that cannot, for example because two words have the same time,
// joins the next group in the same kept segment. A group that cannot join
// and cannot show for the element minimum is not made. Its words are counted
// in skipped.
export function buildCues(words, timeline, options = {}) {
  const limits = { ...CAPTION_LIMITS, ...options.limits };
  const lineChars = options.lineChars ?? limits.lineChars;
  const total = duration(timeline);
  const from = options.start ?? 0,
    to = Math.min(options.end ?? total, total);
  const { words: retained, dropped } = retainedWords(words, timeline);
  const inRange = units(retained, limits).filter((w) => {
    const middle = (w.start + w.end) / 2;
    return middle >= from && middle < to;
  });
  const groups = [];
  let current = null;
  for (const unit of inRange) {
    if (current) {
      const joined = `${current.text} ${unit.text}`;
      const split =
        unit.segment !== current.segment ||
        unit.start - current.last.end > limits.pause ||
        sentenceEnd(current.text) ||
        (unit.speech !== current.last.speech && current.text.length >= 20) ||
        joined.length > lineChars * 2 ||
        unit.end - current.first.start > limits.maxSeconds;
      if (!split) {
        current.units.push(unit);
        current.text = joined;
        current.last = unit;
        continue;
      }
      groups.push(current);
    }
    current = {
      segment: unit.segment,
      units: [unit],
      text: unit.text,
      first: unit,
      last: unit,
    };
  }
  if (current) groups.push(current);
  const startOf = (group) => Math.max(group.first.start, from);
  // The latest end of a group: never into the next cue, the cut, the range
  // end, or the video end.
  const limitOf = (index) => {
    const group = groups[index],
      next = groups[index + 1];
    const segment = timeline.segments[group.segment];
    return Math.min(
      next ? startOf(next) : Infinity,
      (group.first.elapsed + segment.end - segment.start) / timeline.speed,
      to,
      total,
      Math.max(startOf(group) + limits.maxSeconds, group.last.end),
    );
  };
  let skipped = 0;
  for (let i = 0; i < groups.length;) {
    const group = groups[i],
      next = groups[i + 1],
      before = groups[i - 1];
    // The same 1e-9 tolerance as the other duration checks, so an exact
    // minimum is not lost to floating-point error.
    const span = limitOf(i) - startOf(group);
    if (span < limits.shortest - 1e-9 && next?.segment === group.segment) {
      groups.splice(i, 2, join(group, next));
      continue;
    }
    if (span < SHOW_MINIMUM - 1e-9) {
      if (before?.segment === group.segment) {
        groups.splice(i - 1, 2, join(before, group));
        i--;
      } else {
        skipped += group.units.reduce((sum, u) => sum + u.count, 0);
        groups.splice(i, 1);
      }
      continue;
    }
    i++;
  }
  let shortened = 0;
  const cues = groups.map((group, index) => {
    const { first, last } = group;
    const segment = timeline.segments[first.segment];
    const source = (edited) =>
      round(segment.start + edited * timeline.speed - first.elapsed);
    const start = startOf(group);
    // A short hold and a minimum display time make text readable.
    const end = Math.min(
      limitOf(index),
      Math.max(last.end + limits.hold, start + limits.minSeconds),
    );
    const shown = bounded(splitLines(group.text, lineChars));
    if (shown.cut) shortened++;
    const clipped = first.start < from - 1e-9 || last.end > to + 1e-9;
    return {
      start,
      end,
      sourceStart:
        start > first.start ? source(start) : round(first.sourceStart),
      sourceEnd: source(end),
      text: shown.text,
      check: shown.cut || clipped || group.units.some((u) => u.check),
      words: group.units.reduce((sum, u) => sum + u.count, 0),
    };
  });
  return {
    cues,
    words: inRange.reduce((sum, u) => sum + u.count, 0),
    dropped,
    // Words that a cut clipped.
    partial: inRange.filter((u) => u.partial).length,
    skipped,
    shortened,
  };
}

// The caption track: { enabled, style, cues, source }. Old data has none.
export const captionsOf = (timeline) => timeline.captions ?? null;

// One style for all cues. The caption area is a box like a text element box.
// The text is bold white with a dark outline, so it is easy to read on most
// video without a background band.
export const CAPTION_STYLE = {
  x: 0.08,
  y: 0.8,
  width: 0.84,
  height: 0.15,
  font: "sans",
  bold: true,
  size: 0.045,
  color: "#FFFFFF",
  align: "center",
  verticalAlign: "bottom",
  background: "none",
  backgroundOpacity: 0.6,
  outline: "#000000",
};
const CUE_TEXT = {
  characters: CAPTION_LIMITS.characters,
  lines: CAPTION_LIMITS.lines,
};

function checkStyle(v) {
  checkBox(v);
  choice("font", v.font, FONTS);
  if (typeof v.bold !== "boolean")
    throw new Error("bold must be true or false.");
  between("size", v.size, 0.01, 0.5);
  choice("align", v.align, ALIGN);
  choice("verticalAlign", v.verticalAlign, VERTICAL_ALIGN);
  between("backgroundOpacity", v.backgroundOpacity, 0, 1);
  v.color = color("color", v.color);
  v.background = color("background", v.background, true);
  v.outline = color("outline", v.outline, true);
  return v;
}

const sorted = (cues) =>
  [...cues].sort((a, b) => a.sourceStart - b.sourceStart);

// The rules for a whole caption track. Every caption change checks the
// complete new track before it saves, so a change cannot store a cue that
// does not show, a repeated ID, too much text, or an overlap. Returns the
// cues in source order.
function checkTrack(cues) {
  const seen = new Set();
  for (const cue of cues) {
    if (typeof cue.id !== "string" || !cue.id)
      throw new Error("A caption needs an ID.");
    if (seen.has(cue.id)) throw new Error("Caption ID already exists.");
    seen.add(cue.id);
    if (!Number.isFinite(cue.sourceStart) || !Number.isFinite(cue.sourceEnd))
      throw new Error("Caption times must be numbers.");
    // A positive source length. The minimum display time is in edited
    // seconds, so it is checked where a cue changes.
    if (cue.sourceStart < 0 || cue.sourceEnd - cue.sourceStart < 1e-6)
      throw new Error(
        `A caption must show for at least ${SHOW_MINIMUM} seconds.`,
      );
    checkText(cue.text, CUE_TEXT);
  }
  const list = sorted(cues);
  for (let i = 1; i < list.length; i++)
    if (list[i].sourceStart < list[i - 1].sourceEnd - 1e-9)
      throw new Error(
        "Captions cannot overlap. Change the times, or replace the captions in a range that includes both.",
      );
  return list;
}

// Cues keep their source order and do not overlap.
function checkOrder(cues, changed) {
  const list = sorted(cues);
  const index = list.findIndex((c) => c.id === changed.id);
  const before = list[index - 1],
    after = list[index + 1];
  if (before && changed.sourceStart < before.sourceEnd - 1e-9)
    throw new Error(
      "The caption overlaps the previous caption. Change the times or change the previous caption first.",
    );
  if (after && changed.sourceEnd > after.sourceStart + 1e-9)
    throw new Error(
      "The caption overlaps the next caption. Change the times or change the next caption first.",
    );
  return list;
}

function capacityError(needed, draft, keep, from) {
  const room = CAPTION_LIMITS.cues - keep;
  const until = draft[Math.max(0, room)]?.start;
  return new Error(
    `This needs ${needed} captions. A video can have at most ${CAPTION_LIMITS.cues}. Make captions for a shorter range` +
      (until > from
        ? `, for example from ${Math.floor(from)} to ${Math.floor(until)} seconds.`
        : "."),
  );
}

// Put a draft into the caption track as one history entry. replace must be
// true when captions exist. With a range { start, end } in edited seconds,
// only cues that overlap the range are removed; other cues stay. The
// capacity check runs before any change. ids gives a new ID for each cue.
export function applyCaptions(timeline, draft, options) {
  const { ids, replace = false, range, source } = options;
  const existing = captionsOf(timeline);
  if (existing?.cues.length && !replace)
    throw new Error(
      "This video has captions. Set replace to true to replace them. Labels and shapes do not change.",
    );
  const overlaps = (cue) => {
    const shown = placement(timeline, cue);
    return (
      !range ||
      (shown.visibility !== "none" &&
        shown.start < range.end &&
        shown.end > range.start)
    );
  };
  const keep = (existing?.cues ?? []).filter((cue) => !overlaps(cue));
  if (keep.length + draft.length > CAPTION_LIMITS.cues)
    throw capacityError(
      keep.length + draft.length,
      draft,
      keep.length,
      range?.start ?? 0,
    );
  const added = draft.map((cue) => ({
    id: ids(),
    sourceStart: cue.sourceStart,
    sourceEnd: cue.sourceEnd,
    text: cue.text,
    check: Boolean(cue.check),
  }));
  const cues = checkTrack([...keep, ...added]);
  // Each new cue shows in the edited video.
  for (const cue of added) checkShown(timeline, cue);
  const captions = {
    enabled: existing?.enabled ?? true,
    style: existing?.style ?? { ...CAPTION_STYLE },
    cues,
    source: source ?? existing?.source ?? null,
  };
  return {
    timeline: withCaptions(timeline, captions),
    added: added.map((c) => c.id),
    removed: (existing?.cues.length ?? 0) - keep.length,
  };
}

// New or changed times must show in the edited video for at least the
// minimum time, in any time base. At 2x speed, 0.05 source seconds show for
// only 0.025 seconds, which can be between two output frames. A later cut or
// speed change can make a stored cue shorter. A cut gives partial
// visibility, which the list and the editor show. A speed change alone does
// not give a mark.
//
// Stored source times and listed edited times have microsecond precision.
// Rounding changes each end by at most 0.5 microseconds of source time, which
// is 1 microsecond of edited time at the slowest speed, 0.5x. The listed
// edited times are rounded again by at most 0.5 microseconds each. So a cue
// of exactly the minimum can measure up to 3 microseconds shorter. The
// tolerance is 5 microseconds. Every interval of 0.049995 seconds still
// contains an output frame, because a frame is 1/30 seconds.
const PRECISION = 5e-6;
function checkShown(timeline, cue) {
  const shown = placement(timeline, cue);
  if (shown.visibility === "none")
    throw new Error(
      "The time range is not in the edited video. That part was cut or trimmed.",
    );
  if (shown.end - shown.start < SHOW_MINIMUM - PRECISION)
    throw new Error(
      `A caption must show for at least ${SHOW_MINIMUM} seconds in the edited video.`,
    );
}

function track(timeline) {
  const captions = captionsOf(timeline);
  if (!captions)
    throw new Error(
      "This video has no captions. Generate or add captions first.",
    );
  return captions;
}
function findCue(captions, cueId) {
  const cue = captions.cues.find((c) => c.id === cueId);
  if (!cue) throw new Error("Caption was not found.");
  return cue;
}

// Change the text or times of one cue. A text change clears the check mark.
// Times use the edited time base unless timeBase is source. A missing start
// or end keeps its stored source time.
export function updateCue(timeline, sourceDuration, cueId, args) {
  const captions = track(timeline);
  const cue = findCue(captions, cueId);
  const next = { ...cue };
  if (args.text !== undefined) {
    next.text = checkText(args.text, CUE_TEXT);
    if (next.text !== cue.text) next.check = false;
  }
  const timed = args.start !== undefined || args.end !== undefined;
  if (timed && args.timeBase === "source") {
    const range = {
      start: args.start ?? cue.sourceStart,
      end: args.end ?? cue.sourceEnd,
    };
    const times = sourceTimes(timeline, sourceDuration, {
      ...range,
      timeBase: "source",
    });
    next.sourceStart = times.start;
    next.sourceEnd = times.end;
  } else if (timed) {
    if (args.timeBase !== undefined && args.timeBase !== "edited")
      throw new Error("Invalid timeBase. Use edited or source.");
    const total = duration(timeline);
    const outside = (value) =>
      !Number.isFinite(value) || value < 0 || value > total + 1e-6;
    if (outside(args.start ?? 0) || outside(args.end ?? total))
      throw new Error(
        `Select a time range within the edited video, from 0 to ${total} seconds.`,
      );
    if (args.start !== undefined)
      next.sourceStart = round(
        sourceTime(timeline, Math.min(args.start, total)),
      );
    if (args.end !== undefined)
      next.sourceEnd = round(
        sourceEndTime(timeline, Math.min(args.end, total)),
      );
  }
  if (timed && next.sourceEnd <= next.sourceStart)
    throw new Error("Select a time range where the end is after the start.");
  if (JSON.stringify(next) === JSON.stringify(cue)) return timeline;
  if (timed) checkShown(timeline, next);
  const cues = checkOrder(
    captions.cues.map((c) => (c.id === cueId ? next : c)),
    next,
  );
  return withCaptions(timeline, { ...captions, cues: checkTrack(cues) });
}

// Add one cue, for example for speech that recognition missed. It makes a
// caption track with the default style if the video has none.
export function addCue(timeline, sourceDuration, id, args) {
  const existing = captionsOf(timeline);
  if ((existing?.cues.length ?? 0) >= CAPTION_LIMITS.cues)
    throw new Error(
      `A video can have at most ${CAPTION_LIMITS.cues} captions.`,
    );
  if (existing?.cues.some((c) => c.id === id))
    throw new Error("Caption ID already exists.");
  const times = sourceTimes(timeline, sourceDuration, args);
  const cue = {
    id,
    sourceStart: times.start,
    sourceEnd: times.end,
    text: checkText(args.text, CUE_TEXT),
    check: false,
  };
  checkShown(timeline, cue);
  const captions = existing ?? {
    enabled: true,
    style: { ...CAPTION_STYLE },
    cues: [],
    source: null,
  };
  const cues = checkOrder([...captions.cues, cue], cue);
  return withCaptions(timeline, { ...captions, cues: checkTrack(cues) });
}

export function deleteCue(timeline, cueId) {
  const captions = track(timeline);
  findCue(captions, cueId);
  return withCaptions(timeline, {
    ...captions,
    cues: captions.cues.filter((c) => c.id !== cueId),
  });
}

const STYLE_KEYS = Object.keys(CAPTION_STYLE);

// Show or hide captions, or change the shared style. Speech recognition does
// not run again.
export function configureCaptions(timeline, args) {
  const captions = track(timeline);
  for (const key of Object.keys(args))
    if (
      key !== "enabled" &&
      !STYLE_KEYS.includes(key) &&
      args[key] !== undefined
    )
      throw new Error(`The caption style does not use ${key}.`);
  if (args.enabled !== undefined && typeof args.enabled !== "boolean")
    throw new Error("enabled must be true or false.");
  const style = { ...captions.style };
  for (const key of STYLE_KEYS)
    if (args[key] !== undefined) style[key] = args[key];
  const next = {
    ...captions,
    enabled: args.enabled ?? captions.enabled,
    style: checkStyle(style),
  };
  if (JSON.stringify(next) === JSON.stringify(captions)) return timeline;
  return withCaptions(timeline, next);
}

export function removeCaptions(timeline) {
  track(timeline);
  return withCaptions(timeline, null);
}

const describe = (timeline, cue) => {
  const shown = placement(timeline, cue);
  return {
    id: cue.id,
    text: cue.text,
    check: cue.check,
    sourceStart: cue.sourceStart,
    sourceEnd: cue.sourceEnd,
    start: shown.start,
    end: shown.end,
    visibility: shown.visibility,
  };
};

// A bounded page of cues in source order. With start and end (edited
// seconds), only cues that show in that window. offset and limit page
// through the result.
export function describeCaptions(timeline, args = {}) {
  const captions = captionsOf(timeline);
  const limit = args.limit ?? 50,
    offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("limit must be an integer from 1 to 200.");
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error("offset must be an integer from 0.");
  const all = (captions?.cues ?? []).map((cue) => describe(timeline, cue));
  const windowed =
    args.start === undefined && args.end === undefined
      ? all
      : all.filter(
          (c) =>
            c.visibility !== "none" &&
            c.end > (args.start ?? 0) &&
            c.start < (args.end ?? Infinity),
        );
  const page = windowed.slice(offset, offset + limit);
  return {
    exists: Boolean(captions),
    enabled: captions?.enabled ?? false,
    style: captions?.style ?? null,
    source: captions?.source ?? null,
    count: all.length,
    matches: windowed.length,
    toCheck: all.filter((c) => c.check).length,
    partial: all.filter((c) => c.visibility === "partial").length,
    removed: all.filter((c) => c.visibility === "none").length,
    offset,
    limit,
    nextOffset:
      offset + page.length < windowed.length ? offset + page.length : null,
    cues: page,
  };
}

// Pixel style and the shown cues in edited time, or null when there is
// nothing to draw. The same text box rules as text elements.
export function captionPlan(timeline, frame) {
  const captions = captionsOf(timeline);
  if (!captions?.enabled) return null;
  const cues = sorted(captions.cues)
    .map((cue) => describe(timeline, cue))
    .filter((c) => c.visibility !== "none" && c.end > c.start)
    .map(({ start, end, text }) => ({ start, end, text }));
  if (!cues.length) return null;
  return { ...textBoxPixels(captions.style, frame), cues };
}
