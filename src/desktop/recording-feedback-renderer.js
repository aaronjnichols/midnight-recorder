window.recordingFeedback.listen(({ state, remaining }) => {
  document.body.dataset.state = state;
  document.querySelector("#countdown").hidden = state !== "countdown";
  document.querySelector("#border").hidden = !["recording", "paused"].includes(
    state,
  );
  document.querySelector("#count").textContent = remaining ?? "";
  document.querySelector("#badge").textContent =
    state === "paused" ? "Ⅱ Paused" : "● Recording";
});
