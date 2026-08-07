const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desk', {
  platform: process.platform,

  // Lockdown control
  engageLock: () => ipcRenderer.invoke('lock:engage'),
  releaseLock: () => ipcRenderer.invoke('lock:release'),
  isLocked: () => ipcRenderer.invoke('lock:status'),

  // Main process reports integrity events (focus loss, quit attempts, ...)
  onLockEvent: (cb) => {
    const handler = (_e, payload) => cb(payload)
    ipcRenderer.on('lock:event', handler)
    return () => ipcRenderer.removeListener('lock:event', handler)
  },

  // Small persisted store in userData (survives restarts, so a locked
  // student who force-quits comes back into the locked session)
  storeGet: (key) => ipcRenderer.invoke('store:get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store:set', key, value),

  // Whitelist the DesmosLock server so the network filter lets it through
  allowServer: (url) => ipcRenderer.invoke('net:allow-server', url),

  // Window shaping for the teacher console
  setWindowMode: (mode) => ipcRenderer.invoke('window:mode', mode),
  quit: () => ipcRenderer.invoke('app:quit')
})
