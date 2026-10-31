const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureBridge', {
  listen: callback => ipcRenderer.on('capture:request', (_, request) => callback(request)),
  reply: response => ipcRenderer.send('capture:reply', response),
  chunk: bytes => ipcRenderer.invoke('capture:chunk', bytes)
});
