'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const listen = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('x32', {
  connect: (host, port) => ipcRenderer.invoke('x32:connect', host, port),
  disconnect: () => ipcRenderer.invoke('x32:disconnect'),
  discover: () => ipcRenderer.invoke('x32:discover'),
  status: () => ipcRenderer.invoke('x32:status'),
  query: (paths) => ipcRenderer.invoke('x32:query', paths),
  snapshot: () => ipcRenderer.invoke('x32:snapshot'),
  set: (path, value) => ipcRenderer.send('x32:set', path, value),
  command: (address, args) => ipcRenderer.send('x32:command', address, args),
  loadSettings: () => ipcRenderer.sendSync('store:load'),
  saveSetting: (key, value) => ipcRenderer.send('store:set', key, value),
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  platform: process.platform,
  onStatus: listen('x32:status'),
  onUpdates: listen('x32:updates'),
  onMeters: listen('x32:meters'),
});
