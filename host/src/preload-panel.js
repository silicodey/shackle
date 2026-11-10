const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shackle', {
  getState: () => ipcRenderer.invoke('panel:state'),
  action: (name, payload) => ipcRenderer.invoke('panel:action', name, payload),
  onState: (fn) => ipcRenderer.on('panel:state', (_e, s) => fn(s)),
});
