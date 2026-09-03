import { contextBridge, ipcRenderer } from "electron";

import { createTrustedDesktopBridge } from "./trusted-bridge.js";

const trustedDesktopBridge = createTrustedDesktopBridge(
  async (channel, request) => ipcRenderer.invoke(channel, request),
);

contextBridge.exposeInMainWorld("desmoslockDesktop", trustedDesktopBridge);
