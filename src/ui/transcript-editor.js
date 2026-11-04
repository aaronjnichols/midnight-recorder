// The Transcript tool: read the words of a local speech job, select words, and
// cut that footage. The words of a job do not change, so the page builds them
// once and later edits change only attributes. So scroll and the selection
// stay. The service derives the cut from word IDs. It never reads a time or a
// text from this page.
import { mapWords, selectWords } from "../domain/words.js";
import { timingRevision } from "../domain/inspection.js";
import {
  chooseJob,
  moveWord,
  selectionText,
  timedWords,
  transcriptKey,
  transcriptPanel,
  wordAt,
  wordSummary,
} from "./transcript-view.js";
import { clock } from "./view-model.js";

const PAGE = 1000;
const POLL_MS = 400;
const CLICK_DISTANCE = 4;
const HIGHLIGHT = "transcript-selection";

export function createTranscriptEditor({
  $,
  call,
  notice,
  playhead,
  seek,
  isReady,
  isOpen,
  draft,
  range,
  onCut,
}) {
  const area = $("#transcript-words");
  let video = null,
    capability = null,
    checking = null,
    // The speech job of this panel, and the last job list of the service.
    job = null,
    jobs = [],
    // Words of the job, their current view, and their nodes, by word index.
    words = [],
    view = [],
    timed = [],
    nodes = [],
    paragraphs = [],
    timing = "",
    load = null,
    loadToken = 0,
    sourceCurrent = true,
    // The result of selectWords for the current word selection.
    selection = null,
    caret = -1,
    anchor = -1,
    current = -1,
    // A manual scroll, key, or selection stops the follow until the user
    // returns to it.
    manual = false,
    pressed = null;
  const highlight = new Highlight();
  CSS.highlights.set(HIGHLIGHT, highlight);

  // The state of the panel.

  function checkCapability() {
    if (capability?.available || checking) return;
    checking = call("transcript.capabilities")
      .then(
        (result) => (capability = result),
        (error) => (capability = { available: false, reason: error.message }),
      )
      .finally(() => {
        checking = null;
        if (video) renderPanel();
      });
  }

  // Ends all words of the panel. A word page that arrives later is dropped.
  function dropWords() {
    loadToken++;
    words = [];
    view = [];
    timed = [];
    nodes = [];
    paragraphs = [];
    timing = "";
    load = null;
    selection = null;
    caret = anchor = current = -1;
    highlight.clear();
    area.replaceChildren();
    area.dataset.loaded = "false";
  }

  function reset() {
    dropWords();
    job = null;
    sourceCurrent = true;
    manual = false;
    pressed = null;
  }

  function render(next) {
    if (video?.id !== next.id) reset();
    video = next;
    checkCapability();
    adopt();
    const revision = timingRevision(next);
    if (words.length && load?.loaded === load?.total && revision !== timing)
      remap(revision);
    renderPanel();
  }

  function clear() {
    video = null;
    reset();
  }

  // A job from a caption request, the CLI, or MCP also shows here.
  function adopt() {
    if (!video) return;
    const choice = chooseJob({
      jobs: jobs.filter(
        (item) => item.kind === "transcript" && item.videoId === video.id,
      ),
      current: job,
      hasWords: words.length > 0,
      hasSelection: Boolean(selection),
    });
    if (choice.action === "watch") {
      job = choice.job;
      poll(job.id);
    } else if (choice.action === "load") finished(choice.job);
    else if (choice.action === "show") job = choice.job;
    else if (choice.action === "switch") {
      // The same words, so the list and its scroll stay.
      job = choice.job;
      checkSource();
    }
  }

  // Reads only whether the file is the file of the job.
  async function checkSource() {
    const { id: videoId } = video,
      { id: jobId } = job;
    const page = await call("transcript.words", { jobId, limit: 1 }).catch(
      () => null,
    );
    if (!page || video?.id !== videoId || job?.id !== jobId) return;
    sourceCurrent = page.sourceCurrent;
    renderPanel();
  }

  function syncJobs(list) {
    jobs = list;
    if (!video) return;
    adopt();
    renderPanel();
  }

  // Polls one job until it ends. Another job or video ends this loop.
  async function poll(id) {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (job?.id !== id) return;
      const status = await call("transcript.status", { jobId: id }).catch(
        (error) => ({ id, state: "failed", error: error.message }),
      );
      if (job?.id !== id) return;
      if (status.state === "complete") return finished(status);
      job = status;
      renderPanel();
      if (!["running", "cancelling"].includes(status.state)) return;
    }
  }

  function finished(status) {
    dropWords();
    job = status;
    renderPanel();
    if (status.result?.outcome === "ready") readWords(status.id, loadToken);
  }

  // Reads all pages. A long source has many words, so none are dropped, and
  // the page shows the words of each page when they arrive.
  async function readWords(jobId, token) {
    let offset = 0;
    try {
      while (offset !== null) {
        const page = await call("transcript.words", {
          jobId,
          offset,
          limit: PAGE,
        });
        if (token !== loadToken) return;
        load = { loaded: offset + page.words.length, total: page.total };
        sourceCurrent = page.sourceCurrent;
        append(page.words);
        offset = page.nextOffset;
        renderPanel();
      }
    } catch (error) {
      if (token !== loadToken) return;
      job = { ...job, state: "failed", error: error.message };
      renderPanel();
      return;
    }
    area.dataset.loaded = "true";
    remap(timingRevision(video));
    renderPanel();
  }

  function append(list) {
    for (const word of list) {
      const index = words.length;
      words.push({
        id: word.id,
        text: word.text,
        sourceStart: word.sourceStart,
        sourceEnd: word.sourceEnd,
        paragraph: word.paragraph,
      });
      let paragraph = paragraphs[word.paragraph];
      if (!paragraph) {
        const node = document.createElement("p");
        node.className = "tw-paragraph";
        const time = document.createElement("span");
        time.className = "tw-time";
        time.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "tw-text";
        node.append(time, text);
        area.append(node);
        paragraph = paragraphs[word.paragraph] = { time, text, first: index };
      }
      const span = document.createElement("span");
      span.className = "tw";
      span.dataset.index = String(index);
      span.textContent = word.text;
      paragraph.text.append(span, " ");
      nodes[index] = span;
    }
  }

  // A new time map: only attributes change.
  function remap(revision) {
    timing = revision;
    view = mapWords(words, video.timeline);
    timed = timedWords(view);
    for (const [index, word] of view.entries()) {
      const node = nodes[index];
      const state = word.state === "kept" ? undefined : word.state;
      if (node.dataset.state === state) continue;
      if (state) node.dataset.state = state;
      else delete node.dataset.state;
      node.title =
        state === "removed"
          ? "Cut from the video. Undo returns it."
          : state === "partial"
            ? "A cut removed part of this word."
            : "";
    }
    for (const [number, paragraph] of paragraphs.entries()) {
      const first = view
        .slice(paragraph.first, paragraphs[number + 1]?.first ?? view.length)
        .find((word) => word.state !== "removed");
      paragraph.time.textContent = first ? clock(first.start) : "Cut";
    }
    nodes[current]?.classList.remove("current");
    current = -1;
    if (selection) {
      const next = selectWords(
        view,
        video.timeline,
        selection.from,
        selection.to,
      );
      selection = next.keptWords ? next : null;
      if (selection) showDraft();
      else clearNative();
    }
    paint();
    timeChanged();
  }

  // Selection.

  const low = () => Number(selection.from.slice(1));
  const high = () => Number(selection.to.slice(1));

  // One range for each kept run in a paragraph, so the gold band has no gaps
  // over spaces and does not cover removed words or paragraph times.
  function paint() {
    highlight.clear();
    if (!selection) return;
    let start = null;
    const close = (end) => {
      if (start === null) return;
      const part = document.createRange();
      part.setStartBefore(nodes[start]);
      part.setEndAfter(nodes[end]);
      highlight.add(part);
      start = null;
    };
    for (let index = low(); index <= high(); index++) {
      const removed = view[index].state === "removed";
      const broken =
        start !== null && view[index].paragraph !== view[index - 1].paragraph;
      if (removed || broken) close(index - 1);
      if (!removed && start === null) start = index;
    }
    close(high());
  }

  const showDraft = () => draft.show(selection, { jobId: job.id, timing });

  function select(first, last) {
    const next = selectWords(view, video.timeline, `w${first}`, `w${last}`);
    range.stop();
    manual = true;
    if (next.keptWords) {
      selection = next;
      showDraft();
    } else {
      // No kept word: no time range, and no old range stays behind.
      draft.clear();
      selection = next;
    }
    paint();
    renderFollow();
    renderFooter();
  }

  function clearNative() {
    const native = getSelection();
    if (native.rangeCount && area.contains(native.anchorNode))
      native.removeAllRanges();
  }

  // Ends the word selection and its draft.
  function deselect() {
    const had = Boolean(selection);
    selection = null;
    anchor = -1;
    range.stop();
    clearNative();
    paint();
    renderFooter();
    if (had) draft.clear();
    return had;
  }

  // The draft is not the word selection any more, for example after a manual
  // change of the times.
  function ownerEnded() {
    if (!selection) return;
    selection = null;
    anchor = -1;
    clearNative();
    paint();
    renderFooter();
  }

  // A cancelled drag of the draft returns the words from before it. Returns
  // false if they do not apply any more, so no owner stays without its words.
  function restoreSelection(owner) {
    if (job?.id !== owner.jobId || timing !== owner.timing) return false;
    const next = selectWords(view, video.timeline, owner.from, owner.to);
    if (!next.keptWords) return false;
    selection = next;
    paint();
    renderFooter();
    return true;
  }

  // The first and the last word that a browser selection touches. Word nodes
  // are in document order, so two binary searches find them.
  function touched(native) {
    const part = document.createRange();
    const around = (index) => {
      part.selectNodeContents(nodes[index]);
      return part;
    };
    let lowest = 0,
      highest = nodes.length - 1,
      first = -1;
    while (lowest <= highest) {
      const middle = (lowest + highest) >> 1;
      // The word ends after the start of the selection.
      if (
        native.compareBoundaryPoints(Range.END_TO_START, around(middle)) < 0
      ) {
        first = middle;
        highest = middle - 1;
      } else lowest = middle + 1;
    }
    ((lowest = 0), (highest = nodes.length - 1));
    let last = -1;
    while (lowest <= highest) {
      const middle = (lowest + highest) >> 1;
      // The word starts before the end of the selection.
      if (
        native.compareBoundaryPoints(Range.START_TO_END, around(middle)) > 0
      ) {
        last = middle;
        lowest = middle + 1;
      } else highest = middle - 1;
    }
    return first >= 0 && last >= first ? [first, last] : null;
  }

  document.addEventListener("selectionchange", () => {
    if (!view.length || !isOpen()) return;
    const native = getSelection();
    if (!native.rangeCount || native.isCollapsed) return;
    if (!area.contains(native.anchorNode)) return;
    const found = touched(native.getRangeAt(0));
    if (!found) return;
    const [first, last] = found;
    if (selection && low() === first && high() === last) return;
    select(first, last);
    // The keys continue from the selection. The list does not move.
    anchor = first;
    markCaret(last);
  });

  // A click on a word seeks, and it ends a selection. A drag also ends with a
  // click. It selects and does not seek.
  area.addEventListener("pointerdown", (event) => {
    pressed = { x: event.clientX, y: event.clientY };
    // The scrollbar of the list.
    if (event.target === area) stopFollow();
  });
  area.addEventListener("click", (event) => {
    const down = pressed;
    pressed = null;
    const moved =
      down &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) >=
        CLICK_DISTANCE;
    if (moved || !getSelection().isCollapsed) return;
    const node = event.target.closest?.(".tw");
    if (!node) return;
    deselect();
    const index = Number(node.dataset.index);
    setCaret(index);
    if (view[index].state === "removed") return;
    manual = false;
    renderFollow();
    seek(view[index].start);
  });
  document.addEventListener("pointerup", () => {
    pressed = null;
  });

  function markCaret(index) {
    nodes[caret]?.classList.remove("caret");
    caret = index;
    nodes[caret]?.classList.add("caret");
  }
  function setCaret(index) {
    markCaret(index);
    nodes[caret]?.scrollIntoView({ block: "nearest" });
  }

  function extend(index) {
    if (anchor < 0) anchor = caret < 0 ? index : caret;
    setCaret(index);
    clearNative();
    select(Math.min(anchor, index), Math.max(anchor, index));
  }

  // The first kept word of the next or previous paragraph.
  function paragraphWord(index, direction) {
    const number = view[Math.max(index, 0)]?.paragraph ?? 0;
    for (
      let next = number + direction;
      next >= 0 && next < paragraphs.length;
      next += direction
    ) {
      const paragraph = paragraphs[next];
      if (!paragraph) continue;
      const found = moveWord(view, paragraph.first - 1, 1);
      if (view[found]?.paragraph === next) return found;
    }
    return index;
  }

  area.addEventListener("keydown", (event) => {
    if (!view.length) return;
    const action = transcriptKey(event);
    // The page keys stay. PageUp and the like scroll this list.
    if (["PageUp", "PageDown", "Home", "End"].includes(event.key)) stopFollow();
    if (!action) return;
    if (action.clear) {
      if (!selection) return;
      event.preventDefault();
      event.stopPropagation();
      deselect();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stopFollow();
    if (action.all) {
      anchor = 0;
      setCaret(view.length - 1);
      clearNative();
      select(0, view.length - 1);
    } else if (action.seek) {
      const word = view[caret];
      if (word && word.state !== "removed") seek(word.start);
    } else if (action.move) {
      anchor = -1;
      setCaret(moveWord(view, caret, action.move));
    } else if (action.extend) extend(moveWord(view, caret, action.extend));
    else if (action.paragraph) {
      anchor = -1;
      setCaret(paragraphWord(caret, action.paragraph));
    } else if (action.extendParagraph)
      extend(paragraphWord(caret, action.extendParagraph));
  });
  // A press also gives focus. It must not move the list under the pointer.
  area.addEventListener("focus", () => {
    if (caret < 0 && view.length && !pressed)
      setCaret(moveWord(view, current >= 0 ? current - 1 : -1, 1));
  });

  // Copy has whole words, also after the browser selection ended.
  document.addEventListener("copy", (event) => {
    if (!selection?.keptWords) return;
    const native = getSelection();
    const here =
      area.contains(document.activeElement) ||
      (native.rangeCount && area.contains(native.anchorNode));
    if (!here) return;
    event.clipboardData.setData(
      "text/plain",
      selectionText(view, low(), high()),
    );
    event.preventDefault();
  });

  // Follow. The list moves only when the user did not take control.

  function stopFollow() {
    manual = true;
    renderFollow();
  }
  area.addEventListener("wheel", stopFollow, { passive: true });

  function renderFollow() {
    $("#transcript-follow").hidden = !(manual && view.length);
  }

  function reveal(node) {
    const box = area.getBoundingClientRect();
    const place = node.getBoundingClientRect();
    if (place.top >= box.top + 24 && place.bottom <= box.bottom - 48) return;
    area.scrollTop += place.top - box.top - box.height / 3;
  }

  function timeChanged() {
    if (!view.length || !isOpen()) return;
    const index = wordAt(timed, playhead());
    if (index !== current) {
      nodes[current]?.classList.remove("current");
      current = index;
      if (index >= 0) {
        nodes[index].classList.add("current");
        if (!manual && !selection && !pressed) reveal(nodes[index]);
      }
    }
    renderFooter();
  }

  $("#transcript-follow").addEventListener("click", () => {
    manual = false;
    renderFollow();
    const index = wordAt(timed, playhead());
    const word = index >= 0 ? index : moveWord(view, current, 1);
    if (nodes[word]) reveal(nodes[word]);
  });

  // Panel.

  function renderPanel() {
    if (!video) return;
    const state = transcriptPanel({
      video,
      capability,
      job,
      load,
      sourceCurrent,
    });
    const showWords = state.kind === "ready" || state.kind === "loading";
    const card = $("#transcript-state");
    card.hidden = state.kind === "ready" && !state.warning;
    card.dataset.tone = state.warning ? "warn" : state.tone;
    $("#transcript-state-title").textContent = state.warning
      ? "Check the source"
      : state.title;
    $("#transcript-state-text").textContent = state.warning || state.text;
    const bar = $("#transcript-progress");
    const running = ["running", "loading"].includes(state.kind);
    bar.hidden = !running;
    if (state.progress === null) bar.removeAttribute("value");
    else bar.value = state.progress;
    const start = $("#transcript-start");
    start.hidden = !state.canStart;
    start.textContent = state.startLabel;
    $("#transcript-cancel").hidden = !state.canCancel;
    area.hidden = !showWords;
    $("#transcript-footer").hidden = !showWords;
    renderFollow();
    renderFooter();
  }

  function renderFooter() {
    const text = wordSummary(selection);
    const line = $("#transcript-selection");
    const value =
      text || "Select words: drag across them. Correct text in Captions.";
    if (line.textContent !== value) line.textContent = value;
    line.dataset.state = selection
      ? selection.keptWords
        ? "selected"
        : "none"
      : "empty";
    const canCut = Boolean(selection?.canCut) && sourceCurrent;
    const cut = $("#transcript-cut");
    cut.disabled = !canCut;
    cut.title = canCut
      ? "Remove this footage from the video. Word times are estimates, so check the join. Undo returns it."
      : (selection?.reason ??
        (sourceCurrent
          ? "Select words first."
          : "The source file changed. Make a new transcript."));
    const play = $("#transcript-play");
    const label = range.active() ? "Stop" : "Play selection";
    play.disabled = !selection?.keptWords || !isReady();
    if (play.title !== label) {
      play.title = label;
      play.setAttribute("aria-label", label);
      play
        .querySelector("use")
        .setAttribute("href", range.active() ? "#i-pause" : "#i-play");
      play.querySelector("span").textContent = range.active() ? "Stop" : "Play";
    }
  }

  // Actions.

  function start() {
    if (!video) return;
    const id = video.id;
    return call("transcript.start", { id }).then((started) => {
      if (video?.id !== id) return;
      dropWords();
      job = started;
      renderPanel();
      poll(started.id);
    });
  }
  $("#transcript-start").addEventListener("click", () =>
    start().catch((error) => notice(error.message, true)),
  );
  $("#transcript-cancel").addEventListener("click", () => {
    const current = job;
    if (!current) return;
    call("transcript.cancel", { jobId: current.id })
      .then((status) => {
        if (job?.id !== current.id) return;
        job = status;
        renderPanel();
      })
      .catch((error) => notice(error.message, true));
  });

  // Sends the IDs of the selection and the revision of the view that shows it.
  // The service rejects them if the video, the file, or the times changed.
  async function cutSelected() {
    if (!selection?.canCut || !sourceCurrent || !video) return;
    const id = video.id,
      chosen = selection;
    try {
      const result = await call(
        "transcript.cut",
        {
          id,
          jobId: job.id,
          from: chosen.from,
          to: chosen.to,
          revision: timing,
        },
        id,
      );
      await onCut(result, chosen, id);
    } catch (error) {
      // The reason can be a replaced file. The panel then tells it.
      if (video?.id === id) await checkSource();
      throw error;
    }
  }

  function playSelection() {
    if (range.active()) return range.halt();
    if (!selection?.keptWords || !isReady()) return;
    return range.play(selection.start, selection.end);
  }

  return {
    render,
    clear,
    syncJobs,
    timeChanged,
    ownerEnded,
    restoreSelection,
    deselect,
    cutSelected,
    playSelection,
    renderFooter,
    jobId: () => job?.id ?? null,
    opened: () => {
      if (!video) return;
      checkCapability();
      renderPanel();
      timeChanged();
    },
  };
}
