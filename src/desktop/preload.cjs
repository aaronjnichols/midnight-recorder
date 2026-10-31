const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("midnight", {
  execute: (name, args = {}) => ipcRenderer.invoke("command", name, args),
  pickImport: () => ipcRenderer.invoke("pick-import"),
  pickExport: (title) => ipcRenderer.invoke("pick-export", title),
  onNotice: (callback) =>
    ipcRenderer.on("notice", (_, message) => callback(message)),
  onRecording: (callback) =>
    ipcRenderer.on("recording:state", (_, recording) => callback(recording)),
  onPlayback: (callback) =>
    ipcRenderer.on("playback:request", (_, request) => callback(request)),
  playbackReply: (response) => ipcRenderer.send("playback:reply", response),
});
