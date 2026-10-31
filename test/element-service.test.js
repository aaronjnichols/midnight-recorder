import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Service, commands } from "../src/application/service.js";
import { Library } from "../src/adapters/library.js";

async function workspace(prefix) {
  await mkdir(".local/claude-editing", { recursive: true });
  return mkdtemp(path.resolve(".local/claude-editing", prefix));
}

async function setup() {
  const root = await workspace("element-service-");
  const source = path.join(root, "input.webm");
  await writeFile(source, "video");
  const data = path.join(root, "data");
  const service = new Service({
    library: new Library(data),
    media: { probe: async () => ({ duration: 10, width: 640, height: 360 }) },
  });
  const video = await service.execute("library.import", { path: source });
  return { root, data, service, video };
}

const ids = (list) => list.map((e) => e.id);

test("shared element commands add, change, order, remove, and persist text", async () => {
  const { data, service, video } = await setup();
  const names = commands.map((c) => c.name);
  for (const name of [
    "element.add",
    "element.update",
    "element.duplicate",
    "element.order",
    "element.remove",
    "element.list",
  ])
    assert.ok(names.includes(name), name);
  const add = commands.find((c) => c.name === "element.add");
  assert.deepEqual(add.inputSchema.properties.type.enum, [
    "text",
    "rectangle",
    "ellipse",
    "arrow",
  ]);
  assert.match(add.inputSchema.properties.x.description, /inspect\.result/);

  const added = await service.execute("element.add", {
    id: video.id,
    type: "text",
    text: 'Step 1: open "Settings"',
    start: 1,
    end: 3,
    x: 0.1,
    y: 0.7,
    width: 0.8,
    height: 0.15,
    background: "#101820",
  });
  const first = added.element;
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    [first.start, first.end, first.visibility, first.layer],
    [1, 3, "full", 0],
  );
  assert.equal(added.video.timeline.elements[0].id, first.id);
  const second = (
    await service.execute("element.duplicate", {
      id: video.id,
      elementId: first.id,
    })
  ).element;
  assert.notEqual(second.id, first.id);
  assert.equal(second.layer, 1);
  const updated = await service.execute("element.update", {
    id: video.id,
    elementId: second.id,
    text: "Step 2",
    start: 3,
    end: 5,
    y: 0.1,
  });
  assert.deepEqual(
    [updated.element.text, updated.element.start, updated.element.y],
    ["Step 2", 3, 0.1],
  );
  await service.execute("element.order", {
    id: video.id,
    elementId: second.id,
    index: 0,
  });
  let list = await service.execute("element.list", { id: video.id });
  assert.deepEqual(ids(list.elements), [second.id, first.id]);
  assert.equal(list.duration, 10);
  assert.match(list.coordinates, /top left/);
  assert.match(list.timing, /edited/);
  assert.equal(typeof list.revision, "string");

  // Each command is one undo step. Undo also restores element order.
  await service.execute("edit.undo", { id: video.id });
  list = await service.execute("element.list", { id: video.id });
  assert.deepEqual(ids(list.elements), [first.id, second.id]);
  await service.execute("edit.redo", { id: video.id });

  // A trim reports which elements stay visible.
  const trimmed = await service.execute("edit.trim", {
    id: video.id,
    start: 0,
    end: 2,
  });
  assert.deepEqual(
    trimmed.elementPlacement.map((e) => [e.id, e.visibility, e.start, e.end]),
    [
      [second.id, "none", null, null],
      [first.id, "partial", 1, 2],
    ],
  );
  assert.equal(
    (await service.execute("library.get", { id: video.id })).elementPlacement,
    undefined,
    "Placement is a report. It is not stored.",
  );
  await service.execute("edit.undo", { id: video.id });

  const removed = await service.execute("element.remove", {
    id: video.id,
    elementId: first.id,
  });
  assert.equal(removed.removed, first.id);
  assert.deepEqual(ids(removed.video.timeline.elements), [second.id]);

  // A new library object reads the same elements from disk.
  const reopened = new Service({ library: new Library(data) });
  const stored = await reopened.execute("element.list", { id: video.id });
  assert.deepEqual(ids(stored.elements), [second.id]);
  assert.equal(stored.elements[0].text, "Step 2");

  // Reset with scope elements removes text and keeps other edits.
  await service.execute("edit.cut", { id: video.id, start: 8, end: 9 });
  const reset = await service.execute("edit.reset", {
    id: video.id,
    scope: "elements",
  });
  assert.deepEqual(reset.timeline.elements, []);
  assert.equal(reset.timeline.segments.length, 2);

  // Schema checks run before the command.
  for (const [args, message] of [
    [{ id: video.id, elementId: second.id, unknown: 1 }, /Unknown argument/],
    [{ id: video.id, elementId: second.id, x: "0.5" }, /Invalid x/],
    [{ id: video.id, elementId: second.id, font: "comic" }, /Invalid font/],
    [{ id: video.id, elementId: "missing", x: 0.1 }, /not found/],
  ])
    await assert.rejects(service.execute("element.update", args), message);
  await assert.rejects(
    service.execute("element.add", {
      id: video.id,
      type: "text",
      text: "x",
      start: 9,
      end: 12,
    }),
    /edited video/,
  );
});

