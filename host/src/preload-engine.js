const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('tether', {
  getConfig: () => ipcRenderer.invoke('engine:config'),
  getScreens: () => ipcRenderer.invoke('engine:screens'),
  setState: (patch) => ipcRenderer.send('engine:state', patch),
  confirmSession: (viewer) => ipcRenderer.invoke('engine:confirm', viewer),
  setSession: (session) => ipcRenderer.send('engine:session', session),
  input: (ev, displayId) => ipcRenderer.send('engine:input', ev, displayId),
  clipboardWrite: (text) => ipcRenderer.send('engine:clipboard-write', text),
  file: (msg) => ipcRenderer.send('engine:file', msg),
  pullPick: () => ipcRenderer.invoke('engine:pull-pick'),
  pullRead: (id, offset, length) => ipcRenderer.invoke('engine:pull-read', id, offset, length),
  pullClose: (id) => ipcRenderer.send('engine:pull-close', id),
  clearDevice: () => ipcRenderer.invoke('engine:clear-device'),
  onEndSession: on('engine:end-session'),
  onNewCode: on('engine:new-code'),
  onConfigRefresh: on('engine:config-refresh'),
  onClipboard: on('engine:clipboard'),
  onFileResult: on('engine:file-result'),
});
