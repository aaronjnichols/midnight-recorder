// Shared commands for split marks and the parts that they make. A split saves a
// mark and changes no time. Keep and remove use the source span of a part, and
// they need the revision of the list that the caller read.
import {
  MAX_SPLITS,
  MIN_PART,
  addSplit,
  duration,
  keepPart,
  removePart,
  removeSplit,
  splitsOf,
  timelineParts,
} from "../domain/timeline.js";
import { structureRevision } from "../domain/inspection.js";

const string = (description) => ({ type: "string", description, minLength: 1 });
const define = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
});
const id = string("Video ID.");
const revision = string("The revision from parts.list.");
const partId = string("Part ID from parts.list.");

export const partCommands = [
  define(
    "parts.list",
    `Read the parts of the edited video. Split marks and cut joins divide it. Gives the times of each part, the marks, and the revision for part commands. A video has at most ${MAX_SPLITS} marks.`,
    { id },
    ["id"],
  ),
  define(
    "edit.split",
    `Add a split at an edited time. A split removes no time and does not change the rendered video, elements, or captions. It makes two parts that you can keep or remove. The time must be at least ${MIN_PART} seconds from the start, the end, a cut join, and other splits. One undo step.`,
    {
      id,
      seconds: { type: "number", description: "Edited time in seconds." },
      revision: string(
        "Optional revision from parts.list. Reject a changed video.",
      ),
    },
    ["id", "seconds"],
  ),
  define(
    "edit.unsplit",
    "Remove a split mark. Its two parts become one. No time changes. One undo step.",
    {
      id,
      splitId: string("Split ID from parts.list."),
      revision,
    },
    ["id", "splitId", "revision"],
  ),
  define(
    "edit.keepPart",
    "Keep only this part of the edited video. One undo step. Rejected if the parts changed after you read them.",
    { id, partId, revision },
    ["id", "partId", "revision"],
  ),
  define(
    "edit.removePart",
    "Remove this part of the edited video and join the parts around it. One undo step. Rejected if the parts changed after you read them.",
    { id, partId, revision },
    ["id", "partId", "revision"],
  ),
];

export function describeParts(video) {
  const { timeline } = video;
  const parts = timelineParts(timeline);
  return {
    revision: structureRevision(video),
    duration: duration(timeline),
    parts,
    splits: splitsOf(timeline).map((mark) => ({
      ...mark,
      start: parts.find((part) => part.splitBefore === mark.id)?.start ?? null,
    })),
    limits: { splits: MAX_SPLITS, shortestPart: MIN_PART },
  };
}

const edits = {
  split: (timeline, args) => addSplit(timeline, args.seconds),
  unsplit: (timeline, args) => removeSplit(timeline, args.splitId),
  keepPart: (timeline, args) => keepPart(timeline, args.partId),
  removePart: (timeline, args) => removePart(timeline, args.partId),
};
export const isPartEdit = (action) => action in edits;

// Runs in the service queue, so the revision check and the edit see one state.
export function editParts(action, video, args) {
  if (args.revision !== undefined && args.revision !== structureRevision(video))
    throw new Error("The video changed. Read parts.list again.");
  return edits[action](video.timeline, args);
}

// Extra values of a part edit result. They are not stored.
export function partResult(action, saved, before, args) {
  const view = describeParts(saved);
  const added =
    action === "split"
      ? view.splits.find(
          (mark) => !splitsOf(before.timeline).some((m) => m.id === mark.id),
        )
      : undefined;
  return {
    parts: view.parts,
    structureRevision: view.revision,
    ...(added ? { split: added } : {}),
  };
}