test("advertised color patterns accept the same values as the commands", async () => {
  const { service, video } = await setup();
  const { element } = await service.execute("element.add", {
    id: video.id,
    type: "text",
    text: "Color",
    start: 0,
    end: 1,
  });
  for (const name of ["element.add", "element.update"]) {
    const schema = commands.find((c) => c.name === name).inputSchema;
    for (const key of ["color", "background", "outline"]) {
      const pattern = new RegExp(schema.properties[key].pattern);
      for (const value of ["none", "#12abEF", "red", "#FFF"]) {
        const args =
          name === "element.add"
            ? { id: video.id, type: "text", text: "x", start: 0, end: 1 }
            : { id: video.id, elementId: element.id };
        const accepted = await service
          .execute(name, { ...args, [key]: value })
          .then(
            () => true,
            () => false,
          );
        assert.equal(
          pattern.test(value),
          accepted,
          `${name} ${key} ${value}: the schema and the command must agree.`,
        );
      }
    }
  }
});

test("shapes, arrows, and fades use the shared commands and report actual values", async () => {
  const { service, video } = await setup();
  const add = commands.find((c) => c.name === "element.add").inputSchema
    .properties;
  for (const key of [
    "fill",
    "fillOpacity",
    "stroke",
    "strokeWidth",
    "x1",
    "y1",
    "x2",
    "y2",
    "fadeIn",
    "fadeOut",
  ])
    assert.ok(add[key]?.description, `element.add describes ${key}`);
  assert.match(add.x2.description, /tip/);
  assert.match(add.fill.description, /rectangle/i);
  const configure = commands.find((c) => c.name === "edit.configure")
    .inputSchema.properties;
  assert.match(configure.fadeIn.description, /black/);

  const box = await service.execute("element.add", {
    id: video.id,
    type: "rectangle",
    start: 1,
    end: 2,
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.2,
    fill: "#BF616A",
    fillOpacity: 0.4,
    fadeIn: 0.8,
    fadeOut: 0.8,
  });
  assert.equal(box.element.type, "rectangle");
  // 0.8 + 0.8 is longer than the 1-second element.
  assert.deepEqual(
    [box.element.fadeIn, box.element.actualFadeIn, box.element.actualFadeOut],
    [0.8, 0.5, 0.5],
  );
  const arrow = await service.execute("element.add", {
    id: video.id,
    type: "arrow",
    start: 0,
    end: 5,
    x1: 0.8,
    y1: 0.8,
    x2: 0.25,
    y2: 0.2,
    color: "#A3BE8C",
  });
  const moved = await service.execute("element.update", {
    id: video.id,
    elementId: arrow.element.id,
    x2: 0.3,
  });
  assert.deepEqual(
    [moved.element.x1, moved.element.x2, moved.element.y2],
    [0.8, 0.3, 0.2],
  );
  await assert.rejects(
    service.execute("element.update", {
      id: video.id,
      elementId: arrow.element.id,
      fill: "#FFFFFF",
    }),
    /does not use fill/,
  );
  await assert.rejects(
    service.execute("edit.configure", { id: video.id, fadeOut: 12 }),
    /fadeOut must be/,
  );
  const faded = await service.execute("edit.configure", {
    id: video.id,
    fadeIn: 1.5,
    fadeOut: 2,
  });
  assert.deepEqual(faded.videoFades, {
    fadeIn: 1.5,
    fadeOut: 2,
    actualFadeIn: 1.5,
    actualFadeOut: 2,
  });
  const trimmed = await service.execute("edit.trim", {
    id: video.id,
    start: 0,
    end: 2,
  });
  assert.ok(Math.abs(trimmed.videoFades.actualFadeIn - 2 * (1.5 / 3.5)) < 1e-6);
  const list = await service.execute("element.list", { id: video.id });
  assert.equal(list.videoFades.fadeOut, 2);
  assert.deepEqual(
    list.elements.map((e) => e.type),
    ["rectangle", "arrow"],
  );
});

