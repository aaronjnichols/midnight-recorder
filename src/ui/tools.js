// The editing tool switcher: one tab for each tool, and one visible tool
// panel. A tool change only changes what the page shows. It sends no
// command, so it does not change the video or the undo history.
export function createTools({ onChange } = {}) {
  const tabs = [...document.querySelectorAll('[role="tab"][data-tool]')];
  const panelOf = (tab) =>
    document.getElementById(tab.getAttribute("aria-controls"));
  let active = tabs.find((t) => t.getAttribute("aria-selected") === "true")
    ?.dataset.tool;

  // focus moves the keyboard focus to the new tab, for the arrow keys.
  function show(name, { focus = false } = {}) {
    const next = tabs.find((t) => t.dataset.tool === name);
    if (!next) return;
    if (name !== active) {
      // A field in the closing tool loses focus first, so its normal save
      // on leave runs before the field is hidden.
      const closing = panelOf(tabs.find((t) => t.dataset.tool === active));
      if (closing?.contains(document.activeElement))
        document.activeElement.blur();
      active = name;
      for (const tab of tabs) {
        const on = tab === next;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        panelOf(tab).hidden = !on;
      }
      onChange?.(name);
    }
    if (focus) next.focus();
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => show(tab.dataset.tool));
    // Left and Right go around the tabs. Home and End go to the first and
    // last tab. The page shortcuts ignore these keys on a tab.
    tab.addEventListener("keydown", (event) => {
      const target = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      show(tabs[target].dataset.tool, { focus: true });
    });
  }

  return { show, active: () => active };
}
