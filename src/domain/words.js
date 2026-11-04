// Human words of a speech result. Pure functions. No file, process, or Electron
// access. Captions and transcripts use the same word policy.
//
// A canonical word has one identity for its job: the index in the complete
// source list. The list does not change with cuts, undo, or speed, so an ID is
// the same in all pages and windows. It is not a position in a page, and it is
// not a caption ID.

// Recognized text can contain any character. Control characters and line
// separators become spaces, so generated text obeys the same rules as typed
// text.
const clean = (text) =>
  String(text)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/ {2,}/g, " ");

export const sentenceEnd = (text) => /[.?!]["')\]]*$/.test(text);

// Complete words. A token without a leading space, for example 's or a comma,
// joins the word before it. The cut policy applies to the complete word, so a
// suffix cannot stay alone after its word was cut.
export function completeWords(words) {
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

// A token with spaces in it, which the speech engine does not usually give,
// becomes one word for each part. The parts share the time from start to end in
// proportion to their length. These times are estimates.
export function wordParts(text, start, end) {
  const parts = text.trim().split(" ").filter(Boolean);
  const weight = parts.reduce((sum, part) => sum + part.length + 1, 0);
  let at = start;
  return parts.map((part, index) => {
    const until =
      index === parts.length - 1
        ? end
        : at + ((end - start) * (part.length + 1)) / weight;
    const piece = { text: part, start: at, end: until };
    at = until;
    return piece;
  });
}

// A paragraph ends at a long pause, at a sentence end with a pause, at a
// sentence end in a long paragraph, or at the limit.
const PARAGRAPH = {
  pause: 2,
  sentencePause: 0.8,
  sentenceWords: 40,
  words: 90,
};

export function canonicalWords(tokens) {
  // The parts of a token can start after the next token. The final source
  // order comes before the IDs, and mapWords needs it.
  const list = completeWords(tokens)
    .flatMap((word) => {
      const parts = wordParts(word.text, word.start, word.end);
      return parts.map((part) => ({
        ...word,
        ...part,
        estimated: parts.length > 1,
      }));
    })
    .sort((a, b) => a.start - b.start);
  let paragraph = 0,
    count = 0;
  return list.map((word, index) => {
    const before = list[index - 1];
    if (before) {
      const pause = word.start - before.end;
      const sentence = sentenceEnd(before.text);
      if (
        pause > PARAGRAPH.pause ||
        (sentence &&
          (pause > PARAGRAPH.sentencePause ||
            count >= PARAGRAPH.sentenceWords)) ||
        count >= PARAGRAPH.words
      ) {
        paragraph++;
        count = 0;
      }
    }
    count++;
    return {
      id: `w${index}`,
      text: word.text,
      sourceStart: word.start,
      sourceEnd: word.end,
      paragraph,
      probability: word.probability ?? null,
      estimated: word.estimated,
    };
  });
}

const round = (value) => Math.round(value * 1e6) / 1e6;
// Times below the stored precision do not count as kept speech.
const PRECISION = 1e-6;

// The current state of each word with the kept segments of a timeline. A word
// stays one word, also with kept source on both sides of a cut. fragments are
// its kept source intervals. start and end are the edited times of the first
// and the last fragment, or null for a removed word.
export function mapWords(words, timeline) {
  const { segments, speed } = timeline;
  const offsets = [];
  let elapsed = 0;
  for (const segment of segments) {
    offsets.push(elapsed);
    elapsed += segment.end - segment.start;
  }
  let first = 0;
  return words.map((word) => {
    // Words are in start order, so a segment before this word stays behind.
    while (first < segments.length && segments[first].end <= word.sourceStart)
      first++;
    const fragments = [];
    let start = null,
      end = null,
      kept = 0;
    for (
      let index = first;
      index < segments.length && segments[index].start < word.sourceEnd;
      index++
    ) {
      const segment = segments[index];
      const from = Math.max(segment.start, word.sourceStart),
        to = Math.min(segment.end, word.sourceEnd);
      if (to - from < PRECISION) continue;
      fragments.push({ sourceStart: from, sourceEnd: to });
      kept += to - from;
      const edited = (time) =>
        round((offsets[index] + time - segment.start) / speed);
      start ??= edited(from);
      end = edited(to);
    }
    const length = word.sourceEnd - word.sourceStart;
    return {
      ...word,
      state: !fragments.length
        ? "removed"
        : kept >= length - PRECISION
          ? "kept"
          : "partial",
      start,
      end,
      fragments,
    };
  });
}

function wordIndex(view, id) {
  const match = /^w(\d+)$/.exec(String(id));
  const index = match ? Number(match[1]) : -1;
  if (!view[index])
    throw new Error(
      "A selected word was not found. Read transcript.words again.",
    );
  return index;
}

const TEXT_LIMIT = 2000;

// The time range of a contiguous selection. view is the result of mapWords.
// from and to are word IDs in any order. The range goes from the first kept
// start to the last kept end, so the pauses between the words are in it. Source
// that is already removed is not in the range. This is the same calculation for
// a preview and for the cut.
export function selectWords(view, timeline, from, to) {
  const a = wordIndex(view, from),
    b = wordIndex(view, to);
  const low = Math.min(a, b),
    high = Math.max(a, b);
  const picked = view.slice(low, high + 1);
  const kept = picked.filter((word) => word.state !== "removed");
  const count = (state) => picked.filter((w) => w.state === state).length;
  const summary = {
    from: `w${low}`,
    to: `w${high}`,
    words: picked.length,
    keptWords: kept.length,
    partialWords: count("partial"),
    removedWords: count("removed"),
  };
  if (!kept.length)
    return {
      ...summary,
      text: "",
      truncated: false,
      start: null,
      end: null,
      length: 0,
      sourceStart: null,
      sourceEnd: null,
      canCut: false,
      reason: "These words are already cut from the video.",
    };
  const sourceStart = kept[0].fragments[0].sourceStart;
  const sourceEnd = kept.reduce(
    (latest, word) => Math.max(latest, word.fragments.at(-1).sourceEnd),
    0,
  );
  const end = kept.reduce((latest, word) => Math.max(latest, word.end), 0);
  const leaves = timeline.segments.some(
    (segment) =>
      segment.start < sourceStart - PRECISION ||
      segment.end > sourceEnd + PRECISION,
  );
  let text = "",
    shown = 0;
  for (const word of kept) {
    if (text.length + word.text.length + 1 > TEXT_LIMIT) break;
    text += (text ? " " : "") + word.text;
    shown++;
  }
  return {
    ...summary,
    text,
    truncated: shown < kept.length,
    start: kept[0].start,
    end,
    length: round(end - kept[0].start),
    sourceStart,
    sourceEnd,
    canCut: leaves,
    reason: leaves ? null : "A cut must leave some video.",
  };
}
