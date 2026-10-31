import { test } from "node:test";
import assert from "node:assert/strict";
import * as transcript from "../src/domain/transcript.js";
test("a video without an audio track never reports audible audio", () => {
  const data = { duration: 5, outcome: "no_audio", words: [] };
  const timeline = { segments: [{ start: 0, end: 5 }], speed: 1, muted: false };
  for (const timeBase of ["source", "edited"]) {
    assert.equal(
      transcript.readTranscript(data, timeline, { timeBase }).audioAudible,
      false,
    );
    assert.equal(
      transcript.searchTranscript(data, timeline, { query: "word", timeBase })
        .audioAudible,
      false,
    );
  }
});

test("transcript reads keep source times and mark words split by cuts", () => {
  const words = [
    { word: "Do", start: 1, end: 1.3, probability: 0.9 },
    { word: "not", start: 1.4, end: 1.7, probability: 0.8 },
    { word: "select", start: 1.8, end: 2.3, probability: 0.9 },
    { word: "Cancel.", start: 5, end: 5.5, probability: 0.9 },
  ];
  const timeline = {
    segments: [
      { start: 0, end: 2 },
      { start: 5, end: 8 },
    ],
    speed: 2,
    muted: false,
  };
  assert.equal(typeof transcript.readTranscript, "function");
  const result = transcript.readTranscript({ words }, timeline, {
    start: 0,
    end: 2.5,
    detail: "words",
  });
  assert.equal(result.words[2].partial, true);
  assert.equal(result.words[2].sourceEnd, 2.3);
  assert.equal(result.words[3].start, 1);
  assert.equal(result.words[3].cutBefore, true);
  assert.equal(result.timeBase, "edited");
  assert.equal(result.audioAudible, true);
});

test("reads and searches have bounded pages, source mode, and explicit mute state", () => {
  const data = {
    duration: 100,
    words: Array.from({ length: 100 }, (_, i) => ({
      word: "word",
      start: i,
      end: i + 0.5,
      segmentId: Math.floor(i / 5),
    })),
  };
  const timeline = {
    segments: [{ start: 20, end: 30 }],
    speed: 2,
    muted: true,
  };
  const first = transcript.readTranscript(data, timeline, {
    start: 0,
    end: 5,
    detail: "words",
    limit: 3,
  });
  assert.equal(first.words.length, 3);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.audioAudible, false);
  const next = transcript.readTranscript(data, timeline, {
    start: 0,
    end: 5,
    detail: "words",
    limit: 3,
    offset: first.nextOffset,
  });
  assert.equal(next.words[0].sourceStart, 23);
  const source = transcript.readTranscript(data, timeline, {
    timeBase: "source",
    start: 0,
    end: 2,
  });
  assert.equal(source.segments[0].start, 0);
  assert.equal(source.timeBase, "source");
  const hits = transcript.searchTranscript(data, timeline, {
    query: "word",
    limit: 2,
  });
  assert.equal(hits.matches.length, 2);
  assert.ok(hits.nextOffset > 0);
  for (const args of [
    { start: -1 },
    { start: 0, end: 1000 },
    { limit: 501 },
    { offset: 0.5 },
    { timeBase: "bad" },
    { detail: "bad" },
  ])
    assert.throws(() => transcript.readTranscript(data, timeline, args));
  for (const args of [
    { query: "x", limit: 21 },
    { query: "x", contextSeconds: 11 },
    { query: "x", offset: -1 },
    { query: "x", start: -1 },
  ])
    assert.throws(() => transcript.searchTranscript(data, timeline, args));
});

test("phrase search preserves nearby negation and does not join speech across a cut or pause", () => {
  assert.equal(typeof transcript.searchTranscript, "function");
  const data = {
    duration: 10,
    words: [
      { word: "Do", start: 0, end: 0.2 },
      { word: "not", start: 0.3, end: 0.5 },
      { word: "select", start: 0.6, end: 0.8 },
      { word: "Cancel.", start: 0.9, end: 1.2 },
      { word: "select", start: 3, end: 3.5 },
      { word: "Cancel.", start: 6, end: 6.5 },
    ],
  };
  const timeline = {
    segments: [{ start: 0, end: 10 }],
    speed: 1,
    muted: false,
  };
  const result = transcript.searchTranscript(data, timeline, {
    query: "select cancel",
  });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].context.text, /Do not/);
  assert.equal(result.matches[0].inspectionTimestamps.length, 3);
  const cut = {
    ...timeline,
    segments: [
      { start: 0, end: 0.85 },
      { start: 0.9, end: 2 },
    ],
  };
  assert.equal(
    transcript.searchTranscript(data, cut, { query: "select cancel" }).matches
      .length,
    0,
  );
  assert.throws(
    () => transcript.searchTranscript(data, timeline, { query: "!!!" }),
    /query/i,
  );
});
