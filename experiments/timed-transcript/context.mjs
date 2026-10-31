// Research only. These functions are not part of the app command service.
export function mapWords(words, timeline) {
  const result = [];
  let offset = 0;
  for (const [index, segment] of timeline.segments.entries()) {
    let first = true;
    for (const word of words) {
      const start = Math.max(word.start, segment.start);
      const end = Math.min(word.end, segment.end);
      if (end <= start) continue;
      result.push({
        ...word,
        sourceStart: word.start,
        sourceEnd: word.end,
        start: offset + (start - segment.start) / timeline.speed,
        end: offset + (end - segment.start) / timeline.speed,
        partial: start !== word.start || end !== word.end,
        cutBefore: index > 0 && first,
      });
      first = false;
    }
    offset += (segment.end - segment.start) / timeline.speed;
  }
  return result;
}

export function readWindow(words, start, end) {
  return words.filter((word) => word.end > start && word.start < end);
}

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9']/g, "");
export function findPhrase(words, query, contextSeconds = 2) {
  const queryWords = query.trim().split(/\s+/).map(normalize);
  const hits = [];
  for (let i = 0; i <= words.length - queryWords.length; i++) {
    const match = words.slice(i, i + queryWords.length);
    if (
      !match.every(
        (word, k) =>
          normalize(word.word) === queryWords[k] &&
          !word.partial &&
          (k === 0 || !word.cutBefore),
      )
    )
      continue;
    const start = match[0].start,
      end = match.at(-1).end;
    hits.push({
      start,
      end,
      text: match.map((w) => w.word.trim()).join(" "),
      context: readWindow(
        words,
        Math.max(0, start - contextSeconds),
        end + contextSeconds,
      ),
    });
  }
  return hits;
}