test("advertised number bounds and colors for every type match the commands", async () => {
  const { service, video } = await setup();
  const schema = commands.find((c) => c.name === "element.add").inputSchema
    .properties;
  const users = {
    color: ["text", "arrow"],
    background: ["text"],
    outline: ["text", "arrow"],
    fill: ["rectangle", "ellipse"],
    stroke: ["rectangle", "ellipse"],
    fillOpacity: ["rectangle"],
    strokeWidth: ["rectangle", "arrow"],
    opacity: ["text", "ellipse", "arrow"],
    fadeIn: ["text", "rectangle", "arrow"],
    fadeOut: ["ellipse"],
    size: ["text"],
    backgroundOpacity: ["text"],
    x1: ["arrow"],
    y2: ["arrow"],
  };
  const accepted = (type, key, value) =>
    service
      .execute("element.add", {
        id: video.id,
        type,
        start: 0,
        end: 1,
        ...(type === "text" ? { text: "x" } : {}),
        // A shape without a line needs a fill.
        ...(["rectangle", "ellipse"].includes(type) && key === "stroke"
          ? { fill: "#FFFFFF" }
          : {}),
        [key]: value,
      })
      .then(
        () => true,
        () => false,
      );
  for (const [key, types] of Object.entries(users)) {
    const spec = schema[key];
    const values =
      spec.type === "number"
        ? [
            spec.minimum - 0.0001,
            spec.minimum,
            spec.maximum,
            spec.maximum + 0.0001,
          ]
        : ["none", "#12abEF", "red", "#FFF"];
    for (const type of types)
      for (const value of values) {
        const advertised =
          spec.type === "number"
            ? value >= spec.minimum && value <= spec.maximum
            : new RegExp(spec.pattern).test(value);
        assert.equal(
          await accepted(type, key, value),
          advertised,
          `${type} ${key} ${value}: the schema and the command must agree.`,
        );
      }
  }
});

test("an old library file opens and gains elements without migration damage", async () => {
  const root = await workspace("element-old-");
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const old = [
    {
      id: "old-video",
      title: "Old",
      path: path.join(data, "media", "old-video.webm"),
      createdAt: "2026-10-01T00:00:00.000Z",
      metadata: { duration: 10, width: 640, height: 360, hasAudio: false },
      timeline: {
        segments: [{ start: 2, end: 8 }],
        speed: 1,
        muted: false,
        past: [{ segments: [{ start: 0, end: 10 }], speed: 1, muted: false }],
        future: [],
      },
    },
  ];
  const index = path.join(data, "library.json");
  await writeFile(index, JSON.stringify(old, null, 2));
  const before = await readFile(index, "utf8");
  const service = new Service({ library: new Library(data) });
  const listed = await service.execute("element.list", { id: "old-video" });
  assert.deepEqual(listed.elements, []);
  await service.execute("library.get", { id: "old-video" });
  assert.equal(
    await readFile(index, "utf8"),
    before,
    "Reading does not write.",
  );

  const { element } = await service.execute("element.add", {
    id: "old-video",
    type: "text",
    text: "New",
    start: 0,
    end: 1,
  });
  assert.equal(element.sourceStart, 2, "Edited 0 is source 2 after the trim.");
  const stored = JSON.parse(await readFile(index, "utf8"))[0];
  assert.deepEqual(stored.timeline.past[0], old[0].timeline.past[0]);
  assert.equal(stored.metadata.duration, 10);
  let video = await service.execute("edit.undo", { id: "old-video" });
  assert.deepEqual(video.timeline.elements, []);
  video = await service.execute("edit.undo", { id: "old-video" });
  assert.deepEqual(video.timeline.segments, [{ start: 0, end: 10 }]);
  assert.deepEqual(video.timeline.elements, []);
  video = await service.execute("edit.redo", { id: "old-video" });
  video = await service.execute("edit.redo", { id: "old-video" });
  assert.deepEqual(ids(video.timeline.elements), [element.id]);
  assert.deepEqual(video.timeline.segments, [{ start: 2, end: 8 }]);
});
