import { contextBridge, ipcRenderer } from "electron";

import {
  createTrustedDesktopBridge,
  studentSessionChannels,
} from "./trusted-bridge.js";

const trustedDesktopBridge = createTrustedDesktopBridge(
  async (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: unknown) =>
      listener(view);
    ipcRenderer.on(studentSessionChannels.changed, receive);
    return () =>
      ipcRenderer.removeListener(studentSessionChannels.changed, receive);
  },
);

contextBridge.exposeInMainWorld("desmoslockDesktop", trustedDesktopBridge);
