// The timeline overview: sound levels and frames of a source video. The data
// comes from the source once. Pure code maps it through the current cuts and
// speed, so a trim, cut, or speed change needs no new decode. Callers still
// check that a reply is for the open video and the current request.
// The UI uses the same functions, so this file has no Node dependency.
import { duration, sourceTime } from "./timeline.js";
import { textHash } from "./inspection.js";

export const OVERVIEW_LIMITS = {
  // Part of the cache identity. Change it when the data format changes.
  version: 1,
  // Enough for a level display. It keeps the decoded stream small.
  sampleRate: 8000,
  minBucketSeconds: 0.02,
  maxBuckets: 65536,
  minFrameStep: 0.5,
  maxFrames: 48,
  frameWidth: 160,
  frameHeight: 90,
  // The largest sampled frame. A 160 x 90 JPEG is about 3 KB.
  maxFrameBytes: 262144,
  // Time limits for one read. totalSeconds covers all of the read. A longer
  // read stops with a clear state.
  totalSeconds: 180,
  frameSeconds: 60,
  maxWindowBuckets: 1000,
  // Completed overview jobs that the service keeps. The cache keeps the data.
  maxJobs: 16,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Fractions in the order 0, 1/2, 1/4, 3/4, 1/8, ... So any first part of the
// list covers the full range.
function spreadOrder(count) {
  const order = [];
  const seen = new Set();
  for (let i = 0; order.length < count && i < count * 8; i++) {
    let fraction = 0,
      weight = 0.5;
    for (let bits = i; bits; bits >>= 1, weight /= 2)
      if (bits & 1) fraction += weight;
    const index = Math.floor(fraction * count);
    if (!seen.has(index)) {
      seen.add(index);
      order.push(index);
    }
  }
  return order;
}

// The bounded work for one source. Each sound bucket has a whole number of
// samples. Frame times are in work order, spread over the video, so a time
// limit leaves frames from all of the video.
export function overviewPlan({ duration: seconds, hasAudio }) {
  const { sampleRate, minBucketSeconds, maxBuckets, minFrameStep, maxFrames } =
    OVERVIEW_LIMITS;
  const samplesPerBucket = Math.max(
    Math.round(minBucketSeconds * sampleRate),
    Math.ceil((seconds * sampleRate) / maxBuckets),
  );
  const count = clamp(Math.floor(seconds / minFrameStep), 1, maxFrames);
  return {
    audio:
      hasAudio === false
        ? null
        : {
            sampleRate,
            samplesPerBucket,
            bucketSeconds: samplesPerBucket / sampleRate,
            buckets: Math.ceil(
              (seconds * sampleRate) / samplesPerBucket - 1e-9,
            ),
          },
    frames: {
      times: spreadOrder(count).map(
        (index) => ((index + 0.5) * seconds) / count,
      ),
    },
  };
}

// The size of a sampled frame. It keeps the aspect ratio of the rendered
// frame, does not enlarge, and has even sides for the encoder.
export function frameBox({ width, height }) {
  const { frameWidth, frameHeight } = OVERVIEW_LIMITS;
  const scale = Math.min(1, frameWidth / width, frameHeight / height);
  const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

// The cache key of a source. Edits are not part of it.
export function overviewIdentity(video, file) {
  return textHash(
    JSON.stringify({
      version: OVERVIEW_LIMITS.version,
      id: video.id,
      path: video.path,
      metadata: video.metadata,
      size: file.size,
      mtimeMs: file.mtimeMs,
    }),
  );
}

// True for a complete cache file of this source. A damaged file is a cache
// miss, so the read runs again.
export function validOverview(data, identity) {
  const { version, maxBuckets, maxFrames, maxFrameBytes } = OVERVIEW_LIMITS;
  if (data?.version !== version || data.identity !== identity) return false;
  const { audio, frames } = data;
  const base64 = (text, bytes) =>
    typeof text === "string" && text.length <= Math.ceil(bytes / 3) * 4;
  const sound =
    audio?.state === "none" ||
    (["ready", "silent"].includes(audio?.state) &&
      audio.bucketSeconds > 0 &&
      Number.isInteger(audio.loudest) &&
      (audio.state === "silent" || base64(audio.levels, maxBuckets)));
  return (
    sound &&
    ["ready", "partial"].includes(frames?.state) &&
    frames.width > 0 &&
    frames.height > 0 &&
    Array.isArray(frames.items) &&
    frames.items.length > 0 &&
    frames.items.length <= maxFrames &&
    frames.items.every(
      (item) =>
        Number.isFinite(item?.seconds) && base64(item.data, maxFrameBytes),
    )
  );
}

// RMS of a bucket, from 0 to 1 of full scale, as one byte. The square root
// keeps quiet speech visible next to loud sound.
export const levelByte = (rms) => Math.round(255 * Math.sqrt(clamp(rms, 0, 1)));
export const byteLevel = (byte) => byte / 255;

// The levels of the edited window from start to end in equal columns, from 0
// to 1. A column shows the loudest bucket in its time, over all kept parts
// that it covers. A time with no data is 0.
export function editedLevels(
  timeline,
  { levels, bucketSeconds },
  { start, end, columns },
) {
  const result = new Float32Array(Math.max(0, columns));
  if (!columns || !levels?.length || !(end > start)) return result;
  const { segments, speed } = timeline;
  const step = (end - start) / columns;
  // The first kept part that can reach the column, and its edited start.
  let segment = 0,
    offset = 0;
  const length = (index) =>
    (segments[index].end - segments[index].start) / speed;
  for (let column = 0; column < columns; column++) {
    const from = start + column * step,
      to = from + step;
    while (segment < segments.length && offset + length(segment) <= from) {
      offset += length(segment);
      segment++;
    }
    let loudest = 0,
      cursor = offset;
    for (let index = segment; index < segments.length && cursor < to; index++) {
      const size = length(index);
      const left = Math.max(from, cursor),
        right = Math.min(to, cursor + size);
      if (right > left) {
        const base = segments[index].start;
        const first = Math.floor(
          (base + (left - cursor) * speed) / bucketSeconds + 1e-9,
        );
        const last = Math.min(
          levels.length - 1,
          Math.ceil((base + (right - cursor) * speed) / bucketSeconds - 1e-9) -
            1,
        );
        for (let bucket = first; bucket <= last; bucket++)
          if (levels[bucket] > loudest) loudest = levels[bucket];
      }
      cursor += size;
    }
    result[column] = byteLevel(loudest);
  }
  return result;
}

// The first index in frames with a time that is not before seconds.
function frameIndex(frames, seconds) {
  let low = 0,
    high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].seconds < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The sampled frame nearest to the source time of an edited time, from the
// same kept part only. A frame from a removed part never shows as kept video.
// Returns null when a kept part has no sample. frames are in time order.
export function frameAtEdited(timeline, frames, seconds) {
  if (!frames.length) return null;
  const total = duration(timeline);
  const target = sourceTime(timeline, clamp(seconds, 0, total));
  const { segments } = timeline;
  const part = segments.find((s) => target < s.end) ?? segments.at(-1);
  // A kept part is half open: its end is the first removed time.
  const first = frameIndex(frames, part.start);
  const after = frameIndex(frames, part.end);
  if (first >= after) return null;
  const next = clamp(frameIndex(frames, target), first, after - 1);
  const before = Math.max(first, next - 1);
  return Math.abs(frames[before].seconds - target) <=
    Math.abs(frames[next].seconds - target)
    ? frames[before]
    : frames[next];
}

// A bounded read of levels for an agent. Times are edited seconds.
export function windowPlan(timeline, { start = 0, end, buckets = 100 } = {}) {
  const total = duration(timeline);
  const last = end ?? total;
  if (
    !Number.isInteger(buckets) ||
    buckets < 1 ||
    buckets > OVERVIEW_LIMITS.maxWindowBuckets
  )
    throw new Error(
      `Invalid buckets. Use a whole number from 1 to ${OVERVIEW_LIMITS.maxWindowBuckets}.`,
    );
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(last) ||
    start < 0 ||
    last <= start ||
    last > total + 1e-6
  )
    throw new Error(
      `Select a time range within the edited video, from 0 to ${total} seconds.`,
    );
  return { start, end: Math.min(last, total), buckets };
}
