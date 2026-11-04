// The Parts list in Trim & cut: one row for each part, with its exact times. A
// row is the route to a part that is too small to click on the timeline. The
// buttons exist only while the video has two or more parts.
import { partRows } from "./transcript-view.js";

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createPartsPanel({ $, select, keep, remove, join }) {
  const section = $("#parts");
  let rows = [],
    listKey = "";

  function action(label, className, onClick) {
    const button = make("button", className, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function buildList() {
    const list = make("ol", "part-list");
    list.id = "part-list";
    list.append(
      ...rows.map((row) => {
        const item = make("li");
        const button = make("button", "part-row");
        button.type = "button";
        button.dataset.id = row.id;
        button.setAttribute("aria-label", row.label);
        button.setAttribute("aria-pressed", "false");
        button.append(
          make("span", "part-number", String(row.number)),
          make("span", "part-range", `${row.startText} – ${row.endText}`),
          make("span", "part-length", row.lengthText),
        );
        button.addEventListener("click", () =>
          select(rows.find((item) => item.id === row.id)),
        );
        item.append(button);
        return item;
      }),
    );
    const heading = make("div", "section-head");
    const title = make("h4", "section-title", "Parts");
    title.id = "parts-heading";
    heading.append(
      title,
      make("span", "section-count", `${rows.length} parts`),
    );
    const actions = make("div", "part-actions");
    actions.id = "part-actions";
    section.replaceChildren(heading, list, actions);
  }

  function renderActions(row) {
    const actions = $("#part-actions");
    if (!row) {
      actions.replaceChildren(
        make(
          "p",
          "hint",
          "Select a part here or on the timeline to keep or remove it.",
        ),
      );
      return;
    }
    actions.replaceChildren(
      action("Keep part", "button secondary small", () => keep(row)),
      action("Remove part", "button secondary small", () => remove(row)),
      ...(row.splitAfter
        ? [action("Join with next", "text-button small", () => join(row))]
        : []),
    );
  }

  function render(video, selectedId) {
    rows = partRows(video.timeline, selectedId);
    section.hidden = rows.length < 2;
    if (rows.length < 2) {
      listKey = "";
      section.replaceChildren();
      return;
    }
    const key = JSON.stringify(
      rows.map((row) => [row.id, row.startText, row.endText, row.seam]),
    );
    if (key !== listKey) {
      listKey = key;
      buildList();
    }
    for (const button of section.querySelectorAll(".part-row"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.id === selectedId),
      );
    renderActions(rows.find((row) => row.selected));
  }

  return { render };
}
