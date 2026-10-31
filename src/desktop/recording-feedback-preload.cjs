const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("recordingFeedback", {
  listen: (callback) =>
    ipcRenderer.on("recording-feedback", (_, state) => callback(state)),
});
